// app/layout.js
// Resolves the active speaker-frame geometry for an episode: either a saved
// show template or a built-in preset. Single source used by preview + export.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  function resolveRects(episode) {
    const buckets = PDC.episode.assignedBuckets(episode);
    if (!buckets.length) return [];
    if (episode.layoutSource === "template" && episode.templateId) {
      const rects = PDC.templates.rectsForBuckets(episode.templateId, buckets);
      if (rects && rects.every(Boolean)) return rects;
    }
    const preset = PDC.presets.getPreset(episode.presetId) || PDC.presets.PRESETS[0];
    return preset.layout(buckets.length);
  }

  function rectsFromBuckets(episode, rectsByBucket) {
    const buckets = PDC.episode.assignedBuckets(episode);
    return buckets.map(function (bucket) {
      return PDC.templates.clampRect(rectsByBucket[bucket] || { x: 0, y: 0, w: 100, h: 100 });
    });
  }

  function draftFromEpisode(episode) {
    const buckets = PDC.episode.assignedBuckets(episode);
    const draft = {};
    const rects = resolveRects(episode);
    buckets.forEach(function (bucket, i) {
      draft[bucket] = Object.assign({}, rects[i]);
    });
    return draft;
  }

  PDC.layout = {
    resolveRects,
    rectsFromBuckets,
    draftFromEpisode,
  };
})();
