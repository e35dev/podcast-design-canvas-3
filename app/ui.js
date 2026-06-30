// app/ui.js — browser wiring for upload → social links → preset → canvas preview.
(function () {
  const PDC = window.PDC;
  const { PRESETS, BUCKET_LABELS, SPEAKER_BUCKETS } = PDC.presets;
  const { createEpisode, assignMedia, clearMedia, assignedBuckets, setPreset, setSocialLink, speakerName, canCompose, readinessReason } = PDC.episode;

  const $ = function (id) {
    return document.getElementById(id);
  };

  const episode = createEpisode({ title: "Episode 1" });
  const preview = PDC.preview.createPreview($("stage-canvas"));

  // Exporter reuses the SAME canvas the preview draws to (so the recorded file
  // contains real footage in the active preset) and the live decoder videos
  // (for the real audio mix).
  const exporter = PDC.exporter.createExporter({
    canvas: $("stage-canvas"),
    getMediaElements: function () {
      return preview.getMediaElements();
    },
    getEpisode: function () {
      return episode;
    },
  });
  let lastExportUrl = null;
  let exporting = false;

  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogg|ogv|avi|mkv)$/i;

  function isVideoFile(file) {
    if (!file) return false;
    if (file.type && /^video\//i.test(file.type)) return true;
    return VIDEO_EXT.test(file.name || "");
  }

  function updateDerived(bucket) {
    const derived = document.querySelector('[data-derived="' + bucket + '"]');
    if (!derived) return;
    const link = episode.socialLinks && episode.socialLinks[bucket];
    derived.textContent = link ? "Shown as: " + speakerName(episode, bucket) : "";
  }

  function updateBucketRow(bucket) {
    const row = document.querySelector('.bucket[data-bucket="' + bucket + '"]');
    if (!row) return;
    const m = episode.media[bucket];
    const status = row.querySelector('[data-status="' + bucket + '"]');
    if (status) status.textContent = m ? m.name : "No file";
    const nameEl = row.querySelector(".bucket-name");
    if (nameEl) nameEl.textContent = speakerName(episode, bucket);
    row.classList.toggle("filled", !!m);
    updateDerived(bucket);
  }

  function afterMediaChange() {
    preview.render(episode);
    if (canCompose(episode)) preview.play();
    refresh();
  }

  function ingestFile(bucket, file) {
    if (!isVideoFile(file)) return false;
    assignMedia(episode, bucket, { name: file.name, size: file.size, type: file.type || "video/*" });
    preview.setSource(bucket, file);
    updateBucketRow(bucket);
    return true;
  }

  function onFilesForBucket(bucket, fileList) {
    const files = Array.from(fileList || []).filter(isVideoFile);
    if (!files.length) return;
    ingestFile(bucket, files[0]);
    afterMediaChange();
  }

  document.querySelectorAll("input[data-file-bucket]").forEach(function (input) {
    const bucket = input.getAttribute("data-file-bucket");
    function handle() {
      onFilesForBucket(bucket, input.files);
      input.value = "";
    }
    input.addEventListener("change", handle);
    input.addEventListener("input", handle);
  });

  document.querySelectorAll("input[data-link-bucket]").forEach(function (input) {
    const bucket = input.getAttribute("data-link-bucket");
    input.addEventListener("input", function () {
      setSocialLink(episode, bucket, input.value);
      updateBucketRow(bucket);
      if (canCompose(episode)) {
        preview.render(episode);
        preview.play();
      }
      refresh();
    });
  });

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
      preview.render(episode);
      if (canCompose(episode)) preview.play();
      refresh();
    });
    presetsEl.appendChild(btn);
  });

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

  function setExportStatus(text) {
    const el = $("export-status");
    if (el) el.textContent = text || "";
  }

  $("export").addEventListener("click", async function () {
    if (exporting || !canCompose(episode)) return;
    exporting = true;
    const btn = $("export");
    const progress = $("export-progress");
    const result = $("export-result");
    btn.disabled = true;
    btn.textContent = "● Recording…";
    if (result) result.hidden = true;
    if (progress) {
      progress.hidden = false;
      progress.value = 0;
    }
    setExportStatus("Recording the composed preview…");

    // Make sure the preview is actively drawing real frames while we record.
    if (!preview.isPlaying()) preview.play();

    try {
      const plan = exporter.buildPlan();
      const out = await exporter.record({
        durationMs: PDC.exporter.DEFAULT_DURATION_MS,
        fps: 30,
        onProgress: function (pct) {
          if (progress) progress.value = pct;
        },
      });

      if (!out || !out.blob || out.blob.size < 1) {
        throw new Error("Export produced an empty file.");
      }

      if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
      lastExportUrl = URL.createObjectURL(out.blob);

      const fileName = PDC.exporter.exportFileName(episode, plan);
      const link = $("export-download");
      link.href = lastExportUrl;
      link.setAttribute("download", fileName);
      link.textContent = "Download " + fileName + " (" + Math.round(out.blob.size / 1024) + " KB)";

      const video = $("export-video");
      video.src = lastExportUrl;
      video.load();

      // Expose the recorded bytes for headless verification (live-run only; not
      // a committed artifact). The verifier reads window.__lastExport.bytes.
      try {
        const buf = await out.blob.arrayBuffer();
        window.__lastExport = {
          size: out.blob.size,
          mimeType: out.mimeType,
          fileName: fileName,
          presetId: plan.presetId,
          tiles: plan.tiles,
          bytes: Array.from(new Uint8Array(buf.slice(0, 64))),
        };
      } catch (e) {
        window.__lastExport = { size: out.blob.size, mimeType: out.mimeType, fileName: fileName, presetId: plan.presetId };
      }

      // Trigger the real download.
      const a = document.createElement("a");
      a.href = lastExportUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();

      if (result) result.hidden = false;
      setExportStatus(
        "Exported " + Math.round(out.blob.size / 1024) + " KB in the “" + plan.presetName + "” layout with " +
          plan.tiles.map(function (t) { return t.name; }).join(" + ") + ".",
      );
    } catch (err) {
      setExportStatus("Export failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      if (progress) progress.hidden = true;
      exporting = false;
      btn.textContent = "⬇ Export episode video";
      btn.disabled = !canCompose(episode);
    }
  });

  function refresh() {
    const ready = canCompose(episode);
    const n = assignedBuckets(episode).length;
    $("stage-canvas").classList.toggle("ready", ready);
    $("empty").hidden = ready;
    $("readiness").textContent = ready
      ? "Previewing " + n + " speaker" + (n === 1 ? "" : "s") + " in the “" + PDC.presets.getPreset(episode.presetId).name + "” layout."
      : readinessReason(episode);

    const playBtn = $("play");
    playBtn.disabled = !ready;
    playBtn.textContent = preview.isPlaying() ? "⏸ Pause" : "▶ Play preview";
    $("restart").disabled = !ready;
    $("mute").disabled = !ready;
    const exportBtn = $("export");
    if (exportBtn && !exporting) exportBtn.disabled = !ready;
  }

  SPEAKER_BUCKETS.forEach(updateBucketRow);
  refresh();
})();
