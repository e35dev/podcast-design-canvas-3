const {
  PRESETS,
  SPEAKER_BUCKETS,
  buildAssignmentMap,
  buildExportFilename,
  formatSocialLabel,
  getBucketLabel,
  getEpisodeDuration,
  getFrames,
  getPresetById,
  validateSetup
} = window.PodcastDesignCanvasModel;

const state = {
  uploads: [],
  preparedMedia: null,
  previewLoop: 0,
  exportUrl: "",
  exporting: false
};

const els = {
  startButton: document.querySelector("#start-episode"),
  restartButton: document.querySelector("#restart-episode"),
  workspace: document.querySelector("#workspace"),
  episodeTitle: document.querySelector("#episode-title"),
  fileInput: document.querySelector("#speaker-files"),
  uploadList: document.querySelector("#upload-list"),
  uploadHint: document.querySelector("#upload-hint"),
  presetList: document.querySelector("#preset-list"),
  socialFields: document.querySelector("#social-fields"),
  composeButton: document.querySelector("#compose-preview"),
  previewButton: document.querySelector("#play-preview"),
  pauseButton: document.querySelector("#pause-preview"),
  exportButton: document.querySelector("#export-episode"),
  status: document.querySelector("#status"),
  exportLink: document.querySelector("#download-export"),
  previewCanvas: document.querySelector("#preview-canvas"),
  preloadStage: document.querySelector("#preload-stage"),
  readyList: document.querySelector("#ready-list")
};

const canvasContext = els.previewCanvas.getContext("2d");

renderPresets();
renderSocialFields();
resetEpisodeState({ preserveIntro: true });
drawEmptyCanvas("Start a new episode to load speaker video files.");

els.startButton.addEventListener("click", () => resetEpisodeState({ preserveIntro: false }));
els.restartButton.addEventListener("click", () => resetEpisodeState({ preserveIntro: false }));
els.fileInput.addEventListener("change", handleFilesSelected);
els.composeButton.addEventListener("click", handleComposePreview);
els.previewButton.addEventListener("click", () => startPlayback(true));
els.pauseButton.addEventListener("click", pausePlayback);
els.exportButton.addEventListener("click", handleExportEpisode);

els.uploadList.addEventListener("change", (event) => {
  const select = event.target.closest("select[data-upload-id]");
  if (!select) {
    return;
  }

  const upload = state.uploads.find((item) => item.id === select.dataset.uploadId);
  if (!upload) {
    return;
  }

  upload.bucket = select.value;
  renderReadyChecklist();
  redrawPreviewIfPrepared();
});

els.uploadList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-remove-upload]");
  if (!button) {
    return;
  }

  removeUpload(button.dataset.removeUpload);
});

els.presetList.addEventListener("change", redrawPreviewIfPrepared);
els.socialFields.addEventListener("input", redrawPreviewIfPrepared);
els.episodeTitle.addEventListener("input", redrawPreviewIfPrepared);

function renderPresets() {
  els.presetList.innerHTML = PRESETS.map(
    (preset, index) => `
      <label class="preset-card">
        <input type="radio" name="preset" value="${preset.id}" ${index === 0 ? "checked" : ""}>
        <span class="preset-title-row">
          <strong>${preset.name}</strong>
          <span>${preset.pacing}</span>
        </span>
        <span class="preset-description">${preset.description}</span>
      </label>
    `
  ).join("");
}

function renderSocialFields() {
  els.socialFields.innerHTML = SPEAKER_BUCKETS.map(
    (bucket) => `
      <label class="field-group">
        <span>${bucket.label} social link</span>
        <input type="url" name="${bucket.id}" placeholder="https://..." autocomplete="off">
      </label>
    `
  ).join("");
}

function resetEpisodeState({ preserveIntro }) {
  disposePreparedMedia();
  revokeExportUrl();

  state.uploads.forEach((upload) => URL.revokeObjectURL(upload.url));
  state.uploads = [];

  els.workspace.hidden = false;
  els.startButton.hidden = false;
  els.episodeTitle.value = "";
  els.fileInput.value = "";
  els.status.textContent = preserveIntro
    ? "Start a new episode or upload synced speaker tracks to begin."
    : "New episode started. Upload synced speaker tracks, assign buckets, choose a preset, then preview and export.";
  els.previewButton.disabled = true;
  els.pauseButton.disabled = true;
  els.exportButton.disabled = true;
  els.exportLink.hidden = true;

  for (const input of els.socialFields.querySelectorAll("input")) {
    input.value = "";
  }

  renderUploads();
  renderReadyChecklist();
  drawEmptyCanvas("Upload two or three speaker tracks to preview the composed episode.");
}

