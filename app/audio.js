// app/audio.js
// Pure, DOM-free audio quality math for the creator-facing controls: given each
// speaker's measured loudness (RMS of the ORIGINAL uploaded file's decoded
// samples — deterministic, independent of realtime playback), compute per-speaker
// leveling gains that pull quiet and loud tracks toward a common target. Also the
// single source of truth for the simple clarity / noise-reduction filter shapes
// the exporter inserts. No browser APIs here so tests/audio.test.mjs can exercise
// it under plain Node. Classic script — exposed on window.PDC.audio.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // Below this RMS a track is treated as silent: it cannot be meaningfully
  // normalized (dividing by ~0 would explode the gain), so it keeps gain 1 and
  // is excluded from the shared loudness target.
  const SILENCE_FLOOR = 1e-4;

  // Leveling gains are clamped so a very quiet track cannot be boosted into
  // amplified noise and a very loud one cannot be crushed to nothing.
  const GAIN_MIN = 0.1;
  const GAIN_MAX = 4;

  // "Voice clarity": a mild presence boost around the intelligibility band.
  const CLARITY_FILTER = { type: "peaking", frequency: 2500, q: 1, gainDb: 3 };
  // "Reduce background noise": cut low-frequency rumble/hum below speech.
  const NOISE_FILTER = { type: "highpass", frequency: 120 };

  // rmsByKey: { bucket: measuredRms } -> { bucket: gain }. Every non-silent
  // speaker is pulled toward the average non-silent RMS (clamped), so quiet and
  // loud tracks converge: quiet gets gain > 1, loud gets gain < 1. Silent or
  // unmeasurable tracks get gain 1 (leave them untouched rather than guessing).
  function computeLevelingGains(rmsByKey) {
    const source = rmsByKey || {};
    const keys = Object.keys(source);
    const gains = {};
    const audible = keys.filter(function (k) {
      return Number(source[k]) > SILENCE_FLOOR;
    });
    if (!audible.length) {
      keys.forEach(function (k) { gains[k] = 1; });
      return gains;
    }
    const target = audible.reduce(function (sum, k) { return sum + Number(source[k]); }, 0) / audible.length;
    keys.forEach(function (k) {
      const rms = Number(source[k]);
      gains[k] = rms > SILENCE_FLOOR ? Math.min(GAIN_MAX, Math.max(GAIN_MIN, target / rms)) : 1;
    });
    return gains;
  }

  PDC.audio = {
    SILENCE_FLOOR,
    GAIN_MIN,
    GAIN_MAX,
    CLARITY_FILTER,
    NOISE_FILTER,
    computeLevelingGains,
  };
})();
