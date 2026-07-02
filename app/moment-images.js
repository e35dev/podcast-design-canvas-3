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

  function get(momentId) {
    const entry = images.get(momentId);
    return entry ? entry.img : null;
  }

  // Frees the blob URL and drops the decoded image — called when a moment is
  // removed (or its owning episode is reset) so an orphaned image can't keep
  // memory or a blob URL alive.
  function release(momentId) {
    const entry = images.get(momentId);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    images.delete(momentId);
  }

  // Starts decoding a file immediately (e.g. as soon as it's chosen in the
  // file input), before a moment id even exists yet. Decoding a PNG takes
  // real time; starting it the instant the file is picked — rather than
  // waiting until "Add moment" is clicked — means it has almost always
  // finished by the time the moment is actually created, so the overlay is
  // ready to draw on the very next frame instead of racing a first render.
  // Returns a handle whose assign(key) call (re-)targets where the decoded
  // image should land: call it with a real moment id once one exists. Safe
  // to call assign() before OR after decoding finishes.
  function preload(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const box = { key: null };
    let failed = false;
    function commit() {
      if (box.key) images.set(box.key, { img, url });
    }
    img.onload = function () {
      commit();
    };
    img.onerror = function () {
      failed = true;
      URL.revokeObjectURL(url);
    };
    img.src = url;
    return {
      assign: function (key) {
        release(key);
        box.key = key;
        if (!failed && img.complete && img.naturalWidth) commit();
      },
    };
  }

  PDC.momentImages = { preload, get, release };
})();
