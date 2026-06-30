// scripts/rendered-verify.mjs — drives the running app over file:// in headless
// Chrome and proves issue #41: upload two real local WebM files, enter social
// links for derived names, switch Split → Stack → Spotlight, and assert the
// canvas shows non-blank composed pixels with layout that actually changes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"]) {
    if (existsSync(p)) return p;
  }
  try {
    return spawnSync("command", ["-v", "google-chrome"], { encoding: "utf8" }).stdout.trim() || null;
  } catch {
    return null;
  }
}

let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.log("rendered-verify: SKIP — puppeteer-core not installed (npm install --no-save puppeteer-core).");
  process.exit(0);
}

const chrome = findChrome();
if (!chrome) {
  console.log("rendered-verify: SKIP — no Chrome/Chromium found.");
  process.exit(0);
}

const fileUrl = "file://" + resolve("index.html");
const mediaDir = mkdtempSync(join(tmpdir(), "pdc-verify-media-"));

function runFfmpeg(out, color) {
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=" + color + ":s=320x240:d=1", "-c:v", "libvpx", "-t", "1", out],
    { encoding: "utf8" },
  );
  if (r.status !== 0) fail("ffmpeg failed to create " + out);
}

function fail(msg) {
  console.error("rendered-verify: FAIL — " + msg);
  process.exit(1);
}

const hostPath = join(mediaDir, "host.webm");
const guestPath = join(mediaDir, "guest.webm");
runFfmpeg(hostPath, "0x2563eb");
runFfmpeg(guestPath, "0x16a34a");

const NONBLANK = `(() => {
  const c = document.getElementById('stage-canvas');
  const ctx = c.getContext('2d');
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 14 || data[i+1] > 14 || data[i+2] > 14) lit++;
  }
  return Math.round((lit / (data.length / 4)) * 100);
})()`;

const REGION_BLUE_RATIO = `(() => {
  const c = document.getElementById('stage-canvas');
  const ctx = c.getContext('2d');
  const w = c.width;
  const h = c.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let blueish = 0;
  let total = 0;
  const preset = c.dataset.preset;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inLeftHalf = x < w / 2;
      const inTopHalf = y < h / 2;
      const inRegion = preset === 'stack' ? inTopHalf : inLeftHalf;
      if (!inRegion) continue;
      const i = (y * w + x) * 4;
      total++;
      if (data[i] > 20 && data[i + 2] > data[i + 1] + 10) blueish++;
    }
  }
  return total ? Math.round((blueish / total) * 100) : 0;
})()`;

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  await page.goto(fileUrl, { waitUntil: "networkidle0", timeout: 30000 });

  const hostInput = await page.waitForSelector('input[data-bucket="host"]');
  const guestInput = await page.waitForSelector('input[data-bucket="guest1"]');
  await hostInput.uploadFile(hostPath);
  await guestInput.uploadFile(guestPath);
  await page.evaluate(() => {
    const host = document.querySelector('input[data-bucket="host"]');
    const guest = document.querySelector('input[data-bucket="guest1"]');
    host.dispatchEvent(new Event("change", { bubbles: true }));
    guest.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.waitForFunction(() => {
    const host = document.querySelector('[data-status="host"]')?.textContent;
    const guest = document.querySelector('[data-status="guest1"]')?.textContent;
    return host && host !== "No file" && guest && guest !== "No file";
  }, { timeout: 10000 });

  await page.type('input[data-social="host"]', "https://x.com/alicehost");
  await page.type('input[data-social="guest1"]', "https://linkedin.com/in/bobguest");

  await page.waitForFunction(() => {
    const hostName = document.querySelector('.bucket[data-bucket="host"] .bucket-name')?.textContent;
    const guestName = document.querySelector('.bucket[data-bucket="guest1"] .bucket-name')?.textContent;
    return hostName === "Alicehost" && guestName === "Bobguest";
  }, { timeout: 5000 });

  const playBtn = await page.waitForSelector("#play:not([disabled])", { timeout: 10000 });
  await playBtn.click();
  await page.waitForFunction(() => {
    const c = document.getElementById("stage-canvas");
    return c && c.classList.contains("ready") && c.dataset.preset === "split";
  }, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500));

  const litSplit = await page.evaluate(NONBLANK);
  const blueSplit = await page.evaluate(REGION_BLUE_RATIO);

  await page.click('.preset[data-preset="stack"]');
  await page.waitForFunction(() => document.getElementById("stage-canvas")?.dataset.preset === "stack", { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 900));
  const litStack = await page.evaluate(NONBLANK);
  const blueStack = await page.evaluate(REGION_BLUE_RATIO);

  await page.click('.preset[data-preset="spotlight"]');
  await page.waitForFunction(() => document.getElementById("stage-canvas")?.dataset.preset === "spotlight", { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 900));
  const litSpotlight = await page.evaluate(NONBLANK);

  const names = await page.evaluate(() => ({
    host: document.querySelector('[data-status="host"]')?.textContent,
    guest: document.querySelector('[data-status="guest1"]')?.textContent,
    hostLabel: document.querySelector('.bucket[data-bucket="host"] .bucket-name')?.textContent,
    guestLabel: document.querySelector('.bucket[data-bucket="guest1"] .bucket-name')?.textContent,
    preset: document.getElementById("stage-canvas")?.dataset.preset,
  }));

  if (litSplit < 5) fail("composed canvas blank after upload (split " + litSplit + "%)");
  if (litStack < 5) fail("media lost after stack preset (" + litStack + "%)");
  if (litSpotlight < 5) fail("media lost after spotlight preset (" + litSpotlight + "%)");
  if (blueSplit < 8) fail("split layout did not show host (blue) in left half (" + blueSplit + "%)");
  if (blueStack < 8) fail("stack layout did not show host (blue) in top half (" + blueStack + "%)");
  if (names.hostLabel !== "Alicehost" || names.guestLabel !== "Bobguest") {
    fail("derived speaker names lost after preset cycling");
  }
  if (names.host !== "host.webm" || names.guest !== "guest.webm") {
    fail("uploaded filenames lost after preset cycling");
  }
  if (names.preset !== "spotlight") fail("final preset not spotlight");

  console.log(
    "rendered-verify: PASS — host=" +
      names.host +
      ", guest=" +
      names.guest +
      ", labels=" +
      names.hostLabel +
      "/" +
      names.guestLabel +
      ", split " +
      litSplit +
      "%, stack " +
      litStack +
      "%, spotlight " +
      litSpotlight +
      "%",
  );
} catch (e) {
  fail(e && e.message ? e.message : String(e));
} finally {
  if (browser) await browser.close();
  rmSync(mediaDir, { recursive: true, force: true });
}
