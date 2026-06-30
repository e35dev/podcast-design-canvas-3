// app/presets.js
// Preset visual layouts for the composed preview. Classic script (no ES module
// import/export) so the app loads identically over http:// and file://.
// Everything is hung off a single global namespace: window.PDC.
//
// A preset is a pure description of how the assigned speaker videos are placed
// on a 16:9 stage. The preview renderer (app/preview.js) calls layout(n) and
// draws each speaker's video frame into the returned percentage rects on canvas.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // Speaker buckets, in assignment order. The first uploaded file fills HOST,
  // the second GUEST_1, and so on. Two filled buckets is the minimum.
  const SPEAKER_BUCKETS = ["host", "guest1", "guest2"];
  const BUCKET_LABELS = {
    host: "Host",
    guest1: "Guest 1",
    guest2: "Guest 2",
  };

  // rect = { x, y, w, h } in percentages of the stage (0–100).
  // `layout(n)` returns one rect per assigned speaker (n = 2 or 3). Keeping the
  // geometry as data makes the presets unit-testable without a DOM.
  const PRESETS = [
    {
      id: "split",
      name: "Split",
      description: "Speakers side by side, equal billing.",
      layout(n) {
        if (n <= 1) return [{ x: 0, y: 0, w: 100, h: 100 }];
        if (n === 2) {
          return [
            { x: 0, y: 0, w: 50, h: 100 },
            { x: 50, y: 0, w: 50, h: 100 },
          ];
        }
        // 3 speakers: one tall on the left, two stacked on the right.
        return [
          { x: 0, y: 0, w: 50, h: 100 },
          { x: 50, y: 0, w: 50, h: 50 },
          { x: 50, y: 50, w: 50, h: 50 },
        ];
      },
    },
    {
      id: "stack",
      name: "Stack",
      description: "Stacked rows, full-width speakers.",
      layout(n) {
        const count = Math.max(1, n);
        const h = 100 / count;
        return Array.from({ length: count }, (_, i) => ({
          x: 0,
          y: i * h,
          w: 100,
          h,
        }));
      },
    },
    {
      id: "spotlight",
      name: "Spotlight",
      description: "Host full-frame, guests as picture-in-picture.",
      layout(n) {
        if (n <= 1) return [{ x: 0, y: 0, w: 100, h: 100 }];
        const rects = [{ x: 0, y: 0, w: 100, h: 100 }]; // host fills the stage
        const pipW = 26;
        const pipH = 26;
        const gap = 3;
        for (let i = 1; i < n; i++) {
          rects.push({
            x: 100 - pipW - gap,
            y: 100 - i * (pipH + gap),
            w: pipW,
            h: pipH,
          });
        }
        return rects;
      },
    },
  ];

  const DEFAULT_PRESET_ID = PRESETS[0].id;

  function getPreset(id) {
    return PRESETS.find((p) => p.id === id) || null;
  }

  PDC.presets = {
    SPEAKER_BUCKETS,
    BUCKET_LABELS,
    PRESETS,
    DEFAULT_PRESET_ID,
    getPreset,
  };
})();
