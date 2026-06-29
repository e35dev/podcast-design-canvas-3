// app/episode.js — DOM-free episode model.
// Holds the episode name, the uploaded speaker media (real File references kept
// by the UI, plus an object URL), the speaker buckets each media is assigned
// to, per-speaker social links, and the chosen preset. Pure data + validation
// so it can be unit-tested in Node without a DOM.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PdcEpisode = api;
})(typeof window !== "undefined" ? window : null, function () {
  // Speaker buckets the product supports. Host is required; guests optional.
  const BUCKETS = [
    { id: "host", label: "Host" },
    { id: "guest1", label: "Guest 1" },
    { id: "guest2", label: "Guest 2" },
  ];

  function bucketLabel(id) {
    const b = BUCKETS.find((x) => x.id === id);
    return b ? b.label : id;
  }

  // createEpisode() → a plain state object. The UI mutates this and re-renders.
  // media[]: { id, name, fileRef, url, bucket }  (fileRef/url set by the UI;
  // bucket is the assignment). social: { host:{...}, guest1:{...}, ... }.
  function createEpisode(name) {
    return {
      name: name || "",
      media: [],
      social: { host: {}, guest1: {}, guest2: {} },
      presetId: null,
    };
  }

  let _seq = 0;
  function addMedia(ep, { name, fileRef, url }) {
    const id = "m" + ++_seq;
    ep.media.push({ id, name: name || "untitled", fileRef: fileRef || null, url: url || null, bucket: null });
    return id;
  }

  function assignBucket(ep, mediaId, bucket) {
    const m = ep.media.find((x) => x.id === mediaId);
    if (!m) throw new Error("assignBucket: unknown media " + mediaId);
    if (bucket !== null && !BUCKETS.some((b) => b.id === bucket))
      throw new Error("assignBucket: unknown bucket " + bucket);
    m.bucket = bucket;
    return ep;
  }

  function setSocial(ep, bucket, field, value) {
    if (!ep.social[bucket]) ep.social[bucket] = {};
    ep.social[bucket][field] = value;
    return ep;
  }

  function selectPreset(ep, presetId) {
    ep.presetId = presetId;
    return ep;
  }

  // Media that have been assigned to a bucket, in canonical bucket order
  // (Host, Guest 1, Guest 2). This is the speaker order layouts use.
  function assignedSpeakers(ep) {
    const out = [];
    for (const b of BUCKETS) {
      const m = ep.media.find((x) => x.bucket === b.id);
      if (m) out.push({ bucket: b.id, label: b.label, media: m, social: ep.social[b.id] || {} });
    }
    return out;
  }

  // validate(ep) → { ok, errors[] }. Encodes the Acceptance gates:
  // name set, ≥2 uploaded files, each upload assigned, no two files in the same
  // bucket, and a preset selected. Social links are optional but counted.
  function validate(ep) {
    const errors = [];
    if (!ep.name || !ep.name.trim()) errors.push("Episode needs a name.");
    if (ep.media.length < 2) errors.push("Upload at least two speaker video files.");

    const unassigned = ep.media.filter((m) => !m.bucket);
    if (unassigned.length) errors.push(unassigned.length + " uploaded file(s) not assigned to a speaker.");

    const seen = {};
    for (const m of ep.media) {
      if (!m.bucket) continue;
      if (seen[m.bucket]) errors.push("Two files assigned to " + bucketLabel(m.bucket) + ".");
      seen[m.bucket] = true;
    }

    const speakers = assignedSpeakers(ep);
    if (speakers.length < 2) errors.push("Assign files to at least two distinct speaker buckets.");

    if (!ep.presetId) errors.push("Select a preset.");

    return { ok: errors.length === 0, errors };
  }

  return {
    BUCKETS,
    bucketLabel,
    createEpisode,
    addMedia,
    assignBucket,
    setSocial,
    selectPreset,
    assignedSpeakers,
    validate,
  };
});
