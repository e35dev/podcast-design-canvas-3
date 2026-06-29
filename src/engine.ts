import type { Preset, Speaker } from './types';
import { frameForBucket } from './presets';

const CANVAS_W = 1280;
const CANVAS_H = 720;
const FPS = 30;

export interface LoadResult {
  ok: boolean;
  error?: string;
}

/**
 * EpisodeEngine owns the real media graph for a loaded episode:
 *  - one <video> element per speaker (the real uploaded file)
 *  - a canvas that composes those videos into the chosen preset layout each frame
 *  - a Web Audio graph that mixes every speaker track and exposes it as a MediaStream
 *
 * Nothing here is mocked: the canvas draws real decoded video frames and the
 * MediaStream fed to the recorder carries the real mixed audio.
 */
export class EpisodeEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private videos = new Map<string, HTMLVideoElement>();
  private sources = new Map<string, MediaElementAudioSourceNode>();
  private audioCtx: AudioContext | null = null;
  private mixer: GainNode | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private rafId: number | null = null;
  private preset: Preset | null = null;
  private speakers: Speaker[] = [];
  private onEndedCallback: (() => void) | null = null;
  private endedHandled = false;

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    this.ctx = canvas.getContext('2d');
  }

  private ensureAudio() {
    if (this.audioCtx) return;
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioCtx = new Ctor();
    this.mixer = this.audioCtx.createGain();
    // < 1 so that several summed speaker tracks do not clip at the master.
    this.mixer.gain.value = 0.7;
    this.mixer.connect(this.audioCtx.destination);
    this.streamDest = this.audioCtx.createMediaStreamDestination();
    this.mixer.connect(this.streamDest);
  }

  /**
   * Build the video + audio graph for the given speakers. Videos are created
   * but not yet playing. Returns when every video has loaded enough to play.
   */
  async load(speakers: Speaker[], preset: Preset): Promise<LoadResult> {
    this.teardownMedia();
    this.speakers = speakers;
    this.preset = preset;
    this.endedHandled = false;
    if (!this.canvas) return { ok: false, error: 'Canvas not attached' };

    this.ensureAudio();

    const ready: Promise<void>[] = [];
    for (const sp of speakers) {
      const v = document.createElement('video');
      v.src = sp.objectUrl;
      v.crossOrigin = 'anonymous';
      // NOTE: do not set muted=true. The audio is tapped by a
      // MediaElementAudioSourceNode below, which reroutes the element's output
      // exclusively into the Web Audio graph (no double playback). Setting
      // muted would silence the graph too, producing a silent export.
      v.playsInline = true;
      v.preload = 'auto';
      this.videos.set(sp.id, v);

      ready.push(
        new Promise<void>((resolve) => {
          const onReady = () => {
            v.removeEventListener('loadeddata', onReady);
            v.removeEventListener('error', onErr);
            resolve();
          };
          const onErr = () => {
            v.removeEventListener('loadeddata', onReady);
            v.removeEventListener('error', onErr);
            resolve();
          };
          v.addEventListener('loadeddata', onReady);
          v.addEventListener('error', onErr);
        }),
      );

      // route audio through the mixer (monitor + recording stream)
      if (this.audioCtx && this.mixer) {
        try {
          const src = this.audioCtx.createMediaElementSource(v);
          src.connect(this.mixer);
          this.sources.set(sp.id, src);
        } catch {
          // a source can only be created once per element; ignore re-loads
        }
      }
    }

    await Promise.all(ready);
    // paint the first frame so preview isn't black before play
    this.draw();
    return { ok: true };
  }

  get duration(): number {
    let d = 0;
    for (const v of this.videos.values()) if (isFinite(v.duration)) d = Math.max(d, v.duration);
    return d;
  }

  get currentTime(): number {
    let t = Infinity;
    for (const v of this.videos.values())
      if (isFinite(v.currentTime)) t = Math.min(t, v.currentTime);
    return t === Infinity ? 0 : t;
  }

  async play(onEnded?: () => void) {
    if (!this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    this.onEndedCallback = onEnded ?? null;
    this.endedHandled = false;
    const longest = this.longestVideo();
    if (longest) {
      longest.addEventListener('ended', this.handleEnded, { once: true });
    }
    await Promise.all([...this.videos.values()].map((v) => v.play().catch(() => undefined)));
    this.startLoop();
  }

  pause() {
    for (const v of this.videos.values()) v.pause();
    this.stopLoop();
  }

  seek(time: number) {
    for (const v of this.videos.values()) v.currentTime = Math.max(0, Math.min(time, v.duration || time));
    this.draw();
  }

  private longestVideo(): HTMLVideoElement | null {
    let longest: HTMLVideoElement | null = null;
    let d = 0;
    for (const v of this.videos.values()) {
      if (isFinite(v.duration) && v.duration > d) {
        d = v.duration;
        longest = v;
      }
    }
    return longest;
  }

  private handleEnded = () => {
    if (this.endedHandled) return;
    this.endedHandled = true;
    this.pause();
    this.onEndedCallback?.();
  };

  private startLoop() {
    this.stopLoop();
    const tick = () => {
      this.draw();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private draw() {
    const ctx = this.ctx;
    const preset = this.preset;
    if (!ctx || !preset) return;
    ctx.fillStyle = preset.background;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    for (const sp of this.speakers) {
      const frame = frameForBucket(preset, sp.bucket);
      if (!frame) continue;
      const v = this.videos.get(sp.id);
      if (!v) continue;
      const x = frame.x * CANVAS_W;
      const y = frame.y * CANVAS_H;
      const w = frame.w * CANVAS_W;
      const h = frame.h * CANVAS_H;
      this.drawCover(ctx, v, x, y, w, h);
    }
  }

  private drawCover(
    ctx: CanvasRenderingContext2D,
    v: HTMLVideoElement,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return;
    const targetRatio = w / h;
    const srcRatio = vw / vh;
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;
    if (srcRatio > targetRatio) {
      sw = vh * targetRatio;
      sx = (vw - sw) / 2;
    } else {
      sh = vw / targetRatio;
      sy = (vh - sh) / 2;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(v, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
  }

  /**
   * Returns a combined MediaStream of the live canvas (video) plus the real
   * mixed audio from every speaker track. Used by the recorder for export.
   */
  captureStream(): MediaStream {
    if (!this.canvas) throw new Error('Canvas not attached');
    const videoStream = this.canvas.captureStream(FPS);
    const audioTracks = this.streamDest?.stream.getAudioTracks() ?? [];
    return new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);
  }

  private teardownMedia() {
    this.stopLoop();
    for (const [, src] of this.sources) {
      try {
        src.disconnect();
      } catch {
        /* noop */
      }
    }
    this.sources.clear();
    for (const v of this.videos.values()) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    this.videos.clear();
  }

  dispose() {
    this.teardownMedia();
    try {
      this.mixer?.disconnect();
      this.streamDest?.disconnect();
    } catch {
      /* noop */
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => undefined);
    }
    this.audioCtx = null;
    this.mixer = null;
    this.streamDest = null;
    this.canvas = null;
    this.ctx = null;
    this.preset = null;
    this.speakers = [];
  }
}
