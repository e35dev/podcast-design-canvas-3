import type { CompositionState, FrameRect, LoadedTrack, PresetId, SpeakerFrame, SpeakerRole } from "./types";

export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;

export const SPEAKER_LABELS: Record<SpeakerRole, string> = {
  host: "Host",
  guest1: "Guest 1",
  guest2: "Guest 2"
};

export const PRESETS: Array<{
  id: PresetId;
  name: string;
  description: string;
}> = [
  {
    id: "roundtable",
    name: "Roundtable rhythm",
    description: "Balanced split-screen pacing for panel conversations."
  },
  {
    id: "hostFocus",
    name: "Host spotlight",
    description: "Host-led composition with guest reactions stacked beside it."
  },
  {
    id: "socialStudio",
    name: "Social studio",
    description: "Editorial lower thirds and a warmer branded stage."
  }
];

export function hasEnoughTracks(tracks: readonly { file?: File }[]): boolean {
  return tracks.filter((track) => track.file).length >= 2;
}

export function getEpisodeDuration(tracks: readonly LoadedTrack[]): number {
  const finiteDurations = tracks
    .map((track) => track.video.duration)
    .filter((duration) => Number.isFinite(duration) && duration > 0);

  if (finiteDurations.length === 0) {
    return 0;
  }

  return Math.min(...finiteDurations);
}

export function getExportFileName(episodeTitle: string): string {
  const slug = episodeTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return `${slug || "podcast-episode"}-designed.webm`;
}

export function computeSpeakerFrames(state: CompositionState): SpeakerFrame[] {
  const tracks = state.tracks.slice(0, 3);

  if (state.presetId === "hostFocus") {
    return computeHostFocusFrames(tracks, state);
  }

  if (state.presetId === "socialStudio") {
    return computeSocialStudioFrames(tracks, state);
  }

  return computeRoundtableFrames(tracks, state);
}

export function drawComposition(ctx: CanvasRenderingContext2D, state: CompositionState): void {
  const frames = computeSpeakerFrames(state);

  drawStage(ctx, state);
  frames.forEach((frame) => {
    const track = state.tracks.find((candidate) => candidate.role === frame.role);
    if (!track) {
      return;
    }

    drawVideoCover(ctx, track.video, frame);
    drawFrameChrome(ctx, frame, state.presetId);
    drawLowerThird(ctx, frame, state.presetId);
  });

  drawEpisodeChrome(ctx, state, frames.length);
}

export function createPreviewVideo(url: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "metadata";
  return video;
}

export function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("The selected video file could not be loaded."));
    };
    const cleanup = (): void => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
  });
}

function computeRoundtableFrames(tracks: LoadedTrack[], state: CompositionState): SpeakerFrame[] {
  const gap = 24;
  const outer = 48;
  const count = Math.max(tracks.length, 1);
  const frameWidth = (state.width - outer * 2 - gap * (count - 1)) / count;
  const frameHeight = 492;
  const y = 118;

  return tracks.map((track, index) => ({
    role: track.role,
    label: track.label,
    socialLink: track.socialLink,
    emphasized: false,
    x: outer + index * (frameWidth + gap),
    y,
    width: frameWidth,
    height: frameHeight
  }));
}

function computeHostFocusFrames(tracks: LoadedTrack[], state: CompositionState): SpeakerFrame[] {
  const host = tracks.find((track) => track.role === "host") ?? tracks[0];
  const guests = tracks.filter((track) => track.role !== host.role);
  const frames: SpeakerFrame[] = [
    {
      role: host.role,
      label: host.label,
      socialLink: host.socialLink,
      emphasized: true,
      x: 48,
      y: 104,
      width: guests.length > 0 ? 760 : state.width - 96,
      height: 520
    }
  ];

  guests.forEach((track, index) => {
    frames.push({
      role: track.role,
      label: track.label,
      socialLink: track.socialLink,
      emphasized: false,
      x: 840,
      y: 104 + index * 268,
      width: 392,
      height: guests.length === 1 ? 520 : 244
    });
  });

  return frames;
}

function computeSocialStudioFrames(tracks: LoadedTrack[], state: CompositionState): SpeakerFrame[] {
  const featuredIndex = Math.floor(state.time / 12) % tracks.length;
  const featured = tracks[featuredIndex];
  const others = tracks.filter((_, index) => index !== featuredIndex);
  const frames: SpeakerFrame[] = [
    {
      role: featured.role,
      label: featured.label,
      socialLink: featured.socialLink,
      emphasized: true,
      x: 58,
      y: 92,
      width: others.length > 0 ? 690 : state.width - 116,
      height: 524
    }
  ];

  others.forEach((track, index) => {
    frames.push({
      role: track.role,
      label: track.label,
      socialLink: track.socialLink,
      emphasized: false,
      x: 790 + index * 214,
      y: 164,
      width: others.length === 1 ? 432 : 198,
      height: 378
    });
  });

  return frames;
}

