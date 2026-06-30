// app/audio.js — shared audio mixer for the preview/export pipeline.
//
// A <video> element can be tapped by createMediaElementSource exactly ONCE in
// the lifetime of the page. Both the live preview (this module) and the exporter
// need the speakers' audio, so this module is the SINGLE owner of every
// MediaElementSource. Each speaker is wired:
//
//   videoEl -> [perSpeakerGain] -> [perSpeakerAnalyser] -> [master gain] -> destination
//
// The exporter taps the SAME master node via a MediaStreamDestination
// (recordingStream), so there is never a second source for the same element.
//
// computeLevelingGains is a DOM-free pure helper, exported on PDC.audio and also
// requireable from Node for unit tests.
(function () {
  // --- Pure, DOM-free leveling math -----------------------------------------
  // Given measured per-bucket RMS levels, return per-bucket gains that normalize
  // the non-silent speakers toward a common target loudness. Silent/zero levels
  // get gain 1 (we cannot amplify silence into a meaningful signal), and every
  // gain is clamped to a sane range so a near-silent track is not blown up.
  function computeLevelingGains(levels, opts) {
    opts = opts || {};
    const minGain = opts.minGain != null ? opts.minGain : 0.1;
    const maxGain = opts.maxGain != null ? opts.maxGain : 4;
    const eps = opts.eps != null ? opts.eps : 1e-4;
    const mode = opts.target || "mean"; // "mean" | "max"

    const buckets = Object.keys(levels || {});
    const active = buckets.filter((b) => Number.isFinite(levels[b]) && levels[b] > eps);

    const gains = {};
    if (!active.length) {
      buckets.forEach((b) => (gains[b] = 1));
      return gains;
    }

    let target;
    if (mode === "max") {
      target = Math.max(...active.map((b) => levels[b]));
    } else {
      target = active.reduce((s, b) => s + levels[b], 0) / active.length;
    }

    buckets.forEach((b) => {
      const lvl = levels[b];
      if (!Number.isFinite(lvl) || lvl <= eps) {
        gains[b] = 1;
        return;
      }
      let g = target / lvl;
      if (!Number.isFinite(g)) g = 1;
      gains[b] = Math.min(maxGain, Math.max(minGain, g));
    });
    return gains;
  }

  // Expose the pure helper to Node (CommonJS unit tests) without touching the DOM.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { computeLevelingGains };
    return;
  }

  // --- Browser mixer (also runs under the tests' window-shim loader) ----------
  // Under the window-shim loader there is no AudioContext, but nothing below
  // touches it until ensureCtx() is called, so defining the API is side-effect
  // free and the pure helper is reachable via PDC.audio.computeLevelingGains.
  const PDC = (window.PDC = window.PDC || {});

  let ctx = null;
  let master = null;
  // bucket -> { source, gain, analyser, el }
  const nodes = Object.create(null);

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    return ctx;
  }

  function attach(bucket, videoEl) {
    if (!videoEl) return null;
    if (!ensureCtx()) return null;

    const existing = nodes[bucket];
    // Re-attaching the SAME element for a bucket is a no-op.
    if (existing && existing.el === videoEl) return existing;
    // A NEW file for this bucket: the old element keeps its (now-detached) source
    // forever, but we can build a fresh chain for the new element below.
    if (existing) {
      try { existing.gain.disconnect(); } catch (e) {}
      try { existing.analyser.disconnect(); } catch (e) {}
      delete nodes[bucket];
    }

    // muted elements feed silence into a MediaElementSource, so unmute. The
    // AudioContext stays suspended until a gesture/applyLeveling resumes it, so
    // this does not violate autoplay policy.
    try { videoEl.muted = false; } catch (e) {}

    let source;
    try {
      source = ctx.createMediaElementSource(videoEl);
    } catch (e) {
      // The element was already tapped (e.g. attached under a different bucket
      // key). We cannot create a second source; skip safely.
      return null;
    }

    const gain = ctx.createGain();
    gain.gain.value = 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(gain).connect(analyser).connect(master);

    const entry = { source, gain, analyser, el: videoEl };
    nodes[bucket] = entry;
    return entry;
  }

  function rms(bucket) {
    const entry = nodes[bucket];
    if (!entry) return 0;
    const buf = new Float32Array(entry.analyser.fftSize);
    entry.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function levels() {
    const out = {};
    for (const bucket of Object.keys(nodes)) out[bucket] = rms(bucket);
    return out;
  }

  function resume() {
    if (!ensureCtx()) return Promise.resolve();
    if (ctx.state === "suspended") {
      try { return ctx.resume(); } catch (e) { return Promise.resolve(); }
    }
    return Promise.resolve();
  }

  function applyLeveling(opts) {
    if (!ensureCtx()) return { before: {}, gains: {}, target: 0 };
    try { ctx.resume(); } catch (e) {}
    const before = levels();
    const gains = computeLevelingGains(before, opts);
    const active = Object.keys(before).filter((b) => before[b] > 1e-4);
    const target = active.length ? active.reduce((s, b) => s + before[b], 0) / active.length : 0;
    for (const bucket of Object.keys(gains)) {
      const entry = nodes[bucket];
      if (entry) {
        try { entry.gain.gain.value = gains[bucket]; } catch (e) {}
      }
    }
    return { before, gains, target };
  }

  // Reuse the leveled graph for export: tap master into a MediaStreamDestination
  // in the SAME context. There is exactly one source owner, so no conflict.
  function recordingStream() {
    if (!ensureCtx()) return null;
    if (!Object.keys(nodes).length) return null;
    const dest = ctx.createMediaStreamDestination();
    master.connect(dest);
    return dest.stream;
  }

  PDC.audio = {
    ensureCtx,
    attach,
    rms,
    levels,
    computeLevelingGains,
    applyLeveling,
    recordingStream,
    resume,
    _nodes: nodes,
  };
})();
