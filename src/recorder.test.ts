import { describe, it, expect } from 'vitest';
import { recordEpisode, pickSupportedMimeType, extensionFor } from './recorder';

describe('recorder helpers', () => {
  it('returns a webm mime type by default', () => {
    const m = pickSupportedMimeType();
    expect(m).toContain('webm');
  });

  it('extensionFor maps webm and mp4', () => {
    expect(extensionFor('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(extensionFor('video/mp4')).toBe('mp4');
  });
});

describe('recordEpisode ordering', () => {
  it('starts the MediaRecorder before starting playback (captures first frames, avoids InvalidStateError)', async () => {
    const order: string[] = [];
    const chunks: BlobPart[] = [new Blob(['fake'], { type: 'video/webm' })];

    const fakeStream = { getVideoTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
    let endedCb: (() => void) | null = null;
    const engine = {
      captureStream: () => {
        order.push('captureStream');
        return fakeStream;
      },
      play: (onEnded?: () => void) => {
        order.push('play');
        endedCb = onEnded ?? null;
        // simulate the longest track ending immediately -> triggers stop
        queueMicrotask(() => endedCb?.());
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof recordEpisode>[0];

    // MediaRecorder is real in jsdom? It may not exist. Build a minimal stub.
    const RealRecorder = globalThis.MediaRecorder;
    let stopCalled = false;
    class StubRecorder {
      state: 'inactive' | 'recording' = 'inactive';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        this.state = 'recording';
        order.push('recorder.start');
        // emit one chunk
        queueMicrotask(() => this.ondataavailable?.({ data: chunks[0] as Blob }));
      }
      stop() {
        stopCalled = true;
        this.state = 'inactive';
        order.push('recorder.stop');
        queueMicrotask(() => this.onstop?.());
      }
      static isTypeSupported() {
        return true;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).MediaRecorder = StubRecorder;

    try {
      const result = await recordEpisode(engine, { mimeType: 'video/webm;codecs=vp8,opus' });
      // captureStream -> recorder.start -> play  (recorder.start BEFORE play)
      expect(order.slice(0, 3)).toEqual(['captureStream', 'recorder.start', 'play']);
      expect(stopCalled).toBe(true);
      expect(result.blob.size).toBeGreaterThan(0);
      expect(result.mimeType).toContain('webm');
    } finally {
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder = RealRecorder;
    }
  });
});
