// tests/episode.test.js — DOM-free episode model: upload, bucket assignment,
// social links, and the Acceptance validation gates.
const assert = require("assert");
const Episode = require("../app/episode.js");

function fakeFile(name) {
  return { __file: true, name };
}

// Fresh episode is invalid until the flow is completed.
{
  const ep = Episode.createEpisode("");
  const v = Episode.validate(ep);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /name/i.test(e)), "needs name error");
  assert.ok(v.errors.some((e) => /two/i.test(e)), "needs >=2 files error");
  assert.ok(v.errors.some((e) => /preset/i.test(e)), "needs preset error");
}

// Real File references and object URLs are KEPT in state (not discarded).
{
  const ep = Episode.createEpisode("Ep 1");
  const f1 = fakeFile("host.webm");
  const id1 = Episode.addMedia(ep, { name: f1.name, fileRef: f1, url: "blob:host" });
  assert.strictEqual(ep.media.length, 1);
  assert.strictEqual(ep.media[0].fileRef, f1, "file ref retained");
  assert.strictEqual(ep.media[0].url, "blob:host", "object url retained");
  assert.strictEqual(ep.media[0].bucket, null, "starts unassigned");
}

// One file is not enough — Acceptance requires at least two.
{
  const ep = Episode.createEpisode("Ep 1");
  const id1 = Episode.addMedia(ep, { name: "a.webm", fileRef: fakeFile("a"), url: "blob:a" });
  Episode.assignBucket(ep, id1, "host");
  Episode.selectPreset(ep, "studio-sidebyside-calm");
  const v = Episode.validate(ep);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /two/i.test(e)));
}

// Two files, each assigned, preset chosen → valid; assignedSpeakers ordered.
{
  const ep = Episode.createEpisode("Ep 1");
  const id1 = Episode.addMedia(ep, { name: "a.webm", fileRef: fakeFile("a"), url: "blob:a" });
  const id2 = Episode.addMedia(ep, { name: "b.webm", fileRef: fakeFile("b"), url: "blob:b" });
  Episode.assignBucket(ep, id1, "guest1");
  Episode.assignBucket(ep, id2, "host");
  Episode.setSocial(ep, "host", "x", "@host");
  Episode.selectPreset(ep, "studio-sidebyside-calm");
  const v = Episode.validate(ep);
  assert.strictEqual(v.ok, true, "valid: " + v.errors.join(","));

  const speakers = Episode.assignedSpeakers(ep);
  assert.strictEqual(speakers.length, 2);
  // Canonical order: Host first regardless of upload order.
  assert.strictEqual(speakers[0].bucket, "host");
  assert.strictEqual(speakers[0].media.id, id2);
  assert.strictEqual(speakers[1].bucket, "guest1");
  assert.strictEqual(speakers[0].social.x, "@host");
}

// Unassigned file blocks validity.
{
  const ep = Episode.createEpisode("Ep 1");
  const id1 = Episode.addMedia(ep, { name: "a", fileRef: fakeFile("a"), url: "blob:a" });
  const id2 = Episode.addMedia(ep, { name: "b", fileRef: fakeFile("b"), url: "blob:b" });
  Episode.assignBucket(ep, id1, "host");
  Episode.selectPreset(ep, "studio-sidebyside-calm");
  const v = Episode.validate(ep);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /not assigned/i.test(e)));
}

// Two files cannot share a bucket.
{
  const ep = Episode.createEpisode("Ep 1");
  const id1 = Episode.addMedia(ep, { name: "a", fileRef: fakeFile("a"), url: "blob:a" });
  const id2 = Episode.addMedia(ep, { name: "b", fileRef: fakeFile("b"), url: "blob:b" });
  Episode.assignBucket(ep, id1, "host");
  Episode.assignBucket(ep, id2, "host");
  Episode.selectPreset(ep, "studio-sidebyside-calm");
  const v = Episode.validate(ep);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /Two files assigned to Host/i.test(e)));
}

// Unknown bucket rejected.
{
  const ep = Episode.createEpisode("Ep 1");
  const id1 = Episode.addMedia(ep, { name: "a", fileRef: fakeFile("a"), url: "blob:a" });
  assert.throws(() => Episode.assignBucket(ep, id1, "nope"));
}

console.log("episode.test.js: all assertions passed");
