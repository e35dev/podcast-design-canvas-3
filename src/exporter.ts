import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  drawComposition,
  getEpisodeDuration,
  waitForMetadata
} from "./composition";
import type { LoadedTrack, PresetId } from "./types";

export interface ExportProgress {
  state: "preparing" | "recording" | "finalizing";
  progress: number;
}

export interface ExportOptions {
  presetId: PresetId;
  tracks: LoadedTrack[];
  onProgress?: (progress: ExportProgress) => void;
}

export async function exportEpisodeVideo(options: ExportOptions): Promise<Blob> {
  options.onProgress?.({ state: "preparing", progress: 0 });

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = CANVAS_WIDTH;
  exportCanvas.height = CANVAS_HEIGHT;
  const ctx = exportCanvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas rendering is not available in this browser.");
  }

  const exportTracks = await createExportTracks(options.tracks);
  const duration = getEpisodeDuration(exportTracks);

  if (duration <= 0) {
    throw new Error("The uploaded videos need readable durations before export can start.");
  }

  const audioContext = new AudioContext();
  const audioDestination = audioContext.createMediaStreamDestination();

  exportTracks.forEach((track) => {
    const source = audioContext.createMediaElementSource(track.video);
    const gain = audioContext.createGain();
    gain.gain.value = 1 / exportTracks.length;
    source.connect(gain).connect(audioDestination);
  });

  const canvasStream = exportCanvas.captureStream(30);
  const mixedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioDestination.stream.getAudioTracks()
  ]);

  const recorder = new MediaRecorder(mixedStream, {
    mimeType: chooseMimeType()
  });
  const chunks: Blob[] = [];

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener("stop", () => {
      resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
    });
    recorder.addEventListener("error", () => {
      reject(new Error("The browser stopped the export recorder."));
    });
  });

  exportTracks.forEach((track) => {
    track.video.currentTime = 0;
  });

  await audioContext.resume();
  await Promise.all(exportTracks.map((track) => track.video.play()));

  const startedAt = performance.now();
  let frameId = 0;
  const render = (): void => {
    const elapsed = (performance.now() - startedAt) / 1000;
    const time = Math.min(elapsed, duration);
    drawComposition(ctx, {
      presetId: options.presetId,
      tracks: exportTracks,
      time,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT
    });

    options.onProgress?.({
      state: "recording",
      progress: Math.min(time / duration, 1)
    });

    if (time >= duration || exportTracks.every((track) => track.video.ended)) {
      options.onProgress?.({ state: "finalizing", progress: 1 });
      recorder.stop();
      return;
    }

    frameId = requestAnimationFrame(render);
  };

  recorder.start(1000);
  render();

  const blob = await finished.finally(() => {
    cancelAnimationFrame(frameId);
    exportTracks.forEach((track) => track.video.pause());
    mixedStream.getTracks().forEach((track) => track.stop());
    void audioContext.close();
  });

  if (blob.size === 0) {
    throw new Error("The export completed without video data.");
  }

  return blob;
}

async function createExportTracks(tracks: LoadedTrack[]): Promise<LoadedTrack[]> {
  const exportTracks = tracks.map((track) => {
    const video = document.createElement("video");
    video.src = track.objectUrl;
    video.muted = false;
    video.playsInline = true;
    video.preload = "auto";

    return {
      ...track,
      video
    };
  });

  await Promise.all(exportTracks.map((track) => waitForMetadata(track.video)));
  return exportTracks;
}

function chooseMimeType(): string {
  const supportedType = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ].find((type) => MediaRecorder.isTypeSupported(type));

  if (!supportedType) {
    throw new Error("This browser cannot export WebM video with MediaRecorder.");
  }

  return supportedType;
}
