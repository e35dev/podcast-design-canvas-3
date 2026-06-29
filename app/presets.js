// app/presets.js — DOM-free preset model.
// A preset bundles a LAYOUT (how speaker frames are arranged) and a PACING
// (cut rhythm hint for the edit). composeLayout() turns a preset + speaker
// count into normalized frame rectangles (0..1) the exporter/preview draw.
//
// Works in the browser (attaches to window.PdcPresets) and in Node
// (module.exports) so the same logic is unit-tested headlessly.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PdcPresets = api;
})(typeof window !== "undefined" ? window : null, function () {
  // Each preset: id, label, layout id, pacing, and a short style description.
  const PRESETS = [
    {
      id: "studio-sidebyside-calm",
      label: "Studio — Side by Side (Calm)",
      layout: "side-by-side",
      pacing: "calm",
      background: "#10141f",
      accent: "#5b8cff",
      description: "Speakers framed side by side, slow deliberate cuts.",
    },
    {
      id: "spotlight-stacked-balanced",
      label: "Spotlight — Stacked (Balanced)",
      layout: "stacked",
      pacing: "balanced",
      background: "#1a1320",
      accent: "#ff7ac6",
      description: "Speakers stacked vertically, balanced pacing.",
    },
    {
      id: "roundtable-grid-energetic",
      label: "Roundtable — Grid (Energetic)",
      layout: "grid",
      pacing: "energetic",
      background: "#0e1a14",
      accent: "#43d6a0",
      description: "Up to four speakers in a grid, quicker rhythm.",
    },
  ];

  function getPreset(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  // Pacing → seconds-per-cut hint. Used by the edit plan; kept simple but real.
  function pacingSeconds(pacing) {
    return { calm: 12, balanced: 7, energetic: 4 }[pacing] || 7;
  }

  // composeLayout(preset, speakerCount) → array of normalized rects.
  // Each rect: { x, y, w, h } in 0..1 of the output frame. Order matches the
  // speaker order the caller passes (Host first, then guests).
  function composeLayout(preset, speakerCount) {
    const p = typeof preset === "string" ? getPreset(preset) : preset;
    if (!p) throw new Error("composeLayout: unknown preset");
    const n = Math.max(1, Math.min(4, speakerCount | 0));
    const layout = p.layout;

    if (n === 1) return [{ x: 0, y: 0, w: 1, h: 1 }];

    if (layout === "side-by-side") {
      // Split the frame into N equal vertical columns.
      const rects = [];
      for (let i = 0; i < n; i++) {
        rects.push({ x: i / n, y: 0, w: 1 / n, h: 1 });
      }
      return rects;
    }

    if (layout === "stacked") {
      // Split the frame into N equal horizontal rows.
      const rects = [];
      for (let i = 0; i < n; i++) {
        rects.push({ x: 0, y: i / n, w: 1, h: 1 / n });
      }
      return rects;
    }

    if (layout === "grid") {
      if (n === 2) {
        // Two-up grid falls back to side by side (a 2x1 grid).
        return [
          { x: 0, y: 0, w: 0.5, h: 1 },
          { x: 0.5, y: 0, w: 0.5, h: 1 },
        ];
      }
      // 3 or 4 → 2x2 grid (3rd/4th cells; 3 leaves one empty slot).
      const rects = [];
      const cols = 2;
      const rows = 2;
      for (let i = 0; i < n; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        rects.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
      }
      return rects;
    }

    throw new Error("composeLayout: unknown layout " + layout);
  }

  return { PRESETS, getPreset, pacingSeconds, composeLayout };
});
