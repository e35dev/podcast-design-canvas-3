// app/exporter.js — export the composed canvas preview as a real, playable
// video file. The preview already paints the selected preset composition (real
// uploaded frames + speaker labels) onto a <canvas>; we capture THAT canvas
// with MediaRecorder and mix the speakers' audio, so the exported file is
// exactly what the creator sees — no seeded media, no placeholder frames.
// Classic script — exposed on window.PDC.exporter.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  function pickMimeType() {
    const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];
    if (typeof MediaRecorder === "undefined") return "video/webm";
    for (const t of types) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {}
    }
    return "video/webm";
  }

  // The preview keeps its decoding <video> elements tagged with data-speaker.
  function speakerVideos() {
    return [...document.querySelectorAll("video[data-speaker]")].filter(
      (v) => v.src && v.src.indexOf("blob:") === 0,
    );
  }

  // Record the live canvas (and mixed speaker audio) into a downloadable Blob.
  async function exportEpisode(canvasEl, opts) {
    opts = opts || {};
    const fps = opts.fps || 30;
    const vids = speakerVideos();
    const longest = vids.reduce((m, v) => (isFinite(v.duration) && v.duration > m ? v.duration : m), 0);
    // Export the FULL composition: one complete pass of the longest speaker
    // track, so a long-form episode exports in full rather than being truncated.
    // opts.maxSeconds is an explicit override only (not a default cap).
    const recordSeconds = Math.max(1, opts.maxSeconds || longest || 3);

    // Mix the speakers' audio into one track. PDC.audio is the SINGLE owner of
    // every MediaElementSource (a <video> can only be tapped once), so reuse its
    // already-leveled master graph rather than tapping the elements again here.
    let audioTracks = [];
    let audioCtx = null;
    if (PDC.audio && PDC.audio.recordingStream) {
      try {
        await PDC.audio.resume();
        const stream = PDC.audio.recordingStream();
        if (stream) audioTracks = stream.getAudioTracks();
      } catch (e) { audioTracks = []; }
    }
    // Fallback only if the shared mixer is unavailable (e.g. PDC.audio missing).
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!audioTracks.length && AC && vids.length) {
      try {
        audioCtx = new AC();
        if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch (e) {} }
        const dest = audioCtx.createMediaStreamDestination();
        let connected = 0;
        for (const v of vids) {
          try {
            const src = audioCtx.createMediaElementSource(v);
            const gain = audioCtx.createGain();
            gain.gain.value = 1 / Math.max(1, vids.length);
            src.connect(gain).connect(dest);
            connected++;
          } catch (e) { /* a source can only be tapped once; skip if already tapped */ }
        }
        if (connected) audioTracks = dest.stream.getAudioTracks();
      } catch (e) { audioCtx = null; }
    }

    const canvasStream = canvasEl.captureStream(fps);
    const combined = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
    const mimeType = pickMimeType();
    const chunks = [];
    const recorder = new MediaRecorder(combined, { mimeType });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));

    recorder.start(200);
    const started = performance.now();
    const onProgress = opts.onProgress || function () {};
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const elapsed = (performance.now() - started) / 1000;
        onProgress(Math.min(1, elapsed / recordSeconds));
        if (elapsed >= recordSeconds) { clearInterval(timer); resolve(); }
      }, 100);
    });
    try { recorder.requestData(); } catch (e) {}
    recorder.stop();
    await stopped;
    if (audioCtx) { try { await audioCtx.close(); } catch (e) {} }

    const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
    const url = URL.createObjectURL(blob);
    return { blob, url, bytes: blob.size, mimeType, seconds: recordSeconds };
  }

  function download(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "episode.webm";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  PDC.exporter = { exportEpisode, download, pickMimeType };
})();
