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
      return v;
    }

    function clear(bucket) {
      const v = videos[bucket];
      if (v && v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
      delete videos[bucket];
    }

    // Lay the assigned speaker videos onto the stage using the preset geometry.
    // Rebuilding the stage children is cheap and keeps DOM order == speaker order.
    function render(episode) {
      const buckets = PDC.episode.assignedBuckets(episode);
      const preset = getPreset(episode.presetId) || PDC.presets.PRESETS[0];
      const rects = preset.layout(buckets.length);

      stageEl.innerHTML = "";
      stageEl.dataset.preset = preset.id;
      stageEl.dataset.speakers = String(buckets.length);

      buckets.forEach((bucket, i) => {
        const rect = rects[i] || rects[rects.length - 1];
        const frame = document.createElement("div");
        frame.className = "speaker-frame";
        frame.dataset.speaker = bucket;
        frame.style.left = rect.x + "%";
        frame.style.top = rect.y + "%";
        frame.style.width = rect.w + "%";
        frame.style.height = rect.h + "%";

        const v = ensureVideo(bucket);
        frame.appendChild(v);

        const tag = document.createElement("span");
        tag.className = "speaker-tag";
        tag.textContent = PDC.presets.BUCKET_LABELS[bucket];
        frame.appendChild(tag);

        stageEl.appendChild(frame);
      });

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
