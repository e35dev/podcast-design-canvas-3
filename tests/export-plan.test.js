// tests/export-plan.test.js — the composition plan that the exporter consumes.
// Proves the plan ties REAL uploaded media references to the selected preset's
// layout rects, in canonical speaker order.
const assert = require("assert");
const Episode = require("../app/episode.js");
const ExportPlan = require("../app/export-plan.js");

function makeEpisode() {
  const ep = Episode.createEpisode("The Build Loop — Ep 1");
  const f1 = { __file: true, name: "guest.webm" };
  const f2 = { __file: true, name: "host.webm" };
  const id1 = Episode.addMedia(ep, { name: f1.name, fileRef: f1, url: "blob:guest-url" });
  const id2 = Episode.addMedia(ep, { name: f2.name, fileRef: f2, url: "blob:host-url" });
  Episode.assignBucket(ep, id1, "guest1");
  Episode.assignBucket(ep, id2, "host");
  Episode.setSocial(ep, "host", "x", "@thehost");
  Episode.selectPreset(ep, "studio-sidebyside-calm");
  return { ep, id1, id2, f1, f2 };
}

// Invalid episode → plan not ok, carries the validation errors.
{
  const ep = Episode.createEpisode("");
  const plan = ExportPlan.buildExportPlan(ep);
  assert.strictEqual(plan.ok, false);
  assert.ok(plan.errors.length > 0);
  assert.deepStrictEqual(plan.tracks, []);
}

// Valid episode → plan ties media refs to preset rects in canonical order.
{
  const { ep, id1, id2, f1, f2 } = makeEpisode();
  const plan = ExportPlan.buildExportPlan(ep, { width: 1280, height: 720 });
  assert.strictEqual(plan.ok, true, plan.errors.join(","));
  assert.strictEqual(plan.width, 1280);
  assert.strictEqual(plan.height, 720);
  assert.strictEqual(plan.episodeName, "The Build Loop — Ep 1");
  assert.strictEqual(plan.preset.layout, "side-by-side");
  assert.strictEqual(plan.pacingSeconds, 12);

  // Two tracks, Host first.
  assert.strictEqual(plan.tracks.length, 2);
  const host = plan.tracks[0];
  const guest = plan.tracks[1];
  assert.strictEqual(host.bucket, "host");
  assert.strictEqual(guest.bucket, "guest1");

  // The plan references the REAL uploaded media (url + file object), not stubs.
  assert.strictEqual(host.url, "blob:host-url");
  assert.strictEqual(host.fileRef, f2);
  assert.strictEqual(host.mediaId, id2);
  assert.strictEqual(guest.url, "blob:guest-url");
  assert.strictEqual(guest.fileRef, f1);
  assert.strictEqual(host.social.x, "@thehost");

  // Rects come from composeLayout(side-by-side, 2): two columns.
  assert.deepStrictEqual(host.rect, { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepStrictEqual(guest.rect, { x: 0.5, y: 0, w: 0.5, h: 1 });
}

// Switching preset changes the plan's layout/rects but keeps media refs.
{
  const { ep } = makeEpisode();
  Episode.selectPreset(ep, "spotlight-stacked-balanced");
  const plan = ExportPlan.buildExportPlan(ep);
  assert.strictEqual(plan.preset.layout, "stacked");
  // Stacked → rows.
  assert.deepStrictEqual(plan.tracks[0].rect, { x: 0, y: 0, w: 1, h: 0.5 });
  assert.deepStrictEqual(plan.tracks[1].rect, { x: 0, y: 0.5, w: 1, h: 0.5 });
  assert.strictEqual(plan.tracks[0].url, "blob:host-url");
}

console.log("export-plan.test.js: all assertions passed");
