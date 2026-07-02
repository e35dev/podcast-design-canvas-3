// tests/moments.test.mjs — timed visual moments model: validation, time
// parsing, [start, end) activation semantics, and persistence across preset
// and template switches.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const M = PDC.moments;
const E = PDC.episode;

test("parseTime accepts seconds and M:SS forms", () => {
  assert.equal(M.parseTime("4"), 4);
  assert.equal(M.parseTime("2.5"), 2.5);
  assert.equal(M.parseTime(7), 7);
  assert.equal(M.parseTime("0:03"), 3);
  assert.equal(M.parseTime("0:00"), 0);
  assert.equal(M.parseTime("1:05"), 65);
  assert.equal(M.parseTime("2:30.5"), 150.5);
});

test("parseTime rejects non-times", () => {
  for (const bad of ["", "  ", "abc", "1:xx", "-3", "1:70", "0:3:4", null, undefined, NaN, -1, Infinity]) {
    assert.ok(Number.isNaN(M.parseTime(bad)), `expected NaN for ${String(bad)}`);
  }
});

test("formatTime renders M:SS", () => {
  assert.equal(M.formatTime(0), "0:00");
  assert.equal(M.formatTime(3), "0:03");
  assert.equal(M.formatTime(65), "1:05");
  assert.equal(M.formatTime(3.9), "0:03");
});

test("validateMoment requires a type, nonempty text, and 0 <= start < end", () => {
  assert.equal(M.validateMoment({ type: "title", text: "EP", start: "0:00", end: "0:03" }), "");
  assert.equal(M.validateMoment({ type: "callout", text: "Ref", start: 4, end: 7 }), "");
  assert.match(M.validateMoment({ type: "banner", text: "x", start: 0, end: 1 }), /type/i);
  assert.match(M.validateMoment({ type: "title", text: "   ", start: 0, end: 1 }), /text/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: "nope", end: 1 }), /start/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: 0, end: "nope" }), /end/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: 3, end: 3 }), /after/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: 5, end: 2 }), /after/i);
});

test("addMoment stores valid moments on the episode and rejects invalid ones", () => {
  const ep = E.createEpisode({});
  const title = M.addMoment(ep, { type: "title", text: "  EP TITLE  ", start: "0:00", end: "0:03" });
  assert.ok(title && title.id, "valid moment should be added with an id");
  assert.equal(title.text, "EP TITLE", "text should be trimmed");
  assert.equal(title.start, 0);
  assert.equal(title.end, 3);
  assert.equal(M.addMoment(ep, { type: "title", text: "", start: 0, end: 3 }), null);
  assert.equal(M.addMoment(ep, { type: "callout", text: "x", start: 7, end: 4 }), null);
  assert.equal(M.listMoments(ep).length, 1, "invalid moments must not be stored");
});

test("listMoments returns moments ordered by start time", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "callout", text: "later", start: 4, end: 7 });
  M.addMoment(ep, { type: "title", text: "first", start: 0, end: 3 });
  assert.deepEqual(M.listMoments(ep).map((m) => m.text), ["first", "later"]);
});

test("removeMoment removes exactly the identified moment", () => {
  const ep = E.createEpisode({});
  const a = M.addMoment(ep, { type: "title", text: "A", start: 0, end: 3 });
  M.addMoment(ep, { type: "callout", text: "B", start: 4, end: 7 });
  assert.equal(M.removeMoment(ep, a.id), true);
  assert.equal(M.removeMoment(ep, a.id), false, "removing twice reports failure");
  assert.deepEqual(M.listMoments(ep).map((m) => m.text), ["B"]);
});

test("activeMoments is start-inclusive and end-exclusive", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "title", text: "EP TITLE", start: 0, end: 3 });
  M.addMoment(ep, { type: "callout", text: "CALLOUT REF", start: 4, end: 7 });
  const texts = (t) => M.activeMoments(ep, t).map((m) => m.text);
  assert.deepEqual(texts(0), ["EP TITLE"], "start boundary is inclusive");
  assert.deepEqual(texts(1.5), ["EP TITLE"]);
  assert.deepEqual(texts(2.999), ["EP TITLE"]);
  assert.deepEqual(texts(3), [], "end boundary is exclusive");
  assert.deepEqual(texts(3.5), [], "gap between moments shows nothing");
  assert.deepEqual(texts(4), ["CALLOUT REF"], "callout starts exactly at 4");
  assert.deepEqual(texts(5), ["CALLOUT REF"]);
  assert.deepEqual(texts(7), [], "callout gone at its end time");
  assert.deepEqual(texts(-1), []);
  assert.deepEqual(texts(NaN), []);
});

test("overlapping moments are both active inside the overlap", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "title", text: "T", start: 0, end: 5 });
  M.addMoment(ep, { type: "callout", text: "C", start: 3, end: 8 });
  assert.deepEqual(M.activeMoments(ep, 4).map((m) => m.text), ["T", "C"]);
  assert.deepEqual(M.activeMoments(ep, 2).map((m) => m.text), ["T"]);
  assert.deepEqual(M.activeMoments(ep, 6).map((m) => m.text), ["C"]);
});

