// app/episode.js
// Pure, DOM-free episode model: which uploaded file is assigned to which speaker
// bucket, which preset or saved template is active, and social links. Kept free
// of browser APIs so it can be unit-tested under plain Node (tests/episode.test.mjs)
// and reused by the UI. Classic script — exposed on window.PDC.episode.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { SPEAKER_BUCKETS, DEFAULT_PRESET_ID, getPreset } = PDC.presets;

  function createEpisode(init) {
    return {
      title: (init && init.title) || "Untitled episode",
      media: {},
      socialLinks: {},
      presetId: DEFAULT_PRESET_ID,
      layoutSource: "preset",
      templateId: null,
    };
  }

  function assignMedia(episode, bucket, descriptor) {
    if (!SPEAKER_BUCKETS.includes(bucket)) return episode;
    episode.media[bucket] = descriptor;
    return episode;
  }

  function clearMedia(episode, bucket) {
    delete episode.media[bucket];
    if (episode.socialLinks) delete episode.socialLinks[bucket];
    return episode;
  }

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

  function deriveHandle(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    const at = s.match(/^@([A-Za-z0-9_.\-]+)$/);
    if (at) return at[1];
    s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[?#]/)[0].replace(/\/+$/, "");
    const parts = s.split("/").filter(Boolean);
    if (!parts.length) return "";
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i].replace(/^@/, "");
      if (!seg) continue;
      if (/^(in|user|u|profile|channel|c|people)$/i.test(seg)) continue;
      if (i === 0 && seg.includes(".")) continue;
      return seg;
    }
    return "";
  }

  function speakerName(episode, bucket) {
    const fallback = (PDC.presets.BUCKET_LABELS && PDC.presets.BUCKET_LABELS[bucket]) || bucket;
    return deriveHandle(getSocialLink(episode, bucket)) || fallback;
  }

  function assignedBuckets(episode) {
    return SPEAKER_BUCKETS.filter((b) => episode.media[b]);
  }

  function setPreset(episode, presetId) {
    if (getPreset(presetId)) {
      episode.presetId = presetId;
      episode.layoutSource = "preset";
      episode.templateId = null;
    }
    return episode;
  }

  function applyTemplate(episode, templateId) {
    if (!PDC.templates.getTemplate(templateId)) return episode;
    episode.templateId = templateId;
    episode.layoutSource = "template";
    return episode;
  }

  function layoutName(episode) {
    if (episode.layoutSource === "template" && episode.templateId) {
      const t = PDC.templates.getTemplate(episode.templateId);
      if (t) return t.name;
    }
    const preset = getPreset(episode.presetId);
    return preset ? preset.name : "";
  }

  function hasActiveLayout(episode) {
    const buckets = assignedBuckets(episode);
    if (episode.layoutSource === "template" && episode.templateId) {
      return PDC.templates.hasCompleteLayout(episode.templateId, buckets);
    }
    return !!getPreset(episode.presetId);
  }

  const MIN_SPEAKERS = 2;

  function canCompose(episode) {
    return assignedBuckets(episode).length >= MIN_SPEAKERS && hasActiveLayout(episode);
  }

  function readinessReason(episode) {
    const n = assignedBuckets(episode).length;
    if (n < MIN_SPEAKERS) {
      const need = MIN_SPEAKERS - n;
      return `Add ${need} more speaker video${need === 1 ? "" : "s"} to start the preview.`;
    }
    if (!hasActiveLayout(episode)) {
      if (episode.layoutSource === "template") return "Choose a saved layout template.";
      return "Choose a preset layout.";
    }
    return "";
  }

  PDC.episode = {
    MIN_SPEAKERS,
    createEpisode,
    assignMedia,
    clearMedia,
    assignedBuckets,
    setPreset,
    applyTemplate,
    layoutName,
    setSocialLink,
    getSocialLink,
    deriveHandle,
    speakerName,
    canCompose,
    readinessReason,
  };
})();
