export type SpeakerRole = "host" | "guest1" | "guest2";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpeakerRoleDef {
  role: SpeakerRole;
  label: string;
}

export const SPEAKER_ROLE_DEFS: SpeakerRoleDef[] = [
  { role: "host", label: "Host" },
  { role: "guest1", label: "Guest 1" },
  { role: "guest2", label: "Guest 2" },
];

export type LayoutKind = "split" | "spotlight" | "grid";

export interface Preset {
  id: string;
  name: string;
  description: string;
  pacing: "calm" | "balanced" | "dynamic";
  layout: LayoutKind;
}

export const PRESETS: Preset[] = [
  {
    id: "clean-split",
    name: "Clean Split",
    description: "Equal side-by-side frames for an even conversation feel.",
    pacing: "calm",
    layout: "split",
  },
  {
    id: "host-spotlight",
    name: "Host Spotlight",
    description: "Host takes the large frame while guests sit in a side column.",
    pacing: "balanced",
    layout: "spotlight",
  },
  {
    id: "dynamic-grid",
    name: "Dynamic Grid",
    description: "Even grid tiles sized for fast-moving, energetic episodes.",
    pacing: "dynamic",
    layout: "grid",
  },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export interface SpeakerState {
  role: SpeakerRole;
  label: string;
  displayName: string;
  socialLink: string;
  file: File | null;
  objectUrl: string | null;
  duration: number | null;
  /** True once the assigned video has a decoded frame available to draw (not just metadata). */
  ready: boolean;
  videoEl: HTMLVideoElement | null;
}

export function createInitialSpeakers(): SpeakerState[] {
  return SPEAKER_ROLE_DEFS.map((def) => ({
    role: def.role,
    label: def.label,
    displayName: def.label,
    socialLink: "",
    file: null,
    objectUrl: null,
    duration: null,
    ready: false,
    videoEl: null,
  }));
}

/** Speakers with a real uploaded file whose first frame is actually decoded and drawable. */
export function getAssignedSpeakers(speakers: SpeakerState[]): SpeakerState[] {
  return speakers.filter((speaker) => speaker.file !== null && speaker.objectUrl !== null && speaker.ready);
}

export interface AcceptanceCheck {
  ready: boolean;
  reasons: string[];
}

export function checkPreviewReadiness(speakers: SpeakerState[], presetId: string | null): AcceptanceCheck {
  const reasons: string[] = [];
  const assigned = getAssignedSpeakers(speakers);
  if (assigned.length < 2) {
    reasons.push("Assign at least two speaker videos (Host plus one guest).");
  }
  if (!presetId || !getPreset(presetId)) {
    reasons.push("Choose a preset layout.");
  }
  return { ready: reasons.length === 0, reasons };
}

/**
 * Computes per-speaker draw rectangles for a canvas of the given size.
 * Pure and DOM-free so layout math can be unit tested directly.
 */
export function computeLayout(layout: LayoutKind, count: number, canvasWidth: number, canvasHeight: number): Rect[] {
  if (count <= 0) return [];

  if (layout === "split") {
    const width = canvasWidth / count;
    return Array.from({ length: count }, (_, i) => ({
      x: i * width,
      y: 0,
      width,
      height: canvasHeight,
    }));
  }

  if (layout === "spotlight") {
    if (count === 1) {
      return [{ x: 0, y: 0, width: canvasWidth, height: canvasHeight }];
    }
    const mainWidth = canvasWidth * 0.65;
    const sideWidth = canvasWidth - mainWidth;
    const sideCount = count - 1;
    const sideHeight = canvasHeight / sideCount;
    const rects: Rect[] = [{ x: 0, y: 0, width: mainWidth, height: canvasHeight }];
    for (let i = 0; i < sideCount; i += 1) {
      rects.push({ x: mainWidth, y: i * sideHeight, width: sideWidth, height: sideHeight });
    }
    return rects;
  }

  // grid
  const columns = count <= 1 ? 1 : 2;
  const rows = Math.ceil(count / columns);
  const cellWidth = canvasWidth / columns;
  const cellHeight = canvasHeight / rows;
  return Array.from({ length: count }, (_, i) => ({
    x: (i % columns) * cellWidth,
    y: Math.floor(i / columns) * cellHeight,
    width: cellWidth,
    height: cellHeight,
  }));
}

/** Treats non-finite/unknown durations (common for recorder-produced media) as unknown. */
export function safeDuration(duration: number | null | undefined): number | null {
  if (duration === null || duration === undefined) return null;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return duration;
}

export function computeMaxKnownDuration(speakers: SpeakerState[]): number | null {
  const known = getAssignedSpeakers(speakers)
    .map((speaker) => safeDuration(speaker.duration))
    .filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  return Math.max(...known);
}

/** Derives a display filename from an imported URL's last path segment, for status text. */
export function guessFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter((segment) => segment.length > 0).pop();
    return last ? decodeURIComponent(last) : "imported-video";
  } catch {
    return "imported-video";
  }
}

export function formatDuration(duration: number | null): string {
  if (duration === null) return "—";
  const totalSeconds = Math.round(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
