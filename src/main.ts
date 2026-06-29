import "./styles.css";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  PRESETS,
  SPEAKER_LABELS,
  createPreviewVideo,
  drawComposition,
  getEpisodeDuration,
  getExportFileName,
  hasEnoughTracks,
  waitForMetadata
} from "./composition";
import { exportEpisodeVideo } from "./exporter";
import type { LoadedTrack, PresetId, SpeakerRole, SpeakerTrack } from "./types";

const speakerRoles: SpeakerRole[] = ["host", "guest1", "guest2"];

interface AppState {
  episodeTitle: string;
  presetId: PresetId;
  tracks: SpeakerTrack[];
  previewing: boolean;
  exporting: boolean;
  exportProgress: number;
  exportStatus: string;
  exportUrl?: string;
  exportFileName?: string;
  error?: string;
}

let animationFrame = 0;

const state: AppState = {
  episodeTitle: "New podcast episode",
  presetId: "roundtable",
  tracks: speakerRoles.map((role) => ({
    role,
    label: SPEAKER_LABELS[role],
    socialLink: ""
  })),
  previewing: false,
  exporting: false,
  exportProgress: 0,
  exportStatus: ""
};

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("App root not found.");
}

const app = appRoot;

render();

function render(): void {
  app.innerHTML = `
    <section class="workspace">
      <aside class="setup-panel" aria-label="Episode setup">
        <div class="brand-block">
          <p class="eyebrow">Podcast Design Canvas</p>
          <h1>Episode import to export</h1>
        </div>

        <label class="field">
          <span>Episode title</span>
          <input data-action="title" type="text" value="${escapeAttribute(state.episodeTitle)}" />
        </label>

        <div class="section-heading">
          <h2>Speaker buckets</h2>
          <span>${loadedTracksFromState().length}/3 ready</span>
        </div>
        <div class="speaker-list">
          ${state.tracks.map(renderSpeakerBucket).join("")}
        </div>

        <div class="section-heading">
          <h2>Preset</h2>
          <span>Layout and pacing</span>
        </div>
        <div class="preset-grid" role="radiogroup" aria-label="Preset">
          ${PRESETS.map(renderPreset).join("")}
        </div>
      </aside>

      <section class="preview-panel" aria-label="Preview and export">
        <div class="preview-toolbar">
          <div>
            <p class="eyebrow">Live composition</p>
            <h2>${escapeHtml(currentPresetName())}</h2>
          </div>
          <div class="toolbar-actions">
            <button class="secondary" data-action="preview" ${canPreview() ? "" : "disabled"}>
              ${state.previewing ? "Restart preview" : "Preview"}
            </button>
            <button class="primary" data-action="export" ${canExport() ? "" : "disabled"}>
              ${state.exporting ? "Exporting..." : "Export video"}
            </button>
          </div>
        </div>

        <div class="canvas-shell">
          <canvas id="composition-canvas" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}"></canvas>
          ${renderEmptyState()}
        </div>

        <div class="status-row">
          <div>
            <strong>${workflowStatus()}</strong>
            <span>${durationText()}</span>
          </div>
          <progress value="${state.exportProgress}" max="1" ${state.exporting || state.exportUrl ? "" : "hidden"}></progress>
        </div>

        ${state.error ? `<p class="notice error">${escapeHtml(state.error)}</p>` : ""}
        ${state.exportUrl ? renderDownload() : ""}
      </section>
    </section>
  `;

  bindEvents();
  drawCurrentFrame();

  if (state.previewing) {
    startPreviewLoop();
  }
}