function drawStage(ctx: CanvasRenderingContext2D, state: CompositionState): void {
  const gradient = ctx.createLinearGradient(0, 0, state.width, state.height);

  if (state.presetId === "socialStudio") {
    gradient.addColorStop(0, "#13211d");
    gradient.addColorStop(0.54, "#20332d");
    gradient.addColorStop(1, "#473322");
  } else if (state.presetId === "hostFocus") {
    gradient.addColorStop(0, "#151a22");
    gradient.addColorStop(0.55, "#26303d");
    gradient.addColorStop(1, "#1f2d34");
  } else {
    gradient.addColorStop(0, "#111827");
    gradient.addColorStop(0.5, "#1f2937");
    gradient.addColorStop(1, "#26333d");
  }

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, state.width, state.height);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(0, 642, state.width, 78);
}

function drawVideoCover(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, rect: FrameRect): void {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    drawPendingVideo(ctx, rect);
    return;
  }

  const videoWidth = video.videoWidth || 16;
  const videoHeight = video.videoHeight || 9;
  const scale = Math.max(rect.width / videoWidth, rect.height / videoHeight);
  const sourceWidth = rect.width / scale;
  const sourceHeight = rect.height / scale;
  const sourceX = (videoWidth - sourceWidth) / 2;
  const sourceY = (videoHeight - sourceHeight) / 2;

  ctx.save();
  roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 18);
  ctx.clip();
  ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawPendingVideo(ctx: CanvasRenderingContext2D, rect: FrameRect): void {
  ctx.save();
  roundedRect(ctx, rect.x, rect.y, rect.width, rect.height, 18);
  ctx.clip();
  ctx.fillStyle = "#17202a";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  for (let x = rect.x - rect.height; x < rect.x + rect.width; x += 56) {
    ctx.fillRect(x, rect.y, 24, rect.height * 1.6);
  }
  ctx.restore();
}

function drawFrameChrome(ctx: CanvasRenderingContext2D, frame: SpeakerFrame, presetId: PresetId): void {
  ctx.save();
  roundedRect(ctx, frame.x, frame.y, frame.width, frame.height, 18);
  ctx.lineWidth = frame.emphasized ? 6 : 3;
  ctx.strokeStyle = presetId === "socialStudio" ? "#f6c177" : frame.emphasized ? "#7dd3fc" : "rgba(255,255,255,0.45)";
  ctx.stroke();
  ctx.restore();
}

function drawLowerThird(ctx: CanvasRenderingContext2D, frame: SpeakerFrame, presetId: PresetId): void {
  const pad = 18;
  const boxHeight = frame.socialLink ? 78 : 56;
  const x = frame.x + pad;
  const y = frame.y + frame.height - boxHeight - pad;
  const width = Math.min(frame.width - pad * 2, frame.emphasized ? 390 : 270);

  ctx.save();
  roundedRect(ctx, x, y, width, boxHeight, 14);
  ctx.fillStyle = presetId === "socialStudio" ? "rgba(19, 33, 29, 0.82)" : "rgba(15, 23, 42, 0.78)";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 24px Inter, system-ui, sans-serif";
  ctx.fillText(frame.label, x + 18, y + 34);

  if (frame.socialLink) {
    ctx.fillStyle = presetId === "socialStudio" ? "#f6c177" : "#93c5fd";
    ctx.font = "500 17px Inter, system-ui, sans-serif";
    ctx.fillText(shortenSocial(frame.socialLink), x + 18, y + 61, width - 36);
  }

  ctx.restore();
}

function drawEpisodeChrome(ctx: CanvasRenderingContext2D, state: CompositionState, speakerCount: number): void {
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.font = "700 26px Inter, system-ui, sans-serif";
  ctx.fillText("Podcast Design Canvas", 48, 58);

  ctx.fillStyle = "rgba(255,255,255,0.58)";
  ctx.font = "500 18px Inter, system-ui, sans-serif";
  const preset = PRESETS.find((candidate) => candidate.id === state.presetId);
  ctx.fillText(`${preset?.name ?? "Preset"} - ${speakerCount} synced speaker tracks`, 48, 86);
}

function shortenSocial(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
}
