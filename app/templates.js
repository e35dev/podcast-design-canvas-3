// app/templates.js — reusable custom speaker-layout templates. A template is a
// named set of per-speaker rects (percent of the stage). Custom templates flow
// through the SAME render path as the built-in presets: resolveLayout() returns
// the rects the preview/export already consume, so a saved layout drives the
// live preview and the exported video with no separate code path. Pure data +
// string work, DOM-free, classic script on window.PDC.templates.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  const templates = [];
  let seq = 0;
  const DRAFT_ID = "tpl-draft"; // transient layout shown live while the editor is open
  let draft = null;

  const STORAGE_KEY = "pdc.showTemplates.v1";

  const isTemplate = (id) => typeof id === "string" && id.indexOf("tpl-") === 0;
  const getTemplate = (id) => (id === DRAFT_ID ? draft : templates.find((t) => t.id === id) || null);
  const listTemplates = () => templates.slice();

  function loadFromStorage() {
    try {
      if (!window.localStorage) return false;
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed && parsed.templates) ? parsed.templates : [];
      templates.length = 0;
      items.forEach(function (t) {
        if (!t || typeof t !== "object") return;
        if (!isTemplate(t.id)) return;
        const rects = {};
        Object.keys(t.rects || {}).forEach(function (bucket) {
          rects[bucket] = normalizeRect(t.rects[bucket]);
        });
        templates.push({ id: t.id, name: String(t.name || "Template").trim() || "Template", rects });
      });
      seq = Number(parsed && parsed.seq) || templates.reduce((m, t) => {
        const n = Number(String(t.id).replace(/^tpl-/, ""));
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, 0);
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveToStorage() {
    try {
      if (!window.localStorage) return false;
      const payload = {
        v: 1,
        seq,
        templates: templates.map(function (t) {
          return { id: t.id, name: t.name, rects: t.rects };
        }),
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (e) {
      return false;
    }
  }

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
    saveToStorage();
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

  // Load any persisted templates immediately on module load (best-effort).
  loadFromStorage();

  PDC.templates = {
    isTemplate,
    getTemplate,
    listTemplates,
    saveTemplate,
    resolveLayout,
    normalizeRect,
    setDraft,
    clearDraft,
    DRAFT_ID,
    // Explicit hooks for verifiers/tests and future UX.
    _storageKey: STORAGE_KEY,
    loadFromStorage,
    saveToStorage,
  };
})();
