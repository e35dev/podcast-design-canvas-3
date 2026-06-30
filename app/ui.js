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
      if (editor.isOpen()) closeEditor();
      applyLayout(p.id);
    });
    presetsEl.appendChild(btn);
  });

  const templatesEl = $("templates");
  const editor = PDC.editor.createEditor({
    overlayEl: $("edit-overlay"),
    onChange: function (rects) {
      // Live: feed the dragged/resized rects to the preview as a draft layout.
      PDC.templates.setDraft(rects);
      setPreset(episode, PDC.templates.DRAFT_ID);
      preview.render(episode);
    },
  });

  // The id + display name of the currently selected layout (preset or template).
  function currentLayout() {
    const preset = PDC.presets.getPreset(episode.presetId);
    if (preset) return { id: preset.id, name: preset.name };
    const t = PDC.templates.getTemplate(episode.presetId);
    if (t) return { id: t.id, name: t.name };
    return { id: episode.presetId || "custom", name: "Custom" };
  }

  // Apply any layout (preset id or saved template id) and sync selection state.
  function applyLayout(id) {
    setPreset(episode, id);
    markSelected(id);
    preview.render(episode);
    if (canCompose(episode)) preview.play();
    refresh();
  }

  function markSelected(id) {
    [presetsEl, templatesEl].forEach(function (group) {
      Array.prototype.forEach.call(group.children, function (c) {
        const on = c.dataset.layout === id || c.dataset.preset === id;
        c.classList.toggle("selected", on);
        c.setAttribute("aria-pressed", String(on));
      });
    });
  }

  function renderTemplates() {
    templatesEl.innerHTML = "";
    PDC.templates.listTemplates().forEach(function (t) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset template" + (t.id === episode.presetId ? " selected" : "");
      btn.dataset.layout = t.id;
      btn.setAttribute("aria-pressed", String(t.id === episode.presetId));
      btn.innerHTML = "<strong>" + t.name + "</strong><span>Custom layout</span>";
      btn.addEventListener("click", function () {
        if (editor.isOpen()) closeEditor();
        applyLayout(t.id);
      });
      templatesEl.appendChild(btn);
    });
  }

  function openEditor() {
    if (!canCompose(episode)) return;
    const buckets = assignedBuckets(episode);
    const initial = PDC.templates.resolveLayout(episode, buckets.length);
    editor.open(buckets, initial, function (b) { return speakerName(episode, b); });
    $("customize-edit").hidden = false;
    $("customize-hint").hidden = false;
    $("customize").textContent = "✎ Editing layout";
    $("customize").disabled = true;
  }

  function closeEditor() {
    editor.close();
    PDC.templates.clearDraft();
    $("customize-edit").hidden = true;
    $("customize-hint").hidden = true;
    $("customize").textContent = "✎ Customize layout";
    $("customize").disabled = !canCompose(episode);
  }

  $("customize").addEventListener("click", openEditor);
  $("cancel-customize").addEventListener("click", function () {
    // Revert to the previously selected layout (fall back to the first preset).
    const prev = PDC.templates.isTemplate(episode.presetId) && episode.presetId !== PDC.templates.DRAFT_ID
      ? episode.presetId
      : PRESETS[0].id;
    closeEditor();
    applyLayout(prev);
  });
  $("save-template").addEventListener("click", function () {
    const name = ($("template-name").value || "").trim() || "Custom layout";
    const t = PDC.templates.saveTemplate(name, editor.getRects());
    $("template-name").value = "";
    closeEditor();
    renderTemplates();
    applyLayout(t.id);
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
    preview.play(); // ensure the canvas is composing live frames while we capture
    $("export-progress").hidden = false;
    $("export-result").hidden = true;
    try {
      const out = await PDC.exporter.exportEpisode($("stage-canvas"), {
        fps: 30,
        onProgress: function (p) { $("export-bar").style.width = Math.round(p * 100) + "%"; },
      });
      const layout = currentLayout();
      const fname = (episode.title || "episode").replace(/[^\w.-]+/g, "_") + "-" + layout.id + ".webm";
      PDC.exporter.download(out.url, fname);
      const result = $("export-result");
      result.hidden = false;
      result.innerHTML =
        "Exported <strong>" + fname + "</strong> — " + Math.round(out.bytes / 1024) + " KB, " +
        "“" + layout.name + "” layout. " +
        '<a id="export-download" href="' + out.url + '" download="' + fname + '">Download again</a>';
      // A real playable preview of the exported file (also lets review confirm playback).
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

  // Audio quality: a single Off / Speech Clarity choice. Clicking enables the
  // audio engine (a real user gesture, unmuting the speakers) and applies the
  // setting, so the choice is audible in preview and recorded into the export.
  function markAudioQuality(choice) {
    document.querySelectorAll("[data-audio-quality]").forEach(function (b) {
      const on = b.dataset.audioQuality === choice;
      b.classList.toggle("selected", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
  document.querySelectorAll("[data-audio-quality]").forEach(function (b) {
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", async function () {
      if (!canCompose(episode)) return;
      await PDC.audio.enable();
      preview.play(); // keep the speakers playing so the processed audio is audible
      PDC.audio.set("clarity", b.dataset.audioQuality === "clarity" ? "voice" : "off");
      markAudioQuality(b.dataset.audioQuality);
    });
  });

  function refresh() {
    const ready = canCompose(episode);
    const n = assignedBuckets(episode).length;
    $("stage-canvas").classList.toggle("ready", ready);
    $("empty").hidden = ready;
    $("readiness").textContent = ready
      ? "Previewing " + n + " speaker" + (n === 1 ? "" : "s") + " in the “" + currentLayout().name + "” layout."
      : readinessReason(episode);

    const playBtn = $("play");
    playBtn.disabled = !ready;
    playBtn.textContent = preview.isPlaying() ? "⏸ Pause" : "▶ Play preview";
    $("restart").disabled = !ready;
    $("mute").disabled = !ready;
    const exportBtn = $("export");
    if (exportBtn && exportBtn.textContent.indexOf("Exporting") === -1) exportBtn.disabled = !ready;
    if (!editor.isOpen()) $("customize").disabled = !ready;
    document.querySelectorAll("[data-audio-quality]").forEach(function (b) { b.disabled = !ready; });
  }

  SPEAKER_BUCKETS.forEach(updateBucketRow);
  renderTemplates();
  refresh();
})();