function renderSpeakerBucket(track: SpeakerTrack): string {
  const fileName = track.file ? track.file.name : "Choose synced video";
  const duration = track.video && Number.isFinite(track.video.duration) ? formatDuration(track.video.duration) : "No media yet";

  return `
    <article class="speaker-card">
      <div class="speaker-card__head">
        <div>
          <h3>${escapeHtml(track.label)}</h3>
          <p>${escapeHtml(duration)}</p>
        </div>
        <span class="${track.file ? "ready-pill" : "empty-pill"}">${track.file ? "Ready" : "Empty"}</span>
      </div>
      <label class="file-picker">
        <input data-action="file" data-role="${track.role}" type="file" accept="video/*" />
        <span>${escapeHtml(fileName)}</span>
      </label>
      <label class="field compact">
        <span>Social link</span>
        <input data-action="social" data-role="${track.role}" type="url" placeholder="https://..." value="${escapeAttribute(track.socialLink)}" />
      </label>
    </article>
  `;
}

function renderPreset(preset: (typeof PRESETS)[number]): string {
  const checked = preset.id === state.presetId;

  return `
    <button class="preset-card ${checked ? "selected" : ""}" data-action="preset" data-preset="${preset.id}" role="radio" aria-checked="${checked}">
      <strong>${escapeHtml(preset.name)}</strong>
      <span>${escapeHtml(preset.description)}</span>
    </button>
  `;
}

function renderEmptyState(): string {
  if (loadedTracksFromState().length > 0) {
    return "";
  }

  return `
    <div class="empty-preview">
      <strong>Add at least two speaker videos</strong>
      <span>The canvas will render the selected preset from the uploaded media.</span>
    </div>
  `;
}

function renderDownload(): string {
  return `
    <div class="download-panel">
      <div>
        <strong>Export ready</strong>
        <span>${escapeHtml(state.exportFileName ?? "podcast-episode-designed.webm")}</span>
      </div>
      <a class="download-link" href="${state.exportUrl}" download="${escapeAttribute(state.exportFileName ?? "podcast-episode-designed.webm")}">
        Download WebM
      </a>
    </div>
  `;
}

