/**
 * Waits until `video` has a real decoded frame ready to draw. Resolves with
 * `video.duration`, which callers must still treat as possibly non-finite:
 * recorder-produced WebM commonly reports `Infinity` until fully buffered.
 */
export function waitForPlayableData(video: HTMLVideoElement, timeoutMs = 20000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2) {
      resolve(video.duration);
      return;
    }

    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(video.duration);
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("This file could not be decoded as a video."));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out loading this video."));
    }, timeoutMs);

    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("error", onError);
  });
}
