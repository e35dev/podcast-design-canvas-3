import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures');
const SHOT_DIR = join(__dirname, 'screenshots');

/**
 * Generate a short, real, decodable .webm clip entirely inside the browser
 * (canvas.captureStream + MediaRecorder). The clip has a solid color frame so
 * the composed preview/export is visibly correct, and a real video track so
 * the engine's MediaElementAudioSourceNode + MediaRecorder pipeline exercises
 * the same path a creator's uploaded file does.
 */
async function makeClip(page: Page, color: string, label: string, seconds = 1.2): Promise<string> {
  const b64 = await page.evaluate(
    async ({ color, label, seconds }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      const stream = (canvas as HTMLCanvasElement).captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
      rec.start();
      const start = performance.now();
      const draw = () => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText(label, 24, 100);
        if (performance.now() - start < seconds * 1000) {
          requestAnimationFrame(draw);
        } else {
          rec.stop();
        }
      };
      requestAnimationFrame(draw);
      await stopped;
      const blob = new Blob(chunks, { type: 'video/webm' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin);
    },
    { color, label, seconds },
  );
  const path = join(FIXTURE_DIR, `${label}.webm`);
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}

test.describe.configure({ mode: 'serial' });

test('episode import -> preset -> preview -> export (real downloadable file)', async ({ page }) => {
  test.setTimeout(120_000);
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  await page.goto('/');

  // ---- Landing ----
  await expect(page.getByRole('button', { name: /new episode/i })).toBeVisible();
  await page.screenshot({ path: join(SHOT_DIR, '01-landing.png') });
  await page.getByRole('button', { name: /new episode/i }).click();

  // ---- Import: episode title ----
  const titleInput = page.locator('#ep-title');
  await titleInput.fill('Browser Smoke Episode');

  // ---- Import: generate two real webm clips and upload them ----
  const hostClip = await makeClip(page, '#3b4fe0', 'host', 1.2);
  const guestClip = await makeClip(page, '#16a34a', 'guest', 1.2);

  const fileInput = page.locator('input[type=file]');
  await fileInput.setInputFiles([hostClip, guestClip]);

  // two speaker cards should appear, auto-assigned to Host and Guest 1
  const cards = page.locator('.speaker-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAttribute('data-bucket', 'host');
  await expect(cards.nth(1)).toHaveAttribute('data-bucket', 'guest1');
  await page.screenshot({ path: join(SHOT_DIR, '02-import.png') });

  // add display names + social links, scoped per card via placeholders
  await cards.nth(0).getByPlaceholder(/alex lee/i).fill('Host Person');
  await cards.nth(1).getByPlaceholder(/alex lee/i).fill('Guest Person');
  await cards.nth(0).getByPlaceholder(/twitter/i).fill('https://twitter.com/host');
  await cards.nth(1).getByPlaceholder(/twitter/i).fill('https://twitter.com/guest');

  // continue is enabled once 2+ speakers with a host are present
  await expect(page.getByRole('button', { name: /continue to presets/i })).toBeEnabled();
  await page.getByRole('button', { name: /continue to presets/i }).click();

  // ---- Preset ----
  await expect(page.getByText('Choose a visual style')).toBeVisible();
  const presets = page.locator('.preset-card');
  await expect(presets).toHaveCount(3);
  await presets.first().click();
  await expect(presets.first()).toHaveClass(/selected/);
  await page.screenshot({ path: join(SHOT_DIR, '03-preset.png') });
  await page.getByRole('button', { name: /continue to preview/i }).click();

  // ---- Preview ----
  await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  // wait for the engine to load real media + paint a non-black frame.
  // Sample the canvas center pixel and require at least one channel to be bright.
  await expect
    .poll(async () => {
      return await canvas.evaluate((el: HTMLCanvasElement) => {
        const ctx = el.getContext('2d')!;
        const cx = el.width / 2;
        const cy = el.height / 2;
        const d = ctx.getImageData(cx, cy, 1, 1).data;
        return d[0] + d[1] + d[2];
      });
    }, { message: 'composed canvas should paint real speaker frames' })
    .toBeGreaterThan(40);

  await page.screenshot({ path: join(SHOT_DIR, '04-preview.png') });

  // ---- Export: a real downloadable file must be produced ----
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: /export & download/i }).click();

  // while exporting, the export button shows a rendering state
  await expect(page.getByRole('button', { name: /rendering/i })).toBeVisible();

  const download = await downloadPromise;
  const suggested = download.suggestedFilename();
  expect(suggested).toMatch(/\.(webm|mp4)$/);

  const downloadPath = join(SHOT_DIR, suggested);
  await download.saveAs(downloadPath);
  const { statSync } = await import('node:fs');
  const size = statSync(downloadPath).size;
  expect(size, 'exported file must have real bytes').toBeGreaterThan(2000);

  // a result card with a playable inline <video> should appear
  await expect(page.locator('.result video')).toBeVisible();
  await page.screenshot({ path: join(SHOT_DIR, '05-export-result.png'), fullPage: true });
});
