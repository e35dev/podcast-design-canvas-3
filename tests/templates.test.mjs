// tests/templates.test.mjs — DOM-free tests for the custom-layout template model.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("saveTemplate stores a named, reusable template with normalized rects", () => {
  const PDC = loadPDC(root);
  const t = PDC.templates.saveTemplate("My Layout", {
    host: { x: 5, y: 5, w: 60, h: 80 },
    guest1: { x: 70, y: 10, w: 25, h: 25 },
  });
  assert.ok(t.id.startsWith("tpl-"));
  assert.equal(t.name, "My Layout");
  assert.deepEqual(t.rects.host, { x: 5, y: 5, w: 60, h: 80 });
  assert.ok(PDC.templates.listTemplates().some((x) => x.id === t.id));
  assert.ok(PDC.templates.isTemplate(t.id));
});

test("a blank name falls back to a generated label", () => {
  const PDC = loadPDC(root);
  const t = PDC.templates.saveTemplate("   ", { host: { x: 0, y: 0, w: 50, h: 50 } });
  assert.ok(t.name.length > 0);
});

test("normalizeRect keeps rects inside the stage", () => {
  const PDC = loadPDC(root);
  const r = PDC.templates.normalizeRect({ x: 90, y: 95, w: 40, h: 40 });
  assert.ok(r.x + r.w <= 100 + 1e-9);
  assert.ok(r.y + r.h <= 100 + 1e-9);
  const tiny = PDC.templates.normalizeRect({ x: 0, y: 0, w: 1, h: 1 });
  assert.ok(tiny.w >= 8 && tiny.h >= 8);
});

test("resolveLayout returns the saved template rects for the assigned speakers", () => {
  const PDC = loadPDC(root);
  const t = PDC.templates.saveTemplate("Two", {
    host: { x: 0, y: 0, w: 40, h: 100 },
    guest1: { x: 40, y: 0, w: 60, h: 100 },
    guest2: { x: 0, y: 0, w: 20, h: 20 },
  });
  const ep = PDC.episode.createEpisode({ title: "t" });
  PDC.episode.setPreset(ep, t.id);
  const rects = PDC.templates.resolveLayout(ep, 2);
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 40, h: 100 });
  assert.deepEqual(rects[1], { x: 40, y: 0, w: 60, h: 100 });
});

test("resolveLayout falls back to the built-in preset geometry for preset ids", () => {
  const PDC = loadPDC(root);
  const ep = PDC.episode.createEpisode({ title: "t" });
  PDC.episode.setPreset(ep, PDC.presets.DEFAULT_PRESET_ID);
  const rects = PDC.templates.resolveLayout(ep, 2);
  const preset = PDC.presets.getPreset(PDC.presets.DEFAULT_PRESET_ID);
  assert.deepEqual(rects, preset.layout(2));
});

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

test("a saved template survives a reload (fresh realm, same underlying storage)", () => {
  const localStorage = makeLocalStorage();
  const PDC1 = loadPDC(root, { localStorage });
  const saved = PDC1.templates.saveTemplate("Reusable Show", {
    host: { x: 5, y: 10, w: 40, h: 40 },
    guest1: { x: 55, y: 10, w: 40, h: 40 },
  });

  // Simulate a page refresh / brand-new episode: a fresh module realm, same
  // localStorage backing it — nothing but window.localStorage carries over.
  const PDC2 = loadPDC(root, { localStorage });
  const persisted = PDC2.templates.listTemplates();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, saved.id);
  assert.equal(persisted[0].name, "Reusable Show");
  assert.deepEqual(persisted[0].rects, {
    host: { x: 5, y: 10, w: 40, h: 40 },
    guest1: { x: 55, y: 10, w: 40, h: 40 },
  });

  // A template saved after reload never collides with the persisted id.
  const second = PDC2.templates.saveTemplate("Another", { host: { x: 0, y: 0, w: 50, h: 50 } });
  assert.notEqual(second.id, saved.id);

  // ...and both templates are there the next time the app loads.
  const PDC3 = loadPDC(root, { localStorage });
  assert.deepEqual(
    PDC3.templates.listTemplates().map((t) => t.id).sort(),
    [saved.id, second.id].sort(),
  );
});

test("a template applies to a freshly created episode with new media assigned", () => {
  const localStorage = makeLocalStorage();
  const PDC1 = loadPDC(root, { localStorage });
  const saved = PDC1.templates.saveTemplate("Corner Host", {
    host: { x: 10, y: 20, w: 30, h: 30 },
    guest1: { x: 50, y: 20, w: 30, h: 30 },
  });

  const PDC2 = loadPDC(root, { localStorage });
  const freshEpisode = PDC2.episode.createEpisode({ title: "Episode 2" });
  assert.deepEqual(freshEpisode.media, {}, "a brand-new episode carries none of the old episode's media");
  PDC2.episode.assignMedia(freshEpisode, "host", { name: "new-host.webm", size: 1, type: "video/webm" });
  PDC2.episode.assignMedia(freshEpisode, "guest1", { name: "new-guest.webm", size: 1, type: "video/webm" });
  PDC2.episode.setPreset(freshEpisode, saved.id);
  const rects = PDC2.templates.resolveLayout(freshEpisode, 2);
  assert.deepEqual(rects[0], { x: 10, y: 20, w: 30, h: 30 });
  assert.deepEqual(rects[1], { x: 50, y: 20, w: 30, h: 30 });
});

test("corrupt or unavailable storage falls back to an empty template list instead of crashing", () => {
  const brokenStorage = { getItem: () => "not json", setItem: () => {}, removeItem: () => {} };
  assert.deepEqual(loadPDC(root, { localStorage: brokenStorage }).templates.listTemplates(), []);
  // No localStorage on window at all (e.g. disabled storage) is also safe.
  assert.deepEqual(loadPDC(root, {}).templates.listTemplates(), []);
});

test("the draft layout renders live and clears cleanly", () => {
  const PDC = loadPDC(root);
  PDC.templates.setDraft({ host: { x: 10, y: 10, w: 30, h: 30 }, guest1: { x: 50, y: 50, w: 30, h: 30 } });
  const ep = PDC.episode.createEpisode({ title: "t" });
  PDC.episode.setPreset(ep, PDC.templates.DRAFT_ID);
  let rects = PDC.templates.resolveLayout(ep, 2);
  assert.deepEqual(rects[0], { x: 10, y: 10, w: 30, h: 30 });
  PDC.templates.clearDraft();
  // With the draft gone, an unknown id falls back to the first preset's geometry.
  rects = PDC.templates.resolveLayout(ep, 2);
  assert.deepEqual(rects, PDC.presets.PRESETS[0].layout(2));
});
