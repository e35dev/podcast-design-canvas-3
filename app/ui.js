// app/ui.js  (browser entry — classic script, runs last)
// Wires the real product workflow to the DOM:
//   upload speaker videos -> assign to Host/Guest buckets -> pick a preset
//   -> click Play to see a synchronized composed preview of the uploaded pixels.
//
// Each speaker bucket has its own visible Upload button that opens a file picker.
// A bulk "Add multiple videos" control fills empty buckets in order. The preview
// renders real <video> elements as soon as two buckets are filled; Play is enabled
// and starts synchronized playback. Everything reads logic from window.PDC so it
// works over http:// and file:// alike (no ES modules).
(function () {
  const PDC = window.PDC;
  const { PRESETS, BUCKET_LABELS, SPEAKER_BUCKETS } = PDC.presets;
  const { createEpisode, assignMedia, clearMedia, assignedBuckets, setPreset, canCompose, readinessReason } = PDC.episode;

  const $ = (id) => document.getElementById(id);

  const episode = createEpisode({ title: "Episode 1" });
  const preview = PDC.preview.createPreview($("stage"));

  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogg|ogv|avi|mkv)$/i;

  function isVideoFile(file) {
    if (!file) return false;
    if (file.type && /^video\//i.test(file.type)) return true;
    return VIDEO_EXT.test(file.name || "");
  }

  function ingestFile(bucket, file) {
    if (!isVideoFile(file)) return false;
    assignMedia(episode, bucket, { name: file.name, size: file.size, type: file.type || "video/*" });
    preview.setSource(bucket, file);
    return true;
  }

  function afterMediaChange() {
    renderBuckets();
    if (canCompose(episode)) {
      preview.render(episode);
    } else {
      $("stage").innerHTML = "";
    }
    refresh();
  }

  // --- Preset buttons (one selected by default) ---------------------------
  const presetsEl = $("presets");
  PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset" + (p.id === episode.presetId ? " selected" : "");
    btn.dataset.preset = p.id;
    btn.setAttribute("aria-pressed", String(p.id === episode.presetId));
    btn.innerHTML = `<strong>${p.name}</strong><span>${p.description}</span>`;
    btn.addEventListener("click", () => {
      setPreset(episode, p.id);
      [...presetsEl.children].forEach((c) => {
        const on = c.dataset.preset === p.id;
        c.classList.toggle("selected", on);
        c.setAttribute("aria-pressed", String(on));
      });
      if (canCompose(episode)) preview.render(episode);
      refresh();
    });
    presetsEl.appendChild(btn);
  });

  // --- Per-bucket upload: visible button + hidden file input per speaker ---
  const bucketsEl = $("buckets");

  function handleFilesForBucket(bucket, fileList) {
    const files = Array.from(fileList || []).filter(isVideoFile);
    if (!files.length) return;
    ingestFile(bucket, files[0]);
    afterMediaChange();
  }

  function renderBuckets() {
    bucketsEl.innerHTML = "";
    SPEAKER_BUCKETS.forEach((bucket) => {
      const m = episode.media[bucket];
      const row = document.createElement("div");
      row.className = "bucket" + (m ? " filled" : "");
      row.dataset.bucket = bucket;

      const name = document.createElement("span");
      name.className = "bucket-name";
      name.textContent = BUCKET_LABELS[bucket];

      const status = document.createElement("span");
      status.className = "bucket-status";
      status.dataset.status = bucket;
      status.textContent = m ? m.name : "No file";

      const actions = document.createElement("div");
      actions.className = "bucket-actions";

      const inputId = `upload-${bucket}`;
      const input = document.createElement("input");
      input.type = "file";
      input.id = inputId;
      input.hidden = true;
      input.accept = "video/*,.mp4,.webm,.mov,.m4v,.ogg";
      input.setAttribute("aria-label", `Upload video for ${BUCKET_LABELS[bucket]}`);
      input.addEventListener("change", (e) => {
        handleFilesForBucket(bucket, e.target.files);
        e.target.value = "";
      });

      const uploadBtn = document.createElement("button");
      uploadBtn.type = "button";
      uploadBtn.className = "bucket-upload";
      uploadBtn.textContent = m ? "Replace" : "Upload";
      uploadBtn.setAttribute("aria-controls", inputId);
      uploadBtn.addEventListener("click", () => input.click());

      actions.appendChild(input);
      actions.appendChild(uploadBtn);

      if (m) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "bucket-remove";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          clearMedia(episode, bucket);
          preview.clear(bucket);
          afterMediaChange();
        });
        actions.appendChild(remove);
      }

      row.appendChild(name);
      row.appendChild(status);
      row.appendChild(actions);
      bucketsEl.appendChild(row);
    });
  }

  // --- Bulk upload: fills empty buckets in canonical order ------------------
  const bulkInput = $("bulk-files");
  $("bulk-upload").addEventListener("click", () => bulkInput.click());
  bulkInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []).filter(isVideoFile);
    if (!files.length) return;

    files.forEach((file) => {
      const target = SPEAKER_BUCKETS.find((b) => !episode.media[b]) || SPEAKER_BUCKETS[SPEAKER_BUCKETS.length - 1];
      ingestFile(target, file);
    });

    e.target.value = "";
    afterMediaChange();
  });

  // --- Transport controls -------------------------------------------------
  $("play").addEventListener("click", () => {
    if (preview.isPlaying()) preview.pause();
    else preview.play();
    refresh();
  });
  $("restart").addEventListener("click", () => preview.restart());
  $("mute").addEventListener("click", () => {
    const next = $("mute").getAttribute("aria-pressed") !== "true";
    preview.setMuted(!next);
    $("mute").setAttribute("aria-pressed", String(next));
    $("mute").textContent = next ? "🔊 Sound on" : "🔇 Muted";
  });

  // --- Shared state refresh ----------------------------------------------
  function refresh() {
    const ready = canCompose(episode);
    const n = assignedBuckets(episode).length;
    $("stage").classList.toggle("ready", ready);
    $("empty").hidden = ready;
    $("readiness").textContent = ready
      ? `${n} speaker${n === 1 ? "" : "s"} assigned — click Play preview to watch the “${PDC.presets.getPreset(episode.presetId).name}” layout.`
      : readinessReason(episode);

    const playBtn = $("play");
    playBtn.disabled = !ready;
    playBtn.textContent = preview.isPlaying() ? "⏸ Pause" : "▶ Play preview";
    $("restart").disabled = !ready;
    $("mute").disabled = !ready;
  }

  renderBuckets();
  refresh();
})();
