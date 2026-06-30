/*
 * Podcast Design Canvas — pure preview model (active step #32).
 *
 * No DOM, no browser APIs. Single source of truth for the speaker buckets,
 * preset layouts, and the "ready to preview" rule, so the same logic runs in
 * Node tests and in the classic-script browser app.
 *
 * Dual-mode: CommonJS export for the test runner; window.PDC_MODEL for the
 * browser. Wrapped in an IIFE so it leaks NO globals when loaded as a classic
 * <script> (regression guard against a duplicate-declaration crash).
 *
 * Scope note: this step proves uploaded/recorded media reaches a composed
 * preview. Export, audio cleanup, captions, b-roll, social enrichment, and
 * templates are intentionally out of scope and are NOT modeled here.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PDC_MODEL = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 16:9 stage the preview is composed on.
  var STAGE = { width: 1280, height: 720 };

  // The speaker buckets a creator assigns synced tracks to.
  var SPEAKER_SLOTS = [
    { id: "host", label: "Host", accent: "#f97316" },
    { id: "guest1", label: "Guest 1", accent: "#38bdf8" },
    { id: "guest2", label: "Guest 2", accent: "#a78bfa" },
  ];

  // Preset layouts. Presets first — a creator never starts on a blank canvas.
  var PRESETS = [
    {
      id: "split",
      name: "Split",
      blurb: "Equal speaker frames side by side.",
      background: "#0f172a",
    },
    {
      id: "stack",
      name: "Stack",
      blurb: "Speaker frames stacked top to bottom.",
      background: "#111827",
    },
    {
      id: "spotlight",
      name: "Spotlight",
      blurb: "A large host frame with guests alongside.",
      background: "#1e1b4b",
    },
  ];

  function getPreset(presetId) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === presetId) return PRESETS[i];
    }
    return PRESETS[0];
  }

  function slotLabel(slotId) {
    for (var i = 0; i < SPEAKER_SLOTS.length; i++) {
      if (SPEAKER_SLOTS[i].id === slotId) return SPEAKER_SLOTS[i].label;
    }
    return slotId;
  }

  function slotAccent(slotId) {
    for (var i = 0; i < SPEAKER_SLOTS.length; i++) {
      if (SPEAKER_SLOTS[i].id === slotId) return SPEAKER_SLOTS[i].accent;
    }
    return "#38bdf8";
  }

  // A speaker is "assigned" once a real media source (uploaded file or live
  // recording) is attached to its bucket.
  function assignedSlotIds(episode) {
    var ids = [];
    var speakers = (episode && episode.speakers) || {};
    for (var i = 0; i < SPEAKER_SLOTS.length; i++) {
      var id = SPEAKER_SLOTS[i].id;
      if (speakers[id] && speakers[id].hasMedia) ids.push(id);
    }
    return ids;
  }

  // The active step requires at least two assigned speaker tracks to preview.
  function isReadyToPreview(episode) {
    return assignedSlotIds(episode).length >= 2;
  }

  // Creator-facing copy for what still blocks the composed preview.
  function blockingReason(episode) {
    var n = assignedSlotIds(episode).length;
    if (n >= 2) return "";
    return "Add at least two speaker videos to preview (you have " + n + ").";
  }

  function clampRect(rect, id) {
    return {
      id: id,
      label: slotLabel(id),
      accent: slotAccent(id),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.max(1, Math.round(rect.w)),
      h: Math.max(1, Math.round(rect.h)),
    };
  }

  /*
   * On-stage geometry for the assigned speakers under a preset. Returns one
   * rect per assigned speaker (in slot order). Pure geometry — unit-testable.
   */
  function computeLayout(presetId, slotIds, width, height) {
    width = width || STAGE.width;
    height = height || STAGE.height;
    var preset = getPreset(presetId);
    var ids = (slotIds || []).slice(0, SPEAKER_SLOTS.length);
    var m = Math.round(width * 0.022); // margin
    var g = Math.round(width * 0.015); // gap
    var innerW = width - m * 2;
    var innerH = height - m * 2;
    var frames = [];

    if (ids.length === 0) return { preset: preset, background: preset.background, frames: frames };

    if (preset.id === "stack") {
      var cellH = Math.round((innerH - g * (ids.length - 1)) / ids.length);
      for (var i = 0; i < ids.length; i++) {
        frames.push(clampRect({ x: m, y: m + i * (cellH + g), w: innerW, h: cellH }, ids[i]));
      }
    } else if (preset.id === "spotlight") {
      var primary = ids[0];
      var rest = ids.slice(1);
      if (rest.length === 0) {
        frames.push(clampRect({ x: m, y: m, w: innerW, h: innerH }, primary));
      } else {
        var mainW = Math.round(innerW * 0.62);
        frames.push(clampRect({ x: m, y: m, w: mainW, h: innerH }, primary));
        var colX = m + mainW + g;
        var colW = innerW - mainW - g;
        var rH = Math.round((innerH - g * (rest.length - 1)) / rest.length);
        for (var r = 0; r < rest.length; r++) {
          frames.push(clampRect({ x: colX, y: m + r * (rH + g), w: colW, h: rH }, rest[r]));
        }
      }
    } else {
      // split: equal frames in a row.
      var fw = Math.round((innerW - g * (ids.length - 1)) / ids.length);
      for (var s = 0; s < ids.length; s++) {
        frames.push(clampRect({ x: m + s * (fw + g), y: m, w: fw, h: innerH }, ids[s]));
      }
    }

    return { preset: preset, background: preset.background, frames: frames };
  }

  return {
    STAGE: STAGE,
    SPEAKER_SLOTS: SPEAKER_SLOTS,
    PRESETS: PRESETS,
    getPreset: getPreset,
    slotLabel: slotLabel,
    slotAccent: slotAccent,
    assignedSlotIds: assignedSlotIds,
    isReadyToPreview: isReadyToPreview,
    blockingReason: blockingReason,
    computeLayout: computeLayout,
  };
});
