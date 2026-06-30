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
    let pointerActive = false;

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
          '<button type="button" class="layout-frame-bar" data-drag-handle="' + bucket + '" aria-label="Drag to move ' + labelFor(bucket) + ' frame">' +
          labelFor(bucket) + " · drag to move</button>" +
          '<button type="button" class="layout-resize" data-resize-handle="' + bucket + '" aria-label="Resize ' + labelFor(bucket) + ' frame">Resize</button>';
        framesHost.appendChild(el);
      });
    }

    function emitChange() {
      if (typeof onChange === "function") onChange(getDraftRects());
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
      emitChange();
    }

    function pointerToPercent(clientX, clientY) {
      const box = stageWrap.getBoundingClientRect();
      return {
        x: ((clientX - box.left) / box.width) * 100,
        y: ((clientY - box.top) / box.height) * 100,
      };
    }

    function bindDragListeners() {
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd);
      document.addEventListener("pointermove", onDragMove);
      document.addEventListener("pointerup", onPointerUp);
    }

    function unbindDragListeners() {
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
      document.removeEventListener("pointermove", onDragMove);
      document.removeEventListener("pointerup", onPointerUp);
    }

    function onDragStart(event) {
      if (event.type === "mousedown" && event.button !== 0) return;
      if (event.type === "mousedown" && pointerActive) return;

      const moveHandle = event.target.closest("[data-drag-handle]");
      const resizeHandle = event.target.closest("[data-resize-handle]");
      const bucket = (moveHandle && moveHandle.getAttribute("data-drag-handle")) ||
        (resizeHandle && resizeHandle.getAttribute("data-resize-handle"));
      if (!bucket || !draft[bucket]) return;

      if (event.type === "pointerdown") pointerActive = true;
      event.preventDefault();
      event.stopPropagation();
      drag = {
        bucket: bucket,
        mode: resizeHandle ? "resize" : "move",
        start: pointerToPercent(event.clientX, event.clientY),
        origin: Object.assign({}, draft[bucket]),
      };
      stageWrap.dataset.editingDrag = drag.mode;
      bindDragListeners();
    }

    function onDragMove(event) {
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

    function onDragEnd() {
      if (!drag) return;
      drag = null;
      pointerActive = false;
      delete stageWrap.dataset.editingDrag;
      unbindDragListeners();
    }

    function onPointerUp() {
      pointerActive = false;
      onDragEnd();
    }

    framesHost.addEventListener("mousedown", onDragStart);
    framesHost.addEventListener("pointerdown", onDragStart);

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
      emitChange();
    }

    function openEditor(episode, changeCb) {
      episodeRef = episode;
      onChange = changeCb || null;
      syncDraftFromEpisode();
      renderFrames();
      emitChange();
      overlay.hidden = false;
      overlay.setAttribute("aria-hidden", "false");
      stageWrap.classList.add("editing-layout");
      stageWrap.dataset.editing = "true";
      open = true;
    }

    function closeEditor() {
      onDragEnd();
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
      stageWrap.classList.remove("editing-layout");
      delete stageWrap.dataset.editing;
      delete stageWrap.dataset.editingDrag;
      open = false;
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
