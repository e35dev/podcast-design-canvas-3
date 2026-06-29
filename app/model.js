/*
 * Podcast Design Canvas — pure episode model.
 *
 * No DOM, no browser APIs. This file is the single source of truth for preset
 * definitions, speaker slots, layout geometry, and readiness rules so the same
 * logic can be unit tested in Node and reused by the browser app.
 *
 * Dual-mode: exported via CommonJS for the test runner, and attached to
 * window.PDC_MODEL for the classic-script browser app. It is wrapped in an IIFE
 * so it declares NO globals when loaded as a classic <script> (regression guard
 * for a prior "Identifier 'PRESETS' has already been declared" failure).
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

  // Canvas the preview and export are composed on. 720p keeps long-form export
  // light while staying genuinely publishable.
  var CANVAS = { width: 1280, height: 720 };

  // The three speaker buckets a creator assigns synced tracks to.
  var SPEAKER_SLOTS = [
    { id: "host", label: "Host", accent: "#f97316" },
    { id: "guest1", label: "Guest 1", accent: "#38bdf8" },
    { id: "guest2", label: "Guest 2", accent: "#a78bfa" },
  ];

  // Preset visual styles. Each is a distinct identity (no single house look),
  // chosen first so a creator never starts on a blank canvas.
  var PRESETS = [
    {
      id: "roundtable",
      name: "Roundtable",
      pacing: "Balanced",
      background: "#0f172a",
      blurb: "Equal speaker frames side by side for an even conversation.",
    },
    {
      id: "spotlight",
      name: "Host Spotlight",
      pacing: "Steady",
      background: "#111827",
      blurb: "A large host frame with guests stacked alongside.",
    },
    {
      id: "studio",
      name: "Social Studio",
      pacing: "Lively",
      background: "#1e1b4b",
      blurb: "Branded backdrop with stacked guest cards and lower-third room.",
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

  // A speaker is "assigned" once it has a media source (uploaded file or live
  // capture). The active step requires at least two assigned speaker tracks.
  function assignedSlotIds(episode) {
    var ids = [];
    var speakers = (episode && episode.speakers) || {};
    for (var i = 0; i < SPEAKER_SLOTS.length; i++) {
      var id = SPEAKER_SLOTS[i].id;
      if (speakers[id] && speakers[id].hasMedia) ids.push(id);
    }
    return ids;
  }

  function isReadyToPreview(episode) {
    return assignedSlotIds(episode).length >= 2;
  }

  function isReadyToExport(episode) {
    return isReadyToPreview(episode) && !!getPreset(episode && episode.presetId);
  }

  // Human-readable list of what still blocks preview, for creator-facing copy.
  function blockingReasons(episode) {
    var reasons = [];
    var assigned = assignedSlotIds(episode);
    if (assigned.length < 2) {
      reasons.push(
        "Add at least two speaker videos (you have " + assigned.length + ")."
      );
    }
    return reasons;
  }

  // Derive a likely on-screen name from a social link so the edit can label
  // speakers. Used only for names/relevance — never to surface private details.
  function deriveNameFromSocial(rawUrl) {
    if (!rawUrl) return "";
    var url = String(rawUrl).trim();
    if (!url) return "";
    var handle = "";
    var at = url.match(/@([A-Za-z0-9_.]+)/);
    if (at) {
      handle = at[1];
    } else {
      var cleaned = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
      var parts = cleaned.split(/[\/?#]/).filter(Boolean);
      if (parts.length >= 2) handle = parts[parts.length - 1];
    }
    handle = handle.replace(/[._]+/g, " ").trim();
    if (!handle) return "";
    return handle
      .split(/\s+/)
      .map(function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ");
  }

  // Normalize a social link: trim, drop empties, add a scheme if missing.
  function normalizeSocialLink(rawUrl) {
    if (!rawUrl) return "";
    var url = String(rawUrl).trim();
    if (!url) return "";
    if (!/^https?:\/\//i.test(url) && /\./.test(url)) {
      url = "https://" + url;
    }
    return url;
  }

  // The display name for a speaker: explicit name wins, else derived from social.
  function speakerDisplayName(slotId, speaker) {
    if (speaker && speaker.name && String(speaker.name).trim()) {
      return String(speaker.name).trim();
    }
    var derived = deriveNameFromSocial(speaker && speaker.social);
    if (derived) return derived;
    return slotLabel(slotId);
  }

  function clampRect(rect) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.max(1, Math.round(rect.w)),
      h: Math.max(1, Math.round(rect.h)),
    };
  }

  /*
   * Compute the on-canvas geometry for the active speakers under a preset.
   * Returns frames (one rect per assigned speaker, in slot order), a caption
   * box (lower third), and a title box. Pure geometry so it is unit-testable.
   */
  function computeLayout(presetId, slotIds, width, height) {
    width = width || CANVAS.width;
    height = height || CANVAS.height;
    var preset = getPreset(presetId);
    var ids = (slotIds || []).slice(0, SPEAKER_SLOTS.length);
    var margin = Math.round(width * 0.025);
    var captionH = Math.round(height * 0.16);
    var titleH = Math.round(height * 0.1);
    var stageTop = margin + titleH + margin;
    var stageBottom = height - margin - captionH - margin;
    var stageH = Math.max(40, stageBottom - stageTop);
    var stageW = width - margin * 2;
    var frames = [];

    if (ids.length === 0) {
      // Nothing assigned yet — no frames, just title/caption scaffolding.
    } else if (preset.id === "spotlight") {
      // Host large on the left, remaining guests stacked on the right.
      var primary = ids[0];
      var rest = ids.slice(1);
      var gap = Math.round(width * 0.015);
      if (rest.length === 0) {
        frames.push(
          frame(primary, margin, stageTop, stageW, stageH)
        );
      } else {
        var primaryW = Math.round(stageW * 0.62);
        frames.push(frame(primary, margin, stageTop, primaryW, stageH));
        var colX = margin + primaryW + gap;
        var colW = stageW - primaryW - gap;
        var cellH = Math.round((stageH - gap * (rest.length - 1)) / rest.length);
        for (var i = 0; i < rest.length; i++) {
          frames.push(
            frame(rest[i], colX, stageTop + i * (cellH + gap), colW, cellH)
          );
        }
      }
    } else if (preset.id === "studio") {
      // Stacked cards down the right with a branded panel on the left.
      var sGap = Math.round(height * 0.02);
      var cardW = Math.round(stageW * 0.42);
      var cardX = margin + (stageW - cardW);
      var sCellH = Math.round(
        (stageH - sGap * (ids.length - 1)) / ids.length
      );
      for (var s = 0; s < ids.length; s++) {
        frames.push(
          frame(ids[s], cardX, stageTop + s * (sCellH + sGap), cardW, sCellH)
        );
      }
    } else {
      // Roundtable: equal frames in a row.
      var rGap = Math.round(width * 0.015);
      var fw = Math.round((stageW - rGap * (ids.length - 1)) / ids.length);
      for (var r = 0; r < ids.length; r++) {
        frames.push(frame(ids[r], margin + r * (fw + rGap), stageTop, fw, stageH));
      }
    }

    return {
      preset: preset,
      background: preset.background,
      frames: frames,
      titleBox: clampRect({ x: margin, y: margin, w: stageW, h: titleH }),
      captionBox: clampRect({
        x: margin,
        y: height - margin - captionH,
        w: stageW,
        h: captionH,
      }),
    };

    function frame(id, x, y, w, h) {
      var rect = clampRect({ x: x, y: y, w: w, h: h });
      rect.id = id;
      rect.label = slotLabel(id);
      return rect;
    }
  }

  // Pick the export duration: the longest finite assigned track should export
  // in full. Unknown/live sources fall back to a short bounded duration so the
  // recorder never waits forever on an Infinity/NaN media duration.
  function exportDurationSeconds(durations, fallbackSeconds) {
    fallbackSeconds = fallbackSeconds || 5;
    var longest = 0;
    (durations || []).forEach(function (d) {
      if (typeof d === "number" && isFinite(d) && d > longest) longest = d;
    });
    if (!longest) return Math.max(2, fallbackSeconds);
    return Math.max(2, longest);
  }

  function exportFileName(title) {
    var base = (title || "episode").toString().trim().toLowerCase();
    base = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!base) base = "episode";
    return base + ".webm";
  }

  return {
    CANVAS: CANVAS,
    SPEAKER_SLOTS: SPEAKER_SLOTS,
    PRESETS: PRESETS,
    getPreset: getPreset,
    slotLabel: slotLabel,
    assignedSlotIds: assignedSlotIds,
    isReadyToPreview: isReadyToPreview,
    isReadyToExport: isReadyToExport,
    blockingReasons: blockingReasons,
    deriveNameFromSocial: deriveNameFromSocial,
    normalizeSocialLink: normalizeSocialLink,
    speakerDisplayName: speakerDisplayName,
    computeLayout: computeLayout,
    exportDurationSeconds: exportDurationSeconds,
    exportFileName: exportFileName,
  };
});
