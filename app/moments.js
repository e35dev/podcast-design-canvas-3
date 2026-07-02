// app/moments.js — timed visual moments (episode title cards, callout
// lower-thirds, and b-roll image overlays) scheduled over the composed
// preview. Pure, DOM-free model:
// moments live ON THE EPISODE (not on a preset or the preview), so switching
// Split/Stack/Spotlight or a custom template keeps every scheduled moment
// attached and rendered over the new layout. The preview draws the active
// moments straight onto the stage canvas each frame, and because export
// records that same canvas, the moments are burned into the exported video at
// the same scheduled times. Classic script — exposed on window.PDC.moments.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  const MOMENT_TYPES = ["title", "callout", "image"];
  const TYPE_LABELS = { title: "Episode title", callout: "Callout", image: "B-roll image" };
  let seq = 0;

  function ensureMoments(episode) {
    if (!episode.moments) episode.moments = [];
    return episode.moments;
  }

  // Accepts plain seconds ("4", "2.5", 4) or M:SS ("0:03", "1:05"). Returns a
  // finite non-negative number of seconds, or NaN when the input is not a time.
  function parseTime(raw) {
    if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : NaN;
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return NaN;
    const clock = s.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  // Seconds -> "M:SS" (used by the moment list and the scrub readout).
  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // A duck-typed check for a File-like object (name/type/size) — avoids
  // referencing the browser's File global directly so this model stays
  // loadable under plain Node (tests run it with no DOM/File shim).
  function isPngFile(value) {
    if (!value || typeof value !== "object") return false;
    const mime = value.type || "";
    const name = value.name || "";
    if (mime) return mime === "image/png";
    return /\.png$/i.test(name);
  }

  // "" when the fields describe a valid moment, otherwise a creator-readable
  // reason. start/end may be raw strings (seconds or M:SS) or numbers.
  function validateMoment(fields) {
    const f = fields || {};
    if (!MOMENT_TYPES.includes(f.type)) return "Choose a moment type (title, callout, or b-roll image).";
    if (f.type === "image") {
      if (!f.image) return "Choose a PNG image to upload for this moment.";
      if (!isPngFile(f.image)) return "Image overlays must be a PNG file.";
    } else if (!String(f.text == null ? "" : f.text).trim()) {
      return "Enter the text this moment should display.";
    }
    const start = parseTime(f.start);
    const end = parseTime(f.end);
    if (!Number.isFinite(start)) return "Enter a valid start time (seconds or M:SS).";
    if (!Number.isFinite(end)) return "Enter a valid end time (seconds or M:SS).";
    if (start < 0) return "Start time cannot be negative.";
    if (end <= start) return "End time must be after the start time.";
    return "";
  }

  // Adds a validated moment to the episode and returns it; returns null when
  // the fields are invalid (use validateMoment for the reason). Image moments
  // store only a plain descriptor (name) on the model — the loaded pixel data
  // (the actual <img>) is owned by preview.js, same as speaker video buckets.
  function addMoment(episode, fields) {
    if (validateMoment(fields)) return null;
    const moment = {
      id: "moment-" + ++seq,
      type: fields.type,
      start: parseTime(fields.start),
      end: parseTime(fields.end),
    };
    if (fields.type === "image") moment.imageName = fields.image.name || "Image";
    else moment.text = String(fields.text).trim();
    ensureMoments(episode).push(moment);
    return moment;
  }

  function removeMoment(episode, id) {
    const list = ensureMoments(episode);
    const index = list.findIndex((m) => m.id === id);
    if (index === -1) return false;
    list.splice(index, 1);
    return true;
  }

  // Copy of the episode's moments, ordered by start time (stable for the UI list).
  function listMoments(episode) {
    return ensureMoments(episode).slice().sort((a, b) => a.start - b.start || a.end - b.end);
  }

  // Moments scheduled over time t (seconds): start inclusive, end exclusive —
  // a 0:00–0:03 title is visible at exactly 0.0 and gone at exactly 3.0.
  function activeMoments(episode, tSeconds) {
    const t = Number(tSeconds);
    if (!Number.isFinite(t)) return [];
    return listMoments(episode).filter((m) => t >= m.start && t < m.end);
  }

  PDC.moments = {
    MOMENT_TYPES,
    TYPE_LABELS,
    parseTime,
    formatTime,
    validateMoment,
    addMoment,
    removeMoment,
    listMoments,
    activeMoments,
  };
})();
