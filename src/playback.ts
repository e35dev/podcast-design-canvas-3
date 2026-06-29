export interface PlaybackHandle {
  stop(): void;
}

export interface PlaybackOptions {
  videos: HTMLVideoElement[];
  onFrame: (elapsedSeconds: number) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
  /** Safety cap so a malformed file (missing `ended`) can never hang the UI forever. */
  maxDurationMs?: number;
}

/**
 * Plays every video from time 0 in lock-step and drives a draw callback via
 * requestAnimationFrame. Completion is driven entirely by each video's native
 * `ended` event rather than `video.duration` — recorder-produced sources
 * commonly report `duration === Infinity`, which would otherwise turn any
 * duration-based timer into an instant or infinite no-op.
 */
export function startSyncedPlayback(options: PlaybackOptions): PlaybackHandle {
  const { videos, onFrame, onComplete, onError, maxDurationMs = 30 * 60 * 1000 } = options;

  let stopped = false;
  let completed = false;
  let rafId = 0;
  const startedAt = performance.now();
  const pending = new Set(videos);
  const endedListeners = new Map<HTMLVideoElement, () => void>();

  function detachListeners(): void {
    endedListeners.forEach((listener, video) => video.removeEventListener("ended", listener));
  }

  function finish(): void {
    if (completed || stopped) return;
    completed = true;
    cancelAnimationFrame(rafId);
    detachListeners();
    onComplete();
  }

  function tick(): void {
    if (stopped || completed) return;
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > maxDurationMs) {
      finish();
      return;
    }
    onFrame(elapsedMs / 1000);
    rafId = requestAnimationFrame(tick);
  }

  if (videos.length === 0) {
    queueMicrotask(finish);
    return { stop: () => undefined };
  }

  videos.forEach((video) => {
    const listener = (): void => {
      pending.delete(video);
      if (pending.size === 0) finish();
    };
    endedListeners.set(video, listener);
    video.addEventListener("ended", listener);
  });

  Promise.all(
    videos.map(async (video) => {
      video.currentTime = 0;
      try {
        await video.play();
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }),
  ).then(() => {
    if (!stopped && !completed) {
      rafId = requestAnimationFrame(tick);
    }
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
      detachListeners();
      videos.forEach((video) => video.pause());
    },
  };
}
