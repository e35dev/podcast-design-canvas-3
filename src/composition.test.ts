import { describe, expect, it } from "vitest";
import { CANVAS_HEIGHT, CANVAS_WIDTH, computeSpeakerFrames, getExportFileName, hasEnoughTracks } from "./composition";
import type { LoadedTrack } from "./types";

describe("composition helpers", () => {
  it("requires at least two uploaded speaker files for the core workflow", () => {
    expect(hasEnoughTracks([{ file: new File([""], "host.webm") }, {}, {}])).toBe(false);
    expect(hasEnoughTracks([{ file: new File([""], "host.webm") }, { file: new File([""], "guest.webm") }, {}])).toBe(
      true
    );
  });

  it("rotates the social studio feature speaker over time", () => {
    const tracks = makeTracks();
    const initialFrames = computeSpeakerFrames({
      presetId: "socialStudio",
      tracks,
      time: 0,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT
    });
    const laterFrames = computeSpeakerFrames({
      presetId: "socialStudio",
      tracks,
      time: 13,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT
    });

    expect(initialFrames[0].role).toBe("host");
    expect(laterFrames[0].role).toBe("guest1");
    expect(initialFrames[0].emphasized).toBe(true);
  });

  it("creates a stable downloadable export filename", () => {
    expect(getExportFileName("Launch Episode: Design Review!")).toBe("launch-episode-design-review-designed.webm");
    expect(getExportFileName("   ")).toBe("podcast-episode-designed.webm");
  });
});

function makeTracks(): LoadedTrack[] {
  return [
    makeTrack("host", "Host"),
    makeTrack("guest1", "Guest 1"),
    makeTrack("guest2", "Guest 2")
  ];
}

function makeTrack(role: LoadedTrack["role"], label: string): LoadedTrack {
  return {
    role,
    label,
    file: new File([""], `${role}.webm`),
    objectUrl: `blob:${role}`,
    socialLink: "",
    loadState: "ready",
    video: {} as HTMLVideoElement
  };
}
