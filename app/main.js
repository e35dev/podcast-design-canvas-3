(function initializePodcastDesignCanvasApp() {
const {
  PRESETS,
  SPEAKER_BUCKETS,
  buildExportFilename,
  formatSocialLabel,
  getBucketLabel,
  getEpisodeDuration,
  getFrames,
  getPresetById,
  validateSetup
} = window.PodcastDesignCanvasModel;

const state = {
  slots: {
    host: emptySlot("host"),
    guest1: emptySlot("guest1"),
    guest2: emptySlot("guest2")
  },
  preparedMedia: [],
  renderLoop: 0,
  exportUrl: "",
  exporting: false
};

const els = {
  startButton: document.querySelector("#start-episode"),
  restartButton: document.querySelector("#restart-episode"),
  episodeTitle: document.querySelector("#episode-title"),
  fileInputs: Array.from(document.querySelectorAll("[data-file-for]")),
  socialInputs: Array.from(document.querySelectorAll("[data-social-for]")),
  slotStates: Array.from(document.querySelectorAll("[data-state-for]")),
  presetList: document.querySelector("#preset-list"),
  composeButton: document.querySelector("#compose-preview"),
  previewButton: document.querySelector("#play-preview"),
  pauseButton: document.querySelector("#pause-preview"),
  exportButton: document.querySelector("#export-episode"),
  status: document.querySelector("#status"),
  exportLink: document.querySelector("#download-export"),
  previewGrid: document.querySelector("#video-preview-grid"),
  previewCanvas: document.querySelector("#preview-canvas"),
  readyList: document.querySelector("#ready-list")
};

const canvasContext = els.previewCanvas.getContext("2d");

els.previewButton.disabled = true;
els.pauseButton.disabled = true;
els.exportButton.disabled = true;
drawEmptyCanvas("Upload Host and Guest 1 videos, add social links, then preview.");
renderReadyChecklist();
setStatus("Start a new episode or upload synced speaker tracks to begin.");

els.startButton.addEventListener("click", resetEpisode);
els.restartButton.addEventListener("click", resetEpisode);
els.episodeTitle.addEventListener("input", drawPreparedFrame);
els.presetList.addEventListener("change", () => {
  renderNativePreview();
  drawPreparedFrame();
});
els.composeButton.addEventListener("click", handlePreview);
els.previewButton.addEventListener("click", () => playPreparedMedia(true));
els.pauseButton.addEventListener("click", pausePreparedMedia);
els.exportButton.addEventListener("click", handleExport);

els.fileInputs.forEach((input) => {
  input.addEventListener("change", () => {
    const bucket = input.dataset.fileFor;
    const file = input.files?.[0];
    setSlotFile(bucket, file || null);
  });
});

els.socialInputs.forEach((input) => {
  input.addEventListener("input", () => {
    const bucket = input.dataset.socialFor;
    state.slots[bucket].social = input.value.trim();
    renderReadyChecklist();
    drawPreparedFrame();
  });
});

function emptySlot(bucket) {
  return {
    bucket,
    file: null,
    objectUrl: "",
    social: ""
  };
}

function resetEpisode() {
  stopRenderLoop();
  revokeExportUrl();
  state.preparedMedia.forEach((entry) => {
    entry.video.pause();
    entry.video.removeAttribute("src");
  });
  state.preparedMedia = [];

  Object.keys(state.slots).forEach((bucket) => {
    if (state.slots[bucket].objectUrl) {
      URL.revokeObjectURL(state.slots[bucket].objectUrl);
    }
    state.slots[bucket] = emptySlot(bucket);
  });

  els.fileInputs.forEach((input) => {
    input.value = "";
  });
  els.socialInputs.forEach((input) => {
    input.value = "";
  });
  els.episodeTitle.value = "";
  els.previewButton.disabled = true;
  els.pauseButton.disabled = true;
  els.exportButton.disabled = true;
  renderNativePreview();
  renderSlotStates();
  renderReadyChecklist();
  drawEmptyCanvas("Upload Host and Guest 1 videos, add social links, then preview.");
  setStatus("New episode started. Assign local speaker videos to the visible Host and Guest buckets.");
}

function setSlotFile(bucket, file) {
  const slot = state.slots[bucket];
  if (slot.objectUrl) {
    URL.revokeObjectURL(slot.objectUrl);
  }

  slot.file = file;
  slot.objectUrl = file ? URL.createObjectURL(file) : "";
  state.preparedMedia = [];
  revokeExportUrl();
  els.previewButton.disabled = true;
  els.pauseButton.disabled = true;
  els.exportButton.disabled = true;
  renderNativePreview();
  renderSlotStates();
  renderReadyChecklist();
  drawEmptyCanvas(file ? "Click Preview episode to compose the assigned videos." : "Upload Host and Guest 1 videos, add social links, then preview.");
}

async function handlePreview() {
  stopRenderLoop();
  revokeExportUrl();
  state.preparedMedia = [];

  const setup = collectSetup();
  const errors = validateSetup(setup);
  if (errors.length) {
    setStatus(errors[0], true);
    drawEmptyCanvas(errors[0]);
    return;
  }

  setStatus("Loading assigned speaker videos for preview.");
  const prepared = setup.uploads.map((upload) => createPreparedVideo(upload, setup.socials[upload.bucket]));
  state.preparedMedia = prepared;
  renderNativePreview();

  const outcomes = await Promise.all(prepared.map((entry) => waitForPlayable(entry.video, 3000)));
  const failed = outcomes.find((outcome) => !outcome.ok);
  if (failed) {
    setStatus(`Could not load ${getBucketLabel(failed.bucket)} video. Choose a playable local video file.`, true);
    drawEmptyCanvas(`Could not load ${getBucketLabel(failed.bucket)} video.`);
    return;
  }

  state.preparedMedia.forEach((entry) => {
    entry.duration = Number.isFinite(entry.video.duration) ? entry.video.duration : 1;
  });
  drawPreparedFrame();
  els.previewButton.disabled = false;
  els.pauseButton.disabled = false;
  els.exportButton.disabled = false;
  setStatus("Preview ready. The visible composition uses the assigned local speaker videos.");
}

function createPreparedVideo(upload, social) {
  const video = document.createElement("video");
  video.src = upload.url;
  video.preload = "auto";
  video.playsInline = true;
  video.controls = true;
  video.muted = true;
  video.dataset.bucket = upload.bucket;
  video.load();

  return {
    bucket: upload.bucket,
    file: upload.file,
    social,
    video,
    duration: 0
  };
}

function renderNativePreview() {
  if (!state.preparedMedia.length) {
    els.previewGrid.innerHTML = '<div class="preview-placeholder">Assigned speaker videos appear here after preview.</div>';
    return;
  }

  els.previewGrid.innerHTML = "";
  els.previewGrid.dataset.preset = getSelectedPresetId();

  state.preparedMedia.forEach((entry) => {
    const card = document.createElement("article");
    card.className = "native-preview-card";
    card.dataset.bucket = entry.bucket;

    const label = document.createElement("div");
    label.className = "native-preview-label";
    label.innerHTML = `<strong>${getBucketLabel(entry.bucket)}</strong><span>${formatSocialLabel(entry.social)}</span>`;

    card.append(entry.video, label);
    els.previewGrid.appendChild(card);
  });
}

async function playPreparedMedia(fromStart) {
  if (!state.preparedMedia.length || state.exporting) {
    return false;
  }

  try {
    if (fromStart) {
      await Promise.all(state.preparedMedia.map((entry) => seekVideo(entry.video, 0)));
    }
    state.preparedMedia.forEach((entry) => {
      entry.video.muted = false;
    });
    await Promise.all(state.preparedMedia.map((entry) => entry.video.play()));
    startRenderLoop();
    setStatus("Preview playing from the assigned local speaker videos.");
    return true;
  } catch (error) {
    pausePreparedMedia();
    setStatus(`Preview playback could not start: ${error.message}`, true);
    return false;
  }
}

function pausePreparedMedia() {
  stopRenderLoop();
  state.preparedMedia.forEach((entry) => entry.video.pause());
  drawPreparedFrame();
}

async function handleExport() {
  if (!state.preparedMedia.length || state.exporting) {
    return;
  }

  if (!window.MediaRecorder || !els.previewCanvas.captureStream) {
    setStatus("This browser cannot record the composed video export.", true);
    return;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    setStatus("This browser cannot mix the uploaded speaker audio for export.", true);
    return;
  }

  state.exporting = true;
  els.exportButton.disabled = true;
  revokeExportUrl();
  setStatus("Exporting the composed video from the assigned media.");

  const outputStream = new MediaStream();
  const canvasStream = els.previewCanvas.captureStream(30);
  canvasStream.getVideoTracks().forEach((track) => outputStream.addTrack(track));

  const audioContext = new AudioContextCtor();
  const audioDestination = audioContext.createMediaStreamDestination();
  const cleanups = [];

  for (const entry of state.preparedMedia) {
    const mediaStream = entry.video.captureStream ? entry.video.captureStream() : entry.video.mozCaptureStream?.();
    if (!mediaStream) {
      await stopFailedExport(audioContext, cleanups, "This browser cannot capture one of the uploaded videos for export.");
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
    cleanups.push(() => {
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

  const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));

  await audioContext.resume();
  drawPreparedFrame();
  recorder.start(500);

  const started = await playPreparedMediaForExport();
  if (!started) {
    recorder.stop();
    await stopped;
    await stopFailedExport(audioContext, cleanups, "Export stopped because media playback could not start.");
    return;
  }

  const durationMs = Math.max(getEpisodeDuration(state.preparedMedia) * 1000, 1200);
  await wait(durationMs);
  pausePreparedMedia();
  drawPreparedFrame();
  recorder.stop();
  await stopped;
  cleanups.forEach((cleanup) => cleanup());
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
  els.exportLink.textContent = `Download composed video (${formatFileSize(blob.size)})`;
  els.exportLink.hidden = false;
  state.exporting = false;
  els.exportButton.disabled = false;
  setStatus("Export ready. Download the composed video file.");
}

async function playPreparedMediaForExport() {
  try {
    await Promise.all(state.preparedMedia.map((entry) => seekVideo(entry.video, 0)));
    state.preparedMedia.forEach((entry) => {
      entry.video.muted = false;
    });
    await Promise.all(state.preparedMedia.map((entry) => entry.video.play()));
    startRenderLoop();
    return true;
  } catch {
    return false;
  }
}

async function stopFailedExport(audioContext, cleanups, message) {
  cleanups.forEach((cleanup) => cleanup());
  await audioContext.close();
  state.exporting = false;
  els.exportButton.disabled = false;
  setStatus(message, true);
}

function collectSetup() {
  const uploads = Object.values(state.slots)
    .filter((slot) => slot.file)
    .map((slot) => ({
      bucket: slot.bucket,
      file: slot.file,
      url: slot.objectUrl
    }));

  const socials = Object.values(state.slots).reduce((acc, slot) => {
    acc[slot.bucket] = slot.social;
    return acc;
  }, {});

  return {
    uploads,
    socials,
    presetId: getSelectedPresetId()
  };
}

function renderReadyChecklist() {
  const setup = collectSetup();
  const buckets = new Set(setup.uploads.map((upload) => upload.bucket));
  const checks = [
    {
      label: "Host video assigned",
      done: buckets.has("host")
    },
    {
      label: "Guest 1 video assigned",
      done: buckets.has("guest1")
    },
    {
      label: "Host and Guest 1 social links added",
      done: Boolean(setup.socials.host && setup.socials.guest1)
    },
    {
      label: `Preset selected (${getPresetById(setup.presetId).name})`,
      done: Boolean(setup.presetId)
    },
    {
      label: "Preview built from assigned videos",
      done: state.preparedMedia.length >= 2
    }
  ];

  els.readyList.innerHTML = checks.map(
    (check) => `<li class="${check.done ? "done" : ""}">${check.done ? "Ready" : "Pending"} - ${check.label}</li>`
  ).join("");
}

function renderSlotStates() {
  els.slotStates.forEach((node) => {
    const bucket = node.dataset.stateFor;
    const file = state.slots[bucket].file;
    node.textContent = file ? file.name : "No file";
    node.classList.toggle("ready", Boolean(file));
  });
}

function drawPreparedFrame() {
  renderReadyChecklist();
  if (!state.preparedMedia.length) {
    return;
  }

  const preset = getPresetById(getSelectedPresetId());
  const width = els.previewCanvas.width;
  const height = els.previewCanvas.height;
  const elapsedMs = Math.max(...state.preparedMedia.map((entry) => entry.video.currentTime * 1000));
  const buckets = state.preparedMedia.map((entry) => entry.bucket);
  const frames = getFrames(preset.id, buckets, width, height, elapsedMs);

  canvasContext.clearRect(0, 0, width, height);
  canvasContext.fillStyle = preset.background;
  canvasContext.fillRect(0, 0, width, height);

  frames.forEach((frame) => {
    const entry = state.preparedMedia.find((item) => item.bucket === frame.bucket);
    if (entry) {
      drawVideoFrame(entry, frame, preset);
    }
  });

  canvasContext.fillStyle = "rgba(2, 6, 23, 0.86)";
  canvasContext.fillRect(28, 24, 410, 62);
  canvasContext.fillStyle = "#f8fafc";
  canvasContext.font = "600 24px Arial, sans-serif";
  canvasContext.fillText(els.episodeTitle.value.trim() || "New podcast episode", 46, 62);
}

function drawVideoFrame(entry, frame, preset) {
  const video = entry.video;
  canvasContext.fillStyle = "#0f172a";
  canvasContext.fillRect(frame.x, frame.y, frame.width, frame.height);

  if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
    const fit = cover(video.videoWidth, video.videoHeight, frame.width, frame.height);
    canvasContext.drawImage(video, frame.x + fit.offsetX, frame.y + fit.offsetY, fit.width, fit.height);
  }

  canvasContext.lineWidth = frame.spotlight ? 5 : 3;
  canvasContext.strokeStyle = frame.spotlight ? preset.accent : "rgba(226, 232, 240, 0.58)";
  canvasContext.strokeRect(frame.x, frame.y, frame.width, frame.height);

  canvasContext.fillStyle = "rgba(2, 6, 23, 0.82)";
  canvasContext.fillRect(frame.x + 14, frame.y + frame.height - 78, Math.min(340, frame.width - 28), 58);
  canvasContext.fillStyle = "#ffffff";
  canvasContext.font = "600 22px Arial, sans-serif";
  canvasContext.fillText(getBucketLabel(entry.bucket), frame.x + 28, frame.y + frame.height - 43);
  canvasContext.fillStyle = "#cbd5e1";
  canvasContext.font = "500 16px Arial, sans-serif";
  canvasContext.fillText(formatSocialLabel(entry.social), frame.x + 28, frame.y + frame.height - 20);
}

function drawEmptyCanvas(message) {
  canvasContext.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
  canvasContext.fillStyle = "#020617";
  canvasContext.fillRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
  canvasContext.fillStyle = "#f8fafc";
  canvasContext.font = "600 30px Arial, sans-serif";
  canvasContext.fillText("Podcast Design Canvas", 56, 120);
  canvasContext.fillStyle = "#94a3b8";
  canvasContext.font = "500 22px Arial, sans-serif";
  canvasContext.fillText(message, 56, 178);
}

function startRenderLoop() {
  stopRenderLoop();
  const render = () => {
    drawPreparedFrame();
    if (state.preparedMedia.some((entry) => !entry.video.paused && !entry.video.ended)) {
      state.renderLoop = requestAnimationFrame(render);
    }
  };
  state.renderLoop = requestAnimationFrame(render);
}

function stopRenderLoop() {
  if (state.renderLoop) {
    cancelAnimationFrame(state.renderLoop);
    state.renderLoop = 0;
  }
}

function waitForPlayable(video, timeoutMs) {
  return new Promise((resolve) => {
    if (video.readyState >= 2) {
      resolve({ ok: true });
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, bucket: video.dataset.bucket });
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve({ ok: true });
    };
    const onError = () => {
      cleanup();
      resolve({ ok: false, bucket: video.dataset.bucket });
    };

    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function seekVideo(video, time) {
  return new Promise((resolve) => {
    if (!Number.isFinite(video.duration) || Math.abs(video.currentTime - time) < 0.05) {
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

function getSelectedPresetId() {
  return document.querySelector('input[name="preset"]:checked')?.value || PRESETS[0].id;
}

function revokeExportUrl() {
  if (state.exportUrl) {
    URL.revokeObjectURL(state.exportUrl);
    state.exportUrl = "";
  }
  els.exportLink.hidden = true;
}

function selectMimeType() {
  return [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ].find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

function cover(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  if (sourceRatio > targetRatio) {
    const height = targetHeight;
    const width = height * sourceRatio;
    return { width, height, offsetX: (targetWidth - width) / 2, offsetY: 0 };
  }
  const width = targetWidth;
  const height = width / sourceRatio;
  return { width, height, offsetX: 0, offsetY: (targetHeight - height) / 2 };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFileSize(size) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.dataset.tone = isError ? "error" : "default";
}
}());
