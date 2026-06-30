// app/episode.js
// Pure, DOM-free episode model: which uploaded file is assigned to which speaker
// bucket, and which preset is selected. Kept free of browser APIs so it can be
// unit-tested under plain Node (tests/episode.test.mjs) and reused by the UI.
// Classic script — exposed on window.PDC.episode.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { SPEAKER_BUCKETS, DEFAULT_PRESET_ID, getPreset } = PDC.presets;

  function createEpisode(init) {
    return {
      title: (init && init.title) || "Untitled episode",
      // bucket -> { name, size, type } media descriptor (no bytes here; the UI
      // keeps the live <video> element + object URL alongside this model).
      media: {},
      // bucket -> social/profile URL string entered during setup, kept per
      // speaker so later steps can derive names/topics/references from it.
      socialLinks: {},
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

  // Removing a speaker drops that bucket's media AND its own social link, but
  // never touches other speakers' links (so removing one speaker can't lose the
  // social context attached to the others).
  function clearMedia(episode, bucket) {
    delete episode.media[bucket];
    if (episode.socialLinks) delete episode.socialLinks[bucket];
    return episode;
  }

  // Store (or clear, when blank) the social/profile link for one speaker bucket.
  function setSocialLink(episode, bucket, url) {
    if (!SPEAKER_BUCKETS.includes(bucket)) return episode;
    if (!episode.socialLinks) episode.socialLinks = {};
    const trimmed = (url || "").trim();
    if (trimmed) episode.socialLinks[bucket] = trimmed;
    else delete episode.socialLinks[bucket];
    return episode;
  }

  function getSocialLink(episode, bucket) {
    return (episode.socialLinks && episode.socialLinks[bucket]) || "";
  }

  // Pull a readable handle out of a social/profile URL (last path segment, or a
  // bare @handle, or the domain). Pure string work — no network, no scraping.
  function deriveHandle(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    const at = s.match(/^@([A-Za-z0-9_.\-]+)$/);
    if (at) return at[1];
    // Allow a plain handle when the creator skips the full URL.
    if (/^[A-Za-z0-9_.\-]+$/.test(s)) return s;
    s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[?#]/)[0].replace(/\/+$/, "");
    const parts = s.split("/").filter(Boolean);
    if (!parts.length) return "";
    // Walk path segments from the end; skip empty/@-only and generic route words.
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i].replace(/^@/, "");
      if (!seg) continue;
      if (/^(in|user|u|profile|channel|c|people|@)$/i.test(seg)) continue;
      if (i === 0 && seg.includes(".")) continue; // domain-only remainder
      return seg;
    }
    return "";
  }

  // Display name for one speaker bucket (derived link handle or bucket label).
  function speakerName(episode, bucket) {
    const fallback = (PDC.presets.BUCKET_LABELS && PDC.presets.BUCKET_LABELS[bucket]) || bucket;
    return deriveHandle(getSocialLink(episode, bucket)) || fallback;
  }

  // Map each speaker bucket to the label the preview should show right now.
  function speakerLabels(episode) {
    const labels = {};
    SPEAKER_BUCKETS.forEach(function (bucket) {
      labels[bucket] = speakerName(episode, bucket);
    });
    return labels;
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
    assignedBuckets,
    setPreset,
    setSocialLink,
    getSocialLink,
    deriveHandle,
    speakerName,
    speakerLabels,
    canCompose,
    readinessReason,
  };
})();
