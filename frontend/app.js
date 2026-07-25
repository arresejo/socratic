/* app.js — YouTube iframe API + checkpoint watcher + overlay state machine.
 *
 * States: watching → countdown → question → listening → evaluating → feedback
 *         → (followup once | reexplain + replay offer) → watching … → recap
 */

const $ = (sel) => document.querySelector(sel);

const ui = {
  url: $("#url"), intensity: $("#intensity"), build: $("#build"),
  background: $("#background"), status: $("#status"),
  stage: $("#stage"), videoTitle: $("#videoTitle"),
  countdown: $("#countdown"), overlay: $("#overlay"),
  ovConcept: $("#ovConcept"), ovQuestion: $("#ovQuestion"),
  waveform: $("#waveform"), ovHeard: $("#ovHeard"),
  ovResult: $("#ovResult"), ovVerdict: $("#ovVerdict"),
  ovPoints: $("#ovPoints"), ovFeedback: $("#ovFeedback"),
  ovReexplain: $("#ovReexplain"), ovStatus: $("#ovStatus"),
  micDone: $("#micDone"), typeForm: $("#typeForm"), typeInput: $("#typeInput"),
  replayBtn: $("#replayBtn"), continueBtn: $("#continueBtn"), skipBtn: $("#skipBtn"),
  progress: $("#progress"),
  timeline: $("#timeline"), timelineFill: $("#timelineFill"),
  recap: $("#recap"), recapScore: $("#recapScore"),
  recapList: $("#recapList"), recapWeak: $("#recapWeak"), recapLocal: $("#recapLocal"),
};

let player = null;
let session = null;
let cps = [];                 // checkpoints after intensity filter, each with .status
let state = "idle";           // idle|watching|countdown|question|listening|evaluating|feedback|reexplain
let currentCp = null;
let lastTime = 0;
let watcherId = 0;
let countdownId = 0;
let sttRetries = 0;
let followup = null;          // {question, weakPoint} while the follow-up turn is active
let followupUsed = false;
let results = [];             // {cp, verdict} for the session recap

/* ---------- helpers ---------- */

async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

function setStatus(msg) {
  ui.status.classList.toggle("hidden", !msg);
  ui.status.textContent = msg || "";
}

function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
}

/* Intensity: light ≈ 3 cp/h → keep an evenly-spaced subset (SPEC §2.3, §5). */
function applyIntensity(list, intensity) {
  if (intensity !== "light" || list.length <= 2) return list;
  const hours = Math.max(list[list.length - 1].t_pause / 3600, 1 / 3600);
  const target = Math.max(1, Math.round(hours * 3));
  if (list.length <= target) return list;
  const picked = new Set();
  for (let i = 0; i < target; i++) {
    picked.add(Math.round((i * (list.length - 1)) / Math.max(1, target - 1)));
  }
  return [...picked].sort((a, b) => a - b).map((i) => list[i]);
}

function updateProgress() {
  const done = cps.filter((c) => c.status !== "pending" && c.status !== "active").length;
  ui.progress.textContent = `Checkpoints: ${done}/${cps.length}`;
  cps.forEach((cp) => {
    const dot = ui.timeline.querySelector(`[data-cp-id="${cp.id}"]`);
    if (dot) dot.className = `cp-dot ${cp.verdict || cp.status}`;
  });
}

/* Pastilles de checkpoints sur une timeline fine sous le lecteur (la barre
 * YouTube native est inaccessible : iframe cross-origin). */
function renderTimeline() {
  const dur = player && player.getDuration ? player.getDuration() : 0;
  if (!dur) return;
  ui.timeline.querySelectorAll(".cp-dot").forEach((d) => d.remove());
  cps.forEach((cp) => {
    const dot = document.createElement("div");
    dot.className = `cp-dot ${cp.verdict || cp.status}`;
    dot.style.left = `${(cp.t_pause / dur) * 100}%`;
    dot.title = `${Math.floor(cp.t_pause / 60)}:${String(Math.floor(cp.t_pause % 60)).padStart(2, "0")} — ${cp.concept}`;
    dot.dataset.cpId = cp.id;
    ui.timeline.appendChild(dot);
  });
}