function bindEvents(): void {
  app.querySelector<HTMLInputElement>("[data-action='title']")?.addEventListener("input", (event) => {
    state.episodeTitle = (event.currentTarget as HTMLInputElement).value;
  });

  app.querySelectorAll<HTMLInputElement>("[data-action='file']").forEach((input) => {
    input.addEventListener("change", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      const role = target.dataset.role as SpeakerRole;
      const file = target.files?.[0];

      if (file) {
        void setTrackFile(role, file);
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>("[data-action='social']").forEach((input) => {
    input.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      const role = target.dataset.role as SpeakerRole;
      const track = state.tracks.find((candidate) => candidate.role === role);

      if (track) {
        track.socialLink = target.value;
      }
    });
  });

  app.querySelectorAll<HTMLButtonElement>("[data-action='preset']").forEach((button) => {
    button.addEventListener("click", () => {
      state.presetId = button.dataset.preset as PresetId;
      state.error = undefined;
      render();
    });
  });

  app.querySelector<HTMLButtonElement>("[data-action='preview']")?.addEventListener("click", () => {
    void startPreview();
  });

  app.querySelector<HTMLButtonElement>("[data-action='export']")?.addEventListener("click", () => {
    void startExport();
  });
}

async function setTrackFile(role: SpeakerRole, file: File): Promise<void> {
  const track = state.tracks.find((candidate) => candidate.role === role);

  if (!track) {
    return;
  }

  if (track.objectUrl) {
    URL.revokeObjectURL(track.objectUrl);
  }

  const objectUrl = URL.createObjectURL(file);
  const video = createPreviewVideo(objectUrl);

  try {
    await waitForMetadata(video);
    track.file = file;
    track.objectUrl = objectUrl;
    track.video = video;
    state.error = undefined;
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    state.error = getErrorMessage(error);
  }

  state.exportUrl = undefined;
  state.exportFileName = undefined;
  render();
}

async function startPreview(): Promise<void> {
  const tracks = loadedTracksFromState();

  if (tracks.length < 2) {
    state.error = "Upload at least two synced speaker videos before previewing.";
    render();
    return;
  }

  state.error = undefined;
  state.previewing = true;
  tracks.forEach((track) => {
    track.video.currentTime = 0;
  });

  try {
    await Promise.all(tracks.map((track) => track.video.play()));
  } catch (error) {
    state.previewing = false;
    state.error = getErrorMessage(error);
  }

  render();
}

async function startExport(): Promise<void> {
  const tracks = loadedTracksFromState();

  if (tracks.length < 2) {
    state.error = "Upload at least two synced speaker videos before exporting.";
    render();
    return;
  }

  stopPreviewLoop();
  state.previewing = false;
  state.exporting = true;
  state.exportProgress = 0;
  state.exportStatus = "Preparing export...";
  state.error = undefined;
  state.exportUrl = undefined;
  render();

  try {
    const blob = await exportEpisodeVideo({
      presetId: state.presetId,
      tracks,
      onProgress: ({ state: exportState, progress }) => {
        state.exportProgress = progress;
        state.exportStatus =
          exportState === "recording"
            ? `Recording composed episode ${Math.round(progress * 100)}%`
            : exportState === "finalizing"
              ? "Finalizing downloadable video..."
              : "Preparing media...";
        updateExportProgress();
      }
    });

    state.exportUrl = URL.createObjectURL(blob);
    state.exportFileName = getExportFileName(state.episodeTitle);
    state.exportStatus = "Download is ready.";
  } catch (error) {
    state.error = getErrorMessage(error);
    state.exportStatus = "Export failed.";
  } finally {
    state.exporting = false;
    state.exportProgress = state.exportUrl ? 1 : 0;
    render();
  }
}

function updateExportProgress(): void {
  const progress = app.querySelector<HTMLProgressElement>("progress");
  const status = app.querySelector<HTMLElement>(".status-row strong");

  if (progress) {
    progress.value = state.exportProgress;
    progress.hidden = false;
  }

  if (status) {
    status.textContent = state.exportStatus;
  }
}

function startPreviewLoop(): void {
  stopPreviewLoop();
  const loop = (): void => {
    drawCurrentFrame();
    animationFrame = requestAnimationFrame(loop);
  };
  loop();
}

function stopPreviewLoop(): void {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }
}

function drawCurrentFrame(): void {
  const canvas = app.querySelector<HTMLCanvasElement>("#composition-canvas");
  const ctx = canvas?.getContext("2d");
  const tracks = loadedTracksFromState();

  if (!canvas || !ctx) {
    return;
  }

  if (tracks.length === 0) {
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    return;
  }

  drawComposition(ctx, {
    presetId: state.presetId,
    tracks,
    time: tracks[0]?.video.currentTime ?? 0,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT
  });
}

function loadedTracksFromState(): LoadedTrack[] {
  return state.tracks.filter((track): track is LoadedTrack => Boolean(track.file && track.objectUrl && track.video));
}

function canPreview(): boolean {
  return hasEnoughTracks(state.tracks) && !state.exporting;
}

function canExport(): boolean {
  return hasEnoughTracks(state.tracks) && !state.exporting;
}

function workflowStatus(): string {
  if (state.exportStatus) {
    return state.exportStatus;
  }

  if (state.previewing) {
    return "Previewing real uploaded media.";
  }

  if (loadedTracksFromState().length >= 2) {
    return "Ready to preview and export.";
  }

  return "Waiting for synced speaker uploads.";
}

function durationText(): string {
  const tracks = loadedTracksFromState();
  const duration = getEpisodeDuration(tracks);

  if (duration <= 0) {
    return "Export duration appears after media metadata loads.";
  }

  return `Export length: ${formatDuration(duration)} from the synced uploaded files.`;
}

function currentPresetName(): string {
  return PRESETS.find((preset) => preset.id === state.presetId)?.name ?? "Preset";
}

function formatDuration(duration: number): string {
  const totalSeconds = Math.floor(duration);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[character];
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
