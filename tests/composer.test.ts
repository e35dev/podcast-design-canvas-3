import { describe, expect, it, vi } from "vitest";
import { computeCoverRect, drawComposition, type FrameSource } from "../src/composer";
import type { Rect } from "../src/model";

describe("computeCoverRect", () => {
  it("crops left and right when the source is wider than the target", () => {
    const target: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const crop = computeCoverRect(1920, 1080, target);
    expect(crop.sh).toBe(1080);
    expect(crop.sw).toBeCloseTo(1080, 5);
    expect(crop.sx).toBeCloseTo((1920 - crop.sw) / 2, 5);
    expect(crop.sy).toBe(0);
  });

  it("crops top and bottom when the source is taller than the target", () => {
    const target: Rect = { x: 0, y: 0, width: 200, height: 100 };
    const crop = computeCoverRect(400, 800, target);
    expect(crop.sw).toBe(400);
    expect(crop.sh).toBeCloseTo(200, 5);
    expect(crop.sy).toBeCloseTo((800 - crop.sh) / 2, 5);
    expect(crop.sx).toBe(0);
  });

  it("uses the full frame when aspect ratios already match", () => {
    const target: Rect = { x: 0, y: 0, width: 16, height: 9 };
    const crop = computeCoverRect(1600, 900, target);
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 1600, sh: 900 });
  });

  it("does not divide by zero for a degenerate target", () => {
    const crop = computeCoverRect(100, 100, { x: 0, y: 0, width: 0, height: 0 });
    expect(Number.isFinite(crop.sw)).toBe(true);
    expect(Number.isFinite(crop.sh)).toBe(true);
  });
});

function createMockContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {},
    set font(_value: string) {},
    set textBaseline(_value: string) {},
  } as unknown as CanvasRenderingContext2D;
}

describe("drawComposition", () => {
  it("draws one image and one label per source", () => {
    const ctx = createMockContext();
    const rects: Rect[] = [
      { x: 0, y: 0, width: 50, height: 100 },
      { x: 50, y: 0, width: 50, height: 100 },
    ];
    const sources: FrameSource[] = [
      { drawable: {} as CanvasImageSource, naturalWidth: 640, naturalHeight: 480, displayName: "Host" },
      { drawable: {} as CanvasImageSource, naturalWidth: 640, naturalHeight: 480, displayName: "Guest 1" },
    ];

    drawComposition(ctx, 100, 100, rects, sources);

    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    expect(ctx.fillText).toHaveBeenCalledWith("Host", expect.any(Number), expect.any(Number), expect.any(Number));
    expect(ctx.fillText).toHaveBeenCalledWith("Guest 1", expect.any(Number), expect.any(Number), expect.any(Number));
  });

  it("skips drawImage for a source with no decoded dimensions yet", () => {
    const ctx = createMockContext();
    const rects: Rect[] = [{ x: 0, y: 0, width: 100, height: 100 }];
    const sources: FrameSource[] = [
      { drawable: {} as CanvasImageSource, naturalWidth: 0, naturalHeight: 0, displayName: "Host" },
    ];

    drawComposition(ctx, 100, 100, rects, sources);

    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledWith("Host", expect.any(Number), expect.any(Number), expect.any(Number));
  });
});
