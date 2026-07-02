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
    // Decoded b-roll images, keyed by moment id. Like the speaker <video>
    // decoders, the pixels live here in the preview (never in the DOM-free
    // episode model); the model only records that a moment has an image.
    const momentImages = {};
    const videoHost = document.createElement("div");
    videoHost.setAttribute("aria-hidden", "true");
    videoHost.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(videoHost);
    let playing = false;
    let rafId = 0;
    let episodeRef = null;
    let referenceTime = 0;

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

    // Recorded WebM (e.g. MediaRecorder output) can report Infinity duration
    // until the element is nudged to its end once. Resolving a real duration
    // lets the scrub bar span the episode and lets export record a full pass.
    // Every path here is bounded — a stuck probe-seek can never wedge loading.
    function normalizeDuration(v, then) {
      if (isFinite(v.duration)) {
        then();
        return;
      }
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        v.removeEventListener("durationchange", onChange);
        try {
          v.currentTime = 0;
        } catch (e) {
          /* not seekable */
        }
        then();
      }
      function onChange() {
        if (isFinite(v.duration)) finish();
      }
      v.addEventListener("durationchange", onChange);
      setTimeout(finish, 3000);
      try {
        v.currentTime = 1e7;
      } catch (e) {
        finish();
      }
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
          normalizeDuration(v, function () {
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
          });
        },
        { once: true },
      );
      return v;
    }

    // Attach an uploaded image file to a b-roll moment. The image decodes off a
    // blob URL (same mechanism as speaker videos) and redraws once ready, so the
    // overlay appears as soon as playback enters the moment's range.
    function setMomentImage(momentId, file) {
      if (!momentId || !file) return;
      clearMomentImage(momentId);
      const url = URL.createObjectURL(file);
      const img = new Image();
      const entry = { img: img, url: url, ready: false };
      momentImages[momentId] = entry;
      img.onload = function () {
        entry.ready = true;
        drawFrame();
      };
      img.onerror = function () {
        clearMomentImage(momentId);
      };
      img.src = url;
    }

    function clearMomentImage(momentId) {
      const entry = momentImages[momentId];
      if (!entry) return;
      if (entry.url) URL.revokeObjectURL(entry.url);
      delete momentImages[momentId];
    }

    function clearMomentImages() {
      Object.keys(momentImages).forEach(clearMomentImage);
    }

    function hasMomentImage(momentId) {
      const entry = momentImages[momentId];
      return !!(entry && entry.ready);
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

      drawActiveMoments(w, h);

      canvasEl.dataset.preset = episodeRef.presetId;
      canvasEl.dataset.speakers = String(buckets.length);
    }

    // Timed visual moments are painted straight onto the stage canvas, over the
    // composed layout, ONLY while the reference playback time is inside their
    // scheduled [start, end) range. Because export records this same canvas,
    // whatever is drawn here is burned into the exported video at the same
    // times. Solid backing bars keep the text legible in screenshots over any
    // preset (Split / Stack / Spotlight) or custom template.
    function drawActiveMoments(w, h) {
      if (!PDC.moments || !episodeRef) return;
      const active = PDC.moments.activeMoments(episodeRef, referenceTime);
      if (!active.length) return;
      ctx.save();
      ctx.textBaseline = "middle";
      active.forEach(function (moment) {
        if (moment.type === "title") drawTitleMoment(moment, w, h);
        else if (moment.type === "broll") drawBrollMoment(moment, w, h);
        else drawCalloutMoment(moment, w, h);
      });
      ctx.restore();
    }

    // B-roll: the uploaded image over the center of the stage, contain-fitted
    // inside a framed panel (distinct from the top title bar and the lower-third
    // callout) so it clearly reads as an inserted visual and is trivially
    // region-sampled. Drawn only once the image has decoded.
    function drawBrollMoment(moment, w, h) {
      const entry = momentImages[moment.id];
      if (!entry || !entry.ready || !entry.img.naturalWidth) return;
      const img = entry.img;
      const boxW = Math.round(w * 0.44);
      const boxH = Math.round(h * 0.44);
      const boxX = Math.round((w - boxW) / 2);
      const boxY = Math.round((h - boxH) / 2);
      const pad = Math.max(4, Math.round(w * 0.006));
      // Dark backing + light frame so the panel reads over any speaker layout.
      ctx.fillStyle = "rgba(5, 7, 12, 0.92)";
      ctx.fillRect(boxX, boxY, boxW, boxH);
      const innerX = boxX + pad;
      const innerY = boxY + pad;
      const innerW = boxW - pad * 2;
      const innerH = boxH - pad * 2;
      // Contain-fit the image inside the inner panel, preserving aspect ratio.
      const scale = Math.min(innerW / img.naturalWidth, innerH / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = innerX + (innerW - dw) / 2;
      const dy = innerY + (innerH - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = Math.max(2, Math.round(w * 0.003));
      ctx.strokeRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2);
      // Optional caption strip along the bottom of the panel.
      if (moment.text) {
        ctx.fillStyle = "rgba(5, 7, 12, 0.82)";
        const capH = Math.round(h * 0.06);
        ctx.fillRect(boxX, boxY + boxH - capH, boxW, capH);
        ctx.fillStyle = "#ffffff";
        ctx.font = "600 " + Math.round(h * 0.032) + "px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(moment.text, boxX + boxW / 2, boxY + boxH - capH / 2, boxW - pad * 4);
      }
    }

    // Episode title: a prominent centered bar across the top of the stage with
    // a dark backing and an accent underline, distinct from speaker labels.
    function drawTitleMoment(moment, w, h) {
      const barX = Math.round(w * 0.07);
      const barY = Math.round(h * 0.055);
      const barW = w - barX * 2;
      const barH = Math.round(h * 0.13);
      ctx.fillStyle = "rgba(5, 7, 12, 0.88)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#6c8cff";
      ctx.fillRect(barX, barY + barH - Math.max(3, Math.round(h * 0.006)), barW, Math.max(3, Math.round(h * 0.006)));
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 " + Math.round(h * 0.062) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(moment.text, w / 2, barY + barH / 2, barW - Math.round(w * 0.04));
    }

    // Callout / reference: a lower-third banner anchored left with an accent
    // edge — visually distinct from the title bar and from speaker name tags.
    function drawCalloutMoment(moment, w, h) {
      ctx.font = "600 " + Math.round(h * 0.046) + "px system-ui, sans-serif";
      const maxTextW = w * 0.7;
      const textW = Math.min(ctx.measureText(moment.text).width, maxTextW);
      const edgeW = Math.max(5, Math.round(w * 0.006));
      const padX = Math.round(w * 0.018);
      const barX = Math.round(w * 0.045);
      const barY = Math.round(h * 0.76);
      const barH = Math.round(h * 0.105);
      const barW = Math.max(Math.round(textW) + edgeW + padX * 2, Math.round(w * 0.34));
      ctx.fillStyle = "rgba(8, 10, 16, 0.9)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#8a6cff";
      ctx.fillRect(barX, barY, edgeW, barH);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.fillText(moment.text, barX + edgeW + padX, barY + barH / 2, maxTextW);
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

    function setMuted(muted) {
      Object.keys(videos).forEach(function (b) {
        videos[b].muted = muted;
      });
    }

    // Longest known speaker duration — the episode timeline the scrubber spans.
    function getDuration() {
      let longest = 0;
      Object.values(videos).forEach(function (v) {
        if (isFinite(v.duration) && v.duration > longest) longest = v.duration;
      });
      return longest;
    }

    function getTime() {
      return referenceTime;
    }

    // Scrub the shared playback timeline to t seconds. Works while playing or
    // paused; the rAF loop keeps compositing, so timed moments show/hide to
    // match the new time on the very next drawn frame.
    function seekTo(t) {
      if (!Number.isFinite(t) || t < 0) return;
      referenceTime = t;
      seekAll(t);
      drawFrame();
    }

    return {
      setSource,
      clear,
      setMomentImage,
      clearMomentImage,
      clearMomentImages,
      hasMomentImage,
      render,
      play,
      pause,
      restart,
      setMuted,
      isPlaying: function () {
        return playing;
      },
      getDuration,
      getTime,
      seekTo,
      drawFrame,
    };
  }

  PDC.preview = { createPreview };
})();
