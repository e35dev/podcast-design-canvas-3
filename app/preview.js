// app/preview.js
// Composes the preview on a 16:9 canvas by drawing real uploaded video frames
// (ctx.drawImage) into preset layout rects. Hidden <video> elements decode files;
// the canvas is what users and screenshot-based review see — canvas pixels are
// always captured, unlike raw <video> layers in some headless environments.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { getPreset } = PDC.presets;

  function createPreview(canvasEl) {
    const ctx = canvasEl.getContext("2d");
    const videos = {};
    const videoHost = document.createElement("div");
    videoHost.setAttribute("aria-hidden", "true");
    videoHost.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(videoHost);
    let playing = false;
    let rafId = 0;
    let episodeRef = null;
    let referenceTime = 0;

    function mediaDuration() {
      const durations = Object.values(videos)
        .map((video) => video.duration)
        .filter((d) => Number.isFinite(d) && d > 0);
      return durations.length ? Math.max(...durations) : 0;
    }

    function syncReferenceTime() {
      const times = Object.values(videos)
        .map((video) => video.currentTime)
        .filter((time) => Number.isFinite(time))
        .filter((time) => time > 0);
      if (!times.length) return referenceTime;
      const next = Math.min(...times);
      referenceTime = next;
      return next;
    }

    function seekAll(time) {
      if (!Number.isFinite(time)) return;
      Object.values(videos).forEach((video) => {
        try {
          video.currentTime = time;
        } catch (error) {
          /* not seekable yet */
        }
      });
    }

    function alignPlayback(time) {
      referenceTime = syncReferenceTime();
      const target = Number.isFinite(time) ? Math.min(referenceTime, time) : referenceTime;
      seekAll(target);
      return target;
    }

    function ensureVideo(bucket) {
      let v = videos[bucket];
      if (!v) {
        v = document.createElement("video");
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.setAttribute("playsinline", "");
        v.preload = "auto";
        v.dataset.speaker = bucket;
        v.addEventListener("loadeddata", drawFrame);
        v.addEventListener("canplay", drawFrame);
        videoHost.appendChild(v);
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
      v.addEventListener(
        "loadeddata",
        function seekFirstFrame() {
          v.removeEventListener("loadeddata", seekFirstFrame);
          try {
            if (v.currentTime === 0) v.currentTime = Math.max(0, referenceTime);
          } catch (e) {
            /* not seekable yet */
          }
          alignPlayback(referenceTime);
          drawFrame();
          if (playing) {
            const p = v.play();
            if (p && typeof p.catch === "function") p.catch(function () {});
          }
        },
        { once: true },
      );
      return v;
    }

    function clear(bucket) {
      const v = videos[bucket];
      if (v) {
        if (v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
        v.remove();
      }
      delete videos[bucket];
    }

    function drawFrame() {
      if (!episodeRef) return;
      const now = syncReferenceTime();
      const buckets = PDC.episode.assignedBuckets(episodeRef);
      const rects = PDC.templates
        ? PDC.templates.resolveLayout(episodeRef, buckets.length)
        : (getPreset(episodeRef.presetId) || PDC.presets.PRESETS[0]).layout(buckets.length);
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

        // Clip each speaker to its layout rect so cover-scaled frames cannot bleed
        // into neighboring rows (Stack) or outside their PiP inset (Spotlight).
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, rw, rh);
        ctx.clip();

        if (v && v.videoWidth > 0) {
          const scale = Math.max(rw / v.videoWidth, rh / v.videoHeight);
          const dw = v.videoWidth * scale;
          const dh = v.videoHeight * scale;
          const dx = x + (rw - dw) / 2;
          const dy = y + (rh - dh) / 2;
          ctx.drawImage(v, dx, dy, dw, dh);
        }
        ctx.restore();

        // Spotlight guest feeds are small insets — a light frame makes them read
        // as clearly subordinate picture-in-picture overlays on the host frame.
        if (rw < w * 0.75 && rh < h * 0.75) {
          ctx.strokeStyle = "rgba(255,255,255,0.88)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, rw - 2, rh - 2);
        }

        const label = PDC.episode.speakerName(episodeRef, bucket);
        if (label) {
          ctx.fillStyle = "rgba(8,10,16,0.72)";
          ctx.fillRect(x + 8, y + rh - 28, Math.min(rw - 16, label.length * 9 + 20), 22);
          ctx.fillStyle = "#fff";
          ctx.font = "600 14px system-ui, sans-serif";
          ctx.fillText(label, x + 14, y + rh - 12);
        }
      });

      const activeMoments = PDC.episode.activeVisualMomentsAt(episodeRef, now);
      drawMomentsOverlay(activeMoments, w, h);
      canvasEl.dataset.momentText = activeMoments.map((it) => it.text).join("|");
      canvasEl.dataset.momentCount = String(activeMoments.length);
      canvasEl.dataset.previewTime = String(Number(now || 0).toFixed(2));

      canvasEl.dataset.preset = episodeRef.presetId;
      canvasEl.dataset.speakers = String(buckets.length);
    }

    function drawMomentsOverlay(activeMoments, w, h) {
      if (!activeMoments || !activeMoments.length) return;
      const titles = activeMoments.filter((it) => it.type === "title");
      const callouts = activeMoments.filter((it) => it.type !== "title");

      if (titles.length) {
        const title = titles[0];
        const boxW = Math.min(w * 0.82, Math.max(280, title.text.length * 13));
        const x = (w - boxW) / 2;
        const y = Math.max(20, h * 0.04);
        ctx.fillStyle = "rgba(12, 16, 30, 0.74)";
        ctx.fillRect(x, y, boxW, 56);
        ctx.strokeStyle = "rgba(168, 188, 255, 0.9)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, boxW - 2, 54);
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 28px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(title.text, x + boxW / 2, y + 30);
      }

      if (callouts.length) {
        const rowH = 38;
        callouts.slice(0, 2).forEach(function (callout, idx) {
          const boxW = Math.min(w * 0.74, Math.max(300, callout.text.length * 11));
          const x = (w - boxW) / 2;
          const y = h - 32 - rowH * (callouts.length - idx);
          ctx.fillStyle = "rgba(0, 0, 0, 0.68)";
          ctx.fillRect(x, y, boxW, rowH);
          ctx.strokeStyle = "rgba(72, 214, 168, 0.94)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, boxW - 2, rowH - 2);
          ctx.fillStyle = "#f7fff7";
          ctx.font = "600 20px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(callout.text, x + boxW / 2, y + rowH / 2 + 1);
        });
      }
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    function loop() {
      syncReferenceTime();
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
        canvasEl.dataset.preset = "";
        canvasEl.dataset.speakers = "0";
      }
      drawFrame();
      return buckets.length;
    }

    function play() {
      playing = true;
      const targetTime = alignPlayback(0);
      Object.keys(videos).forEach(function (b) {
        const p = videos[b].play();
        if (p && typeof p.catch === "function") p.catch(function () {});
      });
      ensureLoop();
      if (Number.isFinite(targetTime)) {
        seekAll(targetTime);
      }
    }

    function pause() {
      playing = false;
      syncReferenceTime();
      Object.keys(videos).forEach(function (b) {
        videos[b].pause();
      });
    }

    function restart() {
      referenceTime = 0;
      Object.keys(videos).forEach(function (b) {
        try {
          videos[b].currentTime = 0;
        } catch (e) {
          /* not seekable yet */
        }
      });
      play();
    }

    function seek(time) {
      const duration = mediaDuration();
      const t = Number(time);
      if (!Number.isFinite(t)) return referenceTime;
      const next = Math.max(0, duration ? Math.min(t, duration) : t);
      referenceTime = next;
      seekAll(next);
      drawFrame();
      return next;
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
      getCurrentTime: function () {
        return syncReferenceTime();
      },
      getDuration: mediaDuration,
      seek,
      drawFrame,
    };
  }

  PDC.preview = { createPreview };
})();
