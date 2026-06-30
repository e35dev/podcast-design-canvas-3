// app/episode.js
// Episode model: speaker files, social links, chosen preset, and the readiness
// gates the UI and export rely on. Pure logic, no DOM. Classic-script + global
// PDC namespace so it loads over file:// and is importable by Node tests.
(function () {
  const root = typeof window !== "undefined" ? window : globalThis;
  const PDC = root.PDC || (root.PDC = {});
  const { SPEAKER_BUCKETS, getPreset } = PDC.presets;

  function createEpisode(init = {}) {
    return { title: (init && init.title) || "Untitled Episode", speakers: {}, socialLinks: {}, presetId: (init && init.presetId) || null };
  }

  function assignSpeakerFile(episode, bucket, file) {
    if (!SPEAKER_BUCKETS.includes(bucket)) throw new Error(`Unknown speaker bucket: ${bucket}`);
    if (!file || !file.name) throw new Error("A file with a name is required");
    episode.speakers[bucket] = {
      name: file.name,
      size: Number(file.size) || 0,
      type: file.type || "",
      durationSec: Number(file.durationSec) || 0,
    };
    return episode;
  }

  function setSocialLink(episode, bucket, url) {
    if (!SPEAKER_BUCKETS.includes(bucket)) throw new Error(`Unknown speaker bucket: ${bucket}`);
    if (url) episode.socialLinks[bucket] = url;
    else delete episode.socialLinks[bucket];
    return episode;
  }

  function setPreset(episode, presetId) {
    if (presetId && !getPreset(presetId)) throw new Error(`Unknown preset: ${presetId}`);
    episode.presetId = presetId;
    return episode;
  }

  const assignedBuckets = (episode) => SPEAKER_BUCKETS.filter((b) => episode.speakers[b]);

  function episodeDurationSec(episode) {
    const ds = assignedBuckets(episode).map((b) => episode.speakers[b].durationSec || 0);
    return ds.length ? Math.max(...ds) : 0;
  }

  const canCompose = (episode) => assignedBuckets(episode).length >= 2 && !!getPreset(episode.presetId);

  function readinessReason(episode) {
    if (assignedBuckets(episode).length < 2) return "Upload and assign at least two speaker videos.";
    if (!getPreset(episode.presetId)) return "Choose a preset visual style.";
    return null;
  }

  PDC.episode = { createEpisode, assignSpeakerFile, setSocialLink, setPreset, assignedBuckets, episodeDurationSec, canCompose, readinessReason };
})();
