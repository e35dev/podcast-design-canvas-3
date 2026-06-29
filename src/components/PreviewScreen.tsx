import { useEffect, useRef, useState } from 'react';
import { useEpisodeStore } from '../store';
import { getPreset } from '../presets';
import { EpisodeEngine } from '../engine';
import { recordEpisode, triggerDownload, pickSupportedMimeType, extensionFor } from '../recorder';
import type { RecordResult } from '../recorder';

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function PreviewScreen() {
  const episode = useEpisodeStore((s) => s.episode);
  const goToStage = useEpisodeStore((s) => s.goToStage);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EpisodeEngine | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [result, setResult] = useState<RecordResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const preset = getPreset(episode?.presetId ?? null);

  useEffect(() => {
    if (!canvasRef.current || !episode || !preset) return;
    const engine = new EpisodeEngine();
    engineRef.current = engine;
    engine.attach(canvasRef.current);
    let cancelled = false;
    engine
      .load(episode.speakers, preset)
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) setLoadError(r.error ?? 'Failed to load media');
        setDuration(engine.duration);
      })
      .catch((e) => !cancelled && setLoadError(String(e)));
    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
    };
  }, [episode, preset]);

  // time / export-progress ticker
  useEffect(() => {
    if (!playing && !exporting) return;
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      setTime(e.currentTime);
      if (exporting) setExportProgress(Math.min(1, e.duration ? e.currentTime / e.duration : 0));
    }, 200);
    return () => window.clearInterval(id);
  }, [playing, exporting]);

  const onPlay = async () => {
    const e = engineRef.current;
    if (!e) return;
    setResult(null);
    // seek to start so Play works even after a previous playback/export left
    // the tracks at their end position.
    e.seek(0);
    await e.play(() => setPlaying(false));
    setPlaying(true);
  };

  const onPause = () => {
    engineRef.current?.pause();
    setPlaying(false);
  };

  const onExport = async () => {
    const e = engineRef.current;
    if (!e) return;
    setExporting(true);
    setExportError(null);
    setResult(null);
    setExportProgress(0);
    try {
      e.seek(0);
      const mime = pickSupportedMimeType();
      const res = await recordEpisode(e, { mimeType: mime });
      setResult(res);
      const ext = extensionFor(res.mimeType);
      const slug = (episode?.title || 'episode').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      triggerDownload(res.url, `${slug}.${ext}`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
      setPlaying(false);
    }
  };

  if (!preset) {
    return (
      <div className="banner warn">No preset selected. Go back and choose one.</div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>Preview</strong>
          <span className="tag">preset: {preset.name}</span>
        </div>
        <div className="preview-wrap" style={{ marginTop: 12 }}>
          <canvas ref={canvasRef} />
        </div>
        {loadError && <div className="banner warn" style={{ marginTop: 10 }}>{loadError}</div>}

        <div className="preview-controls">
          {!playing ? (
            <button type="button" onClick={onPlay} disabled={exporting}>
              ▶ Play
            </button>
          ) : (
            <button type="button" onClick={onPause} disabled={exporting}>
              ⏸ Pause
            </button>
          )}
          <span className="muted">
            {formatTime(time)} / {formatTime(duration)}
          </span>
        </div>
      </div>

      <div className="card">
        <strong>Export</strong>
        <p className="muted">
          Renders a real downloadable video file from your uploaded media using the selected layout.
          Export runs in real time and stops automatically at the end of the longest track.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="primary"
            onClick={onExport}
            disabled={exporting || !!loadError}
          >
            {exporting ? 'Exporting…' : '⬇ Export & download'}
          </button>
          {exporting && (
            <span className="muted">{Math.round(exportProgress * 100)}%</span>
          )}
        </div>
        {exportError && <div className="banner warn" style={{ marginTop: 10 }}>{exportError}</div>}
        {result && (
          <div className="banner" style={{ marginTop: 10 }}>
            Export ready ({(result.blob.size / 1_000_000).toFixed(1)} MB, {result.mimeType}). Download
            started.{' '}
            <a href={result.url} download={`episode.${extensionFor(result.mimeType)}`}>
              Download again
            </a>
            <video src={result.url} controls style={{ width: '100%', marginTop: 10, borderRadius: 8 }} />
          </div>
        )}
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button type="button" className="ghost" onClick={() => goToStage('preset')} disabled={exporting}>
          Back
        </button>
        <button type="button" className="ghost" onClick={() => useEpisodeStore.getState().reset()} disabled={exporting}>
          Start new episode
        </button>
      </div>
    </div>
  );
}
