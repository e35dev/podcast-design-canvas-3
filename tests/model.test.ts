import { describe, expect, it } from "vitest";
import {
  checkPreviewReadiness,
  computeLayout,
  computeMaxKnownDuration,
  createInitialSpeakers,
  formatDuration,
  getAssignedSpeakers,
  safeDuration,
  type SpeakerState,
} from "../src/model";

function readySpeaker(overrides: Partial<SpeakerState> = {}): SpeakerState {
  return {
    role: "host",
    label: "Host",
    displayName: "Host",
    socialLink: "",
    file: new File(["data"], "host.webm", { type: "video/webm" }),
    objectUrl: "blob:mock",
    duration: 12,
    ready: true,
    videoEl: null,
    ...overrides,
  };
}

describe("createInitialSpeakers", () => {
  it("creates host, guest1, guest2 with no file assigned", () => {
    const speakers = createInitialSpeakers();
    expect(speakers.map((s) => s.role)).toEqual(["host", "guest1", "guest2"]);
    expect(speakers.every((s) => s.file === null && !s.ready)).toBe(true);
  });
});

describe("getAssignedSpeakers", () => {
  it("excludes speakers without a file", () => {
    const speakers = [readySpeaker(), readySpeaker({ role: "guest1", file: null, objectUrl: null, ready: false })];
    expect(getAssignedSpeakers(speakers)).toHaveLength(1);
  });

  it("excludes speakers whose file has not finished decoding a frame yet", () => {
    const speakers = [readySpeaker(), readySpeaker({ role: "guest1", ready: false })];
    expect(getAssignedSpeakers(speakers)).toHaveLength(1);
  });

  it("includes every speaker once all are ready", () => {
    const speakers = [readySpeaker(), readySpeaker({ role: "guest1" }), readySpeaker({ role: "guest2" })];
    expect(getAssignedSpeakers(speakers)).toHaveLength(3);
  });
});

describe("checkPreviewReadiness", () => {
  it("requires at least two ready speakers and a preset", () => {
    const result = checkPreviewReadiness(createInitialSpeakers(), null);
    expect(result.ready).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("reports a single missing requirement once the other is satisfied", () => {
    const speakers = [readySpeaker(), readySpeaker({ role: "guest1" })];
    const result = checkPreviewReadiness(speakers, null);
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["Choose a preset layout."]);
  });

  it("is ready once two speakers are loaded and a preset is chosen", () => {
    const speakers = [readySpeaker(), readySpeaker({ role: "guest1" })];
    const result = checkPreviewReadiness(speakers, "clean-split");
    expect(result).toEqual({ ready: true, reasons: [] });
  });

  it("rejects an unknown preset id", () => {
    const speakers = [readySpeaker(), readySpeaker({ role: "guest1" })];
    const result = checkPreviewReadiness(speakers, "not-a-real-preset");
    expect(result.ready).toBe(false);
  });
});

describe("computeLayout", () => {
  it("splits evenly for the split layout", () => {
    const rects = computeLayout("split", 2, 1000, 500);
    expect(rects).toEqual([
      { x: 0, y: 0, width: 500, height: 500 },
      { x: 500, y: 0, width: 500, height: 500 },
    ]);
  });

  it("gives the spotlight layout a larger main tile and stacks the rest", () => {
    const rects = computeLayout("spotlight", 3, 1000, 600);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: 650, height: 600 });
    expect(rects[1]).toEqual({ x: 650, y: 0, width: 350, height: 300 });
    expect(rects[2]).toEqual({ x: 650, y: 300, width: 350, height: 300 });
  });

  it("falls back to a single full-frame tile for one speaker", () => {
    expect(computeLayout("spotlight", 1, 800, 400)).toEqual([{ x: 0, y: 0, width: 800, height: 400 }]);
  });

  it("arranges the grid layout into two columns", () => {
    const rects = computeLayout("grid", 3, 800, 800);
    expect(rects).toHaveLength(3);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: 400, height: 400 });
    expect(rects[1]).toEqual({ x: 400, y: 0, width: 400, height: 400 });
    expect(rects[2]).toEqual({ x: 0, y: 400, width: 400, height: 400 });
  });

  it("returns nothing for zero speakers", () => {
    expect(computeLayout("split", 0, 800, 400)).toEqual([]);
  });
});

describe("safeDuration", () => {
  it("treats Infinity, NaN, null, and non-positive values as unknown", () => {
    expect(safeDuration(Infinity)).toBeNull();
    expect(safeDuration(NaN)).toBeNull();
    expect(safeDuration(null)).toBeNull();
    expect(safeDuration(0)).toBeNull();
    expect(safeDuration(-3)).toBeNull();
  });

  it("passes through a normal finite duration", () => {
    expect(safeDuration(42.5)).toBe(42.5);
  });
});

describe("computeMaxKnownDuration", () => {
  it("ignores speakers with unknown duration and returns the longest known one", () => {
    const speakers = [
      readySpeaker({ duration: 30 }),
      readySpeaker({ role: "guest1", duration: Infinity }),
      readySpeaker({ role: "guest2", duration: 95 }),
    ];
    expect(computeMaxKnownDuration(speakers)).toBe(95);
  });

  it("returns null when no speaker has a known duration", () => {
    const speakers = [readySpeaker({ duration: Infinity }), readySpeaker({ role: "guest1", duration: null })];
    expect(computeMaxKnownDuration(speakers)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(5)).toBe("0:05");
  });

  it("shows a dash for unknown duration", () => {
    expect(formatDuration(null)).toBe("—");
  });
});
