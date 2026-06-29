// app/export-plan.js — DOM-free composition plan.
// buildExportPlan(episode) ties the real uploaded media references to the
// selected preset's layout: it produces, per speaker, the media reference
// (file/url) the exporter will draw and the normalized frame rect to draw it
// into. The browser exporter consumes this plan verbatim — it is the single
// source of truth shared by preview, export, and tests.
(function (root, factory) {
  const api = factory(
    typeof require === "function" ? require("./episode.js") : (root && root.PdcEpisode),
    typeof require === "function" ? require("./presets.js") : (root && root.PdcPresets),
  );
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PdcExportPlan = api;
})(typeof window !== "undefined" ? window : null, function (Episode, Presets) {
  // buildExportPlan(ep) → {
  //   ok, errors,
  //   preset, pacingSeconds, width, height, background,
  //   tracks: [ { bucket, label, mediaId, url, name, rect, social } ]
  // }
  // rect is normalized 0..1; the exporter multiplies by width/height.
  function buildExportPlan(ep, opts) {
    opts = opts || {};
    const width = opts.width || 1280;
    const height = opts.height || 720;

    const v = Episode.validate(ep);
    if (!v.ok) return { ok: false, errors: v.errors, tracks: [] };

    const preset = Presets.getPreset(ep.presetId);
    if (!preset) return { ok: false, errors: ["Unknown preset."], tracks: [] };

    const speakers = Episode.assignedSpeakers(ep);
    const rects = Presets.composeLayout(preset, speakers.length);

    const tracks = speakers.map((sp, i) => ({
      bucket: sp.bucket,
      label: sp.label,
      mediaId: sp.media.id,
      // Real uploaded media references — NOT placeholders. The exporter draws
      // from these and pulls audio from the same elements.
      url: sp.media.url,
      fileRef: sp.media.fileRef,
      name: sp.media.name,
      rect: rects[i],
      social: sp.social,
    }));

    return {
      ok: true,
      errors: [],
      episodeName: ep.name,
      preset: { id: preset.id, label: preset.label, layout: preset.layout, pacing: preset.pacing },
      pacingSeconds: Presets.pacingSeconds(preset.pacing),
      width,
      height,
      background: preset.background,
      accent: preset.accent,
      tracks,
    };
  }

  return { buildExportPlan };
});
