// app/ui.js — browser wiring for upload → social links → preset/template → preview.
(function () {
  const PDC = window.PDC;
  const { PRESETS, BUCKET_LABELS, SPEAKER_BUCKETS } = PDC.presets;
  const {
    createEpisode,
    assignMedia,
    assignedBuckets,
    setPreset,
    applyTemplate,
    layoutName,
    setSocialLink,
    speakerName,
    canCompose,
    readinessReason,
  } = PDC.episode;

  const $ = function (id) {
    return document.getElementById(id);
  };

  const episode = createEpisode({ title: "Episode 1" });
  const preview = PDC.preview.createPreview($("stage-canvas"));
  const layoutEditor = PDC.layoutEditor.createLayoutEditor({
    stageWrap: $("stage-wrap"),
    overlay: $("layout-editor"),
    framesHost: $("layout-frames"),
  });

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

  function syncPresetSelection() {
    const presetsEl = $("presets");
    Array.prototype.forEach.call(presetsEl.children, function (c) {
      const on = episode.layoutSource === "preset" && c.dataset.preset === episode.presetId;
      c.classList.toggle("selected", on);
      c.setAttribute("aria-pressed", String(on));
    });
  }

  function renderTemplateList() {
    const list = $("template-list");
    list.innerHTML = "";
    const templates = PDC.templates.listTemplates();
    if (!templates.length) {
      list.innerHTML = '<p class="hint">No saved templates yet. Customize frames and save one.</p>';
      return;
    }
    templates.forEach(function (template) {
      const row = document.createElement("div");
      row.className = "template-item" + (episode.layoutSource === "template" && episode.templateId === template.id ? " selected" : "");
      row.setAttribute("role", "listitem");
      row.innerHTML = "<strong>" + template.name + "</strong>";
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.textContent = episode.layoutSource === "template" && episode.templateId === template.id ? "Applied" : "Apply template";
      applyBtn.addEventListener("click", function () {
        applyTemplate(episode, template.id);
        syncPresetSelection();
        renderTemplateList();
        preview.render(episode);
        if (canCompose(episode)) preview.play();
        $("layout-status").textContent = "Applied template “" + template.name + "”.";
        refresh();
      });
      row.appendChild(applyBtn);
      list.appendChild(row);
    });
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
    function handle() {
      setSocialLink(episode, bucket, input.value);
      updateBucketRow(bucket);
      if (canCompose(episode)) {
        preview.render(episode);
        preview.play();
      }
      refresh();
    }
    ["input", "change"].forEach(function (evt) {
      input.addEventListener(evt, handle);
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
      syncPresetSelection();
      renderTemplateList();
      preview.render(episode);
      if (canCompose(episode)) preview.play();
      $("layout-status").textContent = "";
      refresh();
    });
    presetsEl.appendChild(btn);
  });

  $("open-layout-editor").addEventListener("click", function () {
    if (!canCompose(episode)) return;
    layoutEditor.open(episode, function (draftRects) {
      preview.setDraftLayout(draftRects);
    });
    $("layout-save").hidden = false;
    $("layout-status").textContent = "Drag speaker frames to reposition them, then save as a template.";
    refresh();
  });

  $("close-layout-editor").addEventListener("click", function () {
    layoutEditor.close();
    preview.clearDraftLayout();
    preview.render(episode);
    $("layout-save").hidden = true;
    refresh();
  });

  $("save-template").addEventListener("click", function () {
    const name = ($("template-name").value || "").trim();
    if (!name) {
      $("layout-status").textContent = "Enter a template name before saving.";
      return;
    }
    try {
      const template = PDC.templates.createTemplate(name, layoutEditor.getDraftRects());
      applyTemplate(episode, template.id);
      layoutEditor.close();
      preview.clearDraftLayout();
      $("layout-save").hidden = true;
      $("template-name").value = "";
      syncPresetSelection();
      renderTemplateList();
      preview.render(episode);
      preview.play();
      $("layout-status").textContent = "Saved and applied template “" + template.name + "”.";
      refresh();
    } catch (err) {
      $("layout-status").textContent = err && err.message ? err.message : "Could not save template.";
    }
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

  $("export").addEventListener("click", async function () {
    if (!canCompose(episode)) return;
    const btn = $("export");
    btn.disabled = true;
    btn.textContent = "⏳ Exporting…";
    preview.play();
    $("export-progress").hidden = false;
    $("export-result").hidden = true;
    try {
      const out = await PDC.exporter.exportEpisode($("stage-canvas"), {
        fps: 30,
        onProgress: function (p) {
          $("export-bar").style.width = Math.round(p * 100) + "%";
        },
      });
      const layoutSlug =
        episode.layoutSource === "template" && episode.templateId
          ? layoutName(episode).replace(/[^\w.-]+/g, "_")
          : PDC.presets.getPreset(episode.presetId).id;
      const fname = (episode.title || "episode").replace(/[^\w.-]+/g, "_") + "-" + layoutSlug + ".webm";
      PDC.exporter.download(out.url, fname);
      const result = $("export-result");
      result.hidden = false;
      result.innerHTML =
        "Exported <strong>" + fname + "</strong> — " + Math.round(out.bytes / 1024) + " KB, " +
        "“" + layoutName(episode) + "” layout. " +
        '<a id="export-download" href="' + out.url + '" download="' + fname + '">Download again</a>';
      const v = document.createElement("video");
      v.id = "export-playback";
      v.src = out.url;
      v.controls = true;
      v.muted = true;
      v.style.cssText = "display:block;margin-top:8px;max-width:320px;width:100%";
      result.appendChild(v);
    } catch (err) {
      $("export-result").hidden = false;
      $("export-result").textContent = "Export failed: " + (err && err.message);
    } finally {
      btn.disabled = !canCompose(episode);
      btn.textContent = "⬇ Export video";
    }
  });

  function refresh() {
    const ready = canCompose(episode);
    const n = assignedBuckets(episode).length;
    $("stage-canvas").classList.toggle("ready", ready);
    $("empty").hidden = ready;
    $("readiness").textContent = ready
      ? "Previewing " + n + " speaker" + (n === 1 ? "" : "s") + " in the “" + layoutName(episode) + "” layout."
      : readinessReason(episode);

    const playBtn = $("play");
    playBtn.disabled = !ready;
    playBtn.textContent = preview.isPlaying() ? "⏸ Pause" : "▶ Play preview";
    $("restart").disabled = !ready;
    $("mute").disabled = !ready;
    $("open-layout-editor").disabled = !ready;
    const exportBtn = $("export");
    if (exportBtn && exportBtn.textContent.indexOf("Exporting") === -1) exportBtn.disabled = !ready;
  }

  SPEAKER_BUCKETS.forEach(updateBucketRow);
  renderTemplateList();
  refresh();

  PDC.ui = { layoutEditor: layoutEditor, episode: episode };
})();
