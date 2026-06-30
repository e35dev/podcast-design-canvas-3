// app/episode.js
// Pure, DOM-free episode model: which uploaded file is assigned to which speaker
// bucket, optional social links per speaker, and which preset is selected. Kept
// free of browser APIs so it can be unit-tested under plain Node (tests/episode.test.mjs)
// and reused by the UI. Classic script — exposed on window.PDC.episode.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { SPEAKER_BUCKETS, BUCKET_LABELS, DEFAULT_PRESET_ID, getPreset } = PDC.presets;
  const { displayNameForSocial } = PDC.social;

  function createEpisode(init) {
    const social = {};
    SPEAKER_BUCKETS.forEach(function (b) {
      social[b] = (init && init.social && init.social[b]) || "";
    });
    return {
      title: (init && init.title) || "Untitled episode",
      // bucket -> { name, size, type } media descriptor (no bytes here; the UI
      // keeps the live <video> element + object URL alongside this model).
      media: {},
      social: social,
      presetId: DEFAULT_PRESET_ID,
    };
  }

  // Assign an uploaded file descriptor to a bucket. Returns the episode for
  // chaining. Unknown buckets are ignored so a stray input can't corrupt state.
  function assignMedia(episode, bucket, descriptor) {
    if (!SPEAKER_BUCKETS.includes(bucket)) return episode;
    episode.media[bucket] = descriptor;
    return episode;
  }

  function clearMedia(episode, bucket) {
    delete episode.media[bucket];
    return episode;
  }

  function setSocialLink(episode, bucket, url) {
    if (!SPEAKER_BUCKETS.includes(bucket)) return episode;
    if (!episode.social) episode.social = {};
    episode.social[bucket] = typeof url === "string" ? url.trim() : "";
    return episode;
  }

  function speakerLabel(episode, bucket) {
    const fallback = BUCKET_LABELS[bucket] || bucket;
    const url = episode.social && episode.social[bucket];
    return displayNameForSocial(url, fallback);
  }

  // Buckets that currently hold media, in canonical speaker order.
  function assignedBuckets(episode) {
    return SPEAKER_BUCKETS.filter((b) => episode.media[b]);
  }

  function setPreset(episode, presetId) {
    if (getPreset(presetId)) episode.presetId = presetId;
    return episode;
  }

  // The product needs at least two speakers and a valid preset before it can
  // compose a meaningful preview. This is the single source of truth for the
  // "ready to preview" state — the UI never invents its own gate.
  const MIN_SPEAKERS = 2;

  function canCompose(episode) {
    return assignedBuckets(episode).length >= MIN_SPEAKERS && !!getPreset(episode.presetId);
  }

  function readinessReason(episode) {
    const n = assignedBuckets(episode).length;
    if (n < MIN_SPEAKERS) {
      const need = MIN_SPEAKERS - n;
      return `Add ${need} more speaker video${need === 1 ? "" : "s"} to start the preview.`;
    }
    if (!getPreset(episode.presetId)) return "Choose a preset layout.";
    return "";
  }

  PDC.episode = {
    MIN_SPEAKERS,
    createEpisode,
    assignMedia,
    clearMedia,
    setSocialLink,
    speakerLabel,
    assignedBuckets,
    setPreset,
    canCompose,
    readinessReason,
  };
})();
