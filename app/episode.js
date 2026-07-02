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
      // Timed visual moments (title cards / callouts) scheduled over the episode
      // timeline — managed by app/moments.js, kept here so they belong to the
      // episode and survive preset/template switches.
      moments: [],
      audioQuality: {
        leveling: "balanced",
        clarity: "balanced",
        noiseReduction: "balanced",
      },
      visualMoments: [],
      nextMomentId: 1,
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

  const AUDIO_LEVELING = ["off", "balanced", "strong"];
  const AUDIO_CLARITY = ["natural", "balanced", "enhanced"];
  const AUDIO_NOISE_REDUCTION = ["off", "balanced", "strong"];

  function ensureAudioQuality(episode) {
    if (!episode.audioQuality) {
      episode.audioQuality = {
        leveling: "balanced",
        clarity: "balanced",
        noiseReduction: "balanced",
      };
    }
    return episode.audioQuality;
  }

  function setAudioQuality(episode, patch) {
    const next = ensureAudioQuality(episode);
    if (!patch || typeof patch !== "object") return episode;
    if (AUDIO_LEVELING.includes(patch.leveling)) next.leveling = patch.leveling;
    if (AUDIO_CLARITY.includes(patch.clarity)) next.clarity = patch.clarity;
    if (AUDIO_NOISE_REDUCTION.includes(patch.noiseReduction)) next.noiseReduction = patch.noiseReduction;
    return episode;
  }

  function getAudioQuality(episode) {
    const q = ensureAudioQuality(episode);
    return { leveling: q.leveling, clarity: q.clarity, noiseReduction: q.noiseReduction };
  }

  const MOMENT_TYPES = ["title", "callout"];
  const MAX_MOMENT_TEXT = 120;

  function normalizeSecond(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    return Math.max(0, Math.round(n * 100) / 100);
  }

  function ensureMoments(episode) {
    if (!Array.isArray(episode.visualMoments)) episode.visualMoments = [];
    if (!Number.isInteger(episode.nextMomentId) || episode.nextMomentId < 1) {
      const maxId = episode.visualMoments.reduce((m, it) => Math.max(m, Number(it.id) || 0), 0);
      episode.nextMomentId = maxId + 1;
    }
    return episode.visualMoments;
  }

  function normalizeMoment(input) {
    const type = (input && input.type) || "callout";
    const text = String((input && input.text) || "").trim().slice(0, MAX_MOMENT_TEXT);
    const start = normalizeSecond(input && input.start);
    const end = normalizeSecond(input && input.end);
    if (!MOMENT_TYPES.includes(type)) return null;
    if (!text) return null;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end <= start) return null;
    return { type, text, start, end };
  }

  function addVisualMoment(episode, input) {
    const moments = ensureMoments(episode);
    const clean = normalizeMoment(input);
    if (!clean) return null;
    const id = episode.nextMomentId++;
    const next = { id, type: clean.type, text: clean.text, start: clean.start, end: clean.end };
    moments.push(next);
    return { ...next };
  }

  function updateVisualMoment(episode, id, patch) {
    const moments = ensureMoments(episode);
    const idx = moments.findIndex((it) => Number(it.id) === Number(id));
    if (idx < 0) return null;
    const clean = normalizeMoment({ ...moments[idx], ...(patch || {}) });
    if (!clean) return null;
    moments[idx] = { id: moments[idx].id, type: clean.type, text: clean.text, start: clean.start, end: clean.end };
    return { ...moments[idx] };
  }

  function removeVisualMoment(episode, id) {
    const moments = ensureMoments(episode);
    const idx = moments.findIndex((it) => Number(it.id) === Number(id));
    if (idx < 0) return false;
    moments.splice(idx, 1);
    return true;
  }

  function listVisualMoments(episode) {
    return ensureMoments(episode)
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id)
      .map((it) => ({ ...it }));
  }

  function activeVisualMomentsAt(episode, timeSec) {
    const t = Number(timeSec);
    if (!Number.isFinite(t)) return [];
    return listVisualMoments(episode).filter((it) => t >= it.start && t < it.end);
  }

  // Pull a readable handle out of a social/profile URL (last path segment, or a
  // bare @handle, or the domain). Pure string work — no network, no scraping.
  function deriveHandle(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    const at = s.match(/^@([A-Za-z0-9_.\-]+)$/);
    if (at) return at[1];
    s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[?#]/)[0];
    const parts = s.split("/").filter(Boolean);
    const last = parts.length > 1 ? parts[parts.length - 1] : "";
    const handle = (last || "").replace(/^@/, "");
    return handle;
  }

  // The name to display for a speaker: derived from their social link when one
  // is set, otherwise the default bucket label (Host / Guest 1 / Guest 2).
  function speakerName(episode, bucket) {
    const fallback = (PDC.presets.BUCKET_LABELS && PDC.presets.BUCKET_LABELS[bucket]) || bucket;
    return deriveHandle(getSocialLink(episode, bucket)) || fallback;
  }

  // Buckets that currently hold media, in canonical speaker order.
  function assignedBuckets(episode) {
    return SPEAKER_BUCKETS.filter((b) => episode.media[b]);
  }

  // A selectable layout is either a built-in preset or a saved/draft custom
  // template (templates.js loads after this module but is present at call time).
  function layoutExists(id) {
    if (getPreset(id)) return true;
    return !!(PDC.templates && PDC.templates.getTemplate && PDC.templates.getTemplate(id));
  }

  function setPreset(episode, presetId) {
    if (layoutExists(presetId)) episode.presetId = presetId;
    return episode;
  }

  // The product needs at least two speakers and a valid preset before it can
  // compose a meaningful preview. This is the single source of truth for the
  // "ready to preview" state — the UI never invents its own gate.
  const MIN_SPEAKERS = 2;

  function canCompose(episode) {
    return assignedBuckets(episode).length >= MIN_SPEAKERS && layoutExists(episode.presetId);
  }

  function readinessReason(episode) {
    const n = assignedBuckets(episode).length;
    if (n < MIN_SPEAKERS) {
      const need = MIN_SPEAKERS - n;
      return `Add ${need} more speaker video${need === 1 ? "" : "s"} to start the preview.`;
    }
    if (!layoutExists(episode.presetId)) return "Choose a preset layout.";
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
    setAudioQuality,
    getAudioQuality,
    MOMENT_TYPES,
    addVisualMoment,
    updateVisualMoment,
    removeVisualMoment,
    listVisualMoments,
    activeVisualMomentsAt,
    deriveHandle,
    speakerName,
    canCompose,
    readinessReason,
  };
})();