function handleFilesSelected(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) {
    return;
  }

  files.forEach((file, index) => {
    state.uploads.push({
      id: `${file.name}-${file.size}-${Date.now()}-${index}`,
      file,
      url: URL.createObjectURL(file),
      bucket: ""
    });
  });

  event.target.value = "";
  renderUploads();
  renderReadyChecklist();
  setStatus(`${files.length} media file${files.length > 1 ? "s" : ""} added. Assign each file to a speaker bucket.`);
}

function removeUpload(uploadId) {
  const index = state.uploads.findIndex((upload) => upload.id === uploadId);
  if (index < 0) {
    return;
  }

  const [removed] = state.uploads.splice(index, 1);
  URL.revokeObjectURL(removed.url);
  renderUploads();
  renderReadyChecklist();
  disposePreparedMedia();
  revokeExportUrl();
  drawEmptyCanvas("Rebuild the preview after changing uploaded media.");
  setStatus("Uploaded media changed. Rebuild the preview before exporting.");
}

function renderUploads() {
  if (!state.uploads.length) {
    els.uploadHint.hidden = false;
    els.uploadList.innerHTML = "";
    return;
  }

  els.uploadHint.hidden = true;
  els.uploadList.innerHTML = state.uploads.map(
    (upload) => `
      <li class="upload-row">
        <div>
          <strong>${escapeHtml(upload.file.name)}</strong>
          <p>${formatFileSize(upload.file.size)} · ${upload.file.type || "video/*"}</p>
        </div>
        <label class="inline-select">
          <span>Speaker bucket</span>
          <select data-upload-id="${upload.id}">
            <option value="">Unassigned</option>
            ${SPEAKER_BUCKETS.map(
              (bucket) => `<option value="${bucket.id}" ${bucket.id === upload.bucket ? "selected" : ""}>${bucket.label}</option>`
            ).join("")}
          </select>
        </label>
        <button type="button" class="ghost-button" data-remove-upload="${upload.id}">Remove</button>
      </li>
    `
  ).join("");
}

function renderReadyChecklist() {
  const socials = collectSocials();
  const assignedMap = buildAssignmentMap(state.uploads);
  const selectedPreset = getSelectedPresetId();
  const checks = [
    {
      label: "At least two speaker files uploaded",
      done: state.uploads.length >= 2
    },
    {
      label: "No more than three speaker files uploaded",
      done: state.uploads.length <= 3
    },
    {
      label: "Every uploaded file assigned",
      done: state.uploads.length > 0 && state.uploads.every((upload) => Boolean(upload.bucket))
    },
    {
      label: "Host assigned",
      done: Boolean(assignedMap.host)
    },
    {
      label: "At least one guest assigned",
      done: Boolean(assignedMap.guest1 || assignedMap.guest2)
    },
    {
      label: "Social links for assigned speakers",
      done: Object.entries(assignedMap).every(([bucket]) => Boolean(socials[bucket]))
    },
    {
      label: `Preset selected (${getPresetById(selectedPreset).name})`,
      done: Boolean(selectedPreset)
    }
  ];

  els.readyList.innerHTML = checks.map(
    (check) => `<li class="${check.done ? "done" : ""}">${check.done ? "Ready" : "Pending"} · ${check.label}</li>`
  ).join("");
}