test("moments live on the episode and survive preset and template switches", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "title", text: "EP TITLE", start: 0, end: 3 });
  M.addMoment(ep, { type: "callout", text: "CALLOUT REF", start: 4, end: 7 });
  const before = JSON.stringify(M.listMoments(ep));
  for (const preset of ["stack", "spotlight", "split"]) {
    E.setPreset(ep, preset);
    assert.equal(ep.presetId, preset);
    assert.equal(JSON.stringify(M.listMoments(ep)), before, `moments unchanged on ${preset}`);
    assert.deepEqual(M.activeMoments(ep, 1.5).map((m) => m.text), ["EP TITLE"]);
    assert.deepEqual(M.activeMoments(ep, 5).map((m) => m.text), ["CALLOUT REF"]);
  }
  const tpl = PDC.templates.saveTemplate("Custom", { host: { x: 0, y: 0, w: 50, h: 100 } });
  E.setPreset(ep, tpl.id);
  assert.equal(ep.presetId, tpl.id);
  assert.equal(JSON.stringify(M.listMoments(ep)), before, "moments unchanged on a custom template");
});

test("episodes created before the moments feature still work (lazy list)", () => {
  const ep = E.createEpisode({});
  delete ep.moments; // simulate a pre-feature episode object
  assert.deepEqual(M.listMoments(ep), []);
  assert.deepEqual(M.activeMoments(ep, 1), []);
  assert.ok(M.addMoment(ep, { type: "title", text: "x", start: 0, end: 1 }));
  assert.equal(M.listMoments(ep).length, 1);
});

// --- B-roll image moments ---------------------------------------------------

test("broll is a valid moment type", () => {
  assert.ok(M.MOMENT_TYPES.includes("broll"));
  assert.equal(M.TYPE_LABELS.broll, "B-roll image");
});

test("validateMoment requires an image for b-roll, not text", () => {
  // A b-roll moment needs an imageId and a valid range; its text is optional.
  assert.equal(M.validateMoment({ type: "broll", imageId: "img-1", start: "0:02", end: "0:05" }), "");
  assert.equal(M.validateMoment({ type: "broll", imageId: "img-1", text: "", start: 2, end: 5 }), "");
  assert.equal(M.validateMoment({ type: "broll", imageId: "img-1", text: "Caption", start: 2, end: 5 }), "");
  // Missing image is rejected, even when text is present.
  assert.match(M.validateMoment({ type: "broll", text: "Caption", start: 2, end: 5 }), /image/i);
  assert.match(M.validateMoment({ type: "broll", imageId: "  ", start: 2, end: 5 }), /image/i);
  // Range rules still apply to b-roll moments.
  assert.match(M.validateMoment({ type: "broll", imageId: "img-1", start: 5, end: 2 }), /after/i);
  assert.match(M.validateMoment({ type: "broll", imageId: "img-1", start: "nope", end: 5 }), /start/i);
});

test("addMoment stores a b-roll moment with its image reference and optional caption", () => {
  const ep = E.createEpisode({});
  const broll = M.addMoment(ep, {
    type: "broll",
    imageId: "img-42",
    imageName: "chart.png",
    text: "  Q3 revenue  ",
    start: "0:02",
    end: "0:06",
  });
  assert.ok(broll && broll.id, "valid b-roll moment should be added with an id");
  assert.equal(broll.type, "broll");
  assert.equal(broll.imageId, "img-42");
  assert.equal(broll.imageName, "chart.png");
  assert.equal(broll.text, "Q3 revenue", "caption should be trimmed");
  assert.equal(broll.start, 2);
  assert.equal(broll.end, 6);

  // A caption is optional: a b-roll moment can be added with no text at all.
  const noCaption = M.addMoment(ep, { type: "broll", imageId: "img-7", start: 8, end: 10 });
  assert.ok(noCaption, "b-roll moment without a caption should still be added");
  assert.equal(noCaption.text, "");
  assert.equal(noCaption.imageId, "img-7");

  // A b-roll moment without an image is rejected and not stored.
  assert.equal(M.addMoment(ep, { type: "broll", text: "no image", start: 1, end: 2 }), null);
  assert.equal(M.listMoments(ep).length, 2, "invalid b-roll moment must not be stored");
});

test("b-roll moments schedule with the same [start, end) semantics", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "broll", imageId: "img-1", start: 2, end: 5 });
  const ids = (t) => M.activeMoments(ep, t).map((m) => m.type);
  assert.deepEqual(ids(1.9), [], "before start: not active");
  assert.deepEqual(ids(2), ["broll"], "start boundary is inclusive");
  assert.deepEqual(ids(4.9), ["broll"]);
  assert.deepEqual(ids(5), [], "end boundary is exclusive");
});

test("nextImageId returns distinct opaque ids", () => {
  const a = M.nextImageId();
  const b = M.nextImageId();
  assert.match(a, /^broll-img-/);
  assert.notEqual(a, b, "each image id should be unique");
});

test("b-roll moments carry no image bytes (model stays serializable/DOM-free)", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "broll", imageId: "img-1", imageName: "a.png", start: 1, end: 2 });
  // The stored moment references the image by id only — round-tripping through
  // JSON (as a saved template or reload would) must not lose or embed any bytes.
  const round = JSON.parse(JSON.stringify(M.listMoments(ep)));
  assert.equal(round[0].imageId, "img-1");
  assert.equal(round[0].imageName, "a.png");
  assert.ok(!("image" in round[0]) && !("bytes" in round[0]) && !("data" in round[0]));
});
