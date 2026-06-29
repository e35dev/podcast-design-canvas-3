import { create } from 'zustand';
import type { Episode, EpisodeStage, Speaker, SpeakerBucket } from './types';

const BUCKET_ORDER: SpeakerBucket[] = ['host', 'guest1', 'guest2'];

export const BUCKET_LABELS: Record<SpeakerBucket, string> = {
  host: 'Host',
  guest1: 'Guest 1',
  guest2: 'Guest 2',
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function nextFreeBucket(taken: Set<SpeakerBucket>): SpeakerBucket {
  for (const b of BUCKET_ORDER) if (!taken.has(b)) return b;
  return 'guest2';
}

interface EpisodeState {
  episode: Episode | null;
  stage: EpisodeStage;
  error: string | null;

  startEpisode: (title: string) => void;
  setTitle: (title: string) => void;
  addSpeakerFile: (file: File, name?: string) => void;
  setSpeakerBucket: (id: string, bucket: SpeakerBucket) => void;
  setSpeakerName: (id: string, name: string) => void;
  setSpeakerSocial: (id: string, link: string) => void;
  removeSpeaker: (id: string) => void;
  setPreset: (id: string) => void;
  goToStage: (stage: EpisodeStage) => void;
  reset: () => void;
}

function revokeSpeakers(speakers: Speaker[]) {
  for (const s of speakers) URL.revokeObjectURL(s.objectUrl);
}

export const useEpisodeStore = create<EpisodeState>((set, get) => ({
  episode: null,
  stage: 'import',
  error: null,

  startEpisode: (title) => {
    const existing = get().episode;
    if (existing) revokeSpeakers(existing.speakers);
    set({
      episode: { id: uid(), title: title || 'Untitled Episode', speakers: [], presetId: null, createdAt: Date.now() },
      stage: 'import',
      error: null,
    });
  },

  setTitle: (title) => {
    const ep = get().episode;
    if (!ep) return;
    set({ episode: { ...ep, title } });
  },

  addSpeakerFile: (file, name) => {
    const ep = get().episode;
    if (!ep) {
      set({ error: 'Start an episode before adding files.' });
      return;
    }
    const taken = new Set(ep.speakers.map((s) => s.bucket));
    const bucket = nextFreeBucket(taken);
    const speaker: Speaker = {
      id: uid(),
      bucket,
      name: name ?? '',
      socialLink: '',
      file,
      objectUrl: URL.createObjectURL(file),
    };
    set({ episode: { ...ep, speakers: [...ep.speakers, speaker] }, error: null });
  },

  setSpeakerBucket: (id, bucket) => {
    const ep = get().episode;
    if (!ep) return;
    const speakers = ep.speakers.map((s) => {
      if (s.id === id) return { ...s, bucket };
      if (s.bucket === bucket) {
        const other = (['host', 'guest1', 'guest2'] as SpeakerBucket[]).find(
          (b) => b !== bucket && !ep.speakers.some((o) => o.id !== id && o.bucket === b),
        );
        return { ...s, bucket: other ?? s.bucket };
      }
      return s;
    });
    set({ episode: { ...ep, speakers } });
  },

  setSpeakerName: (id, name) => {
    const ep = get().episode;
    if (!ep) return;
    set({
      episode: { ...ep, speakers: ep.speakers.map((s) => (s.id === id ? { ...s, name } : s)) },
    });
  },

  setSpeakerSocial: (id, link) => {
    const ep = get().episode;
    if (!ep) return;
    set({
      episode: { ...ep, speakers: ep.speakers.map((s) => (s.id === id ? { ...s, socialLink: link } : s)) },
    });
  },

  removeSpeaker: (id) => {
    const ep = get().episode;
    if (!ep) return;
    const target = ep.speakers.find((s) => s.id === id);
    if (target) URL.revokeObjectURL(target.objectUrl);
    set({ episode: { ...ep, speakers: ep.speakers.filter((s) => s.id !== id) } });
  },

  setPreset: (id) => {
    const ep = get().episode;
    if (!ep) return;
    set({ episode: { ...ep, presetId: id } });
  },

  goToStage: (stage) => set({ stage }),

  reset: () => {
    const ep = get().episode;
    if (ep) revokeSpeakers(ep.speakers);
    set({ episode: null, stage: 'import', error: null });
  },
}));

export function canAdvanceToPreset(ep: Episode | null): boolean {
  if (!ep) return false;
  const buckets = new Set(ep.speakers.map((s) => s.bucket));
  if (!buckets.has('host')) return false;
  return ep.speakers.length >= 2;
}

export function isValidSocialLink(link: string): boolean {
  if (!link) return true;
  try {
    const u = new URL(link);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
