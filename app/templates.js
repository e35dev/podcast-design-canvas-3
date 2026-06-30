// app/templates.js
// Named show templates: saved speaker-frame layouts (percent rects per bucket).
// Pure model + in-memory store — no DOM. Used by the layout editor, preview,
// and export through app/layout.js and app/episode.js.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { SPEAKER_BUCKETS } = PDC.presets;

  const MIN_SIZE = 8;
  const store = new Map();
  let seq = 0;

  function clampRect(rect) {
    let x = Number(rect.x) || 0;
    let y = Number(rect.y) || 0;
    let w = Number(rect.w) || MIN_SIZE;
    let h = Number(rect.h) || MIN_SIZE;
    w = Math.max(MIN_SIZE, Math.min(100, w));
    h = Math.max(MIN_SIZE, Math.min(100, h));
    x = Math.max(0, Math.min(100 - w, x));
    y = Math.max(0, Math.min(100 - h, y));
    return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, w: Math.round(w * 1000) / 1000, h: Math.round(h * 1000) / 1000 };
  }

  function sanitizeRects(rectsByBucket) {
    const out = {};
    SPEAKER_BUCKETS.forEach(function (bucket) {
      if (rectsByBucket && rectsByBucket[bucket]) out[bucket] = clampRect(rectsByBucket[bucket]);
    });
    return out;
  }

  function slugId(name) {
    const base = String(name || "template")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    seq += 1;
    return (base || "template") + "-" + seq;
  }

  function createTemplate(name, rectsByBucket) {
    const trimmed = String(name || "").trim();
    if (!trimmed) throw new Error("Template name is required.");
    const rects = sanitizeRects(rectsByBucket);
    if (!Object.keys(rects).length) throw new Error("Template needs at least one speaker frame.");
    const template = { id: slugId(trimmed), name: trimmed, rects: rects };
    store.set(template.id, template);
    return template;
  }

  function getTemplate(id) {
    return store.get(id) || null;
  }

  function listTemplates() {
    return Array.from(store.values());
  }

  function updateTemplate(id, rectsByBucket) {
    const existing = store.get(id);
    if (!existing) return null;
    existing.rects = sanitizeRects(rectsByBucket);
    return existing;
  }

  function rectsForBuckets(templateId, buckets) {
    const template = getTemplate(templateId);
    if (!template || !buckets.length) return null;
    return buckets.map(function (bucket) {
      return template.rects[bucket] ? clampRect(template.rects[bucket]) : null;
    });
  }

  function hasCompleteLayout(templateId, buckets) {
    const rects = rectsForBuckets(templateId, buckets);
    return !!rects && rects.length === buckets.length && rects.every(function (r) {
      return r && r.w >= MIN_SIZE && r.h >= MIN_SIZE;
    });
  }

  function resetStore() {
    store.clear();
    seq = 0;
  }

  PDC.templates = {
    MIN_SIZE,
    createTemplate,
    getTemplate,
    listTemplates,
    updateTemplate,
    rectsForBuckets,
    hasCompleteLayout,
    clampRect,
    sanitizeRects,
    resetStore,
  };
})();
