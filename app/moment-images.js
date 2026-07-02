// app/moment-images.js — runtime-only registry mapping a b-roll moment id to
// its decoded PNG <img>. app/moments.js keeps the episode model DOM-free and
// stores only the image's file NAME, so saved templates/localStorage never
// carry image bytes; the actual decoded pixels live here, in the browser,
// for as long as the moment exists in this session. app/preview.js reads
// from this registry each frame to draw the active b-roll overlay, and
// because export records that same canvas, the image is burned into the
// exported video automatically. Classic script — exposed on window.PDC.momentImages.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const images = new Map(); // momentId -> { img, url }

  // Decodes file into an <img> and registers it under momentId only once
  // decoding succeeds (onload) — never before, so a bad or slow file can't
  // show a stale frame. Replaces (and releases) any prior image at this id.
  function register(momentId, file, onReady) {
    release(momentId);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      images.set(momentId, { img, url });
      if (onReady) onReady(img);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  function get(momentId) {
    const entry = images.get(momentId);
    return entry ? entry.img : null;
  }

  // Frees the blob URL and drops the decoded image — called when a moment is
  // removed so an orphaned image can't keep memory or a blob URL alive.
  function release(momentId) {
    const entry = images.get(momentId);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    images.delete(momentId);
  }

  PDC.momentImages = { register, get, release };
})();
