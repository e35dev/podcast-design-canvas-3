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

  // A media element accepts only ONE createMediaElementSource() for its whole
  // lifetime, so we keep a single page-lifetime AudioContext and tap each speaker
  // <video> exactly once, caching the node. This is what lets a creator export
  // the same session more than once without the audio dropping out: earlier code
  // re-tapped (and closed) a fresh context per export, so the second export threw
  // InvalidStateError, skipped every speaker, and produced a silent file.
  let mixCtx = null;
  const speakerTaps = new WeakMap();

  async function ensureMixContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!mixCtx || mixCtx.state === "closed") mixCtx = new AC();
    if (mixCtx.state === "suspended") { try { await mixCtx.resume(); } catch (e) {} }
    return mixCtx;
  }

  // Cached {source, gain} tap for a video, created once. We tap the decoded element
  // audio via createMediaElementSource (repeatable-safe because it is cached, not
  // re-created per export). A muted element feeds silence into the tap, so the
  // caller unmutes each tapped element for the duration of the capture.
  function tapSpeaker(video, ctx) {
    let tap = speakerTaps.get(video);
    if (tap) return tap;
    try {
      const source = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      source.connect(gain);
      tap = { source, gain };
      speakerTaps.set(video, tap);
    } catch (e) {
      tap = null; // already tapped elsewhere; nothing else we can do for it
    }
    return tap;
  }

  // Mix every speaker's audio into one fresh track set for this export, reusing
  // each element's cached tap and rewiring its gain to this export's destination.
  async function mixSpeakerAudio(vids) {
    const ctx = await ensureMixContext();
    if (!ctx || !vids.length) return { tracks: [], connectedCount: 0, cleanup: function () {} };
    const dest = ctx.createMediaStreamDestination();
    const gainValue = 1 / Math.max(1, vids.length);
    let connected = 0;
    const connectedTaps = [];
    for (const v of vids) {
      const tap = tapSpeaker(v, ctx);
      if (!tap) continue;
      tap.gain.gain.value = gainValue;
      try { tap.gain.disconnect(); } catch (e) {}
      tap.gain.connect(dest);
      connectedTaps.push(tap);
      connected++;
    }
    if (!connected) {
      dest.stream.getTracks().forEach(function (track) { track.stop(); });
      return { tracks: [], connectedCount: 0, cleanup: function () {} };
    }
    return {
      tracks: dest.stream.getAudioTracks(),
      connectedCount: connected,
      cleanup: function () {
        connectedTaps.forEach(function (tap) {
          try { tap.gain.disconnect(); } catch (e) {}
        });
        dest.stream.getTracks().forEach(function (track) { track.stop(); });
      },
    };
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

    // Mix each speaker's audio into one track. The tap is created once per element
    // and reused, so a second export in the same session still carries audio.
    const mixedAudio = await mixSpeakerAudio(vids);
    const audioTracks = mixedAudio.tracks;
    if (vids.length && (!audioTracks.length || mixedAudio.connectedCount !== vids.length)) {
      mixedAudio.cleanup();
      throw new Error("Every speaker's audio must be captured before export can finish.");
    }

    // A muted <video> feeds SILENCE into its Web Audio tap, and the preview keeps
    // its speakers muted, so unmute the tapped speakers just for the capture. Each
    // tapped element is rerouted through the audio graph (createMediaElementSource),
    // so unmuting does NOT play it through the speakers — it only lets real samples
    // reach the recorded mix. The prior muted state is restored right after.
    const restoreMuted = [];
    if (audioTracks.length) {
      for (const v of vids) {
        if (speakerTaps.has(v)) { restoreMuted.push([v, v.muted]); v.muted = false; }
      }
    }

    let combined = null;
    let recorder = null;
    try {
      const canvasStream = canvasEl.captureStream(fps);
      combined = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
      const mimeType = pickMimeType();
      const chunks = [];
      recorder = new MediaRecorder(combined, { mimeType });
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

      const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
      const url = URL.createObjectURL(blob);
      return { blob, url, bytes: blob.size, mimeType, seconds: recordSeconds };
    } finally {
      // Restore each speaker's prior muted state even if recording fails.
      for (const [v, wasMuted] of restoreMuted) { v.muted = wasMuted; }
      if (recorder && recorder.state !== "inactive") { try { recorder.stop(); } catch (e) {} }
      if (combined) combined.getTracks().forEach(function (track) { track.stop(); });
      mixedAudio.cleanup();
      // NOTE: mixCtx is page-lifetime and intentionally NOT closed here — closing it
      // would orphan the cached speaker taps and silence every subsequent export.
    }
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