async function handleComposePreview() {
  revokeExportUrl();
  disposePreparedMedia();

  const socials = collectSocials();
  const presetId = getSelectedPresetId();
  const errors = validateSetup({
    uploads: state.uploads,
    socials,
    presetId
  });

  if (errors.length) {
    setStatus(errors[0], true);
    drawEmptyCanvas(errors[0]);
    return;
  }

  const assignmentMap = buildAssignmentMap(state.uploads);
  const preparedEntries = await Promise.all(
    Object.entries(assignmentMap).map(async ([bucket, upload]) => {
      const video = document.createElement("video");
      video.src = upload.url;
      video.preload = "auto";
      video.playsInline = true;
      video.controls = false;
      video.muted = true;
      video.volume = 1 / Math.max(1, Object.keys(assignmentMap).length);
      video.className = "preload-video";
      els.preloadStage.appendChild(video);
      await waitForVideo(video);
      await warmVideoFrame(video);

      return {
        bucket,
        file: upload.file,
        url: upload.url,
        video,
        duration: video.duration,
        social: socials[bucket]
      };
    })
  );

  state.preparedMedia = preparedEntries;
  els.previewButton.disabled = false;
  els.pauseButton.disabled = false;
  els.exportButton.disabled = false;

  drawCompositionFrame();
  setStatus("Preview is ready. Press Play from start to hear and review the composed episode.");
}

async function startPlayback(fromStart, options = {}) {
  if (!state.preparedMedia?.length || (state.exporting && !options.allowDuringExport)) {
    return false;
  }

  state.preparedMedia.forEach((entry) => {
    entry.video.muted = false;
  });

  if (fromStart) {
    await Promise.all(state.preparedMedia.map((entry) => seekVideo(entry.video, 0)));
  }

  try {
    await Promise.all(state.preparedMedia.map((entry) => entry.video.play()));
    startRenderLoop();
    setStatus("Preview playing from the real uploaded media.");
    return true;
  } catch (error) {
    pausePlayback();
    setStatus(`Preview playback could not start: ${error.message}`, true);
    return false;
  }
}

function pausePlayback() {
  if (!state.preparedMedia?.length) {
    return;
  }
  stopRenderLoop();
  state.preparedMedia.forEach((entry) => entry.video.pause());
  drawCompositionFrame();
  setStatus("Preview paused.");
}

async function handleExportEpisode() {
  if (!state.preparedMedia?.length || state.exporting) {
    return;
  }

  state.exporting = true;
  els.exportButton.disabled = true;
  revokeExportUrl();
  setStatus("Recording the composed episode export. This uses the real uploaded media and audio.");

  if (!window.MediaRecorder || !els.previewCanvas.captureStream) {
    state.exporting = false;
    els.exportButton.disabled = false;
    setStatus("This browser cannot record the composed episode export.", true);
    return;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    state.exporting = false;
    els.exportButton.disabled = false;
    setStatus("This browser cannot mix the uploaded speaker audio for export.", true);
    return;
  }

  const audioContext = new AudioContextCtor();
  const audioDestination = audioContext.createMediaStreamDestination();
  const outputStream = new MediaStream();
  const canvasStream = els.previewCanvas.captureStream(30);

  canvasStream.getVideoTracks().forEach((track) => outputStream.addTrack(track));

  const cleanupAudio = [];
  for (const entry of state.preparedMedia) {
    entry.video.muted = false;
    const mediaStream = entry.video.captureStream ? entry.video.captureStream() : entry.video.mozCaptureStream?.();
    if (!mediaStream) {
      audioContext.close();
      state.exporting = false;
      els.exportButton.disabled = false;
      setStatus("This browser cannot capture media streams for export.", true);
      return;
    }

    if (!mediaStream.getAudioTracks().length) {
      continue;
    }

    const source = audioContext.createMediaStreamSource(mediaStream);
    const gain = audioContext.createGain();
    gain.gain.value = 1 / Math.max(1, state.preparedMedia.length);
    source.connect(gain);
    gain.connect(audioDestination);
    cleanupAudio.push(() => {
      source.disconnect();
      gain.disconnect();
    });
  }

  audioDestination.stream.getAudioTracks().forEach((track) => outputStream.addTrack(track));

  const mimeType = selectMimeType();
  const recorder = mimeType ? new MediaRecorder(outputStream, { mimeType }) : new MediaRecorder(outputStream);
  const chunks = [];

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) {
      chunks.push(event.data);
    }
  });

  const recordingStopped = new Promise((resolve) => {
    recorder.addEventListener("stop", resolve, { once: true });
  });

  await audioContext.resume();
  await Promise.all(state.preparedMedia.map((entry) => seekVideo(entry.video, 0)));
  recorder.start(1000);
  const playbackStarted = await startPlayback(true, { allowDuringExport: true });
  if (!playbackStarted) {
    recorder.stop();
    await recordingStopped;
    cleanupAudio.forEach((cleanup) => cleanup());
    await audioContext.close();
    state.exporting = false;
    els.exportButton.disabled = false;
    setStatus("Export stopped because media playback could not start.", true);
    return;
  }

  const durationMs = getEpisodeDuration(state.preparedMedia) * 1000;
  await wait(durationMs + 400);
  pausePlayback();
  recorder.stop();
  await recordingStopped;

  cleanupAudio.forEach((cleanup) => cleanup());
  await audioContext.close();

  const blob = new Blob(chunks, { type: mimeType || "video/webm" });
  if (!blob.size) {
    state.exporting = false;
    els.exportButton.disabled = false;
    setStatus("Export failed because the browser produced an empty video file.", true);
    return;
  }

  state.exportUrl = URL.createObjectURL(blob);
  els.exportLink.href = state.exportUrl;
  els.exportLink.download = buildExportFilename(els.episodeTitle.value.trim(), getSelectedPresetId());
  els.exportLink.hidden = false;
  els.exportLink.textContent = `Download export (${formatFileSize(blob.size)})`;

  state.exporting = false;
  els.exportButton.disabled = false;
  setStatus("Export finished. Download the composed long-form episode file.");
}

function selectMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

function startRenderLoop() {
  stopRenderLoop();
  const render = () => {
    drawCompositionFrame();
    if (state.preparedMedia?.some((entry) => !entry.video.paused && !entry.video.ended)) {
      state.previewLoop = requestAnimationFrame(render);
      return;
    }
    drawCompositionFrame();
  };
  state.previewLoop = requestAnimationFrame(render);
}

function stopRenderLoop() {
  if (state.previewLoop) {
    cancelAnimationFrame(state.previewLoop);
    state.previewLoop = 0;
  }
}

function redrawPreviewIfPrepared() {
  renderReadyChecklist();
  if (state.preparedMedia?.length) {
    drawCompositionFrame();
  }
}

function drawCompositionFrame() {
  if (!state.preparedMedia?.length) {
    drawEmptyCanvas("Build the preview after assigning speakers and choosing a preset.");
    return;
  }

  const preset = getPresetById(getSelectedPresetId());
  const width = els.previewCanvas.width;
  const height = els.previewCanvas.height;
  const elapsedMs = Math.max(...state.preparedMedia.map((entry) => entry.video.currentTime * 1000));
  const assignedBuckets = state.preparedMedia.map((entry) => entry.bucket);
  const frames = getFrames(preset.id, assignedBuckets, width, height, elapsedMs);

  canvasContext.clearRect(0, 0, width, height);
  const background = canvasContext.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, preset.background);
  background.addColorStop(1, "#020617");
  canvasContext.fillStyle = background;
  canvasContext.fillRect(0, 0, width, height);

  frames.forEach((frame) => {
    if (!frame.bucket) {
      return;
    }

    const entry = state.preparedMedia.find((item) => item.bucket === frame.bucket);
    if (!entry) {
      return;
    }

    drawFrame(entry, frame, preset);
  });

  canvasContext.fillStyle = "rgba(15, 23, 42, 0.82)";
  canvasContext.fillRect(28, 24, 360, 60);
  canvasContext.fillStyle = "#e2e8f0";
  canvasContext.font = "600 24px Inter, system-ui, sans-serif";
  canvasContext.fillText(els.episodeTitle.value.trim() || "New podcast episode", 46, 61);
}

