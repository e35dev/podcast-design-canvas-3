// tests/template-persistence.test.mjs — DOM-free tests for saved-show-template
// persistence: templates round-trip through localStorage across a "reload"
// (fresh module load over the same storage), the serialized payload carries
// ONLY layout data (never media/URLs/episode state), saved rects resolve for
// both 2- and 3-speaker episodes, and a missing or throwing localStorage
// degrades gracefully to the in-memory behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "pdc3.templates.v1";

// Minimal localStorage stand-in: same getItem/setItem contract, inspectable.
function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    raw: (k) => map.get(k),
  };
}

test("saved templates round-trip through storage across a reload", () => {
  const storage = fakeStorage();
  const first = loadPDC(root, { localStorage: storage });
  const saved = first.templates.saveTemplate("My Show Layout", {
    host: { x: 4, y: 32, w: 18, h: 68 },
    guest1: { x: 42, y: 16, w: 30, h: 30 },
    guest2: { x: 50, y: 50, w: 50, h: 50 },
  });
  assert.ok(storage.raw(KEY), "saving should write the store key");

  // A fresh module load over the SAME storage models a page refresh.
  const second = loadPDC(root, { localStorage: storage });
  const loaded = second.templates.getTemplate(saved.id);
  assert.ok(loaded, "the saved template should survive the reload");
  assert.equal(loaded.name, "My Show Layout");
  assert.deepEqual(loaded.rects, saved.rects);
  assert.ok(second.templates.listTemplates().some((t) => t.id === saved.id));
  assert.ok(second.templates.isTemplate(saved.id));
});

test("new saves after a reload never collide with persisted ids", () => {
  const storage = fakeStorage();
  const first = loadPDC(root, { localStorage: storage });
  const a = first.templates.saveTemplate("A", { host: { x: 0, y: 0, w: 50, h: 50 } });
  const second = loadPDC(root, { localStorage: storage });
  const b = second.templates.saveTemplate("B", { host: { x: 10, y: 10, w: 40, h: 40 } });
  assert.notEqual(b.id, a.id, "the id sequence should continue past loaded templates");
  assert.equal(second.templates.listTemplates().length, 2);
});

test("the serialized payload carries ONLY layout data — no media fields", () => {
  const storage = fakeStorage();
  const PDC = loadPDC(root, { localStorage: storage });
  PDC.templates.saveTemplate("Clean", {
    host: { x: 0, y: 0, w: 40, h: 100 },
    guest1: { x: 40, y: 0, w: 60, h: 100 },
  });
  const raw = storage.raw(KEY);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.length, 1);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["id", "name", "rects"]);
  for (const rect of Object.values(parsed[0].rects)) {
    assert.deepEqual(Object.keys(rect).sort(), ["h", "w", "x", "y"]);
    for (const v of Object.values(rect)) assert.equal(typeof v, "number");
  }
  assert.ok(!/blob:|objectUrl|"media"|"src"|"url"|"file"|\.webm/i.test(raw), "stored JSON must not reference media: " + raw);
});

test("media-ish fields on stored entries are stripped on load; junk entries are dropped", () => {
  const storage = fakeStorage({
    [KEY]: JSON.stringify([
      {
        id: "tpl-7",
        name: "Tampered",
        rects: { host: { x: 5, y: 5, w: 50, h: 50, src: "blob:x" }, bogus: { x: 0, y: 0, w: 9, h: 9 } },
        media: { host: { name: "old.webm" } },
        url: "blob:abc",
      },
      { id: "tpl-draft", name: "Draft", rects: { host: { x: 0, y: 0, w: 50, h: 50 } } },
      { id: "not-a-template", rects: { host: { x: 0, y: 0, w: 50, h: 50 } } },
      { id: "tpl-8", name: "No rects", rects: {} },
      "garbage",
      null,
    ]),
  });
  const PDC = loadPDC(root, { localStorage: storage });
  const list = PDC.templates.listTemplates();
  assert.equal(list.length, 1, "only the one repairable entry should load");
  const t = list[0];
  assert.equal(t.id, "tpl-7");
  assert.deepEqual(Object.keys(t).sort(), ["id", "name", "rects"]);
  assert.deepEqual(Object.keys(t.rects), ["host"], "unknown buckets should be dropped");
  assert.deepEqual(t.rects.host, { x: 5, y: 5, w: 50, h: 50 }, "rects should be re-normalized to pure geometry");
});

