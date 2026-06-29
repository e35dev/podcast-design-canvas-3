import type { Rect } from "./model";

export interface CoverRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Computes a source crop rect (in source-pixel space) so that drawing it into
 * `target` behaves like CSS `object-fit: cover` instead of stretching/squashing
 * speaker video to the tile's aspect ratio.
 */
export function computeCoverRect(naturalWidth: number, naturalHeight: number, target: Rect): CoverRect {
  if (naturalWidth <= 0 || naturalHeight <= 0 || target.width <= 0 || target.height <= 0) {
    return { sx: 0, sy: 0, sw: naturalWidth, sh: naturalHeight };
  }
  const sourceRatio = naturalWidth / naturalHeight;
  const targetRatio = target.width / target.height;
  let sw: number;
  let sh: number;
  if (sourceRatio > targetRatio) {
    sh = naturalHeight;
    sw = naturalHeight * targetRatio;
  } else {
    sw = naturalWidth;
    sh = naturalWidth / targetRatio;
  }
  return {
    sx: (naturalWidth - sw) / 2,
    sy: (naturalHeight - sh) / 2,
    sw,
    sh,
  };
}

export interface FrameSource {
  drawable: CanvasImageSource;
  naturalWidth: number;
  naturalHeight: number;
  displayName: string;
}

const BACKGROUND_COLOR = "#0b0b12";
const FRAME_COLOR = "rgba(255,255,255,0.28)";
const LABEL_BG = "rgba(10,10,16,0.72)";
const LABEL_COLOR = "#f5f5f7";

export function drawComposition(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  rects: Rect[],
  sources: FrameSource[],
): void {
  ctx.save();
  ctx.fillStyle = BACKGROUND_COLOR;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  sources.forEach((source, index) => {
    const rect = rects[index];
    if (!rect) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();

    if (source.naturalWidth > 0 && source.naturalHeight > 0) {
      const crop = computeCoverRect(source.naturalWidth, source.naturalHeight, rect);
      ctx.drawImage(
        source.drawable,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
      );
    }
    ctx.restore();

    ctx.strokeStyle = FRAME_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x + 1, rect.y + 1, Math.max(rect.width - 2, 0), Math.max(rect.height - 2, 0));

    const labelHeight = Math.max(Math.min(rect.height * 0.12, 32), 20);
    ctx.fillStyle = LABEL_BG;
    ctx.fillRect(rect.x, rect.y + rect.height - labelHeight, rect.width, labelHeight);
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = `${Math.max(labelHeight * 0.55, 11)}px sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(
      source.displayName,
      rect.x + 10,
      rect.y + rect.height - labelHeight / 2,
      Math.max(rect.width - 20, 10),
    );
  });

  ctx.restore();
}
