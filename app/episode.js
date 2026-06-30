// app/episode.js
// Pure, DOM-free episode model: which uploaded file is assigned to which speaker
// bucket, which preset/template is selected, and how custom speaker-frame
// positions are stored. Kept free of browser APIs so it can be unit-tested
// under plain Node (tests/episode.test.mjs) and reused by the UI.
// Classic script — exposed on window.PDC.episode.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { SPEAKER_BUCKETS, DEFAULT_PRESET_ID, getPreset } = PDC.presets;

  const TEMPLATE_NAME_MAX = 64;

  function clamp(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function sanitizeTemplateName(name) {
    return String(name || "").trim().slice(0, TEMPLATE_NAME_MAX);
  }

  function slugFromName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 24) || "template";
  }

  function normalizeRect(rect) {
    const x = clamp(rect && rect.x, 0, 100);
    const y = clamp(rect && rect.y, 0, 100);
    const maxW = Math.max(3, 100 - x);
    const maxH = Math.max(3, 100 - y);
    return {
      x,
      y,
      w: clamp(rect && rect.w, 3, maxW),
      h: clamp(rect && rect.h, 3, maxH),
    };
  }

  function asBucketRects(layout, buckets) {
    const out = {};
    if (!Array.isArray(layout) || !buckets.length) return out;

    const canonicalLayout = layout.map((rect, i) => normalizeRect(rect));
    buckets.forEach(function (bucket, i) {
      out[bucket] = canonicalLayout[i] || canonicalLayout[canonicalLayout.length - 1] || { x: 0, y: 0, w: 100, h: 100 };
    });
    return out;
  }

  function getEpisodeTemplates(episode) {
    if (!Array.isArray(episode.templates)) episode.templates = [];
    return episode.templates;
  }

  function templateForId(episode, templateId) {
    const target = String(templateId || "").trim();
    return getEpisodeTemplates(episode).find((template) => template.id === target) || null;
  }

  function makeTemplateId(episode, name) {
    const existing = getEpisodeTemplates(episode);
    const base = slugFromName(name) + "-" + String(existing.length + 1);
    return base;
  }

  function fallbackTemplateForEpisode(episode, buckets) {
    const preset = getPreset(episode.presetId) || PDC.presets.PRESETS[0];
    return {
      kind: "preset",
      id: preset.id,
      name: preset.name,
      rects: asBucketRects(preset.layout(buckets.length), buckets),
    };
  }

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
      activeLayoutMode: "preset",
      activeTemplateId: null,
      draftLayout: null,
      templates: [],
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

  function setPreset(episode, presetId) {
    if (getPreset(presetId)) episode.presetId = presetId;
    episode.activeTemplateId = null;
    episode.activeLayoutMode = "preset";
    episode.draftLayout = null;
    return episode;
  }

  // Save a layout as a reusable template with per-speaker rectangles in
  // percentage space. The template is selected immediately after save.
  function saveTemplate(episode, name, rectByBucket) {
    const safeName = sanitizeTemplateName(name);
    if (!safeName) return null;

    const buckets = assignedBuckets(episode);
    if (!buckets.length) return null;

    const fallback = fallbackTemplateForEpisode(episode, buckets);
    const rects = {};
    buckets.forEach(function (bucket) {
      rects[bucket] = normalizeRect((rectByBucket && rectByBucket[bucket]) || fallback.rects[bucket]);
    });

    const template = {
      id: makeTemplateId(episode, safeName),
      name: safeName,
      rects,
      createdAt: Date.now(),
    };

    const bucketList = getEpisodeTemplates(episode);
    bucketList.push(template);
    episode.activeTemplateId = template.id;
    episode.activeLayoutMode = "template";
    episode.draftLayout = null;

    return template;
  }

  function getActiveLayout(episode) {
    const buckets = assignedBuckets(episode);
    if (!buckets.length) return null;

    if (episode && episode.draftLayout) {
      return {
        kind: "draft",
        id: "draft",
        name: "Draft",
        rects: (function () {
          const rects = {};
          buckets.forEach(function (bucket) {
            rects[bucket] = normalizeRect(episode.draftLayout[bucket] || { x: 0, y: 0, w: 100, h: 100 });
          });
          return rects;
        })(),
      };
    }

    const activeTemplate = templateForId(episode, episode.activeTemplateId);
    if (episode.activeLayoutMode === "template" && activeTemplate) {
      return {
        kind: "template",
        id: activeTemplate.id,
        name: activeTemplate.name,
        rects: activeTemplate.rects,
      };
    }

    return fallbackTemplateForEpisode(episode, buckets);
  }

  function applyTemplate(episode, templateId) {
    const template = templateForId(episode, templateId);
    if (!template) return false;
    episode.activeTemplateId = template.id;
    episode.activeLayoutMode = "template";
    episode.draftLayout = null;
    return true;
  }

  function listTemplates(episode) {
    return getEpisodeTemplates(episode).map((template) => ({
      id: template.id,
      name: template.name,
    }));
  }

  function getTemplate(episode, templateId) {
    return templateForId(episode, templateId);
  }

  function setDraftLayout(episode, rectByBucket) {
    const buckets = assignedBuckets(episode);
    if (!buckets.length) {
      episode.draftLayout = null;
      return episode;
    }

    const fallback = fallbackTemplateForEpisode(episode, buckets);
    const next = {};
    buckets.forEach(function (bucket) {
      next[bucket] = normalizeRect((rectByBucket && rectByBucket[bucket]) || fallback.rects[bucket]);
    });
    episode.draftLayout = next;
    episode.activeLayoutMode = "draft";
    return episode;
  }

  function clearDraftLayout(episode) {
    episode.draftLayout = null;
    episode.activeLayoutMode = episode.activeTemplateId ? "template" : "preset";
    return episode;
  }

  // The product needs at least two speakers and a valid preset before it can
  // compose a meaningful preview. This is the single source of truth for the
  // "ready to preview" state — the UI never invents its own gate.
  const MIN_SPEAKERS = 2;

  function canCompose(episode) {
    return assignedBuckets(episode).length >= MIN_SPEAKERS && !!getActiveLayout(episode);
  }

  function readinessReason(episode) {
    const n = assignedBuckets(episode).length;
    if (n < MIN_SPEAKERS) {
      const need = MIN_SPEAKERS - n;
      return `Add ${need} more speaker video${need === 1 ? "" : "s"} to start the preview.`;
    }
    if (!getActiveLayout(episode)) return "Choose a preset or apply a template.";
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
    canCompose,
    readinessReason,
    getActiveLayout,
    setDraftLayout,
    clearDraftLayout,
    saveTemplate,
    applyTemplate,
    listTemplates,
    getTemplate,
  };
})();
