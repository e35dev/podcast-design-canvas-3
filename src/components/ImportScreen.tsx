import { useRef, useState } from 'react';
import { useEpisodeStore, BUCKET_LABELS, canAdvanceToPreset, isValidSocialLink } from '../store';
import type { SpeakerBucket } from '../types';

const ACCEPTED = 'video/*,audio/*';

function BucketPicker({
  value,
  onChange,
}: {
  value: SpeakerBucket;
  onChange: (b: SpeakerBucket) => void;
}) {
  const buckets: SpeakerBucket[] = ['host', 'guest1', 'guest2'];
  return (
    <div className="bucket-pills" role="radiogroup" aria-label="Speaker bucket">
      {buckets.map((b) => (
        <button
          key={b}
          type="button"
          role="radio"
          aria-checked={value === b}
          data-b={b}
          className={`bucket-pill ${value === b ? 'active' : ''}`}
          onClick={() => onChange(b)}
        >
          {BUCKET_LABELS[b]}
        </button>
      ))}
    </div>
  );
}

export function ImportScreen() {
  const fileRef = useRef<HTMLInputElement>(null);
  const episode = useEpisodeStore((s) => s.episode);
  const setTitle = useEpisodeStore((s) => s.setTitle);
  const addSpeakerFile = useEpisodeStore((s) => s.addSpeakerFile);
  const setSpeakerBucket = useEpisodeStore((s) => s.setSpeakerBucket);
  const setSpeakerName = useEpisodeStore((s) => s.setSpeakerName);
  const setSpeakerSocial = useEpisodeStore((s) => s.setSpeakerSocial);
  const removeSpeaker = useEpisodeStore((s) => s.removeSpeaker);
  const goToStage = useEpisodeStore((s) => s.goToStage);
  const error = useEpisodeStore((s) => s.error);
  const [drag, setDrag] = useState(false);

  const speakers = episode?.speakers ?? [];

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) addSpeakerFile(f);
  };

  const validSocials = speakers.every((s) => isValidSocialLink(s.socialLink));
  const ready = canAdvanceToPreset(episode) && validSocials;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-eyebrow">Step 1</div>
        <h2>Set up your episode</h2>
        <p className="muted">
          Upload separate synced speaker recordings — one file per person. Riverside-style exports work
          best.
        </p>

        <div style={{ marginTop: 18 }} className="field">
          <label htmlFor="ep-title">Episode title</label>
          <input
            id="ep-title"
            type="text"
            placeholder="My Podcast — Episode 1"
            value={episode?.title ?? ''}
            onChange={(e) => setTitle(e.target.value)}
            style={{ marginTop: 6 }}
          />
        </div>
      </div>

      <div className="card">
        <div className="section-title">
          <div>
            <div className="card-eyebrow">Sources</div>
            <h2 style={{ marginTop: 2 }}>Speaker files</h2>
          </div>
          {speakers.length > 0 && (
            <button type="button" onClick={() => fileRef.current?.click()}>
              + Add files
            </button>
          )}
        </div>

        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            onFiles(e.dataTransfer.files);
          }}
        >
          <div className="dz-icon" aria-hidden="true">↑</div>
          <strong>Drop speaker video files here, or click to browse</strong>
          <div className="sub">MP4 / WebM / MOV — select all speakers at once</div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          multiple
          hidden
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {speakers.length > 0 && (
          <div className="speaker-list" style={{ marginTop: 16 }}>
            {speakers.map((s, i) => (
              <div key={s.id} className="speaker-card" data-bucket={s.bucket}>
                <div className="speaker-rail" />
                <div className="speaker-body">
                  <div className="speaker-head">
                    <span className="file-chip">
                      <span className="dot" />
                      <span className="name">{s.file.name}</span>
                    </span>
                    <button
                      type="button"
                      className="ghost icon"
                      aria-label={`Remove speaker ${i + 1}`}
                      onClick={() => removeSpeaker(s.id)}
                    >
                      ✕
                    </button>
                  </div>

                  <BucketPicker value={s.bucket} onChange={(b) => setSpeakerBucket(s.id, b)} />

                  <div className="speaker-fields">
                    <div className="field">
                      <label>Display name</label>
                      <input
                        type="text"
                        placeholder="e.g. Alex Lee"
                        value={s.name}
                        onChange={(e) => setSpeakerName(s.id, e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Social link (optional)</label>
                      <input
                        type="url"
                        placeholder="https://twitter.com/handle"
                        value={s.socialLink}
                        onChange={(e) => setSpeakerSocial(s.id, e.target.value)}
                        aria-invalid={!isValidSocialLink(s.socialLink)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="banner warn" style={{ marginTop: 14 }}>
            {error}
          </div>
        )}
      </div>

      <div className="actions">
        <span className="muted">
          {speakers.length < 2
            ? `Add at least ${2 - speakers.length} more speaker file${speakers.length === 1 ? '' : '(s)'} to continue.`
            : 'Looking good — ready to choose a preset.'}
        </span>
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={() => goToStage('preset')}
        >
          Continue to presets →
        </button>
      </div>
    </div>
  );
}
