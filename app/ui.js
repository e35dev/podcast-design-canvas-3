// app/ui.js — browser wiring for upload → social links → preset → canvas preview.
(function () {
  const PDC = window.PDC;
  const { PRESETS, BUCKET_LABELS, SPEAKER_BUCKETS } = PDC.presets;
  const { createEpisode, assignMedia, clearMedia, assignedBuckets, setPreset, setSocialLink, speakerName, canCompose, readinessReason, setAudioQuality, getAudioQuality, MOMENT_TYPES, addVisualMoment, updateVisualMoment, removeVisualMoment, listVisualMoments } = PDC.episode;

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

  const audioButtons = Array.from(document.querySelectorAll("button[data-audio-setting]"));
  const AUDIO_KEYS = ["leveling", "clarity", "noiseReduction"];
  function syncAudioUi() {
    const q = getAudioQuality(episode);
    audioButtons.forEach(function (btn) {
      const key = btn.getAttribute("data-audio-setting");
      const value = btn.getAttribute("data-audio-value");
      const selected = q[key] === value;
      btn.classList.toggle("selected", selected);
      btn.setAttribute("aria-pressed", String(selected));
    });
  }
  function handleAudioPick(setting, value) {
    if (!AUDIO_KEYS.includes(setting)) return;
    const patch = {};
    patch[setting] = value;
    setAudioQuality(episode, patch);
    syncAudioUi();
    refresh();
  }
  audioButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      handleAudioPick(btn.getAttribute("data-audio-setting"), btn.getAttribute("data-audio-value"));
    });
  });

  const momentType = $("moment-type");
  const momentText = $("moment-text");
  const momentStart = $("moment-start");
  const momentEnd = $("moment-end");
  const momentSave = $("moment-save");
  const momentCancelEdit = $("moment-cancel-edit");
  const momentsList = $("moments-list");
  const momentsStatus = $("moments-status");
  let editingMomentId = null;

  function fmtTime(sec) {
    const n = Math.max(0, Number(sec) || 0);
    return n.toFixed(1) + "s";
  }

  function resetMomentForm() {
    editingMomentId = null;
    momentType.value = "title";
    momentText.value = "";
    momentStart.value = "0";
    momentEnd.value = "3";
    momentSave.textContent = "Add moment";
    momentCancelEdit.hidden = true;
  }

  function renderMoments() {
    const all = listVisualMoments(episode);
    momentsList.innerHTML = "";
    if (!all.length) {
      momentsStatus.textContent = "No visual moments yet.";
      return;
    }
    momentsStatus.textContent = all.length + " timed moment" + (all.length === 1 ? "" : "s") + " saved.";
    all.forEach(function (m) {
      const row = document.createElement("div");
      row.className = "moment-item";
      row.dataset.momentId = String(m.id);
      row.innerHTML =
        '<span class="moment-pill">' + m.type + "</span>" +
        '<span class="moment-range">' + fmtTime(m.start) + " → " + fmtTime(m.end) + "</span>" +
        '<span class="moment-text">' + m.text + "</span>" +
        '<span class="moment-actions"><button type="button" data-edit="' + m.id + '">Edit</button><button type="button" data-remove="' + m.id + '">Remove</button></span>';
      momentsList.appendChild(row);
    });
  }

  momentSave.addEventListener("click", function () {
    const payload = {
      type: MOMENT_TYPES.includes(momentType.value) ? momentType.value : "callout",
      text: (momentText.value || "").trim(),
      start: Number(momentStart.value),
      end: Number(momentEnd.value),
    };
    const out = editingMomentId == null
      ? addVisualMoment(episode, payload)
      : updateVisualMoment(episode, editingMomentId, payload);
    if (!out) {
      momentsStatus.textContent = "Enter a valid type, text, and time range (end must be after start).";
      return;
    }
    resetMomentForm();
    renderMoments();
    preview.render(episode);
    refresh();
  });

  momentCancelEdit.addEventListener("click", function () {
    resetMomentForm();
    renderMoments();
  });

  momentsList.addEventListener("click", function (event) {
    const removeId = event.target && event.target.getAttribute("data-remove");
    if (removeId) {
      removeVisualMoment(episode, Number(removeId));
      if (editingMomentId === Number(removeId)) resetMomentForm();
      renderMoments();
      preview.render(episode);
      refresh();
      return;
    }
    const editId = event.target && event.target.getAttribute("data-edit");
    if (editId) {
      const current = listVisualMoments(episode).find((m) => m.id === Number(editId));
      if (!current) return;
      editingMomentId = current.id;
      momentType.value = current.type;
      momentText.value = current.text;
      momentStart.value = String(current.start);
      momentEnd.value = String(current.end);
      momentSave.textContent = "Update moment";
      momentCancelEdit.hidden = false;
    }
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
  let layoutBeforeEdit = null;

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
    layoutBeforeEdit = episode.presetId;
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
    layoutBeforeEdit = null;
    $("customize-edit").hidden = true;
    $("customize-hint").hidden = true;
    $("customize").textContent = "✎ Customize layout";
    $("customize").disabled = !canCompose(episode);
  }

  $("customize").addEventListener("click", openEditor);
  $("cancel-customize").addEventListener("click", function () {
    const prev = layoutBeforeEdit || PRESETS[0].id;
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

  const scrub = $("preview-scrub");
  const scrubTime = $("preview-time");
  function syncScrubUi() {
    const duration = preview.getDuration();
    const current = preview.getCurrentTime();
    const ready = canCompose(episode) && duration > 0;
    scrub.disabled = !ready;
    if (ready) {
      scrub.value = String(Math.round((Math.min(duration, current) / duration) * 1000));
      scrubTime.textContent = fmtTime(current) + " / " + fmtTime(duration);
    } else {
      scrub.value = "0";
      scrubTime.textContent = "0.0s / 0.0s";
    }
  }
  scrub.addEventListener("input", function () {
    const duration = preview.getDuration();
    if (!duration) return;
    const t = (Number(scrub.value) / 1000) * duration;
    preview.seek(t);
    syncScrubUi();
  });
  setInterval(syncScrubUi, 120);

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
        audioQuality: getAudioQuality(episode),
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
        "Audio: " + getAudioQuality(episode).leveling + " leveling, " +
        getAudioQuality(episode).clarity + " clarity, " +
        getAudioQuality(episode).noiseReduction + " noise reduction. " +
        listVisualMoments(episode).length + " visual moment" + (listVisualMoments(episode).length === 1 ? "" : "s") + ". " +
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
    syncScrubUi();
  }

  SPEAKER_BUCKETS.forEach(updateBucketRow);
  syncAudioUi();
  resetMomentForm();
  renderMoments();
  renderTemplates();
  refresh();
})();
