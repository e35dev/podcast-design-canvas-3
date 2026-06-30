// app/editor.js — the custom-layout editor. Renders one draggable, resizable
// frame per assigned speaker as an absolutely-positioned overlay on top of the
// composed canvas. Positions are kept in PERCENT of the stage so they map back
// to the same rects the preview/export consume. Each drag/resize reports the new
// rects via onChange, which the app feeds to the live preview as a draft layout.
// Classic script on window.PDC.editor.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  function createEditor(opts) {
    const overlay = opts.overlayEl;
    const onChange = opts.onChange || function () {};
    let rects = {}; // bucket -> {x,y,w,h} in percent
    let open = false;

    function emit() {
      onChange(JSON.parse(JSON.stringify(rects)));
    }

    function clampRect(r) {
      let w = Math.max(8, Math.min(100, r.w));
      let h = Math.max(8, Math.min(100, r.h));
      let x = Math.max(0, Math.min(100 - w, r.x));
      let y = Math.max(0, Math.min(100 - h, r.y));
      return { x, y, w, h };
    }

    function place(frame, r) {
      frame.style.left = r.x + "%";
      frame.style.top = r.y + "%";
      frame.style.width = r.w + "%";
      frame.style.height = r.h + "%";
    }

    function startDrag(bucket, frame, handle, e) {
      e.preventDefault();
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY };
      const base = { x: rects[bucket].x, y: rects[bucket].y, w: rects[bucket].w, h: rects[bucket].h };
      const W = overlay.clientWidth || 1;
      const H = overlay.clientHeight || 1;
      function move(ev) {
        const dxp = ((ev.clientX - start.x) / W) * 100;
        const dyp = ((ev.clientY - start.y) / H) * 100;
        let next;
        if (handle === "resize") {
          next = clampRect({ x: base.x, y: base.y, w: base.w + dxp, h: base.h + dyp });
        } else {
          next = clampRect({ x: base.x + dxp, y: base.y + dyp, w: base.w, h: base.h });
        }
        rects[bucket] = next;
        place(frame, next);
        emit();
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        emit();
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    }

    function build(buckets, initialRects, labelFor) {
      overlay.innerHTML = "";
      rects = {};
      buckets.forEach(function (bucket, i) {
        rects[bucket] = clampRect(initialRects[i] || { x: 0, y: 0, w: 50, h: 50 });
        const frame = document.createElement("div");
        frame.className = "edit-frame";
        frame.dataset.frameBucket = bucket;
        place(frame, rects[bucket]);
        const tag = document.createElement("span");
        tag.className = "edit-frame-label";
        tag.textContent = labelFor ? labelFor(bucket) : bucket;
        frame.appendChild(tag);
        const handle = document.createElement("span");
        handle.className = "edit-frame-resize";
        handle.dataset.resizeBucket = bucket;
        frame.appendChild(handle);
        frame.addEventListener("mousedown", function (e) {
          if (e.target === handle) return;
          startDrag(bucket, frame, "move", e);
        });
        handle.addEventListener("mousedown", function (e) {
          startDrag(bucket, frame, "resize", e);
        });
        overlay.appendChild(frame);
      });
    }

    return {
      open: function (buckets, initialRects, labelFor) {
        open = true;
        overlay.hidden = false;
        build(buckets, initialRects, labelFor);
        emit();
      },
      close: function () {
        open = false;
        overlay.hidden = true;
        overlay.innerHTML = "";
      },
      isOpen: function () {
        return open;
      },
      getRects: function () {
        return JSON.parse(JSON.stringify(rects));
      },
    };
  }

  PDC.editor = { createEditor };
})();
