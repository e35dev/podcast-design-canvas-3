import type { EpisodeEngine } from './engine';

export interface RecorderOptions {
  mimeType?: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

export function pickSupportedMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

export function extensionFor(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

export interface RecordResult {
  blob: Blob;
  url: string;
  mimeType: string;
  durationMs: number;
}

/**
 * Records the engine's live composed canvas + real mixed audio to a real,
 * downloadable media file. Recording happens in real time: the engine plays
 * the uploaded media from the start, and capture stops when the longest
 * speaker track ends.
 */
export function recordEpisode(
  engine: EpisodeEngine,
  opts: RecorderOptions = {},
): Promise<RecordResult> {
  return new Promise((resolve, reject) => {
    let stream: MediaStream;
    try {
      stream = engine.captureStream();
    } catch (e) {
      reject(e);
      return;
    }

    const mimeType = opts.mimeType ?? pickSupportedMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: opts.videoBitsPerSecond ?? 4_000_000,
        audioBitsPerSecond: opts.audioBitsPerSecond ?? 128_000,
      });
    } catch (e) {
      reject(e);
      return;
    }

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const startedAt = performance.now();
    recorder.onerror = (e) => reject((e as unknown as { error?: Error }).error ?? new Error('Recorder error'));
    recorder.onstop = () => {
      const durationMs = performance.now() - startedAt;
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      resolve({ blob, url, mimeType, durationMs });
    };

    // Start the recorder BEFORE playback so the first frames/audio are
    // captured and so a very short clip's 'ended' event cannot fire before
    // the recorder has started (which would throw InvalidStateError on stop).
    try {
      recorder.start(250);
    } catch (e) {
      reject(e);
      return;
    }

    engine
      .play(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      })
      .catch((err) => {
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          /* noop */
        }
        reject(err);
      });
  });
}

export function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
