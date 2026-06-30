// app/exporter.js  (browser)
// Real export: capture the live composited canvas as a video track, mix every
// speaker's audio via WebAudio, record the combined stream with MediaRecorder,
// and return a downloadable, playable video Blob from the uploaded media.
// Classic script attaching to the global PDC namespace (works over file://).
(function () {
  const root = typeof window !== "undefined" ? window : globalThis;
  const PDC = root.PDC || (root.PDC = {});

  function pickMimeType() {
    const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];
    if (typeof MediaRecorder === "undefined") return "video/webm";
    for (const t of candidates) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {}
    }
    return "video/webm";
  }

  async function exportEpisode(canvas, plan, videos, optsArg) {
    const opts = optsArg || {};
    const ctx = canvas.getContext("2d");
    const onProgress = opts.onProgress || function () {};
    const maxSeconds = Math.max(0.5, opts.maxSeconds || plan.durationSec || 5);
    const drawComposite = PDC.compositor.drawComposite;

    // Mix all speaker audio tracks into one stream.
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let audioCtx = null;
    const audioTracks = [];
    if (AudioCtx) {
      audioCtx = new AudioCtx();
      if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch (e) {} }
      const dest = audioCtx.createMediaStreamDestination();
      for (const bucket of plan.audioBuckets) {
        const v = videos[bucket];
        if (!v) continue;
        try {
          const src = audioCtx.createMediaElementSource(v);
          const gain = audioCtx.createGain();
          gain.gain.value = 1 / Math.max(1, plan.audioBuckets.length);
          src.connect(gain).connect(dest);
        } catch (e) { /* no audio track or already connected — skip */ }
      }
      audioTracks.push(...dest.stream.getAudioTracks());
    }

    const canvasStream = canvas.captureStream(plan.fps);
    const combined = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
    const mimeType = pickMimeType();
    const chunks = [];
    const recorder = new MediaRecorder(combined, { mimeType });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const started = performance.now();
    const done = new Promise((resolve) => (recorder.onstop = resolve));

    for (const bucket of plan.audioBuckets) {
      const v = videos[bucket];
      if (!v) continue;
      try { v.currentTime = 0; } catch (e) {}
      v.muted = false;
      try { await v.play(); } catch (e) {}
    }

    recorder.start(250);

    // A fixed-interval draw (NOT requestAnimationFrame, which is throttled/paused
    // headless or backgrounded) keeps the canvas updating so captureStream always
    // has fresh frames and the recording is never empty.
    await new Promise((resolve) => {
      const frameMs = Math.max(10, Math.round(1000 / plan.fps));
      const timer = setInterval(() => {
        const elapsed = (performance.now() - started) / 1000;
        drawComposite(ctx, plan, videos, { title: opts.title });
        onProgress(Math.min(1, elapsed / maxSeconds));
        const allEnded = plan.audioBuckets.every((b) => !videos[b] || videos[b].ended);
        if (elapsed >= maxSeconds || allEnded) { clearInterval(timer); resolve(); }
      }, frameMs);
    });

    try { recorder.requestData(); } catch (e) {}
    recorder.stop();
    await done;
    for (const b of plan.audioBuckets) { const v = videos[b]; if (v) { try { v.pause(); } catch (e) {} } }
    if (audioCtx) { try { await audioCtx.close(); } catch (e) {} }

    const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
    const url = URL.createObjectURL(blob);
    return { blob, url, mimeType, durationMs: performance.now() - started, bytes: blob.size };
  }

  function downloadBlob(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "episode.webm";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  PDC.exporter = { pickMimeType, exportEpisode, downloadBlob };
})();
