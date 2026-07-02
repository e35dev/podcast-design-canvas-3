// app/templates.js — reusable custom speaker-layout templates. A template is a
// named set of per-speaker rects (percent of the stage). Custom templates flow
// through the SAME render path as the built-in presets: resolveLayout() returns
// the rects the preview/export already consume, so a saved layout drives the
// live preview and the exported video with no separate code path.
//
// Templates are the one piece of episode setup meant to outlive a single
// episode, so they're persisted to localStorage (not just kept in memory):
// saving a template survives a page refresh or a brand-new episode, while the
// uploaded media that was on screen when it was saved never does — only the
// rects (percent-of-stage geometry) are stored, never file data.
// DOM-free aside from the storage read/write, classic script on window.PDC.templates.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const STORAGE_KEY = "pdc.templates.v1";

  const clampPos = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  const clampSize = (v) => Math.max(8, Math.min(100, Number(v) || 8));

  function normalizeRect(r) {
    r = r || {};
    let w = clampSize(r.w);
    let h = clampSize(r.h);
    let x = clampPos(r.x);
    let y = clampPos(r.y);
    if (x + w > 100) x = 100 - w;
    if (y + h > 100) y = 100 - h;
    return { x, y, w, h };
  }

  function normalizeRects(rects) {
    const clean = {};
    Object.keys(rects || {}).forEach((bucket) => {
      clean[bucket] = normalizeRect(rects[bucket]);
    });
    return clean;
  }

  // Best-effort read of whatever was saved last session. A missing/unavailable
  // store (private browsing, disabled storage, first run) or corrupt JSON just
  // means an empty template list — never a crash.
  function loadPersisted() {
    try {
      const store = window.localStorage;
      const raw = store && store.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((t) => t && typeof t.id === "string" && typeof t.name === "string" && t.rects && typeof t.rects === "object")
        .map((t) => ({ id: t.id, name: t.name, rects: normalizeRects(t.rects) }));
    } catch (e) {
      return [];
    }
  }

  function persist() {
    try {
      const store = window.localStorage;
      if (store) store.setItem(STORAGE_KEY, JSON.stringify(templates));
    } catch (e) {
      /* storage unavailable or full — template still works for this session */
    }
  }

  const templates = loadPersisted();
  // Resume the id sequence above the highest persisted id so a freshly loaded
  // session can never mint an id that collides with a saved template.
  let seq = templates.reduce((max, t) => {
    const n = parseInt(String(t.id).slice(4), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  const DRAFT_ID = "tpl-draft"; // transient layout shown live while the editor is open
  let draft = null;

  const isTemplate = (id) => typeof id === "string" && id.indexOf("tpl-") === 0;
  const getTemplate = (id) => (id === DRAFT_ID ? draft : templates.find((t) => t.id === id) || null);
  const listTemplates = () => templates.slice();

  function setDraft(rects) {
    draft = { id: DRAFT_ID, name: "Custom (editing)", rects: normalizeRects(rects) };
    return draft;
  }
  function clearDraft() {
    draft = null;
  }

  // Persist a layout as a named, reusable template; returns the stored template.
  // Only geometry is stored — never the media that happened to be loaded when
  // the creator saved it — so the template is safe to reuse in any future episode.
  function saveTemplate(name, rects) {
    const id = "tpl-" + ++seq;
    const trimmed = String(name == null ? "" : name).trim();
    const template = { id, name: trimmed || "Custom " + seq, rects: normalizeRects(rects) };
    templates.push(template);
    persist();
    return template;
  }

  // The rects (one per assigned speaker, in canonical bucket order) for whatever
  // layout the episode currently selects — a custom template or a built-in preset.
  function resolveLayout(episode, n) {
    const buckets = PDC.presets.SPEAKER_BUCKETS.slice(0, Math.max(1, n));
    const id = episode && episode.presetId;
    if (isTemplate(id)) {
      const t = getTemplate(id);
      if (t) {
        const fallback = (PDC.presets.PRESETS[0].layout(n)) || [];
        return buckets.map((b, i) => t.rects[b] || fallback[i] || { x: 0, y: 0, w: 100, h: 100 });
      }
    }
    const preset = PDC.presets.getPreset(id) || PDC.presets.PRESETS[0];
    return preset.layout(n);
  }

  PDC.templates = { isTemplate, getTemplate, listTemplates, saveTemplate, resolveLayout, normalizeRect, setDraft, clearDraft, DRAFT_ID };
})();
