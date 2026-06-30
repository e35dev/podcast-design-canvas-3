// app/layout-editor.js
// Drag-and-resize speaker video frames over the live preview stage. Draft rects
// feed the same layout path as presets once saved/applied as a named template.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  function createLayoutEditor(options) {
    const stageWrap = options.stageWrap;
    const overlay = options.overlay;
    const framesHost = options.framesHost;
    let episodeRef = null;
    let draft = {};
    let open = false;
    let onChange = null;
    let drag = null;

    function buckets() {
      return episodeRef ? PDC.episode.assignedBuckets(episodeRef) : [];
    }

    function labelFor(bucket) {
      return PDC.episode.speakerName(episodeRef, bucket);
    }

    function syncDraftFromEpisode() {
      draft = PDC.layout.draftFromEpisode(episodeRef);
    }

    function frameEl(bucket) {
      return framesHost.querySelector('[data-layout-frame="' + bucket + '"]');
    }

    function renderFrames() {
      framesHost.innerHTML = "";
      buckets().forEach(function (bucket) {
        const rect = draft[bucket];
        if (!rect) return;
        const el = document.createElement("div");
        el.className = "layout-frame";
        el.dataset.layoutFrame = bucket;
        el.style.left = rect.x + "%";
        el.style.top = rect.y + "%";
        el.style.width = rect.w + "%";
        el.style.height = rect.h + "%";
        el.innerHTML =
          '<span class="layout-frame-label">' + labelFor(bucket) + "</span>" +
          '<span class="layout-handle" data-drag-handle="' + bucket + '" aria-hidden="true"></span>' +
          '<span class="layout-resize" data-resize-handle="' + bucket + '" aria-hidden="true"></span>';
        framesHost.appendChild(el);
      });
    }

    function setFrameRect(bucket, rect) {
      if (!draft[bucket]) return;
      draft[bucket] = PDC.templates.clampRect(rect);
      const el = frameEl(bucket);
      if (el) {
        el.style.left = draft[bucket].x + "%";
        el.style.top = draft[bucket].y + "%";
        el.style.width = draft[bucket].w + "%";
        el.style.height = draft[bucket].h + "%";
      }
      if (typeof onChange === "function") onChange(getDraftRects());
    }

    function pointerToPercent(clientX, clientY) {
      const box = stageWrap.getBoundingClientRect();
      return {
        x: ((clientX - box.left) / box.width) * 100,
        y: ((clientY - box.top) / box.height) * 100,
      };
    }

    function onPointerDown(event) {
      const moveHandle = event.target.closest("[data-drag-handle]");
      const resizeHandle = event.target.closest("[data-resize-handle]");
      const bucket = (moveHandle && moveHandle.getAttribute("data-drag-handle")) ||
        (resizeHandle && resizeHandle.getAttribute("data-resize-handle"));
      if (!bucket || !draft[bucket]) return;
      event.preventDefault();
      drag = {
        bucket: bucket,
        mode: resizeHandle ? "resize" : "move",
        start: pointerToPercent(event.clientX, event.clientY),
        origin: Object.assign({}, draft[bucket]),
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    }

    function onPointerMove(event) {
      if (!drag) return;
      const pt = pointerToPercent(event.clientX, event.clientY);
      const dx = pt.x - drag.start.x;
      const dy = pt.y - drag.start.y;
      const o = drag.origin;
      if (drag.mode === "move") {
        setFrameRect(drag.bucket, { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h });
      } else {
        setFrameRect(drag.bucket, { x: o.x, y: o.y, w: o.w + dx, h: o.h + dy });
      }
    }

    function onPointerUp() {
      drag = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }

    framesHost.addEventListener("pointerdown", onPointerDown);

    function getDraftRects() {
      const copy = {};
      buckets().forEach(function (bucket) {
        if (draft[bucket]) copy[bucket] = Object.assign({}, draft[bucket]);
      });
      return copy;
    }

    function setDraftRects(rectsByBucket) {
      buckets().forEach(function (bucket) {
        if (rectsByBucket[bucket]) draft[bucket] = PDC.templates.clampRect(rectsByBucket[bucket]);
      });
      renderFrames();
      if (typeof onChange === "function") onChange(getDraftRects());
    }

    function openEditor(episode, changeCb) {
      episodeRef = episode;
      onChange = changeCb || null;
      syncDraftFromEpisode();
      renderFrames();
      overlay.hidden = false;
      overlay.setAttribute("aria-hidden", "false");
      stageWrap.classList.add("editing-layout");
      open = true;
    }

    function closeEditor() {
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
      stageWrap.classList.remove("editing-layout");
      open = false;
      drag = null;
    }

    function isOpen() {
      return open;
    }

    return {
      open: openEditor,
      close: closeEditor,
      isOpen: isOpen,
      getDraftRects: getDraftRects,
      setDraftRects: setDraftRects,
      setFrameRect: setFrameRect,
    };
  }

  PDC.layoutEditor = { createLayoutEditor };
})();
