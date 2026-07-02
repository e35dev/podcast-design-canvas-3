// app/ui.js — browser wiring for upload → social links → preset → canvas preview.
(function () {
  const PDC = window.PDC;
  const { PRESETS, BUCKET_LABELS, SPEAKER_BUCKETS } = PDC.presets;
  const { createEpisode, assignMedia, clearMedia, assignedBuckets, setPreset, setSocialLink, speakerName, canCompose, readinessReason, setAudioQuality, getAudioQuality } = PDC.episode;

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

  // Timed visual moments: type + text + start/end times, listed with remove
  // controls. Moments live on the episode model, so they survive preset and
  // template switches; the preview draws whichever are active each frame.
  const M = PDC.moments;
  function showMomentError(message) {
    const el = $("moment-error");
    el.textContent = message || "";
    el.hidden = !message;
  }
  function renderMomentList() {
    const list = $("moment-list");
    list.innerHTML = "";
    M.listMoments(episode).forEach(function (m) {
      const li = document.createElement("li");
      li.dataset.momentId = m.id;
      li.dataset.momentType = m.type;
      const kind = document.createElement("span");
      kind.className = "moment-kind " + m.type;
      kind.textContent = m.type === "title" ? "Title" : m.type === "broll" ? "B-roll" : "Callout";
      const text = document.createElement("span");
      text.className = "moment-text";
      text.textContent = m.type === "broll" ? m.text || m.imageName || "Image" : m.text;
      const range = document.createElement("span");
      range.className = "moment-range";
      range.textContent = M.formatTime(m.start) + "–" + M.formatTime(m.end);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "moment-remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", "Remove " + m.type + " moment " + m.text);
      remove.addEventListener("click", function () {
        if (preview.clearMomentImage) preview.clearMomentImage(m.id);
        M.removeMoment(episode, m.id);
        renderMomentList();
        preview.drawFrame();
      });
      li.append(kind, text, range, remove);
      list.appendChild(li);
    });
  }
  // B-roll moments carry a PNG upload; the caption text stays optional. The
  // image field is always available so the order of steps never matters —
  // picking an image auto-selects the b-roll type, and selecting the b-roll
  // type highlights the image field. This keeps the upload flow reliable
  // regardless of whether the creator chooses the type or the file first.
  const momentImageField = $("moment-image-field");
  const momentImageInput = $("moment-image");
  function syncMomentType() {
    const isBroll = $("moment-type").value === "broll";
    momentImageField.classList.toggle("active", isBroll);
    $("moment-text").placeholder = isBroll ? "Caption (optional)" : "Text to display";
  }
  $("moment-type").addEventListener("change", syncMomentType);
  momentImageInput.addEventListener("change", function () {
    if (momentImageInput.files && momentImageInput.files[0] && $("moment-type").value !== "broll") {
      $("moment-type").value = "broll";
    }
    syncMomentType();
  });
  syncMomentType();

  $("moment-add").addEventListener("click", function () {
    const type = $("moment-type").value;
    const imageFile = type === "broll" ? momentImageInput.files[0] || null : null;
    const fields = {
      type: type,
      text: $("moment-text").value,
      start: $("moment-start").value,
      end: $("moment-end").value,
      hasImage: !!imageFile,
      imageName: imageFile ? imageFile.name : "",
    };
    const problem = M.validateMoment(fields);
    if (problem) {
      showMomentError(problem);
      return;
    }
    const moment = M.addMoment(episode, fields);
    if (moment && imageFile && preview.setMomentImage) preview.setMomentImage(moment.id, imageFile);
    showMomentError("");
    $("moment-text").value = "";
    $("moment-start").value = "";
    $("moment-end").value = "";
    momentImageInput.value = "";
    renderMomentList();
    preview.drawFrame();
  });

  // Scrub bar: jump the shared preview timeline to any time — scheduled
  // moments show or hide immediately to match the scrubbed position.
  const scrubEl = $("scrub");
  const scrubTimeEl = $("scrub-time");
  function syncScrub() {
    const duration = preview.getDuration();
    if (duration > 0) {
      scrubEl.max = String(Math.round(duration * 10) / 10);
      scrubEl.disabled = !canCompose(episode);
    } else {
      scrubEl.disabled = true;
    }
    if (preview.isPlaying()) {
      scrubEl.value = String(preview.getTime());
      scrubTimeEl.textContent = M.formatTime(preview.getTime());
    }
  }
  scrubEl.addEventListener("input", function () {
    const t = Number(scrubEl.value);
    preview.seekTo(t);
    scrubTimeEl.textContent = M.formatTime(t);
  });
  setInterval(syncScrub, 200);

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

  // Start a new episode without reloading the page: clears uploaded media,
  // social links, moments, and audio settings back to defaults, but never
  // touches saved show templates (those live independently in
  // app/templates.js) — the whole point is that a fresh episode can still
  // pick one up from the setup/preset controls below.
  $("new-episode").addEventListener("click", function () {
    if (editor.isOpen()) closeEditor();
    preview.pause();
    assignedBuckets(episode).forEach(function (bucket) {
      preview.clear(bucket);
    });
    PDC.episode.resetEpisode(episode, { title: "Episode 1" });

    document.querySelectorAll("input[data-file-bucket]").forEach(function (input) { input.value = ""; });
    document.querySelectorAll("input[data-link-bucket]").forEach(function (input) { input.value = ""; });
    $("moment-text").value = "";
    $("moment-start").value = "";
    $("moment-end").value = "";
    if (momentImageInput) momentImageInput.value = "";
    if (preview.clearMomentImages) preview.clearMomentImages();
    syncMomentType();
    showMomentError("");
    renderMomentList();

    $("export-progress").hidden = true;
    $("export-bar").style.width = "0%";
    $("export-result").hidden = true;
    $("export-result").innerHTML = "";

    SPEAKER_BUCKETS.forEach(updateBucketRow);
    syncAudioUi();
    markSelected(episode.presetId);
    preview.render(episode);
    refresh();
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
  }

  SPEAKER_BUCKETS.forEach(updateBucketRow);
  syncAudioUi();
  renderMomentList();
  renderTemplates();
  refresh();
})();
