// app/preview.js
// Renders the composed preview from the REAL uploaded video pixels. Each speaker
// is a live <video> element backed by an object URL of the uploaded file; the
// selected preset positions them on a 16:9 stage with CSS percentages. There is
// no canvas and no placeholder — what you see is the decoded uploaded media.
//
// Playback is synchronized: a single Play/Pause/restart drives every speaker
// video together, and looping keeps the composed preview alive for inspection.
// Classic script — exposed on window.PDC.preview.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { getPreset } = PDC.presets;

  // A Preview owns the live <video> elements for the session so that uploaded
  // media survives re-layouts, preset switches, and other UI interaction. We
  // create one <video> per bucket on first upload and reuse it thereafter.
  function createPreview(stageEl) {
    const videos = {}; // bucket -> HTMLVideoElement
    const frames = {}; // bucket -> speaker frame element
    let playing = false;

    function ensureVideo(bucket) {
      let v = videos[bucket];
      if (!v) {
        v = document.createElement("video");
        v.muted = true; // muted is required for programmatic autoplay
        v.loop = true;
        v.playsInline = true;
        v.setAttribute("playsinline", "");
        v.preload = "auto";
        v.dataset.speaker = bucket;
        videos[bucket] = v;
      }
      return v;
    }

    // Point a bucket's video at a fresh object URL, revoking any previous one.
    function setSource(bucket, file) {
      const v = ensureVideo(bucket);
      if (v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
      const url = URL.createObjectURL(file);
      v.dataset.objectUrl = url;
      v.src = url;
      v.load();
      v.addEventListener(
        "loadeddata",
        () => {
          try {
            v.currentTime = 0;
            if (playing) {
              const p = v.play();
              if (p && typeof p.catch === "function") p.catch(() => {});
            }
          } catch (error) {
            /* play may be blocked until decode is stable; ignore */
          }
        },
        { once: true },
      );
      return v;
    }

    function clear(bucket) {
      const v = videos[bucket];
      if (v && v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
      if (frames[bucket]) {
        frames[bucket].remove();
        delete frames[bucket];
      }
      delete videos[bucket];
    }

    function currentPlayhead() {
      const times = Object.values(videos)
        .map((video) => video.currentTime)
        .filter((time) => Number.isFinite(time));
      if (!times.length) return null;
      return Math.max(...times);
    }

    function seekAll(time) {
      if (!Number.isFinite(time) || time < 0) return;
      Object.values(videos).forEach((v) => {
        try {
          v.currentTime = time;
        } catch (error) {
          /* not seekable at the moment; ignore until metadata is loaded */
        }
      });
    }

    // Lay the assigned speaker videos onto the stage using the preset geometry.
    // Keep existing frame and video nodes so decoded buffers stay warm and
    // prevent brief black screens during preset switching.
    function render(episode) {
      const restoreTime = currentPlayhead();
      const buckets = PDC.episode.assignedBuckets(episode);
      const preset = getPreset(episode.presetId) || PDC.presets.PRESETS[0];
      const rects = preset.layout(buckets.length);
      stageEl.dataset.preset = preset.id;
      stageEl.dataset.speakers = String(buckets.length);
      const activeBuckets = new Set(buckets);

      // Remove stale frames when speakers are no longer assigned.
      Object.keys(frames).forEach((bucket) => {
        if (!activeBuckets.has(bucket)) {
          frames[bucket].remove();
          delete frames[bucket];
        }
      });

      buckets.forEach((bucket, i) => {
        const rect = rects[i] || rects[rects.length - 1];
        let frame = frames[bucket];
        if (!frame) {
          frame = document.createElement("div");
          frame.className = "speaker-frame";

          const v = ensureVideo(bucket);
          frame.appendChild(v);

          const tag = document.createElement("span");
          tag.className = "speaker-tag";
          tag.dataset.speakerTag = bucket;
          frame.appendChild(tag);

          frames[bucket] = frame;
        }

        frame.dataset.speaker = bucket;
        frame.style.left = rect.x + "%";
        frame.style.top = rect.y + "%";
        frame.style.width = rect.w + "%";
        frame.style.height = rect.h + "%";
        let tag = frame.querySelector(".speaker-tag");
        if (!tag) {
          tag = document.createElement("span");
          tag.className = "speaker-tag";
          tag.dataset.speakerTag = bucket;
          frame.appendChild(tag);
        }
        // Show the name derived from the speaker's social link when one is set,
        // otherwise the default bucket label — so the preview visibly reflects
        // the per-speaker social context entered during setup.
        tag.textContent = PDC.episode.speakerName(episode, bucket);

        if (!stageEl.contains(frame)) {
          stageEl.appendChild(frame);
        }
      });

      seekAll(restoreTime);

      // Keep playing across re-layout so a preset switch doesn't freeze the preview.
      if (playing) play();
      return buckets.length;
    }

    function play() {
      playing = true;
      Object.values(videos).forEach((v) => {
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      });
    }

    function pause() {
      playing = false;
      Object.values(videos).forEach((v) => v.pause());
    }

    function restart() {
      Object.values(videos).forEach((v) => {
        try {
          v.currentTime = 0;
        } catch (e) {
          /* not yet seekable; ignore */
        }
      });
      play();
    }

    function setMuted(muted) {
      Object.values(videos).forEach((v) => (v.muted = muted));
    }

    return {
      setSource,
      clear,
      render,
      play,
      pause,
      restart,
      setMuted,
      isPlaying: () => playing,
    };
  }

  PDC.preview = { createPreview };
})();