/* ---------- session build ---------- */

ui.build.addEventListener("click", buildSession);
ui.background.addEventListener("change", () => {
  api("/api/settings", { background: ui.background.value }).catch(() => {});
});

async function buildSession() {
  const url = ui.url.value.trim();
  if (!url) return;
  ui.build.disabled = true;
  setStatus("Building the session… (transcript + LLM segmentation, can take a few minutes)");

  // Compteur de tokens en direct pendant le build : le "spinner" devient la
  // preuve que Gemma 4 travaille localement (argument Edge, visible).
  let baseline = null;
  try { baseline = await api("/api/stats"); } catch { /* stats optional */ }
  const ticker = baseline && setInterval(async () => {
    try {
      const s = await api("/api/stats");
      const calls = s.calls - baseline.calls;
      const tokens = (s.prompt_tokens + s.completion_tokens)
                   - (baseline.prompt_tokens + baseline.completion_tokens);
      if (calls > 0) {
        setStatus(`Building the session… ${calls} Gemma 4 calls · ` +
          `${tokens.toLocaleString("en-US")} tokens processed on this machine 🔒`);
      }
    } catch { /* transient */ }
  }, 1500);

  try {
    session = await api("/api/session", { url });
  } catch (e) {
    setStatus(`Failed: ${e.message}`);
    ui.build.disabled = false;
    return;
  } finally {
    if (ticker) clearInterval(ticker);
  }
  setStatus("");
  ui.build.disabled = false;

  cps = applyIntensity(session.checkpoints, ui.intensity.value)
    .map((cp) => ({ ...cp, status: "pending" }));
  results = [];
  ui.videoTitle.textContent = session.title || session.video_id;
  ui.stage.classList.remove("hidden");
  ui.recap.classList.add("hidden");
  updateProgress();

  await loadYouTubeAPI();
  if (player) player.destroy();
  player = new YT.Player("player", {
    videoId: session.video_id,
    playerVars: { rel: 0, modestbranding: 1 },
    events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange },
  });
}

function onPlayerReady() {
  lastTime = 0;
  state = "watching";
  renderTimeline();
  clearInterval(watcherId);
  watcherId = setInterval(watch, 250);
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.ENDED) showRecap();
}

/* ---------- checkpoint watcher (poll every 250 ms) ---------- */

function watch() {
  if (!player || typeof player.getCurrentTime !== "function") return;
  const dur = player.getDuration ? player.getDuration() : 0;
  if (dur) {
    if (!ui.timeline.querySelector(".cp-dot")) renderTimeline();
    ui.timelineFill.style.width = `${(player.getCurrentTime() / dur) * 100}%`;
  }
  if (state !== "watching") return;
  const ct = player.getCurrentTime();

  // Manual seek forward: mark jumped-over checkpoints, don't fire retroactively.
  if (ct - lastTime > 3) {
    cps.forEach((cp) => {
      if (cp.status === "pending" && cp.t_pause > lastTime && cp.t_pause <= ct) {
        cp.status = "seek-skipped";
      }
    });
    updateProgress();
  }
  lastTime = ct;

  const next = cps.find((c) => c.status === "pending");
  if (next && ct >= next.t_pause - 3) startCountdown(next);
}

function startCountdown(cp) {
  state = "countdown";
  let n = 3;
  ui.countdown.classList.remove("hidden");
  ui.countdown.textContent = `Question in ${n}…`;
  countdownId = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      clearInterval(countdownId);
      ui.countdown.classList.add("hidden");
      fireCheckpoint(cp);
    } else {
      ui.countdown.textContent = `Question in ${n}…`;
    }
  }, 1000);
}

/* ---------- question / listening ---------- */