function drawFrame(entry, frame, preset) {
  const { video } = entry;
  const ready = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  const radius = 18;

  roundRect(canvasContext, frame.x, frame.y, frame.width, frame.height, radius);
  canvasContext.save();
  canvasContext.clip();

  if (ready) {
    const fit = cover(video.videoWidth, video.videoHeight, frame.width, frame.height);
    canvasContext.drawImage(
      video,
      frame.x + fit.offsetX,
      frame.y + fit.offsetY,
      fit.width,
      fit.height
    );
  } else {
    canvasContext.fillStyle = "#0f172a";
    canvasContext.fillRect(frame.x, frame.y, frame.width, frame.height);
  }

  canvasContext.restore();
  canvasContext.lineWidth = frame.spotlight ? 4 : 2;
  canvasContext.strokeStyle = frame.spotlight ? preset.accent : "rgba(148, 163, 184, 0.55)";
  roundRect(canvasContext, frame.x, frame.y, frame.width, frame.height, radius);
  canvasContext.stroke();

  canvasContext.fillStyle = "rgba(2, 6, 23, 0.78)";
  canvasContext.fillRect(frame.x + 14, frame.y + frame.height - 78, Math.min(frame.width - 28, 320), 60);
  canvasContext.fillStyle = "#f8fafc";
  canvasContext.font = "600 22px Inter, system-ui, sans-serif";
  canvasContext.fillText(getBucketLabel(entry.bucket), frame.x + 28, frame.y + frame.height - 42);
  canvasContext.fillStyle = "#cbd5e1";
  canvasContext.font = "500 16px Inter, system-ui, sans-serif";
  canvasContext.fillText(formatSocialLabel(entry.social), frame.x + 28, frame.y + frame.height - 18);
}

function drawEmptyCanvas(message) {
  const width = els.previewCanvas.width;
  const height = els.previewCanvas.height;
  canvasContext.clearRect(0, 0, width, height);
  canvasContext.fillStyle = "#020617";
  canvasContext.fillRect(0, 0, width, height);
  canvasContext.fillStyle = "#f8fafc";
  canvasContext.font = "600 30px Inter, system-ui, sans-serif";
  canvasContext.fillText("Podcast Design Canvas", 56, 120);
  canvasContext.fillStyle = "#94a3b8";
  canvasContext.font = "500 22px Inter, system-ui, sans-serif";
  wrapText(message, 56, 178, width - 112, 32);
}

function collectSocials() {
  return SPEAKER_BUCKETS.reduce((accumulator, bucket) => {
    const input = els.socialFields.querySelector(`[name="${bucket.id}"]`);
    accumulator[bucket.id] = input?.value.trim() || "";
    return accumulator;
  }, {});
}

function getSelectedPresetId() {
  return els.presetList.querySelector('input[name="preset"]:checked')?.value || PRESETS[0].id;
}

function disposePreparedMedia() {
  stopRenderLoop();
  if (!state.preparedMedia?.length) {
    els.preloadStage.innerHTML = "";
    state.preparedMedia = null;
    return;
  }

  state.preparedMedia.forEach((entry) => {
    entry.video.pause();
    entry.video.src = "";
    entry.video.remove();
  });

  state.preparedMedia = null;
  els.preloadStage.innerHTML = "";
  els.previewButton.disabled = true;
  els.pauseButton.disabled = true;
  els.exportButton.disabled = true;
}

function revokeExportUrl() {
  if (!state.exportUrl) {
    return;
  }
  URL.revokeObjectURL(state.exportUrl);
  state.exportUrl = "";
  els.exportLink.hidden = true;
}

function waitForVideo(video) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }

    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("canplay", onLoaded);
      video.removeEventListener("error", onError);
    };

    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Unable to load ${video.currentSrc}`));
    };

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("canplay", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.load();
  });
}

function seekVideo(video, time) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.05) {
      resolve();
      return;
    }

    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = time;
  });
}

async function warmVideoFrame(video) {
  try {
    await video.play();
    await wait(120);
    video.pause();
    await seekVideo(video, 0);
  } catch {
    video.pause();
  }
}

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function cover(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;

  if (sourceRatio > targetRatio) {
    const height = targetHeight;
    const width = height * sourceRatio;
    return {
      width,
      height,
      offsetX: (targetWidth - width) / 2,
      offsetY: 0
    };
  }

  const width = targetWidth;
  const height = width / sourceRatio;
  return {
    width,
    height,
    offsetX: 0,
    offsetY: (targetHeight - height) / 2
  };
}

function wrapText(text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";

  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (canvasContext.measureText(candidate).width <= maxWidth) {
      line = candidate;
      return;
    }

    canvasContext.fillText(line, x, y);
    y += lineHeight;
    line = word;
  });

  if (line) {
    canvasContext.fillText(line, x, y);
  }
}

function formatFileSize(size) {
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.dataset.tone = isError ? "error" : "default";
}
