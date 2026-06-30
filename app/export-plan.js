// app/export-plan.js
// Bridge between the episode model and the canvas compositor/exporter: a
// concrete render plan (dimensions, fps, duration, per-speaker frame rects,
// audio buckets) plus cover-fit math. Pure logic; the live preview and the
// export consume the SAME plan. Classic-script + global PDC namespace.
(function () {
  const root = typeof window !== "undefined" ? window : globalThis;
  const PDC = root.PDC || (root.PDC = {});
  const { assignedBuckets, episodeDurationSec, canCompose } = PDC.episode;
  const { getPreset } = PDC.presets;

  const DEFAULT_RESOLUTIONS = { "720p": { width: 1280, height: 720 }, "1080p": { width: 1920, height: 1080 } };

  const round2 = (n) => Math.round(n * 100) / 100;
  const clampFps = (fps) => Math.min(60, Math.max(15, Math.round(Number(fps) || 30)));

  function buildExportPlan(episode, opts = {}) {
    if (!canCompose(episode)) throw new Error("Episode is not ready to compose (need 2+ speakers and a preset).");
    const res =
      DEFAULT_RESOLUTIONS[opts.resolution] ||
      (opts.width && opts.height ? { width: opts.width, height: opts.height } : DEFAULT_RESOLUTIONS["720p"]);
    const width = res.width;
    const height = res.height;
    const fps = clampFps(opts.fps);
    const preset = getPreset(episode.presetId);
    const buckets = assignedBuckets(episode);
    const frames = preset.layout(buckets, width, height);
    const durationSec = round2(episodeDurationSec(episode));
    return {
      presetId: preset.id,
      presetName: preset.name,
      background: preset.background,
      accent: preset.accent,
      width,
      height,
      fps,
      durationSec,
      frameCount: Math.max(1, Math.round(durationSec * fps)),
      frames,
      audioBuckets: buckets.slice(),
    };
  }

  function coverRect(frame, sw, sh) {
    if (!sw || !sh) return { dx: frame.x, dy: frame.y, dw: frame.w, dh: frame.h, sx: 0, sy: 0, sw: 0, sh: 0 };
    const scale = Math.max(frame.w / sw, frame.h / sh);
    const cropW = frame.w / scale;
    const cropH = frame.h / scale;
    return { sx: (sw - cropW) / 2, sy: (sh - cropH) / 2, sw: cropW, sh: cropH, dx: frame.x, dy: frame.y, dw: frame.w, dh: frame.h };
  }

  PDC.exportPlan = { DEFAULT_RESOLUTIONS, buildExportPlan, coverRect };
})();
