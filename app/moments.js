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

  const MOMENT_TYPES = ["title", "callout", "broll"];
  const TYPE_LABELS = { title: "Episode title", callout: "Callout", broll: "B-roll image" };
  let seq = 0;

  // Runtime registry of decoded b-roll images, keyed by moment id. The image
  // ELEMENT (and its blob-backed object URL) is deliberately kept OUT of the
  // episode/moment data: templates persist only geometry (app/templates.js)
  // and nothing here is ever serialized, so saved templates and any future
  // storage can never carry image bytes. The model stores only the imageName
  // label; the UI decodes the uploaded file and parks the element here for
  // the preview/export renderer to draw while the moment is active.
  const momentImages = new Map();

  function setMomentImage(id, image) {
    if (!id || !image) return;
    momentImages.set(id, image);
  }

  function getMomentImage(id) {
    return momentImages.get(id) || null;
  }

  // Drops a moment's decoded image and best-effort revokes its blob URL so a
  // removed b-roll cannot leak memory. Safe under plain Node (no-op revoke).
  function clearMomentImage(id) {
    const image = momentImages.get(id);
    momentImages.delete(id);
    if (!image) return;
    try {
      const src = image.src || "";
      if (src.indexOf("blob:") === 0 && typeof URL !== "undefined" && URL.revokeObjectURL) {
        URL.revokeObjectURL(src);
      }
    } catch (e) {
      /* revocation is best-effort */
    }
  }

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

  // "" when the fields describe a valid moment, otherwise a creator-readable
  // reason. start/end may be raw strings (seconds or M:SS) or numbers.
  function validateMoment(fields) {
    const f = fields || {};
    if (!MOMENT_TYPES.includes(f.type)) return "Choose a moment type (title, callout, or b-roll image).";
    if (f.type === "broll") {
      // B-roll moments show an uploaded image instead of text. The UI attaches
      // the decoded image; the model only requires that an image was chosen.
      if (!String(f.imageName == null ? "" : f.imageName).trim()) return "Choose a PNG image for this b-roll moment.";
    } else if (!String(f.text == null ? "" : f.text).trim()) return "Enter the text this moment should display.";
    const start = parseTime(f.start);
    const end = parseTime(f.end);
    if (!Number.isFinite(start)) return "Enter a valid start time (seconds or M:SS).";
    if (!Number.isFinite(end)) return "Enter a valid end time (seconds or M:SS).";
    if (start < 0) return "Start time cannot be negative.";
    if (end <= start) return "End time must be after the start time.";
    return "";
  }

  // Adds a validated moment to the episode and returns it; returns null when
  // the fields are invalid (use validateMoment for the reason).
  function addMoment(episode, fields) {
    if (validateMoment(fields)) return null;
    const moment = {
      id: "moment-" + ++seq,
      type: fields.type,
      text: fields.type === "broll" ? "" : String(fields.text).trim(),
      start: parseTime(fields.start),
      end: parseTime(fields.end),
    };
    if (fields.type === "broll") moment.imageName = String(fields.imageName).trim();
    ensureMoments(episode).push(moment);
    return moment;
  }

  function removeMoment(episode, id) {
    const list = ensureMoments(episode);
    const index = list.findIndex((m) => m.id === id);
    if (index === -1) return false;
    list.splice(index, 1);
    clearMomentImage(id);
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
    setMomentImage,
    getMomentImage,
    clearMomentImage,
  };
})();