async function fireCheckpoint(cp) {
  player.pauseVideo();
  currentCp = cp;
  cp.status = "active";
  followup = null;
  followupUsed = false;
  sttRetries = 0;

  resetOverlay();
  ui.ovConcept.textContent = cp.concept;
  ui.ovQuestion.textContent = cp.question;
  setOverlay("question");
  try {  // audio pré-généré au build → voix instantanée
    await Voice.speakUrl(`/api/tts/question/${session.video_id}/${cp.id}`);
  } catch {
    await Voice.speak(cp.question);
  }
  startListening();
}

function resetOverlay() {
  ui.ovHeard.classList.add("hidden");
  ui.ovResult.classList.add("hidden");
  ui.ovReexplain.classList.add("hidden");
  ui.replayBtn.classList.add("hidden");
  ui.continueBtn.classList.add("hidden");
  ui.waveform.classList.add("hidden");
  ui.micDone.classList.add("hidden");
  ui.typeInput.value = "";
  ui.ovStatus.textContent = "";
}

function setOverlay(s) {
  state = s === "hidden" ? state : s;
  ui.overlay.classList.toggle("hidden", s === "hidden");
  if (s !== "hidden") ui.overlay.dataset.state = s;
}

function startListening() {
  if (!Voice.supported()) {
    ui.ovStatus.textContent = "Mic unavailable — type your answer.";
    ui.typeInput.focus();
    return;
  }
  setOverlay("listening");
  ui.waveform.classList.remove("hidden");
  ui.micDone.classList.remove("hidden");
  ui.ovStatus.textContent = "Listening…";
  Voice.listen({
    canvas: ui.waveform,
    onEnd: submitAudio,
    onError: () => {
      ui.ovStatus.textContent = "Mic access denied — type your answer.";
      ui.typeInput.focus();
    },
  });
}

ui.micDone.addEventListener("click", () => Voice.finish());

ui.typeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ui.typeInput.value.trim();
  if (!text || !currentCp) return;
  Voice.stop();
  submitAnswer(text);
});

async function submitAudio(blob) {
  ui.waveform.classList.add("hidden");
  ui.micDone.classList.add("hidden");
  ui.ovStatus.textContent = "Transcription…";
  const t0 = performance.now();
  let text = "";
  try {
    const fd = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : "webm";
    fd.append("audio", blob, `answer.${ext}`);
    const r = await fetch("/api/stt", { method: "POST", body: fd });
    if (r.ok) text = (await r.json()).text.trim();
  } catch { /* fall through to retry */ }
  lastSttMs = performance.now() - t0;

  if (!text) {
    if (sttRetries < 1) {
      sttRetries += 1;
      ui.ovStatus.textContent = "Didn't catch that…";
      await Voice.speak("I didn't quite catch that — one more time?");
      startListening();
    } else {
      ui.ovStatus.textContent = "Still nothing — type your answer.";
      ui.typeInput.focus();
    }
    return;
  }
  submitAnswer(text);
}

/* ---------- evaluation + pedagogical branches ---------- */

/* Accusés de réception vocaux variés (un « hmm » identique à chaque fois
 * sonne robotique ; au-delà de ~3 s d'attente c'est le visuel qui porte). */
const ACKS = ["Okay…", "Alright…", "Let me see…", "Got it…"];
let lastSttMs = 0;

async function submitAnswer(answer) {
  setOverlay("evaluating");
  ui.waveform.classList.add("hidden");
  ui.micDone.classList.add("hidden");
  ui.typeInput.value = "";
  ui.ovHeard.textContent = answer;
  ui.ovHeard.classList.remove("hidden");
  ui.ovStatus.textContent = "Grading";
  ui.ovStatus.classList.add("thinking");
  Voice.speak(ACKS[Math.floor(Math.random() * ACKS.length)]); // couvre le début de l'attente

  const isFollowup = !!followup;
  const tEval = performance.now();
  let ev;
  try {
    ev = await api("/api/evaluate", {
      video_id: session.video_id,
      checkpoint_id: currentCp.id,
      answer,
      question: isFollowup ? followup.question : null,
      expected_key_points: isFollowup ? [followup.weakPoint] : null,
      is_followup: isFollowup,
    });
  } catch (e) {
    ui.ovStatus.textContent = `Grading failed (${e.message}) — moving on.`;
    return resumeSoon("skipped", 2500);
  }
  const evalMs = performance.now() - tEval;
  handleVerdict(ev, isFollowup, evalMs);
}

