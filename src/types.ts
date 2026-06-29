export type SpeakerRole = "host" | "guest1" | "guest2";

export type PresetId = "roundtable" | "hostFocus" | "socialStudio";

export interface SpeakerTrack {
  role: SpeakerRole;
  label: string;
  file?: File;
  objectUrl?: string;
  socialLink: string;
  video?: HTMLVideoElement;
  loadState: "empty" | "loading" | "ready" | "error";
  mediaError?: string;
}

export interface LoadedTrack extends SpeakerTrack {
  file: File;
  objectUrl: string;
  video: HTMLVideoElement;
}

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpeakerFrame extends FrameRect {
  role: SpeakerRole;
  label: string;
  socialLink: string;
  emphasized: boolean;
}

export interface CompositionState {
  presetId: PresetId;
  tracks: LoadedTrack[];
  time: number;
  width: number;
  height: number;
}
