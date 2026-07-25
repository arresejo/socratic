/* voice.js — mic capture + energy-based end-of-speech + waveform + TTS playback.
 * VAD note: V1 uses an RMS-energy endpointer (silero-vad via backend ws is the
 * upgrade path). A "J'ai fini de parler" button remains as manual fallback. */

window.Voice = (() => {
  let stream = null, ctx = null, analyser = null, recorder = null;
  let chunks = [], raf = 0, aborted = false;

  const pickMime = () =>
    ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
      (t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)
    );

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && pickMime());
  }

  function cleanup() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    stream = null; ctx = null; analyser = null;
  }

  /* Records until 1.4 s of silence after speech started (or maxMs / manual
   * finish), then calls onEnd(blob). */
  async function listen({ canvas, onEnd, onError, maxMs = 60000, silenceMs = 1400 }) {
    stop(); // kill any previous capture
    aborted = false;
    const mime = pickMime();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (onError) onError(e);
      return;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);

    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const wasAborted = aborted;
      cleanup();
      if (!wasAborted) onEnd(new Blob(chunks, { type: mime }));
    };
    recorder.start(250);

    const data = new Float32Array(analyser.fftSize);
    const cctx = canvas ? canvas.getContext("2d") : null;
    let speechStarted = false;
    let lastVoice = performance.now();
    const t0 = performance.now();

    const tick = () => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      if (cctx) drawWave(cctx, canvas, data, speechStarted);
      const now = performance.now();
      if (rms > 0.02) { speechStarted = true; lastVoice = now; }
      if ((speechStarted && now - lastVoice > silenceMs) || now - t0 > maxMs) {
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function drawWave(cctx, canvas, data, active) {
    const { width: w, height: h } = canvas;
    cctx.clearRect(0, 0, w, h);
    cctx.strokeStyle = active ? "#4f8cff" : "#3a4556";
    cctx.lineWidth = 2;
    cctx.beginPath();
    const step = Math.max(1, Math.floor(data.length / w));
    for (let x = 0; x < w; x++) {
      const v = data[x * step] || 0;
      const y = h / 2 + v * h * 1.8;
      x === 0 ? cctx.moveTo(x, y) : cctx.lineTo(x, y);
    }
    cctx.stroke();
  }

  function finish() { // manual or VAD end-of-speech
    if (recorder && recorder.state === "recording") recorder.stop();
  }

  function stop() { // abort without callback
    aborted = true;
    if (recorder && recorder.state === "recording") recorder.stop();
    else cleanup();
    recorder = null;
  }

  let currentAudio = null;

  /* Piper TTS via backend; resolves when playback ends. Silent no-op if TTS
   * is unavailable (503) so the text-only path always works. Any utterance
   * still playing is stopped first — never two voices at once. */
  async function speak(text) {
    if (!text) return;
    try {
      await speakUrl("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch { /* offline TTS missing — degrade to text */ }
  }

  /* Plays a wav served by the backend (e.g. pre-generated question audio). */
  async function speakUrl(url, fetchOpts) {
    stopSpeaking();
    const r = await fetch(url, fetchOpts);
    if (!r.ok) throw new Error(String(r.status));
    const blobUrl = URL.createObjectURL(await r.blob());
    await new Promise((res) => {
      currentAudio = new Audio(blobUrl);
      currentAudio.onended = res;
      currentAudio.onerror = res;
      currentAudio.play().catch(res);
    });
    URL.revokeObjectURL(blobUrl);
  }

  function stopSpeaking() {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  }

  return { supported, listen, finish, stop, speak, speakUrl, stopSpeaking };
})();