/* Raccourcit un critère complet en étiquette de quelques mots : la réponse
 * complète ne doit pas être servie d'un bloc (ça court-circuite le replay). */
function shortLabel(point) {
  const words = point.replace(/\(.*?\)/g, "").trim().split(/\s+/);
  return words.length <= 7 ? point : words.slice(0, 7).join(" ") + "…";
}

function renderResult(ev, { compact = false } = {}) {
  const labels = { pass: "Correct", partial: "Almost there", miss: "Not quite" };
  ui.ovVerdict.textContent = labels[ev.verdict] || ev.verdict;
  ui.ovVerdict.className = ev.verdict;
  ui.ovPoints.innerHTML = "";
  for (const [point, res] of Object.entries(ev.points || {})) {
    const li = document.createElement("li");
    li.className = res.status;
    const mark = { covered: "✓", partial: "~", missed: "✗" }[res.status] || "•";
    li.textContent = `${mark} ${compact ? shortLabel(point) : point}`;
    const evidence = (res.evidence || "").trim();
    if (!compact && evidence && res.status !== "missed" && !/^n\/?a$/i.test(evidence)) {
      const q = document.createElement("span");
      q.className = "evidence";
      q.textContent = ` — « ${evidence} »`;
      li.appendChild(q);
    }
    ui.ovPoints.appendChild(li);
  }
  // Sur un miss, le feedback est dit à voix haute et la ré-explication porte le
  // contenu écrit : pas de double bloc de texte.
  ui.ovFeedback.textContent = ev.verdict === "miss" ? "" : ev.feedback || "";
  ui.ovFeedback.classList.toggle("hidden", ev.verdict === "miss");
  ui.ovResult.classList.remove("hidden");
}

async function handleVerdict(ev, wasFollowup, evalMs = 0) {
  setOverlay("feedback");
  const parts = [];
  if (lastSttMs) parts.push(`STT ${(lastSttMs / 1000).toFixed(1)}s`);
  if (evalMs) parts.push(`Gemma ${(evalMs / 1000).toFixed(1)}s`);
  ui.ovStatus.textContent = parts.length ? `${parts.join(" · ")} — 100 % local` : "";
  lastSttMs = 0;
  ui.ovStatus.classList.remove("thinking");
  renderResult(ev, { compact: ev.verdict === "miss" });

  if (wasFollowup) {
    // Second answer: correct + resume regardless — never loop more than once.
    await Voice.speak(ev.feedback);
    return resumeSoon("partial", 1500);
  }

  if (ev.verdict === "pass") {
    await Voice.speak(ev.feedback);
    return resumeSoon("pass", 2000);
  }

  if (ev.verdict === "partial" && !followupUsed) {
    followupUsed = true;
    const weakPoint =
      Object.entries(ev.points || {}).find(([, r]) => r.status !== "covered")?.[0] ||
      currentCp.expected_key_points[0];
    await Voice.speak(ev.feedback);
    let fq;
    try {
      fq = await api("/api/followup", {
        video_id: session.video_id, checkpoint_id: currentCp.id, weak_point: weakPoint,
      });
    } catch {
      return resumeSoon("partial", 1500);
    }
    followup = { question: fq.question, weakPoint };
    resetOverlay();
    ui.ovConcept.textContent = currentCp.concept;
    ui.ovQuestion.textContent = fq.question;
    setOverlay("question");
    await Voice.speak(fq.question);
    startListening();
    return;
  }

  if (ev.verdict === "partial") {
    await Voice.speak(ev.feedback);
    return resumeSoon("partial", 2000);
  }

  // miss → re-explain differently + offer replay (SPEC §2.5).
  // The reexplain request is fired FIRST so the LLM works while the spoken
  // feedback covers the latency; buttons allow barge-in at any moment.
  const missed = Object.entries(ev.points || {})
    .filter(([, r]) => r.status !== "covered").map(([p]) => p);
  const rxPromise = api("/api/reexplain", {
    video_id: session.video_id, checkpoint_id: currentCp.id, missed_points: missed,
  });
  ui.replayBtn.classList.remove("hidden");
  ui.continueBtn.classList.remove("hidden");
  await Voice.speak(ev.feedback);
  ui.ovStatus.textContent = "Let me rephrase";
  ui.ovStatus.classList.add("thinking");
  let rx;
  try {
    rx = await rxPromise;
  } catch {
    return resumeSoon("miss", 2500);
  }
  if (!currentCp) return; // user already clicked Continuer/Revoir
  setOverlay("reexplain");
  ui.ovStatus.textContent = "";
  ui.ovStatus.classList.remove("thinking");
  ui.ovReexplain.textContent = rx.text;
  ui.ovReexplain.classList.remove("hidden");
  await Voice.speak(rx.text);
}

