// scripts/e2e-preview.mjs — headless Chrome E2E for the upload → preview workflow.
// Uses system Chrome + puppeteer-core (no browser download). Generates real WebM
// fixtures via ffmpeg, uploads through the per-bucket Upload buttons, clicks
// Play, and asserts stage <video> elements show blob: URLs with decoded frames.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8765);
const tmp = fs.mkdtempSync(path.join(root, ".e2e-"));

function die(msg) {
  console.error("e2e-preview:", msg);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  return r;
}

// 1. Generate two distinct test WebM clips (real video pixels, not fixtures in product).
const hostWebm = path.join(tmp, "host.webm");
const guestWebm = path.join(tmp, "guest.webm");
for (const [out, color] of [
  [hostWebm, "0x3366ff"],
  [guestWebm, "0xff6633"],
]) {
  run("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x240:d=1`, "-c:v", "libvpx", "-t", "1", out,
  ]);
}

// 2. Static server (dependency-free).
function startServer() {
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = (req.url || "/").split("?")[0] === "/" ? "index.html" : req.url.replace(/^\//, "");
      const full = path.join(root, rel);
      if (!full.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(full, (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": types[path.extname(full)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(port, () => resolve(server));
  });
}

// 3. Puppeteer against system Chrome.
let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  die("puppeteer-core is required for e2e-preview — run: npm install --no-save puppeteer-core");
}

const chromePaths = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
const executablePath = chromePaths.find((p) => fs.existsSync(p));
if (!executablePath) die("system Chrome/Chromium not found");

const server = await startServer();
let browser;
try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle0" });

  // Upload Host via per-bucket Upload button.
  const hostInput = await page.waitForSelector("#upload-host");
  await hostInput.uploadFile(hostWebm);
  await page.waitForFunction(() => document.querySelector('[data-status="host"]')?.textContent !== "No file");

  // Upload Guest 1.
  const guestInput = await page.waitForSelector("#upload-guest1");
  await guestInput.uploadFile(guestWebm);
  await page.waitForFunction(() => document.querySelector('[data-status="guest1"]')?.textContent !== "No file");

  // Play button should be enabled; click it.
  const playBtn = await page.waitForSelector("#play:not([disabled])");
  await playBtn.click();

  // Stage should have two <video> elements with blob: sources and decoded frames.
  await page.waitForFunction(() => {
    const videos = [...document.querySelectorAll("#stage video")];
    return (
      videos.length >= 2 &&
      videos.every((v) => v.src.startsWith("blob:") && v.readyState >= 2 && v.videoWidth > 0)
    );
  }, { timeout: 15000 });

  const stats = await page.evaluate(() => {
    const videos = [...document.querySelectorAll("#stage video")];
    return {
      count: videos.length,
      playing: videos.filter((v) => !v.paused).length,
      preset: document.getElementById("stage")?.dataset.preset,
      hostFile: document.querySelector('[data-status="host"]')?.textContent,
      guestFile: document.querySelector('[data-status="guest1"]')?.textContent,
      playEnabled: !document.getElementById("play").disabled,
    };
  });

  if (stats.count < 2) die(`expected 2 stage videos, got ${stats.count}`);
  if (!stats.playEnabled) die("Play button still disabled after upload");
  if (!stats.hostFile?.includes("host.webm")) die(`Host bucket wrong: ${stats.hostFile}`);
  if (!stats.guestFile?.includes("guest.webm")) die(`Guest bucket wrong: ${stats.guestFile}`);

  // Switch preset and confirm videos persist.
  await page.click('.preset[data-preset="spotlight"]');
  await page.waitForFunction(() => document.getElementById("stage")?.dataset.preset === "spotlight");
  const afterSwitch = await page.evaluate(() => document.querySelectorAll("#stage video").length);
  if (afterSwitch < 2) die("videos lost after preset switch");

  console.log(
    `e2e-preview: OK — ${stats.count} uploaded videos in “${stats.preset}” layout, ${stats.playing} playing`,
  );
} finally {
  if (browser) await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
