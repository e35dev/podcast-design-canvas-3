import {
  PRESETS,
  createInitialSpeakers,
  checkPreviewReadiness,
  getAssignedSpeakers,
  getPreset,
  computeLayout,
  formatDuration,
  safeDuration,
  type SpeakerState,
  type SpeakerRole,
} from "./model";
import { drawComposition, type FrameSource } from "./composer";
import { startSyncedPlayback, type PlaybackHandle } from "./playback";
import { exportComposition } from "./export";
import { waitForPlayableData } from "./media";

const episodeTitleInput = document.getElementById("episode-title") as HTMLInputElement;
const presetGrid = document.getElementById("preset-grid") as HTMLDivElement;
const previewStatus = document.getElementById("preview-status") as HTMLParagraphElement;
const playButton = document.getElementById("play-button") as HTMLButtonElement;
const previewTime = document.getElementById("preview-time") as HTMLSpanElement;
const exportButton = document.getElementById("export-button") as HTMLButtonElement;
const exportStatus = document.getElementById("export-status") as HTMLParagraphElement;
const exportResult = document.getElementById("export-result") as HTMLDivElement;
const exportVideo = document.getElementById("export-video") as HTMLVideoElement;
const downloadLink = document.getElementById("download-link") as HTMLAnchorElement;
const canvas = document.getElementById("preview-canvas") as HTMLCanvasElement;

const rawCtx = canvas.getContext("2d");
if (!rawCtx) {
  throw new Error("Canvas 2D context is not supported in this browser.");
}
const ctx = rawCtx;

const speakers = createInitialSpeakers();
let selectedPresetId: string | null = null;
let isPlaying = false;
let isExporting = false;
let playbackHandle: PlaybackHandle | null = null;
let lastExportUrl: string | null = null;

function getSpeaker(role: SpeakerRole): SpeakerState {
  const speaker = speakers.find((candidate) => candidate.role === role);
  if (!speaker) throw new Error(`Unknown speaker role: ${role}`);
  return speaker;
}

function buildPresetSwatch(layout: "split" | "spotlight" | "grid"): HTMLDivElement {
  const swatch = document.createElement("div");
  swatch.className = `preset-swatch ${layout}`;

  if (layout === "split") {
    swatch.append(document.createElement("span"), document.createElement("span"));
  } else if (layout === "spotlight") {
    const sideStack = document.createElement("div");
    sideStack.className = "side-stack";
    sideStack.append(document.createElement("span"), document.createElement("span"));
    swatch.append(document.createElement("span"), sideStack);
  } else {
    swatch.append(
      document.createElement("span"),
      document.createElement("span"),
      document.createElement("span"),
      document.createElement("span"),
    );
  }
  return swatch;
}

function renderPresetGrid(): void {
  PRESETS.forEach((preset) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    card.dataset.presetId = preset.id;

    const title = document.createElement("h3");
    title.textContent = preset.name;
    const description = document.createElement("p");
    description.textContent = preset.description;
    const pacing = document.createElement("span");
    pacing.className = "pacing-tag";
    pacing.textContent = preset.pacing;

    card.append(buildPresetSwatch(preset.layout), title, description, pacing);
    card.addEventListener("click", () => selectPreset(preset.id));
    presetGrid.appendChild(card);
  });
}

function selectPreset(presetId: string): void {
  selectedPresetId = presetId;
  presetGrid.querySelectorAll<HTMLButtonElement>(".preset-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.presetId === presetId);
  });
  refreshAll();
}

function handleFileSelected(
  speaker: SpeakerState,
  videoEl: HTMLVideoElement,
  statusEl: HTMLElement,
  file: File | null,
): void {
  if (speaker.objectUrl) {
    URL.revokeObjectURL(speaker.objectUrl);
  }
  speaker.file = file;
  speaker.objectUrl = null;
  speaker.ready = false;
  speaker.duration = null;

  if (!file) {
    videoEl.removeAttribute("src");
    videoEl.load();
    statusEl.textContent = "No file selected.";
    refreshAll();
    return;
  }

  const url = URL.createObjectURL(file);
  speaker.objectUrl = url;
  videoEl.src = url;
  statusEl.textContent = `Loading ${file.name}…`;

  waitForPlayableData(videoEl)
    .then((duration) => {
      speaker.ready = true;
      speaker.duration = duration;
      statusEl.textContent = `${file.name} • ${formatDuration(safeDuration(duration))}`;
      refreshAll();
    })
    .catch((error: unknown) => {
      speaker.file = null;
      speaker.ready = false;
      speaker.objectUrl = null;
      URL.revokeObjectURL(url);
      statusEl.textContent = error instanceof Error ? error.message : "This file could not be loaded.";
      refreshAll();
    });

  refreshAll();
}

function wireSpeakerCards(): void {
  document.querySelectorAll<HTMLElement>(".speaker-card").forEach((card) => {
    const role = card.dataset.role as SpeakerRole;
    const speaker = getSpeaker(role);
    const fileInput = card.querySelector<HTMLInputElement>('[data-input="file"]');
    const nameInput = card.querySelector<HTMLInputElement>('[data-input="name"]');
    const socialInput = card.querySelector<HTMLInputElement>('[data-input="social"]');
    const videoEl = card.querySelector<HTMLVideoElement>('[data-el="video"]');
    const statusEl = card.querySelector<HTMLElement>('[data-el="status"]');
    if (!fileInput || !nameInput || !socialInput || !videoEl || !statusEl) {
      throw new Error(`Speaker card for role "${role}" is missing required elements.`);
    }

    speaker.videoEl = videoEl;

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
      handleFileSelected(speaker, videoEl, statusEl, file);
    });

    nameInput.addEventListener("input", () => {
      speaker.displayName = nameInput.value.trim() || speaker.label;
      if (!isPlaying) renderStaticFrame();
    });

    socialInput.addEventListener("input", () => {
      speaker.socialLink = socialInput.value.trim();
    });
  });
}

