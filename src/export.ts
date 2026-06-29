import { startSyncedPlayback } from "./playback";

export interface ExportSource {
  video: HTMLVideoElement;
}

export interface ExportOptions {
  canvas: HTMLCanvasElement;
  sources: ExportSource[];
  draw: (elapsedSeconds: number) => void;
  fps?: number;
  onProgress?: (elapsedSeconds: number) => void;
}

const audioSourceCache = new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>();
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext();
  }
  return sharedAudioContext;
}

/** A media element may only ever be wired into one MediaElementAudioSourceNode for its lifetime. */
function getOrCreateSource(ctx: AudioContext, video: HTMLVideoElement): MediaElementAudioSourceNode {
  const cached = audioSourceCache.get(video);
  if (cached) return cached;
  // The speaker cards mute this element for the silent on-page thumbnail, but a muted source
  // can also silence what a MediaElementAudioSourceNode tap captures. Unmuting right before
  // tapping is safe: creating the node permanently redirects the element's audio into the Web
  // Audio graph instead of straight to speakers, so this never causes audible double playback.
  video.muted = false;
  const node = ctx.createMediaElementSource(video);
  audioSourceCache.set(video, node);
  return node;
}

function pickSupportedMimeType(): string {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "video/webm";
}

export async function exportComposition(options: ExportOptions): Promise<Blob> {
  const { canvas, sources, draw, fps = 30, onProgress } = options;
  if (sources.length === 0) {
    throw new Error("No assigned speaker videos to export.");
  }

  const audioCtx = getAudioContext();
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  const destination = audioCtx.createMediaStreamDestination();
  const connectedNodes = sources.map((source) => {
    const node = getOrCreateSource(audioCtx, source.video);
    node.connect(destination);
    return node;
  });

  const canvasStream = canvas.captureStream(fps);
  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);

  const mimeType = pickSupportedMimeType();
  const recorder = new MediaRecorder(combinedStream, { mimeType });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event: BlobEvent): void => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const cleanupAudioGraph = (): void => {
    connectedNodes.forEach((node) => {
      try {
        node.disconnect(destination);
      } catch {
        /* already disconnected */
      }
    });
  };

  let settleReject: (error: Error) => void = () => undefined;
  const recordingDone = new Promise<Blob>((resolve, reject) => {
    settleReject = reject;
    recorder.onerror = (event: Event): void => {
      const message = "error" in event ? String((event as unknown as { error: unknown }).error) : "unknown";
      reject(new Error(`Recorder error: ${message}`));
    };
    recorder.onstop = (): void => {
      cleanupAudioGraph();
      resolve(new Blob(chunks, { type: mimeType }));
    };
  });

  recorder.start(250);

  const playback = startSyncedPlayback({
    videos: sources.map((source) => source.video),
    onFrame: (elapsed) => {
      draw(elapsed);
      onProgress?.(elapsed);
    },
    onComplete: () => {
      window.setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 150);
    },
    onError: (error) => {
      settleReject(error);
      if (recorder.state !== "inactive") recorder.stop();
    },
  });

  try {
    return await recordingDone;
  } finally {
    playback.stop();
  }
}
