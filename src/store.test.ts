import { describe, it, expect, beforeEach } from 'vitest';
import { useEpisodeStore, canAdvanceToPreset, isValidSocialLink, BUCKET_LABELS } from './store';
import type { SpeakerBucket } from './types';

function file(name: string): File {
  return new File(['x'], name, { type: 'video/mp4' });
}

beforeEach(() => {
  useEpisodeStore.getState().reset();
  useEpisodeStore.setState({ episode: null });
});

describe('episode store', () => {
  it('starts a new episode', () => {
    useEpisodeStore.getState().startEpisode('My Show');
    const ep = useEpisodeStore.getState().episode;
    expect(ep).not.toBeNull();
    expect(ep!.title).toBe('My Show');
    expect(ep!.speakers).toEqual([]);
    expect(ep!.presetId).toBeNull();
  });

  it('setTitle updates the title without clearing speakers', () => {
    const { startEpisode, addSpeakerFile, setTitle } = useEpisodeStore.getState();
    startEpisode('E');
    addSpeakerFile(file('a.mp4'));
    addSpeakerFile(file('b.mp4'));
    const beforeCount = useEpisodeStore.getState().episode!.speakers.length;
    setTitle('Renamed Episode');
    const ep = useEpisodeStore.getState().episode!;
    expect(ep.title).toBe('Renamed Episode');
    expect(ep.speakers.length).toBe(beforeCount);
  });

  it('assigns buckets in order host -> guest1 -> guest2 as files are added', () => {
    const { startEpisode, addSpeakerFile } = useEpisodeStore.getState();
    startEpisode('E');
    addSpeakerFile(file('host.mp4'));
    addSpeakerFile(file('g1.mp4'));
    addSpeakerFile(file('g2.mp4'));
    const speakers = useEpisodeStore.getState().episode!.speakers;
    expect(speakers.map((s) => s.bucket)).toEqual(['host', 'guest1', 'guest2']);
  });

  it('each speaker gets an object URL for the real uploaded file', () => {
    const { startEpisode, addSpeakerFile } = useEpisodeStore.getState();
    startEpisode('E');
    addSpeakerFile(file('a.mp4'));
    const s = useEpisodeStore.getState().episode!.speakers[0];
    expect(s.objectUrl).toMatch(/^blob:/);
    expect(s.file.name).toBe('a.mp4');
  });

  it('cannot advance to preset without a host bucket assigned', () => {
    const { startEpisode, addSpeakerFile, setSpeakerBucket } = useEpisodeStore.getState();
    startEpisode('E');
    addSpeakerFile(file('a.mp4')); // host
    addSpeakerFile(file('b.mp4')); // guest1
    expect(canAdvanceToPreset(useEpisodeStore.getState().episode)).toBe(true);
    // move the host off the host bucket to a non-colliding bucket (guest2)
    setSpeakerBucket(useEpisodeStore.getState().episode!.speakers[0].id, 'guest2');
    // now speakers are guest2 + guest1 with no host
    expect(canAdvanceToPreset(useEpisodeStore.getState().episode)).toBe(false);
  });

  it('swaps buckets when two speakers collide on the same bucket', () => {
    const { startEpisode, addSpeakerFile, setSpeakerBucket } = useEpisodeStore.getState();
    startEpisode('E');
    addSpeakerFile(file('a.mp4')); // host
    addSpeakerFile(file('b.mp4')); // guest1
    const speakers = useEpisodeStore.getState().episode!.speakers;
    // move host onto guest1 -> the previous guest1 should be swapped to host
    setSpeakerBucket(speakers[0].id, 'guest1');
    const after = useEpisodeStore.getState().episode!.speakers;
    expect(after.map((s) => s.bucket).sort()).toEqual(['guest1', 'host']);
  });

  it('cannot advance to preset with fewer than two speakers', () => {
    const { startEpisode, addSpeakerFile } = useEpisodeStore.getState();
    startEpisode('E');
    addSpeakerFile(file('a.mp4'));
    expect(canAdvanceToPreset(useEpisodeStore.getState().episode)).toBe(false);
  });

  it('updates name, social link, and bucket', () => {
    const { startEpisode, addSpeakerFile, setSpeakerName, setSpeakerSocial } = useEpisodeStore.getState();
    startEpisode('E');
    addSpeakerFile(file('a.mp4'));
    const id = useEpisodeStore.getState().episode!.speakers[0].id;
    setSpeakerName(id, 'Alex');
    setSpeakerSocial(id, 'https://twitter.com/alex');
    const s = useEpisodeStore.getState().episode!.speakers[0];
    expect(s.name).toBe('Alex');
    expect(s.socialLink).toBe('https://twitter.com/alex');
  });

  it('stores the selected preset', () => {
    const { startEpisode, setPreset } = useEpisodeStore.getState();
    startEpisode('E');
    setPreset('side-by-side');
    expect(useEpisodeStore.getState().episode!.presetId).toBe('side-by-side');
  });

  it('has labels for every bucket', () => {
    const buckets: SpeakerBucket[] = ['host', 'guest1', 'guest2'];
    for (const b of buckets) expect(BUCKET_LABELS[b]).toBeTruthy();
  });
});

describe('social link validation', () => {
  it('accepts empty, http, and https links', () => {
    expect(isValidSocialLink('')).toBe(true);
    expect(isValidSocialLink('https://x.com/y')).toBe(true);
    expect(isValidSocialLink('http://x.com/y')).toBe(true);
  });

  it('rejects malformed and non-http schemes', () => {
    expect(isValidSocialLink('not-a-url')).toBe(false);
    expect(isValidSocialLink('javascript:alert(1)')).toBe(false);
  });
});
