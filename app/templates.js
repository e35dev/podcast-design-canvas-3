// app/templates.js — reusable custom speaker-layout templates. A template is a
// named set of per-speaker rects (percent of the stage). Custom templates flow
// through the SAME render path as the built-in presets: resolveLayout() returns
// the rects the preview/export already consume, so a saved layout drives the
// live preview and the exported video with no separate code path.
//
// Saved templates persist to localStorage (pdc3.templates.v1) so a creator can
// refresh or start a fresh episode and reuse a named show template with brand
// new uploads. Persisted entries carry ONLY layout data ({ id, name, rects });
// media descriptors, object URLs, and episode state are never serialized, so a
// template can never drag the old episode's uploads into a new one. When
// storage is unavailable (sandboxed/private contexts) templates simply stay
// in-memory for the session. Pure data + string work, DOM-free, classic script
// on window.PDC.templates.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  const STORE_KEY = "pdc3.templates.v1";
  const templates = [];
  let seq = 0;
  const DRAFT_ID = "tpl-draft"; // transient layout shown live while the editor is open
  let draft = null;

  const isTemplate = (id) => typeof id === "string" && id.indexOf("tpl-") === 0;
  const getTemplate = (id) => (id === DRAFT_ID ? draft : templates.find((t) => t.id === id) || null);
  const listTemplates = () => templates.slice();

  function setDraft(rects) {
    draft = { id: DRAFT_ID, name: "Custom (editing)", rects: {} };
    Object.keys(rects || {}).forEach((b) => (draft.rects[b] = normalizeRect(rects[b])));
    return draft;
  }
  function clearDraft() {
    draft = null;
  }

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

  // --- persistence -----------------------------------------------------------
  // The exact serialized shape: id + name + per-bucket {x,y,w,h}. Nothing else
  // (no media, file names, blob/object URLs, or episode fields) ever reaches
  // storage — building the payload field-by-field enforces that structurally.
  function serializeTemplate(t) {
    const rects = {};
    Object.keys(t.rects).forEach((bucket) => {
      const r = t.rects[bucket];
      rects[bucket] = { x: r.x, y: r.y, w: r.w, h: r.h };
    });
    return { id: t.id, name: t.name, rects };
  }

  // Rebuild a trustworthy template from a stored entry; anything malformed,
  // draft-shaped, media-carrying, or without a usable rect is dropped/stripped.
  function sanitizeStored(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.id !== "string" || entry.id.indexOf("tpl-") !== 0 || entry.id === DRAFT_ID) return null;
    const src = entry.rects && typeof entry.rects === "object" ? entry.rects : {};
    const rects = {};
    PDC.presets.SPEAKER_BUCKETS.forEach((bucket) => {
      if (src[bucket] && typeof src[bucket] === "object") rects[bucket] = normalizeRect(src[bucket]);
    });
    if (!Object.keys(rects).length) return null;
    const name = String(entry.name == null ? "" : entry.name).trim();
    return { id: entry.id, name: name || entry.id, rects };
  }

  // localStorage can throw on ACCESS (sandboxed documents) and on use (private
  // mode quotas); every touch is guarded so templates fall back to in-memory
  // and the app never breaks.
  function storageArea() {
    try {
      return window.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function loadStored() {
    try {
      const area = storageArea();
      const raw = area && area.getItem(STORE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(sanitizeStored).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function persist() {
    try {
      const area = storageArea();
      if (area) area.setItem(STORE_KEY, JSON.stringify(templates.map(serializeTemplate)));
    } catch (e) {
      /* storage unavailable — keep this session's templates in-memory */
    }
  }

  // Load previously saved show templates on startup, and continue id numbering
  // after the highest persisted id so new saves never collide with loaded ones.
  loadStored().forEach((t) => templates.push(t));
  seq = templates.reduce((max, t) => {
    const n = parseInt(t.id.slice(4), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  // ---------------------------------------------------------------------------

  // Persist a layout as a named, reusable template; returns the stored template.
  function saveTemplate(name, rects) {
    const id = "tpl-" + ++seq;
    const clean = {};
    Object.keys(rects || {}).forEach((bucket) => {
      clean[bucket] = normalizeRect(rects[bucket]);
    });
    const trimmed = String(name == null ? "" : name).trim();
    const template = { id, name: trimmed || "Custom " + seq, rects: clean };
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

  PDC.templates = { isTemplate, getTemplate, listTemplates, saveTemplate, resolveLayout, normalizeRect, setDraft, clearDraft, DRAFT_ID, STORE_KEY };
})();
