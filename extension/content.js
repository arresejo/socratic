/* Socratic Chrome extension — content script (V0, hackathon sprint).
 *
 * Drives the REAL YouTube player (no iframe API): timeupdate watcher,
 * shadow-DOM overlay, voice loop against the local backend (127.0.0.1:8123).
 * 127.0.0.1 is a "potentially trustworthy origin", so these http fetches are
 * allowed from https://www.youtube.com, and the mic works (HTTPS page).
 */

const API = "http://127.0.0.1:8123";

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

async function speak(text) {
  if (!text) return;
  try {
    const r = await fetch(`${API}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return;
    await playUrl(URL.createObjectURL(await r.blob()));
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
    setStatus("Micro refusé — répondez au clavier.");
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

/* ---------- overlay (shadow DOM: immune to YouTube CSS) ---------- */

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.badge {
  position: fixed; top: 70px; right: 16px; z-index: 2147483647;
  background: rgba(14,17,22,.92); color: #e7ecf3; border: 1px solid #4f8cff;
  border-radius: 999px; padding: 8px 16px; font-size: 14px; font-weight: 600;
}
.fab {
  position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
  background: #4f8cff; color: #fff; border: none; border-radius: 999px;
  padding: 12px 18px; font-size: 14px; font-weight: 700; cursor: pointer;
  box-shadow: 0 4px 16px rgba(0,0,0,.4);
}
.fab.on { background: #3ecf8e; }
.panel {
  position: fixed; inset: 0; z-index: 2147483646;
  background: rgba(10,13,18,.94); color: #e7ecf3;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  padding: 6vh 12vw; gap: 14px;
}
.concept { color: #8b96a5; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
.question { font-size: 24px; font-weight: 650; line-height: 1.35; text-align: center; max-width: 900px; }
.panel[data-state="feedback"] .question, .panel[data-state="reexplain"] .question {
  font-size: 15px; font-weight: 400; color: #8b96a5;
}
.heard { color: #8b96a5; font-style: italic; }
.verdict { font-weight: 800; font-size: 22px; }
.verdict.pass { color: #3ecf8e; } .verdict.partial { color: #f4b942; } .verdict.miss { color: #f0616d; }
.points { list-style: none; margin: 0; padding: 0; font-size: 14px; max-width: 800px; }
.points li.covered { color: #3ecf8e; } .points li.partial { color: #f4b942; } .points li.missed { color: #f0616d; }
.feedback { background: #1e2530; border-radius: 8px; padding: 10px 14px; max-width: 800px; }
.reexplain { background: #1e2530; border-left: 3px solid #4f8cff; border-radius: 8px; padding: 12px 14px; max-width: 800px; }
.controls { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; align-items: center; }
button {
  background: #4f8cff; color: #fff; border: none; border-radius: 8px;
  padding: 10px 16px; font-size: 14px; cursor: pointer;
}
button.ghost { background: transparent; border: 1px solid #2a3342; color: #8b96a5; }
input[type="text"] {
  background: #171c24; border: 1px solid #2a3342; border-radius: 8px;
  color: #e7ecf3; padding: 10px 12px; font-size: 14px; width: 340px;
}
.status { color: #8b96a5; font-size: 13px; min-height: 18px; }
.micdot { width: 12px; height: 12px; border-radius: 50%; background: #3a4556; display: inline-block; }
.micdot.live { background: #f0616d; }
.hidden { display: none !important; }
`;

function buildOverlay() {
  const host = document.createElement("div");
  host.id = "socratic-host";
  document.documentElement.appendChild(host);
  root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  const fab = el("button", "fab", "🦉 Socratic");
  fab.addEventListener("click", toggle);
  root.appendChild(fab);

  const badge = el("div", "badge hidden", "");
  root.appendChild(badge);

  const panel = el("div", "panel hidden", "");
  panel.innerHTML = `
    <div class="concept"></div>
    <div class="question"></div>
    <div class="heard hidden"></div>
    <div class="verdict hidden"></div>
    <ul class="points"></ul>
    <div class="feedback hidden"></div>
    <div class="reexplain hidden"></div>
    <div class="controls">
      <span class="micdot hidden"></span>
      <button class="done hidden">J'ai fini de parler</button>
      <input type="text" class="type" placeholder="…ou répondez au clavier">
      <button class="send">Envoyer</button>
      <button class="replay hidden">↺ Revoir ce passage</button>
      <button class="continue hidden">Continuer ▸</button>
      <button class="skip ghost">Passer</button>
    </div>
    <div class="status"></div>`;
  root.appendChild(panel);

  ui = {
    fab, badge, panel,
    concept: panel.querySelector(".concept"),
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
  };

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

/* ---------- session ---------- */

async function toggle() {
  if (state !== "idle") { teardownSession(); return; }
  const vid = new URL(location.href).searchParams.get("v");
  if (!vid) return;
  state = "building";
  ui.fab.textContent = "⏳ Préparation…";
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
    state = "idle";
    alert(`Socratic : backend injoignable ou erreur.\n${e.message}\nLancez ./scripts/serve_app.sh`);
    return;
  }
  cps = session.checkpoints.map((c) => ({ ...c, status: "pending" }));
  ui.fab.textContent = `✓ Socratic — ${cps.length} checkpoints`;
  ui.fab.classList.add("on");
  video = document.querySelector("video");
  lastTime = video ? video.currentTime : 0;
  state = "watching";
  video.addEventListener("timeupdate", onTime);
}

function teardownSession() {
  stopListening();
  stopSpeaking();
  if (video) video.removeEventListener("timeupdate", onTime);
  ui.panel.classList.add("hidden");
  ui.badge.classList.add("hidden");
  ui.fab.textContent = "🦉 Socratic";
  ui.fab.classList.remove("on");
  session = null; cps = []; currentCp = null; state = "idle";
}

/* ---------- watcher ---------- */

function onTime() {
  if (state !== "watching" || !video) return;
  const ct = video.currentTime;
  if (ct - lastTime > 3) {
    cps.forEach((cp) => {
      if (cp.status === "pending" && cp.t_pause > lastTime && cp.t_pause <= ct) cp.status = "skipped";
    });
  }
  lastTime = ct;
  const next = cps.find((c) => c.status === "pending");
  if (next && ct >= next.t_pause - 3) startCountdown(next);
}

function startCountdown(cp) {
  state = "countdown";
  let n = 3;
  ui.badge.classList.remove("hidden");
  ui.badge.textContent = `Question dans ${n}…`;
  const id = setInterval(() => {
    n -= 1;
    if (n <= 0) { clearInterval(id); ui.badge.classList.add("hidden"); fire(cp); }
    else ui.badge.textContent = `Question dans ${n}…`;
  }, 1000);
}

/* ---------- the loop ---------- */

async function fire(cp) {
  video.pause();
  currentCp = cp;
  cp.status = "active";
  followup = null;
  followupUsed = false;
  resetPanel();
  ui.concept.textContent = cp.concept;
  ui.question.textContent = cp.question;
  ui.panel.dataset.state = "question";
  ui.panel.classList.remove("hidden");
  state = "question";
  try { await playUrl(`${API}/api/tts/question/${session.video_id}/${cp.id}`); }
  catch { await speak(cp.question); }
  startListening();
}

function startListening() {
  if (!micSupported()) { setStatus("Micro indisponible — clavier."); ui.typeInput.focus(); return; }
  state = "listening";
  ui.micDot.classList.remove("hidden");
  ui.doneBtn.classList.remove("hidden");
  setStatus("Je vous écoute…");
  listen(async (blob) => {
    ui.micDot.classList.add("hidden");
    ui.doneBtn.classList.add("hidden");
    setStatus("Transcription…");
    let text = "";
    try {
      const fd = new FormData();
      fd.append("audio", blob, blob.type.includes("mp4") ? "a.m4a" : "a.webm");
      const r = await fetch(`${API}/api/stt`, { method: "POST", body: fd });
      if (r.ok) text = (await r.json()).text.trim();
    } catch { /* fall through */ }
    if (!text) { setStatus("Rien entendu — clavier ?"); ui.typeInput.focus(); return; }
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
  ui.micDot.classList.add("hidden");
  ui.doneBtn.classList.add("hidden");
  ui.typeInput.value = "";
  ui.heard.textContent = `Vous avez dit : ${answer}`;
  ui.heard.classList.remove("hidden");
  setStatus("Évaluation (Gemma 4, local)…");
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
    setStatus("Évaluation impossible — on continue.");
    return setTimeout(() => finishCp("skipped"), 2000);
  }
  handleVerdict(ev, isFu);
}

function renderVerdict(ev, compact) {
  const labels = { pass: "✓ Correct", partial: "~ Partiel", miss: "✗ À revoir" };
  ui.verdict.textContent = labels[ev.verdict] || ev.verdict;
  ui.verdict.className = `verdict ${ev.verdict}`;
  ui.verdict.classList.remove("hidden");
  ui.points.innerHTML = "";
  for (const [point, res] of Object.entries(ev.points || {})) {
    const li = document.createElement("li");
    li.className = res.status;
    const mark = { covered: "✓", partial: "~", missed: "✗" }[res.status] || "•";
    const words = point.split(/\s+/);
    li.textContent = `${mark} ${compact && words.length > 7 ? words.slice(0, 7).join(" ") + "…" : point}`;
    ui.points.appendChild(li);
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
  setStatus("Je reformule…");
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
  currentCp = null;
  followup = null;
  ui.panel.classList.add("hidden");
  state = "watching";
  if (video && verdict !== "replay") video.play();
}

/* ---------- boot + SPA navigation ---------- */

function boot() {
  if (root) return;
  buildOverlay();
}

boot();
window.addEventListener("yt-navigate-finish", () => {
  // Video changed (YouTube is a SPA): drop the session, keep the FAB.
  if (state !== "idle") teardownSession();
});