ui.replayBtn.addEventListener("click", () => {
  Voice.stopSpeaking(); // barge-in: never make the user wait out the audio
  const t = currentCp.t_source_start;
  finishCheckpoint("miss");
  lastTime = t;
  player.seekTo(t, true);
  player.playVideo();
});

ui.continueBtn.addEventListener("click", () => {
  Voice.stopSpeaking();
  finishCheckpoint("miss");
  player.playVideo();
});

ui.skipBtn.addEventListener("click", () => {
  Voice.stop();
  Voice.stopSpeaking();
  api("/api/profile", {
    video_id: session.video_id, checkpoint_id: currentCp.id,
    concept: currentCp.concept, verdict: "skipped", missed: [],
  }).catch(() => {});
  finishCheckpoint("skipped");
  player.playVideo();
});

function resumeSoon(verdict, ms) {
  setTimeout(() => {
    finishCheckpoint(verdict);
    player.playVideo();
  }, ms);
}

function finishCheckpoint(verdict) {
  if (!currentCp) return;
  currentCp.status = "done";
  currentCp.verdict = verdict;
  results.push({ cp: currentCp, verdict });
  currentCp = null;
  followup = null;
  setOverlay("hidden");
  state = "watching";
  updateProgress();
}

/* ---------- recap ---------- */

async function showRecap() {
  clearInterval(watcherId);
  state = "idle";
  const answered = results.filter((r) => r.verdict !== "skipped");
  const passed = answered.filter((r) => r.verdict === "pass").length;
  ui.recapScore.textContent = `You nailed ${passed}/${answered.length} checkpoints.`;
  ui.recapList.innerHTML = "";
  for (const r of results) {
    const li = document.createElement("li");
    li.className = r.verdict;
    li.textContent = `${r.cp.concept} — ${r.verdict}`;
    ui.recapList.appendChild(li);
  }
  try {
    const recap = await api(`/api/recap?video_id=${encodeURIComponent(session.video_id)}`);
    const repeat = (recap.weak_spots || []).filter((w) => w.count >= 2);
    if (repeat.length) {
      ui.recapWeak.textContent =
        "Recurring weak spot: " +
        repeat.map((w) => `${w.point} (${w.count}×)`).join(" · ");
    }
  } catch { /* recap works without history */ }
  try { // l'argument Edge, mesuré : tokens traités localement, privacy
    const s = await api("/api/stats");
    const total = (s.prompt_tokens || 0) + (s.completion_tokens || 0);
    ui.recapLocal.textContent =
      `🔒 ${s.calls} Gemma 4 calls · ${total.toLocaleString("en-US")} tokens — ` +
      `all processed on this machine, and your learning profile never left this disk.`;
  } catch { /* stats optional */ }
  ui.recap.classList.remove("hidden");
  ui.recap.scrollIntoView({ behavior: "smooth" });
}

/* ---------- init ---------- */

api("/api/settings")
  .then((s) => { if (s.background) ui.background.value = s.background; })
  .catch(() => {});
