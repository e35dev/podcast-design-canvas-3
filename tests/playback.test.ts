import { describe, expect, it, vi } from "vitest";
import { startSyncedPlayback } from "../src/playback";

function createStubVideo(): HTMLVideoElement {
  const target = new EventTarget() as unknown as HTMLVideoElement;
  Object.assign(target, {
    currentTime: 0,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  });
  return target;
}

describe("startSyncedPlayback", () => {
  it("calls onComplete once, after every video has fired ended", () => {
    const videoA = createStubVideo();
    const videoB = createStubVideo();
    const onComplete = vi.fn();

    startSyncedPlayback({
      videos: [videoA, videoB],
      onFrame: vi.fn(),
      onComplete,
      onError: vi.fn(),
    });

    videoA.dispatchEvent(new Event("ended"));
    expect(onComplete).not.toHaveBeenCalled();

    videoB.dispatchEvent(new Event("ended"));
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Further ended events (e.g. a duplicate dispatch) must not call onComplete again.
    videoB.dispatchEvent(new Event("ended"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("resolves via the safety timeout if a video never fires ended", async () => {
    const video = createStubVideo();
    const onComplete = vi.fn();

    startSyncedPlayback({
      videos: [video],
      onFrame: vi.fn(),
      onComplete,
      onError: vi.fn(),
      maxDurationMs: 10,
    });

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("stop() prevents a later onComplete from firing", () => {
    const video = createStubVideo();
    const onComplete = vi.fn();

    const handle = startSyncedPlayback({
      videos: [video],
      onFrame: vi.fn(),
      onComplete,
      onError: vi.fn(),
    });

    handle.stop();
    video.dispatchEvent(new Event("ended"));
    expect(onComplete).not.toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
  });

  it("calls onComplete immediately when there are no videos to play", async () => {
    const onComplete = vi.fn();
    startSyncedPlayback({ videos: [], onFrame: vi.fn(), onComplete, onError: vi.fn() });
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});