test("malformed stored JSON is ignored and then repaired by the next save", () => {
  const storage = fakeStorage({ [KEY]: "{not json" });
  const PDC = loadPDC(root, { localStorage: storage });
  assert.deepEqual(PDC.templates.listTemplates(), []);
  const t = PDC.templates.saveTemplate("Fresh", { host: { x: 0, y: 0, w: 50, h: 50 } });
  assert.deepEqual(JSON.parse(storage.raw(KEY)).map((x) => x.id), [t.id]);
});

test("a throwing localStorage falls back to in-memory templates without breaking", () => {
  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  const PDC = loadPDC(root, { localStorage: throwing });
  const t = PDC.templates.saveTemplate("Session only", { host: { x: 0, y: 0, w: 50, h: 50 } });
  assert.ok(PDC.templates.getTemplate(t.id), "template should still work in-memory");
  assert.equal(PDC.templates.listTemplates().length, 1);
});

test("no localStorage at all (bare window) keeps the in-memory behavior", () => {
  const PDC = loadPDC(root); // the shim window has no localStorage
  const t = PDC.templates.saveTemplate("Memory", { host: { x: 0, y: 0, w: 50, h: 50 } });
  assert.ok(PDC.templates.getTemplate(t.id));
});

test("a persisted 3-speaker template resolves for both 3 and 2 speakers", () => {
  const storage = fakeStorage();
  const first = loadPDC(root, { localStorage: storage });
  const saved = first.templates.saveTemplate("Three up", {
    host: { x: 4, y: 32, w: 18, h: 68 },
    guest1: { x: 42, y: 16, w: 30, h: 30 },
    guest2: { x: 50, y: 50, w: 50, h: 50 },
  });

  const PDC = loadPDC(root, { localStorage: storage }); // fresh episode after "refresh"
  const ep = PDC.episode.createEpisode({ title: "new" });
  PDC.episode.setPreset(ep, saved.id);

  const three = PDC.templates.resolveLayout(ep, 3);
  assert.deepEqual(three, [saved.rects.host, saved.rects.guest1, saved.rects.guest2]);

  const two = PDC.templates.resolveLayout(ep, 2);
  assert.equal(two.length, 2, "a 2-speaker episode should get exactly two rects");
  assert.deepEqual(two, [saved.rects.host, saved.rects.guest1], "the first N saved rects should apply");
});

test("a persisted 2-speaker template resolves sensibly for a 3-speaker episode", () => {
  const storage = fakeStorage();
  const first = loadPDC(root, { localStorage: storage });
  const saved = first.templates.saveTemplate("Two up", {
    host: { x: 0, y: 0, w: 40, h: 100 },
    guest1: { x: 40, y: 0, w: 60, h: 100 },
  });

  const PDC = loadPDC(root, { localStorage: storage });
  const ep = PDC.episode.createEpisode({ title: "new" });
  PDC.episode.setPreset(ep, saved.id);
  const rects = PDC.templates.resolveLayout(ep, 3);
  assert.equal(rects.length, 3);
  assert.deepEqual(rects[0], saved.rects.host);
  assert.deepEqual(rects[1], saved.rects.guest1);
  // The bucket the template never covered falls back to preset geometry so the
  // extra speaker still gets a real on-stage rect.
  assert.deepEqual(rects[2], PDC.presets.PRESETS[0].layout(3)[2]);
});
