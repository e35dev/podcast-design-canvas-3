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

  // bucket -> original uploaded File. Leveling measures loudness from these
  // ORIGINAL bytes (arrayBuffer -> decodeAudioData -> sample RMS), which is
  // deterministic and independent of realtime playback state — the same upload
  // always measures the same, however many exports or preset switches happen.
  const speakerFiles = {};
  const fileRmsCache = new WeakMap(); // File -> Promise<number>, decode once per upload

  function registerSpeakerFile(bucket, file) {
    speakerFiles[bucket] = file;
  }

  function measureFileRms(file, ctx) {
    let cached = fileRmsCache.get(file);
    if (cached) return cached;
    cached = (async function () {
      const buf = await file.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      let sum = 0;
      let count = 0;
      // The whole clip up to 30s per channel is plenty to characterize loudness.
      const limit = Math.min(decoded.length, decoded.sampleRate * 30);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch);
        for (let i = 0; i < limit; i++) sum += data[i] * data[i];
        count += limit;
      }
      return count ? Math.sqrt(sum / count) : 0;
    })().catch(function () {
      return 0; // undecodable audio measures as silent -> leveling leaves it at gain 1
    });
    fileRmsCache.set(file, cached);
    return cached;
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
  // each element's cached tap and rewiring it to this export's destination
  // through the episode's audio quality settings: per-speaker LEVELING gains
  // (measured from the original uploaded bytes) plus optional clarity /
  // noise-reduction filters. The settings live on the episode, so the graph is
  // re-applied from them on EVERY export — preset switches and repeated exports
  // keep the same choices without re-uploading.
  async function mixSpeakerAudio(vids, settings) {
    settings = settings || {};
    const none = { tracks: [], connectedCount: 0, applied: null, cleanup: function () {} };
    const ctx = await ensureMixContext();
    if (!ctx || !vids.length) return none;

    const levelingOn = settings.leveling === true;
    let levelGains = {};
    if (levelingOn && PDC.audio) {
      const rmsByBucket = {};
      for (const v of vids) {
        const bucket = v.dataset.speaker;
        const file = speakerFiles[bucket];
        rmsByBucket[bucket] = file ? await measureFileRms(file, ctx) : 0;
      }
      levelGains = PDC.audio.computeLevelingGains(rmsByBucket);
    }

    const dest = ctx.createMediaStreamDestination();
    const share = 1 / Math.max(1, vids.length);
    let connected = 0;
    const connectedTaps = [];
    const filterNodes = [];
    for (const v of vids) {
      const tap = tapSpeaker(v, ctx);
      if (!tap) continue;
      const bucket = v.dataset.speaker;
      const level = levelingOn && levelGains[bucket] ? levelGains[bucket] : 1;
      tap.gain.gain.value = share * level;
      try { tap.gain.disconnect(); } catch (e) {}
      let node = tap.gain;
      if (settings.noiseReduction === "on" && PDC.audio) {
        const spec = PDC.audio.NOISE_FILTER;
        const hp = ctx.createBiquadFilter();
        hp.type = spec.type;
        hp.frequency.value = spec.frequency;
        node.connect(hp);
        filterNodes.push(hp);
        node = hp;
      }
      if (settings.clarity === "on" && PDC.audio) {
        const spec = PDC.audio.CLARITY_FILTER;
        const peak = ctx.createBiquadFilter();
        peak.type = spec.type;
        peak.frequency.value = spec.frequency;
        peak.Q.value = spec.q;
        peak.gain.value = spec.gainDb;
        node.connect(peak);
        filterNodes.push(peak);
        node = peak;
      }
      node.connect(dest);
      connectedTaps.push(tap);
      connected++;
    }
    if (!connected) {
      dest.stream.getTracks().forEach(function (track) { track.stop(); });
      return none;
    }
    return {
      tracks: dest.stream.getAudioTracks(),
      connectedCount: connected,
      // What this export's audio graph actually applied — surfaced on the
      // export result so the selected settings are visible with the artifact.
      applied: {
        leveling: levelingOn,
        levelingGains: levelGains,
        clarity: settings.clarity === "on" ? "on" : "off",
        noiseReduction: settings.noiseReduction === "on" ? "on" : "off",
      },
      cleanup: function () {
        connectedTaps.forEach(function (tap) {
          try { tap.gain.disconnect(); } catch (e) {}
        });
        filterNodes.forEach(function (nodeToDrop) {
          try { nodeToDrop.disconnect(); } catch (e) {}
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

    // Mix each speaker's audio into one track, shaped by the episode's audio
    // quality settings (opts.audioSettings). The tap is created once per element
    // and reused, so a second export in the same session still carries audio.
    const mixedAudio = await mixSpeakerAudio(vids, opts.audioSettings);
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
      return { blob, url, bytes: blob.size, mimeType, seconds: recordSeconds, audio: mixedAudio.applied };
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

  PDC.exporter = { exportEpisode, download, pickMimeType, registerSpeakerFile };
})();
