/* Socratic Chrome extension — content script (V0, hackathon sprint).
 *
 * Drives the REAL YouTube player (no iframe API): timeupdate watcher,
 * shadow-DOM overlay, voice loop against the local backend (127.0.0.1:8123).
 * 127.0.0.1 is a "potentially trustworthy origin", so these http fetches are
 * allowed from https://www.youtube.com, and the mic works (HTTPS page).
 */

const API = "http://127.0.0.1:8123";

// Réglages démo : micro coupé (réponses clavier), activation automatique à
// l'ouverture d'une vidéo. Basculer ici pour réactiver la boucle vocale.
const MIC_ENABLED = false;
const AUTO_START = true;

// Le logo glyphe, inliné (blanc, pour le FAB bleu).
const GLYPH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="130 105 250 290" width="16" height="18" style="vertical-align:-3px;margin-right:6px"><rect x="162" y="135" width="50" height="230" rx="25" fill="#fff"/><path d="M 240 190 A 55 55 0 1 1 295 245 L 295 272" fill="none" stroke="#fff" stroke-width="50" stroke-linecap="round"/><circle cx="295" cy="338" r="27" fill="#f5b942"/></svg>`;

let session = null;
let cps = [];
let state = "idle"; // idle|building|watching|countdown|question|listening|evaluating|feedback|reexplain
let currentCp = null;
let followup = null;
let followupUsed = false;
let lastTime = 0;
let video = null;
let root = null; // shadow root
let ui = {};
let currentAudio = null;
let rec = null; // recorder state

/* ---------- backend ---------- */

async function api(path, body) {
  const r = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || r.statusText);
  return r.json();
}

/* ---------- audio out ---------- */

function stopSpeaking() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
}

async function playUrl(url) {
  stopSpeaking();
  await new Promise((res) => {
    currentAudio = new Audio(url);
    currentAudio.onended = res;
    currentAudio.onerror = res;
    currentAudio.play().catch(res);
  });
}

// Cache local des synthèses : un texte déjà prononcé (acks, feedbacks répétés)
// rejoue instantanément au lieu de repasser par Kokoro (~1s de synthèse).
const ttsCache = new Map();

async function speak(text) {
  if (!text) return;
  try {
    let blobUrl = ttsCache.get(text);
    if (!blobUrl) {
      const r = await fetch(`${API}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) return;
      blobUrl = URL.createObjectURL(await r.blob());
      ttsCache.set(text, blobUrl);
    }
    await playUrl(blobUrl);
  } catch { /* TTS down — text-only */ }
}

/* ---------- mic in (RMS endpointing, ported from voice.js) ---------- */

function micSupported() {
  return !!(navigator.mediaDevices && window.MediaRecorder);
}

async function listen(onEnd) {
  stopListening();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus("Mic denied — type instead.");
    ui.typeInput.focus();
    return;
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
    .find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    if (!rec || !rec.aborted) onEnd(new Blob(chunks, { type: mime }));
    rec = null;
  };
  recorder.start(250);
  rec = { recorder, aborted: false, raf: 0 };

  const data = new Float32Array(analyser.fftSize);
  let speechStarted = false;
  let lastVoice = performance.now();
  const t0 = performance.now();
  const tick = () => {
    if (!rec) return;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    if (rms > 0.02) { speechStarted = true; lastVoice = now; ui.micDot.classList.add("live"); }
    else ui.micDot.classList.remove("live");
    if ((speechStarted && now - lastVoice > 1400) || now - t0 > 60000) {
      finishListening();
      return;
    }
    rec.raf = requestAnimationFrame(tick);
  };
  rec.raf = requestAnimationFrame(tick);
}

function finishListening() {
  if (rec && rec.recorder.state === "recording") rec.recorder.stop();
}

function stopListening() {
  if (rec) { rec.aborted = true; cancelAnimationFrame(rec.raf); finishListening(); }
}

