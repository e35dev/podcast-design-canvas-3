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