function drawFrame(assigned: SpeakerState[], presetId: string): void {
  const preset = getPreset(presetId);
  if (!preset) return;
  const rects = computeLayout(preset.layout, assigned.length, canvas.width, canvas.height);
  const sources: FrameSource[] = assigned.map((speaker) => ({
    drawable: speaker.videoEl as HTMLVideoElement,
    naturalWidth: speaker.videoEl?.videoWidth ?? 0,
    naturalHeight: speaker.videoEl?.videoHeight ?? 0,
    displayName: speaker.displayName,
  }));
  drawComposition(ctx, canvas.width, canvas.height, rects, sources);
}

function clearCanvasWithMessage(message: string): void {
  ctx.fillStyle = "#0b0b12";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#5d5775";
  ctx.font = "28px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, canvas.width / 2, canvas.height / 2, canvas.width - 120);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function renderStaticFrame(): void {
  const check = checkPreviewReadiness(speakers, selectedPresetId);
  if (!check.ready || !selectedPresetId) {
    clearCanvasWithMessage("Add at least two speaker videos and choose a preset");
    return;
  }
  drawFrame(getAssignedSpeakers(speakers), selectedPresetId);
}

function stopPlaybackUi(): void {
  isPlaying = false;
  playbackHandle = null;
  playButton.textContent = "Play preview";
  previewTime.textContent = "0:00";
  refreshAll();
}

function refreshAll(options: { resetExportStatus?: boolean } = {}): void {
  const { resetExportStatus = true } = options;
  const check = checkPreviewReadiness(speakers, selectedPresetId);

  if (check.ready && selectedPresetId) {
    const preset = getPreset(selectedPresetId);
    previewStatus.textContent = `Ready • ${getAssignedSpeakers(speakers).length} speakers composed in "${preset?.name}".`;
  } else {
    previewStatus.textContent = check.reasons.join(" ");
  }

  playButton.disabled = !check.ready || isPlaying;
  exportButton.disabled = !check.ready || isExporting;

  if (!isExporting && resetExportStatus) {
    exportStatus.textContent = check.ready
      ? "Ready to export with the real uploaded media and audio."
      : "Assign speakers and choose a preset to enable export.";
  }

  if (!isPlaying) {
    renderStaticFrame();
  }
}

function wirePlayback(): void {
  playButton.addEventListener("click", startPlayback);
}

function startPlayback(): void {
  if (isPlaying) return;
  const check = checkPreviewReadiness(speakers, selectedPresetId);
  if (!check.ready || !selectedPresetId) return;

  const assigned = getAssignedSpeakers(speakers);
  const presetId = selectedPresetId;

  isPlaying = true;
  playButton.textContent = "Playing…";
  playButton.disabled = true;
  exportButton.disabled = true;

  playbackHandle = startSyncedPlayback({
    videos: assigned.map((speaker) => speaker.videoEl as HTMLVideoElement),
    onFrame: (elapsed) => {
      drawFrame(assigned, presetId);
      previewTime.textContent = formatDuration(elapsed);
    },
    onComplete: stopPlaybackUi,
    onError: (error) => {
      previewStatus.textContent = `Playback error: ${error.message}`;
      stopPlaybackUi();
    },
  });
}

function wireExport(): void {
  exportButton.addEventListener("click", () => {
    void runExport();
  });
}

async function runExport(): Promise<void> {
  const check = checkPreviewReadiness(speakers, selectedPresetId);
  if (!check.ready || !selectedPresetId) return;

  if (isPlaying && playbackHandle) {
    playbackHandle.stop();
    stopPlaybackUi();
  }

  const assigned = getAssignedSpeakers(speakers);
  const presetId = selectedPresetId;

  isExporting = true;
  exportButton.disabled = true;
  playButton.disabled = true;
  exportButton.textContent = "Exporting…";
  exportStatus.textContent = "Rendering your episode from the uploaded media…";
  exportResult.hidden = true;

  try {
    const blob = await exportComposition({
      canvas,
      sources: assigned.map((speaker) => ({ video: speaker.videoEl as HTMLVideoElement })),
      draw: () => drawFrame(assigned, presetId),
      onProgress: (elapsed) => {
        exportStatus.textContent = `Rendering… ${formatDuration(elapsed)} captured`;
      },
    });

    const url = URL.createObjectURL(blob);
    if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
    lastExportUrl = url;
    exportVideo.src = url;
    downloadLink.href = url;
    const safeTitle = (episodeTitleInput.value.trim() || "episode").replace(/[^a-z0-9-_]+/gi, "-");
    downloadLink.download = `${safeTitle}.webm`;
    exportResult.hidden = false;
    exportStatus.textContent = `Export ready • ${(blob.size / (1024 * 1024)).toFixed(1)} MB`;
  } catch (error) {
    exportStatus.textContent = `Export failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    isExporting = false;
    exportButton.textContent = "Export video";
    refreshAll({ resetExportStatus: false });
  }
}

renderPresetGrid();
wireSpeakerCards();
wirePlayback();
wireExport();
refreshAll();