/* ---------- overlay (carte lower-third DANS le player, codes visuels YouTube) ---------- */

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Roboto", "YouTube Sans", -apple-system, BlinkMacSystemFont, sans-serif; }
.badge {
  position: absolute; top: 16px; right: 16px; z-index: 2100;
  background: rgba(18,18,18,.85); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  color: #f1f1f1; border: 1px solid rgba(255,255,255,.1); border-radius: 999px;
  padding: 8px 16px; font-size: 13px; font-weight: 500; pointer-events: none;
}
@keyframes sk-in {
  from { opacity: 0; transform: translate(-50%, 14px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
}
.panel {
  position: absolute; left: 50%; bottom: 76px; transform: translateX(-50%);
  z-index: 2100; width: min(720px, calc(100% - 48px));
  background: rgba(18,18,18,.88);
  -webkit-backdrop-filter: blur(16px) saturate(1.3); backdrop-filter: blur(16px) saturate(1.3);
  border: 1px solid rgba(255,255,255,.08); border-radius: 16px;
  padding: 16px 20px; color: #f1f1f1;
  display: flex; flex-direction: column; gap: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,.55);
  pointer-events: auto;
  animation: sk-in .28s cubic-bezier(.2,.7,.3,1);
}
.brand {
  display: flex; align-items: center; gap: 6px;
  color: #aaa; font-size: 11px; font-weight: 500;
  letter-spacing: 1.2px; text-transform: uppercase;
}
.brand .progress { margin-left: auto; color: #717171; letter-spacing: 0; }
.question { font-size: 18px; font-weight: 500; line-height: 1.45; }
.panel[data-state="feedback"] .question, .panel[data-state="reexplain"] .question {
  font-size: 13px; font-weight: 400; color: #aaa;
}
.heard { color: #aaa; font-size: 13px; font-style: italic; }
.verdict { font-weight: 700; font-size: 16px; }
.verdict.pass { color: #2ba640; } .verdict.partial { color: #ffd600; } .verdict.miss { color: #ff4e45; }
.points { list-style: none; margin: 0; padding: 0; font-size: 13px; line-height: 1.5; }
.points li.covered { color: #2ba640; } .points li.partial { color: #ffd600; } .points li.missed { color: #ff4e45; }
.feedback { background: rgba(255,255,255,.06); border-radius: 10px; padding: 10px 14px; font-size: 14px; line-height: 1.5; }
.reexplain { background: rgba(62,166,255,.08); border-left: 3px solid #3ea6ff; border-radius: 10px; padding: 10px 14px; font-size: 14px; line-height: 1.5; }
.controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
button {
  border: none; border-radius: 18px; padding: 8px 16px; font-size: 13px;
  font-weight: 500; background: rgba(255,255,255,.1); color: #f1f1f1; cursor: pointer;
  transition: background .15s;
}
button:hover { background: rgba(255,255,255,.2); }
button.primary { background: #f1f1f1; color: #0f0f0f; }
button.primary:hover { background: #d9d9d9; }
button.ghost { background: transparent; color: #aaa; }
button.ghost:hover { background: rgba(255,255,255,.1); color: #f1f1f1; }
input[type="text"] {
  flex: 1; min-width: 200px; background: rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.14); border-radius: 18px;
  color: #f1f1f1; padding: 8px 14px; font-size: 13px; outline: none;
}
input[type="text"]:focus { border-color: #3ea6ff; }
.status { color: #aaa; font-size: 12px; min-height: 16px; }
.micdot { width: 10px; height: 10px; border-radius: 50%; background: #3a4556; display: inline-block; transition: background .15s; }
.micdot.live { background: #ff4e45; box-shadow: 0 0 8px rgba(255,78,69,.8); }
.hidden { display: none !important; }
/* Un seul jeu de contrôles pertinent par état — jamais d'action hors contexte. */
.panel[data-state="evaluating"] .type, .panel[data-state="evaluating"] .send,
.panel[data-state="feedback"] .type,   .panel[data-state="feedback"] .send,
.panel[data-state="reexplain"] .type,  .panel[data-state="reexplain"] .send,
.panel[data-state="evaluating"] .skip,
.panel[data-state="feedback"] .skip,
.panel[data-state="reexplain"] .skip { display: none; }
`;

function buildOverlay() {
  const host = document.createElement("div");
  host.id = "socratic-host";
  document.documentElement.appendChild(host);
  root = host.attachShadow({ mode: "open" });

  const fab = el("button", "socratic-fab", "");
  fab.innerHTML = `${GLYPH}Socratic`;
  // Styles inline : résiste aux filtres cosmétiques des adblockers et à toute
  // interférence de stylesheet (cause avérée de FAB invisible chez certains profils).
  fab.style.cssText = `position:fixed !important; bottom:24px; right:24px;
    z-index:2147483647; background:#4f8cff; color:#fff; border:none;
    border-radius:999px; padding:12px 18px; font-size:14px; font-weight:700;
    cursor:pointer; box-shadow:0 4px 16px rgba(0,0,0,.4);
    display:block !important; visibility:visible !important; opacity:1 !important;
    font-family:-apple-system,BlinkMacSystemFont,sans-serif;`;
  fab.addEventListener("click", toggle);
  root.appendChild(fab);
  ui.fab = fab;
}

let panelHost = null;

/* La carte vit DANS #movie_player : elle suit le player (theater, fullscreen),
 * laisse la vidéo visible derrière, et n'obstrue ni les contrôles ni la barre
 * de lecture (pointer-events:none hors carte — les pastilles restent cliquables). */
function ensurePanel() {
  const player = document.querySelector("#movie_player") || document.body;
  if (panelHost && panelHost.parentElement === player) return;
  if (panelHost) panelHost.remove();
  panelHost = document.createElement("div");
  panelHost.id = "socratic-panel-host";
  panelHost.style.cssText = "position:absolute; inset:0; z-index:2050; pointer-events:none;";
  // Les hotkeys YouTube (espace, i, f, chiffres) voient le host comme target
  // (shadow retargeting), pas un input — on coupe la propagation.
  for (const evt of ["keydown", "keyup", "keypress"]) {
    panelHost.addEventListener(evt, (e) => e.stopPropagation());
  }
  player.appendChild(panelHost);
  const proot = panelHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  proot.appendChild(style);

  const badge = el("div", "badge hidden", "");
  proot.appendChild(badge);

  const panel = el("div", "panel hidden", "");
  panel.innerHTML = `
    <div class="brand">${GLYPH}<span>Socratic</span><span class="progress"></span></div>
    <div class="question"></div>
    <div class="heard hidden"></div>
    <div class="verdict hidden"></div>
    <ul class="points"></ul>
    <div class="feedback hidden"></div>
    <div class="reexplain hidden"></div>
    <div class="controls">
      <span class="micdot hidden"></span>
      <button class="done hidden">I'm done speaking</button>
      <input type="text" class="type" placeholder="Your answer…">
      <button class="send primary">Send</button>
      <button class="replay hidden">↺ Watch that part again</button>
      <button class="continue primary hidden">Continue ▸</button>
      <button class="skip ghost">Skip</button>
    </div>
    <div class="status"></div>`;
  proot.appendChild(panel);

  Object.assign(ui, {
    badge, panel,
    progress: panel.querySelector(".progress"),
    question: panel.querySelector(".question"),
    heard: panel.querySelector(".heard"),
    verdict: panel.querySelector(".verdict"),
    points: panel.querySelector(".points"),
    feedback: panel.querySelector(".feedback"),
    reexplain: panel.querySelector(".reexplain"),
    micDot: panel.querySelector(".micdot"),
    doneBtn: panel.querySelector(".done"),
    typeInput: panel.querySelector(".type"),
    sendBtn: panel.querySelector(".send"),
    replayBtn: panel.querySelector(".replay"),
    continueBtn: panel.querySelector(".continue"),
    skipBtn: panel.querySelector(".skip"),
    status: panel.querySelector(".status"),
  });

  ui.doneBtn.addEventListener("click", finishListening);
  ui.sendBtn.addEventListener("click", submitTyped);
  ui.typeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitTyped(); });
  ui.skipBtn.addEventListener("click", () => { stopListening(); stopSpeaking(); finishCp("skipped"); });
  ui.replayBtn.addEventListener("click", () => {
    stopSpeaking();
    const t = currentCp.t_source_start;
    finishCp("miss");
    video.currentTime = t;
    lastTime = t;
  });
  ui.continueBtn.addEventListener("click", () => { stopSpeaking(); finishCp("miss"); });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function setStatus(msg) { ui.status.textContent = msg || ""; }

function resetPanel() {
  for (const k of ["heard", "verdict", "feedback", "reexplain", "replayBtn", "continueBtn", "doneBtn", "micDot"]) {
    ui[k].classList.add("hidden");
  }
  ui.points.innerHTML = "";
  ui.typeInput.value = "";
  setStatus("");
}

/* ---------- pastilles sur la vraie barre de lecture YouTube ---------- */

const DOT_COLORS = {
  pending: "#4f8cff", active: "#4f8cff", pass: "#3ecf8e",
  partial: "#f4b942", miss: "#f0616d", skipped: "#4a5568",
};

function renderDots() {
  const bar = document.querySelector(".ytp-progress-bar");
  if (!bar || !video || !video.duration) return;
  bar.querySelectorAll(".socratic-dot").forEach((d) => d.remove());
  for (const cp of cps) {
    const dot = document.createElement("div");
    dot.className = "socratic-dot";
    const color = DOT_COLORS[cp.verdict || cp.status] || DOT_COLORS.pending;
    // Inline styles: résiste au CSS YouTube et aux adblockers.
    dot.style.cssText = `position:absolute; top:50%;
      left:${(cp.t_pause / video.duration) * 100}%;
      transform:translate(-50%,-50%); width:13px; height:13px;
      border-radius:50%; background:${color}; border:2px solid rgba(0,0,0,.6);
      z-index:100; pointer-events:auto; cursor:pointer;`;
    dot.title = cp.status === "pending"
      ? `Question at ${fmtTime(cp.t_pause)} — ${cp.concept}`
      : `Replay this question — ${cp.concept}`;
    // Auto = one-shot ; clic = re-test volontaire. On intercepte mousedown/click
    // pour que le clic sur la pastille ne déclenche PAS le seek de YouTube.
    for (const evt of ["mousedown", "mouseup", "click"]) {
      dot.addEventListener(evt, (e) => { e.stopPropagation(); e.preventDefault(); });
    }
    dot.addEventListener("click", () => {
      if (state === "watching") { cp.verdict = undefined; fire(cp); }
    });
    bar.appendChild(dot);
  }
}

function fmtTime(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function removeDots() {
  document.querySelectorAll(".socratic-dot").forEach((d) => d.remove());
}

/* ---------- session ---------- */

async function toggle() {
  if (state !== "idle") { teardownSession(); return; }
  const vid = new URL(location.href).searchParams.get("v");
  if (!vid) return;
  state = "building";
  ui.fab.textContent = "⏳ Preparing…";
  ui.fab.style.background = "#f4b942";
  try {
    const base = await api("/api/stats").catch(() => null);
    const ticker = base && setInterval(async () => {
      try {
        const s = await api("/api/stats");
        const tok = s.prompt_tokens + s.completion_tokens - base.prompt_tokens - base.completion_tokens;
        if (tok > 0) ui.fab.textContent = `⏳ Gemma 4 · ${tok.toLocaleString()} tokens (local)`;
      } catch { /* transient */ }
    }, 1500);
    session = await api("/api/session", { url: location.href });
    if (ticker) clearInterval(ticker);
  } catch (e) {
    ui.fab.textContent = "🦉 Socratic";
    ui.fab.style.background = "#4f8cff";
    state = "idle";
    alert(`Socratic: backend unreachable.\n${e.message}\nRun ./scripts/serve_app.sh`);
    return;
  }
  cps = session.checkpoints.map((c) => ({ ...c, status: "pending" }));
  ui.fab.textContent = `✓ Socratic — ${cps.length} checkpoints`;
  ui.fab.style.background = "#3ecf8e";
  ensurePanel();
  video = document.querySelector("video");
  lastTime = video ? video.currentTime : 0;
  state = "watching";
  video.addEventListener("timeupdate", onTime);
  if (video.duration) renderDots();
  else video.addEventListener("loadedmetadata", renderDots, { once: true });
}

function teardownSession() {
  stopListening();
  stopSpeaking();
  if (video) video.removeEventListener("timeupdate", onTime);
  removeDots();
  ui.panel.classList.add("hidden");
  ui.badge.classList.add("hidden");
  ui.fab.textContent = "🦉 Socratic";
  ui.fab.style.background = "#4f8cff";
  session = null; cps = []; currentCp = null; state = "idle";
}

/* ---------- watcher ---------- */

function onTime() {
  if (state !== "watching" || !video) return;
  const ct = video.currentTime;
  if (ct - lastTime > 3) {
    let skipped = false;
    cps.forEach((cp) => {
      if (cp.status === "pending" && cp.t_pause > lastTime && cp.t_pause <= ct) {
        cp.status = "skipped";
        skipped = true;
      }
    });
    if (skipped) renderDots();
  }
  lastTime = ct;
  const next = cps.find((c) => c.status === "pending");
  if (next && ct >= next.t_pause - 3) startCountdown(next);
}

function startCountdown(cp) {
  state = "countdown";
  let n = 3;
  ui.badge.classList.remove("hidden");
  ui.badge.textContent = `Question in ${n}…`;
  const id = setInterval(() => {
    n -= 1;
    if (n <= 0) { clearInterval(id); ui.badge.classList.add("hidden"); fire(cp); }
    else ui.badge.textContent = `Question in ${n}…`;
  }, 1000);
}

/* ---------- the loop ---------- */

async function fire(cp) {
  ensurePanel(); // le player a pu être re-rendu (theater/fullscreen)
  video.pause();
  currentCp = cp;
  cp.status = "active";
  followup = null;
  followupUsed = false;
  resetPanel();
  // Pas de label de concept : il paraphrase souvent la réponse (anti-spoiler).
  ui.progress.textContent = `Question ${cps.indexOf(cp) + 1}/${cps.length}`;
  ui.question.textContent = cp.question;
  ui.panel.dataset.state = "question";
  ui.panel.classList.remove("hidden");
  state = "question";
  // Garde anti-reprise : si quoi que ce soit relance la vidéo pendant la
  // question (hotkey résiduel, autoplay), on la remet en pause.
  video.addEventListener("play", pauseGuard);
  try { await playUrl(`${API}/api/tts/question/${session.video_id}/${cp.id}`); }
  catch { await speak(cp.question); }
  startListening();
}

function pauseGuard() {
  if (currentCp && ["question", "listening", "evaluating", "feedback", "reexplain"].includes(state)) {
    video.pause();
  }
}

function startListening() {
  if (!MIC_ENABLED) {
    ui.typeInput.focus();
    return;
  }
  if (!micSupported()) { setStatus("Mic unavailable — type instead."); ui.typeInput.focus(); return; }
  state = "listening";
  ui.micDot.classList.remove("hidden");
  ui.doneBtn.classList.remove("hidden");
  setStatus("Listening…");
  listen(async (blob) => {
    ui.micDot.classList.add("hidden");
    ui.doneBtn.classList.add("hidden");
    setStatus("Transcribing…");
    let text = "";
    try {
      const fd = new FormData();
      fd.append("audio", blob, blob.type.includes("mp4") ? "a.m4a" : "a.webm");
      const r = await fetch(`${API}/api/stt`, { method: "POST", body: fd });
      if (r.ok) text = (await r.json()).text.trim();
    } catch { /* fall through */ }
    if (!text) { setStatus("Didn't catch that — try typing?"); ui.typeInput.focus(); return; }
    submitAnswer(text);
  });
}

function submitTyped() {
  const t = ui.typeInput.value.trim();
  if (!t || !currentCp) return;
  stopListening();
  submitAnswer(t);
}

async function submitAnswer(answer) {
  state = "evaluating";
  ui.panel.dataset.state = "evaluating";
  ui.micDot.classList.add("hidden");
  ui.doneBtn.classList.add("hidden");
  ui.typeInput.value = "";
  ui.heard.textContent = `You said: ${answer}`;
  ui.heard.classList.remove("hidden");
  setStatus("Grading (Gemma 4, on-device)…");
  speak(["Okay…", "Alright…", "Let me see…"][Math.floor(Math.random() * 3)]);
  const isFu = !!followup;
  let ev;
  try {
    ev = await api("/api/evaluate", {
      video_id: session.video_id,
      checkpoint_id: currentCp.id,
      answer,
      question: isFu ? followup.question : null,
      expected_key_points: isFu ? [followup.weakPoint] : null,
      is_followup: isFu,
    });
  } catch {
    setStatus("Grading failed — moving on.");
    return setTimeout(() => finishCp("skipped"), 2000);
  }
  handleVerdict(ev, isFu);
}

function renderVerdict(ev, compact) {
  const labels = { pass: "✓ Correct", partial: "~ Almost", miss: "✗ Not quite" };
  ui.verdict.textContent = labels[ev.verdict] || ev.verdict;
  ui.verdict.className = `verdict ${ev.verdict}`;
  ui.verdict.classList.remove("hidden");
  ui.points.innerHTML = "";
  // Sur un miss : pas de liste de critères (tronqués = illisibles, complets =
  // réponse servie d'un bloc) — la ré-explication porte le contenu.
  if (!compact) {
    for (const [point, res] of Object.entries(ev.points || {})) {
      const li = document.createElement("li");
      li.className = res.status;
      const mark = { covered: "✓", partial: "~", missed: "✗" }[res.status] || "•";
      li.textContent = `${mark} ${point}`;
      ui.points.appendChild(li);
    }
  }
  if (ev.verdict !== "miss" && ev.feedback) {
    ui.feedback.textContent = ev.feedback;
    ui.feedback.classList.remove("hidden");
  }
}

async function handleVerdict(ev, wasFollowup) {
  state = "feedback";
  ui.panel.dataset.state = "feedback";
  setStatus("");
  renderVerdict(ev, ev.verdict === "miss");

  if (wasFollowup || (ev.verdict === "partial" && followupUsed)) {
    await speak(ev.feedback);
    return setTimeout(() => finishCp("partial"), 1500);
  }
  if (ev.verdict === "pass") {
    await speak(ev.feedback);
    return setTimeout(() => finishCp("pass"), 2000);
  }
  if (ev.verdict === "partial") {
    followupUsed = true;
    const weakPoint = Object.entries(ev.points || {}).find(([, r]) => r.status !== "covered")?.[0]
      || currentCp.expected_key_points[0];
    await speak(ev.feedback);
    let fq;
    try {
      fq = await api("/api/followup", {
        video_id: session.video_id, checkpoint_id: currentCp.id, weak_point: weakPoint,
      });
    } catch { return setTimeout(() => finishCp("partial"), 1500); }
    followup = { question: fq.question, weakPoint };
    resetPanel();
    ui.question.textContent = fq.question;
    ui.panel.dataset.state = "question";
    await speak(fq.question);
    startListening();
    return;
  }
  // miss: reexplain fired first, feedback speech covers the LLM latency
  const missed = Object.entries(ev.points || {}).filter(([, r]) => r.status !== "covered").map(([p]) => p);
  const rxP = api("/api/reexplain", {
    video_id: session.video_id, checkpoint_id: currentCp.id, missed_points: missed,
  });
  ui.replayBtn.classList.remove("hidden");
  ui.continueBtn.classList.remove("hidden");
  await speak(ev.feedback);
  setStatus("Let me rephrase…");
  let rx;
  try { rx = await rxP; } catch { return setTimeout(() => finishCp("miss"), 2000); }
  if (!currentCp) return; // barge-in already resumed
  state = "reexplain";
  ui.panel.dataset.state = "reexplain";
  setStatus("");
  ui.reexplain.textContent = rx.text;
  ui.reexplain.classList.remove("hidden");
  await speak(rx.text);
}

function finishCp(verdict) {
  if (!currentCp) return;
  currentCp.status = "done";
  currentCp.verdict = verdict;
  currentCp = null;
  followup = null;
  ui.panel.classList.add("hidden");
  state = "watching";
  renderDots();
  if (video) {
    video.removeEventListener("play", pauseGuard);
    if (verdict !== "replay") video.play();
  }
}

/* ---------- boot + SPA navigation ---------- */

function boot() {
  if (root) return;
  buildOverlay();
  maybeAutoStart();
}

function maybeAutoStart() {
  if (!AUTO_START || state !== "idle") return;
  if (!new URL(location.href).searchParams.get("v")) return;
  // Attendre que le player existe avant d'armer la session.
  const wait = setInterval(() => {
    if (document.querySelector("video") && document.querySelector("#movie_player")) {
      clearInterval(wait);
      if (state === "idle") toggle();
    }
  }, 500);
  setTimeout(() => clearInterval(wait), 15000); // abandon silencieux hors /watch
}

boot();
window.addEventListener("yt-navigate-finish", () => {
  // Video changed (YouTube is a SPA): drop the session, keep the FAB.
  if (state !== "idle") teardownSession();
  maybeAutoStart();
});
