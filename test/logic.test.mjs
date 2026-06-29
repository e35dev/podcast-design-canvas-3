import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PDC = require('../app/logic.js');

test('presets: three distinct identities with distinct layouts', () => {
  assert.equal(PDC.PRESETS.length, 3);
  const ids = PDC.PRESETS.map((p) => p.id);
  assert.deepEqual([...new Set(ids)].sort(), ['roundtable', 'social', 'spotlight'].sort());
  const layouts = new Set(PDC.PRESETS.map((p) => p.layout));
  assert.equal(layouts.size, 3, 'each preset uses a different layout strategy');
  for (const p of PDC.PRESETS) {
    assert.ok(p.pacingMs > 0, 'preset has a pacing rhythm');
    assert.match(p.accent, /^#/, 'preset has an accent color');
  }
});

test('getPreset returns the match, or falls back to the first preset', () => {
  assert.equal(PDC.getPreset('spotlight').id, 'spotlight');
  assert.equal(PDC.getPreset('does-not-exist').id, PDC.PRESETS[0].id);
});

test('inferName: derives a likely on-screen name from social links', () => {
  assert.equal(PDC.inferName('https://x.com/jane_doe'), 'Jane Doe');
  assert.equal(PDC.inferName('twitter.com/john.smith'), 'John Smith');
  assert.equal(PDC.inferName('@cool-host'), 'Cool Host');
  assert.equal(PDC.inferName('https://www.linkedin.com/in/maria-lopez'), 'Maria Lopez');
  assert.equal(PDC.inferName('https://instagram.com/u/the_guest'), 'The Guest');
  assert.equal(PDC.inferName(''), '');
  assert.equal(PDC.inferName(null), '');
});

test('speakerName: explicit name > social > role label', () => {
  assert.equal(PDC.speakerName({ name: 'Pat' }, 'Host'), 'Pat');
  assert.equal(PDC.speakerName({ social: 'x.com/sam' }, 'Guest 1'), 'Sam');
  assert.equal(PDC.speakerName({}, 'Guest 2'), 'Guest 2');
  assert.equal(PDC.speakerName(null, 'Host'), 'Host');
});

test('computeLayout: count handling and bounds', () => {
  const W = 1280, H = 720;
  assert.deepEqual(PDC.computeLayout('roundtable', 0, W, H), []);
  // clamps to 3 tiles maximum
  assert.equal(PDC.computeLayout('roundtable', 5, W, H).length, 3);

  for (const id of ['roundtable', 'spotlight', 'social']) {
    for (const n of [1, 2, 3]) {
      const rects = PDC.computeLayout(id, n, W, H);
      assert.equal(rects.length, n, `${id} produces ${n} rect(s)`);
      for (const r of rects) {
        assert.ok(r.w > 0 && r.h > 0, 'tile has positive size');
        assert.ok(r.x >= 0 && r.y >= 0, 'tile starts on-canvas');
        assert.ok(r.x + r.w <= W + 1, 'tile stays within width');
        assert.ok(r.y + r.h <= H + 1, 'tile stays within height');
      }
    }
  }
});

test('computeLayout: roundtable tiles are equal width and side by side', () => {
  const rects = PDC.computeLayout('roundtable', 2, 1280, 720);
  assert.equal(rects[0].w, rects[1].w, 'equal panel tiles are equal width');
  assert.ok(rects[1].x > rects[0].x, 'tiles are laid out left to right');
});

test('computeLayout: spotlight emphasizes the host tile', () => {
  const rects = PDC.computeLayout('spotlight', 3, 1280, 720);
  assert.equal(rects[0].emphasis, true, 'host tile is emphasized');
  assert.ok(rects[0].w > rects[1].w, 'host tile is larger than guest tiles');
});

test('coverRect: fills the destination while preserving aspect ratio', () => {
  // wide source into a square box -> crop horizontally, keep full height
  const wide = PDC.coverRect(1920, 1080, { w: 100, h: 100 });
  assert.equal(Math.round(wide.sh), 1080);
  assert.ok(wide.sw < 1920);
  assert.ok(Math.abs(wide.sw / wide.sh - 1) < 0.01, 'cropped source matches box ratio');
  // zero source is handled safely
  assert.deepEqual(PDC.coverRect(0, 0, { w: 100, h: 100 }), { sx: 0, sy: 0, sw: 0, sh: 0 });
});

test('slugify / exportFileName', () => {
  assert.equal(PDC.slugify('  My Great Show!! '), 'my-great-show');
  assert.equal(PDC.slugify(''), 'podcast-episode');
  assert.equal(PDC.exportFileName('Episode 12: Deep Dive'), 'episode-12-deep-dive.webm');
  assert.equal(PDC.exportFileName(''), 'podcast-episode.webm');
});

test('formatDuration', () => {
  assert.equal(PDC.formatDuration(0), '00:00');
  assert.equal(PDC.formatDuration(5), '00:05');
  assert.equal(PDC.formatDuration(75), '01:15');
  assert.equal(PDC.formatDuration(NaN), '00:00');
  assert.equal(PDC.formatDuration(-3), '00:00');
});

test('pickRecorderMime: chooses the first supported candidate', () => {
  const onlyVp8 = PDC.pickRecorderMime(null, (m) => m === 'video/webm;codecs=vp8,opus');
  assert.equal(onlyVp8, 'video/webm;codecs=vp8,opus');
  const nothing = PDC.pickRecorderMime(null, () => false);
  assert.equal(nothing, '');
  // without a support probe, returns a safe generic webm
  assert.equal(PDC.pickRecorderMime(null), 'video/webm');
});
