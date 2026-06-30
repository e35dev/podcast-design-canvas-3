// scripts/verify-rendered-preview.mjs
// Drives the shipped app in headless Chrome and proves issue #41/#58: upload Host +
// Guest videos (including Guest 2), confirm nonblank decoded pixels, visibly
// recompose across Split, Stack, and Spotlight without losing uploaded media,
// and assert Stack/Spotlight geometry with real per-region video pixels.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }

  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run rendered preview verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.off("exit", finish);
      resolve(false);
    }, timeoutMs);

    child.once("exit", finish);
  });
}

async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2000);
}

async function removeDirEventually(dir) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.warn(`verify-rendered-preview: could not remove temp profile ${dir}: ${error.message}`);
        return;
      }
      await sleep(100 * (attempt + 1));
    }
  }
}

async function fetchJson(url, attempts = 60) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError;
}

function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  function send(method, params = {}) {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  }

  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };

    recorder.start();
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "26px sans-serif";
      ctx.fillText(name.slice(0, 20), 20, 78);
      ctx.fillText("frame " + i, 20, 118);
      await sleep(45);
    }
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
    stream.getTracks().forEach((track) => track.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  const waitFor = async (fn, label) => {
    for (let i = 0; i < 120; i++) {
      if (fn()) return;
      await sleep(50);
    }
    throw new Error(label);
  };

  await waitFor(() => window.PDC, "PDC namespace");
  await waitFor(() => window.PDC && window.PDC.episode, "PDC episode API should load");
  await waitFor(() => document.querySelector("#stage-canvas"), "composed preview canvas should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="guest1"]'), "Guest 1 upload control should exist");
  await waitFor(() => document.querySelector('[data-link-bucket="host"]'), "Host social link input should exist");
  await waitFor(() => document.querySelector("#play") && document.querySelector("#play").disabled, "play should start disabled before uploads");

  function layoutSignature(speakerCount) {
    const presetId = document.querySelector("#stage-canvas").dataset.preset;
    const preset = window.PDC.presets.getPreset(presetId);
    const n = speakerCount || Number(document.querySelector("#stage-canvas").dataset.speakers) || 2;
    const buckets = ["host", "guest1", "guest2"];
    return preset.layout(n).map((rect, i) => ({
      speaker: buckets[i] || "guest" + i,
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
    }));
  }

  function regionAvgColor(xStartPct, yStartPct, xEndPct, yEndPct) {
    const c = document.getElementById("stage-canvas");
    const w = c.width;
    const h = c.height;
    const data = c.getContext("2d").getImageData(0, 0, w, h).data;
    const x0 = Math.floor(xStartPct / 100 * w);
    const x1 = Math.floor(xEndPct / 100 * w);
    const y0 = Math.floor(yStartPct / 100 * h);
    const y1 = Math.floor(yEndPct / 100 * h);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * w + x) * 4;
        r += data[idx];
        g += data[idx + 1];
        b += data[idx + 2];
        n++;
      }
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }

  function dominantChannel(color) {
    if (color.r > color.g + 25 && color.r > color.b + 25) return "red";
    if (color.g > color.r + 25 && color.g > color.b + 25) return "green";
    if (color.b > color.r + 25 && color.b > color.g + 25) return "blue";
    return "mixed";
  }

  function assertRegionColor(label, x0, y0, x1, y1, expected) {
    const color = regionAvgColor(x0, y0, x1, y1);
    const dom = dominantChannel(color);
    assert(
      dom === expected,
      label + ": expected " + expected + "-dominant pixels, got " + dom + " (" + JSON.stringify(color) + ")",
    );
    return color;
  }

  function assertStackRowsVisible() {
    const rects = window.PDC.presets.getPreset("stack").layout(3);
    assert(rects.length === 3, "stack should lay out three speakers");
    const rowColors = rects.map((rect, i) => {
      const pad = Math.min(4, rect.h * 0.15);
      const color = regionAvgColor(
        rect.x + 2,
        rect.y + pad,
        rect.x + rect.w - 2,
        rect.y + rect.h - pad,
      );
      return { row: i, color, dom: dominantChannel(color) };
    });
    assert(rowColors[0].dom === "red", "stack row 1 should show the host feed");
    assert(rowColors[1].dom === "green", "stack row 2 should show Guest 1 feed");
    assert(rowColors[2].dom === "blue", "stack row 3 should show Guest 2 feed");
    return rowColors;
  }

  function assertSpotlightComposition() {
    const rects = window.PDC.presets.getPreset("spotlight").layout(3);
    assert(rects[0].w === 100 && rects[0].h === 100, "spotlight host should fill the stage");
    assert(rects[1].w < 50 && rects[1].h < 50, "spotlight guest overlays should be PiP insets");
    const center = assertRegionColor("spotlight center", 25, 25, 75, 75, "red");
    const guest1 = rects[1];
    assertRegionColor(
      "spotlight guest1 PiP",
      guest1.x + 2,
      guest1.y + 2,
      guest1.x + guest1.w - 2,
      guest1.y + guest1.h - 2,
      "green",
    );
    const guest2 = rects[2];
    assertRegionColor(
      "spotlight guest2 PiP",
      guest2.x + 2,
      guest2.y + 2,
      guest2.x + guest2.w - 2,
      guest2.y + guest2.h - 2,
      "blue",
    );
    return { hostRect: rects[0], guestRects: [rects[1], rects[2]], center };
  }

  function canvasLitPct() {
    const c = document.getElementById("stage-canvas");
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) lit++;
    }
    return Math.round((lit / (data.length / 4)) * 100);
  }

  function assertCanvasVisible(label) {
    const pct = canvasLitPct();
    assert(pct >= 5, label + ": composed canvas should show nonblank pixels (" + pct + "%)");
    return pct;
  }

  function hiddenVideos() {
    return [...document.querySelectorAll("video[data-speaker]")];
  }

  async function clickPreset(id) {
    document.querySelector('[data-preset="' + id + '"]').click();
    await sleep(500);
  }

  const hostName = "<img src=x onerror=document.body.dataset.injected=1>.webm";
  const host = await makeVideo(hostName, "#b91c1c");
  const guest = await makeVideo("guest.webm", "#047857");
  const guest2 = await makeVideo("guest2.webm", "#2563eb");

  function uploadTo(input, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest2"]'), guest2);

  await sleep(1200);
  const videos = hiddenVideos();
  assert(videos.length === 3, "three hidden decoder videos should exist after upload");
  await Promise.all(
    videos.map((video) =>
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ? null
        : new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true })),
    ),
  );

  function typeSocial(bucket, url) {
    const input = document.querySelector('[data-link-bucket="' + bucket + '"]');
    input.value = url;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  typeSocial("host", "https://x.com/hostperson");
  typeSocial("guest1", "https://x.com/guestperson");
  typeSocial("guest2", "https://x.com/guesttwo");
  await sleep(300);
  assert(document.querySelector('.bucket[data-bucket="host"] .bucket-name').textContent === "hostperson");
  assert(document.querySelector('.bucket[data-bucket="guest1"] .bucket-name').textContent === "guestperson");
  assert(document.querySelector('.bucket[data-bucket="guest2"] .bucket-name').textContent === "guesttwo");

  const hostStatus = document.querySelector('[data-status="host"]');
  const guestStatus = document.querySelector('[data-status="guest1"]');
  assert(hostStatus && hostStatus.textContent === hostName, "host bucket should show uploaded filename as text");
  assert(hostStatus.innerHTML.includes("&lt;img"), "host filename markup should be escaped");
  assert(document.body.dataset.injected !== "1", "host filename must not execute markup");
  assert(guestStatus && guestStatus.textContent === "guest.webm", "guest bucket should show uploaded filename");
  assert(document.querySelectorAll(".bucket.filled").length === 3, "three buckets should be filled");

  const playButton = document.querySelector("#play");
  assert(!playButton.disabled, "play control should be reachable after uploads");
  if (playButton.textContent.includes("Pause")) {
    playButton.click();
    await sleep(150);
  }
  playButton.click();
  await sleep(700);

  const beforeSwitch = videos.map((video) => ({
    speaker: video.dataset.speaker,
    width: video.videoWidth,
    height: video.videoHeight,
    paused: video.paused,
    time: video.currentTime,
    srcIsBlob: video.src.startsWith("blob:"),
  }));

  assert(beforeSwitch.every((item) => item.srcIsBlob), "videos should be backed by uploaded blob URLs");
  assert(beforeSwitch.every((item) => item.width > 0 && item.height > 0), "videos should decode real dimensions");
  assert(beforeSwitch.every((item) => !item.paused), "videos should be playing after Play click");
  assert(Math.abs(beforeSwitch[0].time - beforeSwitch[1].time) < 0.25, "videos should start in sync");
  assertCanvasVisible("split preset");

  const splitLayout = layoutSignature(2);
  assert(splitLayout.length === 2, "split should lay out two speakers");
  assert(splitLayout[0].left === 0 && splitLayout[1].left === 50, "split should place speakers side by side");

  await clickPreset("stack");
  assert(document.querySelector("#stage-canvas").dataset.preset === "stack", "preset switch should update the canvas to stack");
  assert(document.querySelector("#stage-canvas").dataset.speakers === "3", "stack should compose three speakers");
  const stackLayout = layoutSignature(3);
  assert(stackLayout[0].top === 0 && stackLayout[1].top === 33.333 && stackLayout[2].top === 66.667, "stack should place speakers in three rows");
  assert(JSON.stringify(splitLayout) !== JSON.stringify(stackLayout.slice(0, 2)), "stack layout should differ from split");
  assertCanvasVisible("stack preset");
  const stackRows = assertStackRowsVisible();

  await clickPreset("spotlight");
  assert(document.querySelector("#stage-canvas").dataset.preset === "spotlight", "preset switch should update the canvas to spotlight");
  const spotlightLayout = layoutSignature(3);
  assert(spotlightLayout[0].width === 100 && spotlightLayout[0].height === 100, "spotlight host should fill the stage");
  assert(spotlightLayout[1].width < 50 && spotlightLayout[1].height < 50, "spotlight guest should be a PiP inset");
  assert(JSON.stringify(stackLayout) !== JSON.stringify(spotlightLayout), "spotlight layout should differ from stack");
  const spotlightLit = assertCanvasVisible("spotlight preset");
  const spotlightRegions = assertSpotlightComposition();

  assert(hostStatus.textContent === hostName, "host filename should survive preset cycling");
  assert(guestStatus.textContent === "guest.webm", "guest filename should survive preset cycling");
  assert(document.querySelector('[data-export]') || document.querySelector("#export"), "export control should remain available");
  const exportBtn = document.querySelector("#export");
  assert(exportBtn && !exportBtn.disabled, "export should stay enabled after preset cycling");

  return {
    readiness: document.querySelector("#readiness").textContent,
    filledBuckets: [...document.querySelectorAll(".bucket.filled")].map((bucket) => bucket.dataset.bucket),
    beforeSwitch,
    layouts: { split: splitLayout, stack: stackLayout, spotlight: spotlightLayout },
    stackRows,
    spotlightRegions,
    canvasLitPct: spotlightLit,
    afterSpotlight: hiddenVideos().map((video) => ({
      speaker: video.dataset.speaker,
      width: video.videoWidth,
      height: video.videoHeight,
      srcIsBlob: video.src.startsWith("blob:"),
    })),
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-rendered-preview-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;

  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    entryUrl,
  ]);

  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");

    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression: browserExpression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 25000,
    });
    ws.close();

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }

    console.log("verify-rendered-preview: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((error) => {
  console.error(`verify-rendered-preview: ${error.message}`);
  process.exit(1);
});
