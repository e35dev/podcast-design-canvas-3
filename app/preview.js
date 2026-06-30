// app/preview.js
// Composes the preview on a 16:9 canvas by drawing real uploaded video frames
// (ctx.drawImage) into preset layout rects. Hidden <video> elements decode the
// uploaded files; the canvas is what the user sees. The draw loop runs as soon
// as media exists so composed pixels are visible even before Play is pressed.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { getPreset, BUCKET_LABELS } = PDC.presets;

  function createPreview(canvasEl) {
    const ctx = canvasEl.getContext("2d");
    const videos = {};
    let playing = false;
    let rafId = 0;
    let episodeRef = null;

    function ensureVideo(bucket) {
      let v = videos[bucket];
      if (!v) {
        v = document.createElement("video");
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.setAttribute("playsinline", "");
        v.preload = "auto";
        v.crossOrigin = "anonymous";
        videos[bucket] = v;
      }
      return v;
    }

    function setSource(bucket, file) {
      const v = ensureVideo(bucket);
      if (v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
      const url = URL.createObjectURL(file);
      v.dataset.objectUrl = url;
      v.src = url;
      v.load();
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
      return v;
    }

    function clear(bucket) {
      const v = videos[bucket];
      if (v && v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
      delete videos[bucket];
    }

    function drawFrame() {
      if (!episodeRef) return;
      const buckets = PDC.episode.assignedBuckets(episodeRef);
      const preset = getPreset(episodeRef.presetId) || PDC.presets.PRESETS[0];
      const rects = preset.layout(buckets.length);
      const w = canvasEl.width;
      const h = canvasEl.height;

      ctx.fillStyle = "#05070c";
      ctx.fillRect(0, 0, w, h);

      buckets.forEach(function (bucket, i) {
        const rect = rects[i] || rects[rects.length - 1];
        const x = (rect.x / 100) * w;
        const y = (rect.y / 100) * h;
        const rw = (rect.w / 100) * w;
        const rh = (rect.h / 100) * h;
        const v = videos[bucket];

        ctx.fillStyle = "#000";
        ctx.fillRect(x, y, rw, rh);

        if (v && v.readyState >= 2 && v.videoWidth > 0) {
          const scale = Math.max(rw / v.videoWidth, rh / v.videoHeight);
          const dw = v.videoWidth * scale;
          const dh = v.videoHeight * scale;
          const dx = x + (rw - dw) / 2;
          const dy = y + (rh - dh) / 2;
          ctx.drawImage(v, dx, dy, dw, dh);
        }

        ctx.fillStyle = "rgba(8,10,16,0.72)";
        ctx.fillRect(x + 8, y + rh - 28, 90, 22);
        ctx.fillStyle = "#fff";
        ctx.font = "600 14px system-ui, sans-serif";
        ctx.fillText(BUCKET_LABELS[bucket] || bucket, x + 14, y + rh - 12);
      });

      canvasEl.dataset.preset = preset.id;
      canvasEl.dataset.speakers = String(buckets.length);
    }

    function loop() {
      drawFrame();
      rafId = requestAnimationFrame(loop);
    }

    function ensureLoop() {
      if (!rafId) rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    function render(episode) {
      episodeRef = episode;
      const buckets = PDC.episode.assignedBuckets(episode);
      if (buckets.length) ensureLoop();
      else {
        stopLoop();
        ctx.fillStyle = "#05070c";
        ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
      }
      drawFrame();
      return buckets.length;
    }

    function play() {
      playing = true;
      Object.keys(videos).forEach(function (b) {
        const p = videos[b].play();
        if (p && typeof p.catch === "function") p.catch(function () {});
      });
      ensureLoop();
    }

    function pause() {
      playing = false;
      Object.keys(videos).forEach(function (b) {
        videos[b].pause();
      });
    }

    function restart() {
      Object.keys(videos).forEach(function (b) {
        try {
          videos[b].currentTime = 0;
        } catch (e) {
          /* not seekable yet */
        }
      });
      play();
    }

    function setMuted(muted) {
      Object.keys(videos).forEach(function (b) {
        videos[b].muted = muted;
      });
    }

    return {
      setSource,
      clear,
      render,
      play,
      pause,
      restart,
      setMuted,
      isPlaying: function () {
        return playing;
      },
      drawFrame,
    };
  }

  PDC.preview = { createPreview };
})();
