// app/ui.js — browser wiring for upload, social links, presets, and reusable layouts.
(function () {
  const PDC = window.PDC;
  const { PRESETS, SPEAKER_BUCKETS } = PDC.presets;
  const {
    createEpisode,
    assignMedia,
    assignedBuckets,
    setPreset,
    setSocialLink,
    speakerName,
    canCompose,
    readinessReason,
    getActiveLayout,
    saveTemplate,
    applyTemplate,
    listTemplates,
    getTemplate,
    setDraftLayout,
    clearDraftLayout,
    setAudioQuality,
  } = PDC.episode;

  const $ = (id) => document.getElementById(id);
  const episode = createEpisode({ title: "Episode 1" });
  const preview = PDC.preview.createPreview($("stage-canvas"));
  PDC.previewController = preview;
  PDC.currentEpisode = episode;

  const editor = $("layout-editor");
  const editorShell = $("layout-editor-shell");
  const openEditorBtn = $("open-editor");
  const templateActions = $("template-actions");
  const templateNameInput = $("template-name");
  const saveTemplateBtn = $("save-template");
  const templateListEl = $("template-list");
  const audioPanel = $("audio-controls");
  const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogg|ogv|avi|mkv)$/i;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v)));

  let draftLayout = null;
  let editorOpen = false;
  let dragState = null;

  function isVideoFile(file) {
    if (!file) return false;
    if (file.type && /^video\//i.test(file.type)) return true;
    return VIDEO_EXT.test(file.name || "");
  }

  function cloneRect(rect) {
    return {
      x: Number(rect && rect.x) || 0,
      y: Number(rect && rect.y) || 0,
      w: Number(rect && rect.w) || 0,
      h: Number(rect && rect.h) || 0,
    };
  }

  function clampRect(rect) {
    const x = clamp(rect.x, 0, 100);
    const y = clamp(rect.y, 0, 100);
    return { x, y, w: clamp(rect.w, 3, 100 - x), h: clamp(rect.h, 3, 100 - y) };
  }

  function cloneLayout(layout) {
    const out = {};
    Object.keys(layout || {}).forEach((bucket) => (out[bucket] = clampRect(cloneRect(layout[bucket]))));
    return out;
  }

  function activeSnapshot() {
    const active = getActiveLayout(episode) || {};
    const out = {};
    assignedBuckets(episode).forEach((bucket) => {
      out[bucket] = clampRect(cloneRect((active.rects && active.rects[bucket]) || { x: 0, y: 0, w: 100, h: 100 }));
    });
    return out;
  }

  function syncDraftFromActive() {
    draftLayout = activeSnapshot();
    setDraftLayout(episode, draftLayout);
  }

  function updateBucketRow(bucket) {
    const row = document.querySelector('.bucket[data-bucket="' + bucket + '"]');
    if (!row) return;
    const media = episode.media[bucket];
    const status = row.querySelector('[data-status="' + bucket + '"]');
    if (status) status.textContent = media ? media.name : "No file";
    const nameEl = row.querySelector(".bucket-name");
    if (nameEl) nameEl.textContent = speakerName(episode, bucket);
    row.classList.toggle("filled", !!media);
    const derived = document.querySelector('[data-derived="' + bucket + '"]');
    if (derived) derived.textContent = episode.socialLinks && episode.socialLinks[bucket] ? "Shown as: " + speakerName(episode, bucket) : "";
  }

  function renderFrame(bucket) {
    const frame = editor.querySelector('.layout-frame[data-bucket="' + bucket + '"]');
    const rect = draftLayout && draftLayout[bucket];
    if (!frame || !rect) return;
    frame.style.left = rect.x + "%";
    frame.style.top = rect.y + "%";
    frame.style.width = rect.w + "%";
    frame.style.height = rect.h + "%";
    const label = frame.querySelector(".frame-label");
    if (label) label.textContent = speakerName(episode, bucket);
  }

  function renderFrames() {
    editor.innerHTML = "";
    assignedBuckets(episode).forEach((bucket) => {
      const frame = document.createElement("div");
      frame.className = "layout-frame";
      frame.dataset.bucket = bucket;
      const label = document.createElement("span");
      label.className = "frame-label";
      label.textContent = speakerName(episode, bucket);
      const handle = document.createElement("span");
      handle.className = "frame-handle";
      frame.appendChild(label);
      frame.appendChild(handle);
      frame.addEventListener("pointerdown", (event) => {
        if (event.button && event.button !== 0) return;
        startDrag(event, bucket, frame, event.target === handle);
      });
      editor.appendChild(frame);
      renderFrame(bucket);
    });
  }

  function startDrag(event, bucket, frame, isResize) {
    event.preventDefault();
    event.stopPropagation();
    if (!draftLayout) syncDraftFromActive();
    const current = draftLayout[bucket];
    const box = editor.getBoundingClientRect();
    dragState = {
      bucket,
      frame,
      isResize,
      x0: event.clientX,
      y0: event.clientY,
      x: current.x,
      y: current.y,
      w: current.w,
      h: current.h,
      widthPx: Math.max(1, box.width),
      heightPx: Math.max(1, box.height),
    };
    frame.classList.add("active");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag, { once: true });
  }

  function onPointerMove(event) {
    if (!dragState || !draftLayout) return;
    const dx = ((event.clientX - dragState.x0) / dragState.widthPx) * 100;
    const dy = ((event.clientY - dragState.y0) / dragState.heightPx) * 100;
    const next = cloneRect(draftLayout[dragState.bucket]);
    if (dragState.isResize) {
      next.w = clamp(next.w + dx, 3, 100 - next.x);
      next.h = clamp(next.h + dy, 3, 100 - next.y);
    } else {
      next.x = clamp(next.x + dx, 0, 100 - next.w);
      next.y = clamp(next.y + dy, 0, 100 - next.h);
    }
    draftLayout[dragState.bucket] = clampRect(next);
    setDraftLayout(episode, draftLayout);
    renderFrame(dragState.bucket);
    preview.render(episode);
  }

  function stopDrag() {
    if (dragState && dragState.frame) dragState.frame.classList.remove("active");
    dragState = null;
    window.removeEventListener("pointermove", onPointerMove);
    refresh();
  }

  function openEditor() {
    if (!canCompose(episode)) return;
    editorOpen = true;
    syncDraftFromActive();
    editor.hidden = false;
    templateActions.hidden = false;
    openEditorBtn.textContent = "Close layout editor";
    renderFrames();
    refresh();
  }

  function closeEditor() {
    editorOpen = false;
    editor.hidden = true;
    templateActions.hidden = true;
    openEditorBtn.textContent = "Open layout editor";
    clearDraftLayout(episode);
    draftLayout = activeSnapshot();
    preview.render(episode);
    refresh();
  }

  function toggleEditor() {
    if (editorOpen) closeEditor();
    else openEditor();
  }

  function renderTemplateList() {
    const templates = listTemplates(episode);
    templateListEl.innerHTML = "";
    if (!templates.length) {
      const empty = document.createElement("span");
      empty.className = "template-empty";
      empty.textContent = "No saved templates yet.";
      templateListEl.appendChild(empty);
      return;
    }
    templates.forEach((template) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "template-pill";
      btn.textContent = template.name;
      if (episode.activeLayoutMode === "template" && episode.activeTemplateId === template.id) btn.classList.add("active-template");
      btn.addEventListener("click", () => {
        if (!applyTemplate(episode, template.id)) return;
        clearDraftLayout(episode);
        draftLayout = activeSnapshot();
        if (editorOpen) renderFrames();
        preview.render(episode);
        refresh();
      });
      templateListEl.appendChild(btn);
    });
  }

  function refresh() {
    const ready = canCompose(episode);
    const n = assignedBuckets(episode).length;
    const active = getActiveLayout(episode) || {};
    editorShell.classList.toggle("layout-ready", ready);
    openEditorBtn.disabled = !ready;
    $("stage-canvas").classList.toggle("ready", ready);
    $("empty").hidden = ready;
    $("readiness").textContent = ready
      ? "Previewing " + n + " speaker" + (n === 1 ? "" : "s") + " in the “" + (active.name || "layout") + "” " + (active.kind || "") + " layout."
      : readinessReason(episode);
    $("play").disabled = !ready;
    $("play").textContent = preview.isPlaying() ? "⏸ Pause" : "▶ Play preview";
    $("restart").disabled = !ready;
    $("mute").disabled = !ready;
    if ($("export").textContent.indexOf("Exporting") === -1) $("export").disabled = !ready;
    saveTemplateBtn.disabled = !(ready && editorOpen);
    templateActions.hidden = !editorOpen;
    if (audioPanel) audioPanel.hidden = !ready;
    if (!ready) {
      editor.hidden = true;
      templateActions.hidden = true;
      openEditorBtn.textContent = "Open layout editor";
    }
  }

  function renderAudioControls() {
    const el = $("audio-quality");
    if (el) el.value = episode.audioQuality || "off";
  }

  function afterMediaChange() {
    clearDraftLayout(episode);
    draftLayout = activeSnapshot();
    preview.render(episode);
    if (editorOpen) renderFrames();
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

  document.querySelectorAll("input[data-file-bucket]").forEach((input) => {
    const bucket = input.getAttribute("data-file-bucket");
    const handle = () => {
      onFilesForBucket(bucket, input.files);
      input.value = "";
    };
    input.addEventListener("change", handle);
    input.addEventListener("input", handle);
  });

  document.querySelectorAll("input[data-link-bucket]").forEach((input) => {
    const bucket = input.getAttribute("data-link-bucket");
    const handle = () => {
      setSocialLink(episode, bucket, input.value);
      updateBucketRow(bucket);
      if (canCompose(episode)) preview.render(episode);
      refresh();
    };
    input.addEventListener("input", handle);
    input.addEventListener("change", handle);
  });

  const presetsEl = $("presets");
  PRESETS.forEach((preset) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset" + (preset.id === episode.presetId ? " selected" : "");
    btn.dataset.preset = preset.id;
    btn.setAttribute("aria-pressed", String(preset.id === episode.presetId));
    btn.innerHTML = "<strong>" + preset.name + "</strong><span>" + preset.description + "</span>";
    btn.addEventListener("click", () => {
      setPreset(episode, preset.id);
      clearDraftLayout(episode);
      draftLayout = activeSnapshot();
      Array.prototype.forEach.call(presetsEl.children, (node) => {
        const selected = node.dataset.preset === preset.id;
        node.classList.toggle("selected", selected);
        node.setAttribute("aria-pressed", String(selected));
      });
      preview.render(episode);
      if (editorOpen) renderFrames();
      refresh();
    });
    presetsEl.appendChild(btn);
  });

  openEditorBtn.addEventListener("click", toggleEditor);
  saveTemplateBtn.addEventListener("click", () => {
    if (!editorOpen || !draftLayout) return;
    const template = saveTemplate(episode, templateNameInput.value, draftLayout);
    if (!template) return;
    templateNameInput.value = "";
    clearDraftLayout(episode);
    draftLayout = activeSnapshot();
    preview.render(episode);
    renderTemplateList();
    refresh();
  });

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

  const audioQuality = $("audio-quality");
  if (audioQuality) {
    audioQuality.addEventListener("change", async () => {
      setAudioQuality(episode, audioQuality.value);
      await preview.syncAudio();
      if (preview.isPlaying()) preview.play();
      refresh();
    });
  }

  $("export").addEventListener("click", async () => {
    if (!canCompose(episode)) return;
    const btn = $("export");
    btn.disabled = true;
    btn.textContent = "⏳ Exporting…";
    await preview.syncAudio();
    preview.play();
    $("export-progress").hidden = false;
    $("export-result").hidden = true;
    try {
      const out = await PDC.exporter.exportEpisode($("stage-canvas"), {
        fps: 30,
        audioQuality: episode.audioQuality,
        onProgress: (p) => { $("export-bar").style.width = Math.round(p * 100) + "%"; },
      });
      const active = getActiveLayout(episode) || {};
      const name = (active.name || "layout").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const fileName = (episode.title || "episode").replace(/[^\w.-]+/g, "_") + "-" + (name || "layout") + ".webm";
      PDC.exporter.download(out.url, fileName);
      const result = $("export-result");
      result.hidden = false;
      result.innerHTML =
        "Exported <strong>" + fileName + "</strong> — " + Math.round(out.bytes / 1024) + " KB, active " + (active.kind || "layout") + " layout. " +
        '<a id="export-download" href="' + out.url + '" download="' + fileName + '">Download again</a>';
      const video = document.createElement("video");
      video.id = "export-playback";
      video.src = out.url;
      video.controls = true;
      video.muted = true;
      video.style.cssText = "display:block;margin-top:8px;max-width:320px;width:100%";
      result.appendChild(video);
    } catch (error) {
      $("export-result").hidden = false;
      $("export-result").textContent = "Export failed: " + (error && error.message);
    } finally {
      btn.disabled = !canCompose(episode);
      btn.textContent = "⬇ Export video";
    }
  });

  SPEAKER_BUCKETS.forEach(updateBucketRow);
  syncDraftFromActive();
  renderTemplateList();
  renderAudioControls();
  refresh();
})();
