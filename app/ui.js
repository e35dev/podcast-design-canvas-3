// app/ui.js — browser wiring for the upload → assign → preset → play workflow.
// File inputs are static in index.html (never re-created). Upload uses label-
// wrapped inputs plus drag-and-drop. The composed canvas draws real uploaded
// pixels as soon as two speakers are assigned.
(function () {
  const PDC = window.PDC;
  const { PRESETS, BUCKET_LABELS, SPEAKER_BUCKETS } = PDC.presets;
  const { createEpisode, assignMedia, clearMedia, assignedBuckets, setPreset, canCompose, readinessReason } = PDC.episode;

  const $ = function (id) {
    return document.getElementById(id);
  };

  const episode = createEpisode({ title: "Episode 1" });
  const preview = PDC.preview.createPreview($("stage-canvas"));

  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogg|ogv|avi|mkv)$/i;

  function isVideoFile(file) {
    if (!file) return false;
    if (file.type && /^video\//i.test(file.type)) return true;
    return VIDEO_EXT.test(file.name || "");
  }

  function updateBucketRow(bucket) {
    const row = document.querySelector('.bucket[data-bucket="' + bucket + '"]');
    if (!row) return;
    const m = episode.media[bucket];
    const status = row.querySelector('[data-status="' + bucket + '"]');
    if (status) status.textContent = m ? m.name : "No file";
    row.classList.toggle("filled", !!m);
  }

  function ingestFile(bucket, file) {
    if (!isVideoFile(file)) return false;
    assignMedia(episode, bucket, { name: file.name, size: file.size, type: file.type || "video/*" });
    preview.setSource(bucket, file);
    updateBucketRow(bucket);
    return true;
  }

  function afterMediaChange() {
    if (canCompose(episode)) preview.render(episode);
    else preview.render(episode);
    refresh();
  }

  function onFilesForBucket(bucket, fileList) {
    const files = Array.from(fileList || []).filter(isVideoFile);
    if (!files.length) return;
    ingestFile(bucket, files[0]);
    afterMediaChange();
  }

  // --- Wire static file inputs (present on first paint) --------------------
  document.querySelectorAll('input[type="file"][data-bucket]').forEach(function (input) {
    const bucket = input.getAttribute("data-bucket");
    function handle() {
      onFilesForBucket(bucket, input.files);
      input.value = "";
    }
    input.addEventListener("change", handle);
    input.addEventListener("input", handle);
  });

  // --- Drag-and-drop onto each bucket --------------------------------------
  document.querySelectorAll(".bucket-drop").forEach(function (zone) {
    const bucket = zone.getAttribute("data-drop");
    ["dragover", "dragenter"].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.add("drag");
      });
    });
    ["dragleave", "drop"].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        zone.classList.remove("drag");
      });
    });
    zone.addEventListener("drop", function (e) {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) onFilesForBucket(bucket, [file]);
    });
  });

  // --- Preset buttons -------------------------------------------------------
  const presetsEl = $("presets");
  PRESETS.forEach(function (p) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset" + (p.id === episode.presetId ? " selected" : "");
    btn.dataset.preset = p.id;
    btn.setAttribute("aria-pressed", String(p.id === episode.presetId));
    btn.innerHTML = "<strong>" + p.name + "</strong><span>" + p.description + "</span>";
    btn.addEventListener("click", function () {
      setPreset(episode, p.id);
      Array.prototype.forEach.call(presetsEl.children, function (c) {
        const on = c.dataset.preset === p.id;
        c.classList.toggle("selected", on);
        c.setAttribute("aria-pressed", String(on));
      });
      if (canCompose(episode)) preview.render(episode);
      refresh();
    });
    presetsEl.appendChild(btn);
  });

  // --- Transport ------------------------------------------------------------
  $("play").addEventListener("click", function () {
    if (preview.isPlaying()) preview.pause();
    else preview.play();
    refresh();
  });
  $("restart").addEventListener("click", function () {
    preview.restart();
  });
  $("mute").addEventListener("click", function () {
    const next = $("mute").getAttribute("aria-pressed") !== "true";
    preview.setMuted(!next);
    $("mute").setAttribute("aria-pressed", String(next));
    $("mute").textContent = next ? "🔊 Sound on" : "🔇 Muted";
  });

  function refresh() {
    const ready = canCompose(episode);
    const n = assignedBuckets(episode).length;
    $("stage-canvas").classList.toggle("ready", ready);
    $("empty").hidden = ready;
    $("readiness").textContent = ready
      ? n + " speaker" + (n === 1 ? "" : "s") + " assigned — click Play preview to watch the “" + PDC.presets.getPreset(episode.presetId).name + "” layout."
      : readinessReason(episode);

    const playBtn = $("play");
    playBtn.disabled = !ready;
    playBtn.textContent = preview.isPlaying() ? "⏸ Pause" : "▶ Play preview";
    $("restart").disabled = !ready;
    $("mute").disabled = !ready;
  }

  SPEAKER_BUCKETS.forEach(updateBucketRow);
  refresh();
})();
