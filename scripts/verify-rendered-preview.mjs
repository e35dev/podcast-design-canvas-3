// scripts/verify-rendered-preview.mjs
// Drives the shipped app in headless Chrome and proves issue #58: upload Host +
// Guest 1 + Guest 2 videos, confirm nonblank decoded pixels, and visibly
// recompose across Split, Stack, and Spotlight without losing uploaded media,
// social context, playback state, or export readiness.
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

  assert(window.PDC, "PDC namespace should load");

  const waitFor = async (fn, label) => {
    for (let i = 0; i < 120; i++) {
      if (fn()) return;
      await sleep(50);
    }
    throw new Error(label);
  };

  await waitFor(() => window.PDC && window.PDC.episode, "PDC episode API should load");
  await waitFor(() => document.querySelector("#stage-canvas"), "composed preview canvas should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="guest1"]'), "Guest 1 upload control should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="guest2"]'), "Guest 2 upload control should exist");
  await waitFor(() => document.querySelector('[data-link-bucket="host"]'), "Host social link input should exist");
  await waitFor(() => document.querySelector('[data-link-bucket="guest2"]'), "Guest 2 social link input should exist");
  await waitFor(() => document.querySelector("#play") && document.querySelector("#play").disabled, "play should start disabled before uploads");

  function layoutSignature() {
    const presetId = document.querySelector("#stage-canvas").dataset.preset;
    const preset = window.PDC.presets.getPreset(presetId);
    const speakerNames = ["host", "guest1", "guest2"];
    return preset.layout(3).map((rect, i) => ({
      speaker: speakerNames[i] || "speaker" + i,
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
    }));
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

  function regionLitPct(rect) {
    const c = document.getElementById("stage-canvas");
    const ctx = c.getContext("2d");
    const x = Math.max(0, Math.floor((rect.left / 100) * c.width));
    const y = Math.max(0, Math.floor((rect.top / 100) * c.height));
    const width = Math.max(1, Math.floor((rect.width / 100) * c.width));
    const height = Math.max(1, Math.floor((rect.height / 100) * c.height));
    const data = ctx.getImageData(x, y, width, height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) lit++;
    }
    return Math.round((lit / (data.length / 4)) * 100);
  }

  function expectRegionVisible(label, rect, minimum) {
    const min = Number.isFinite(minimum) ? minimum : 1;
    const pct = regionLitPct(rect);
    assert(pct >= min, label + ": speaker region should remain visibly nonblank (" + pct + "%)");
    return pct;
  }

  function approxEquals(value, expected, tolerance, label) {
    const tol = Number.isFinite(tolerance) ? tolerance : 0.01;
    assert(Math.abs(value - expected) <= tol, label + " expected " + expected + " got " + value);
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
  const guest1 = await makeVideo("guest1.webm", "#047857");
  const guest2 = await makeVideo("guest2.webm", "#1d4ed8");

  function uploadTo(input, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest1);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest2"]'), guest2);

  await sleep(1600);
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
  typeSocial("guest2", "https://x.com/guest2person");
  await sleep(300);
  assert(document.querySelector('.bucket[data-bucket="host"] .bucket-name').textContent === "hostperson");
  assert(document.querySelector('.bucket[data-bucket="guest1"] .bucket-name').textContent === "guestperson");
  assert(document.querySelector('.bucket[data-bucket="guest2"] .bucket-name').textContent === "guest2person");
  assert(document.querySelector('[data-derived="host"]').textContent === "Shown as: hostperson");
  assert(document.querySelector('[data-derived="guest1"]').textContent === "Shown as: guestperson");
  assert(document.querySelector('[data-derived="guest2"]').textContent === "Shown as: guest2person");

  const hostStatus = document.querySelector('[data-status="host"]');
  const guestStatus = document.querySelector('[data-status="guest1"]');
  const guest2Status = document.querySelector('[data-status="guest2"]');
  assert(hostStatus && hostStatus.textContent === hostName, "host bucket should show uploaded filename as text");
  assert(hostStatus.innerHTML.includes("&lt;img"), "host filename markup should be escaped");
  assert(document.body.dataset.injected !== "1", "host filename must not execute markup");
  assert(document.querySelector('[data-link-bucket="host"]').value === "https://x.com/hostperson", "host social link should persist");
  assert(document.querySelector('[data-link-bucket="guest1"]').value === "https://x.com/guestperson", "guest1 social link should persist");
  assert(guestStatus && guestStatus.textContent === "guest1.webm", "guest1 bucket should show uploaded filename");
  assert(guest2Status && guest2Status.textContent === "guest2.webm", "guest2 bucket should show uploaded filename");
  assert(document.querySelector('[data-link-bucket="guest2"]').value === "https://x.com/guest2person", "guest2 social link should persist");
  assert(document.querySelectorAll(".bucket.filled").length === 3, "three buckets should be filled");

  const playButton = document.querySelector("#play");
  assert(!playButton.disabled, "play control should be reachable after uploads");
  if (playButton.textContent.includes("Pause")) playButton.click();
  playButton.click();
  await sleep(700);
  assert(playButton.textContent.includes("Pause"), "preview should be in play state after pressing Play");

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
  assert(Math.abs(beforeSwitch[0].time - beforeSwitch[1].time) < 0.25, "host and guest1 should start in sync");
  assert(Math.abs(beforeSwitch[1].time - beforeSwitch[2].time) < 0.25, "guest1 and guest2 should start in sync");
  assertCanvasVisible("split preset");

  const splitLayout = layoutSignature();
  const splitLitByRegion = splitLayout.map((layout, index) => expectRegionVisible("split region " + (index + 1), layout, 5));
  assert(splitLayout.length === 3, "split should place three speakers");
  assert(splitLayout[0].left === 0 && splitLayout[1].left === 50 && splitLayout[2].left === 50, "split should keep host in left and guests in right stack");
  assert(splitLayout[1].top === 0 && splitLayout[2].top === 50, "split should stack both guests when 3 speakers");

  await clickPreset("stack");
  assert(document.querySelector("#stage-canvas").dataset.preset === "stack", "preset switch should update the canvas to stack");
  const stackLayout = layoutSignature();
  const stackLitByRegion = stackLayout.map((layout, index) => expectRegionVisible("stack region " + (index + 1), layout, 2));
  assert(stackLayout.length === 3, "stack should place three speakers");
  assert(stackLayout[0].left === 0 && stackLayout[1].left === 0 && stackLayout[2].left === 0, "stack should keep all regions full width");
  approxEquals(stackLayout[0].top, 0, 0.001, "stack row 1 top");
  approxEquals(stackLayout[1].top, 33.333333333333336, 0.02, "stack row 2 top");
  approxEquals(stackLayout[2].top, 66.66666666666667, 0.02, "stack row 3 top");
  assert(JSON.stringify(splitLayout) !== JSON.stringify(stackLayout), "stack layout should differ from split");
  assert(playButton.textContent.includes("Pause"), "play state should stay playing when switching split -> stack");
  assert(!document.querySelector("#export").disabled, "export should stay enabled while composed");
  assertCanvasVisible("stack preset");

  await clickPreset("spotlight");
  assert(document.querySelector("#stage-canvas").dataset.preset === "spotlight", "preset switch should update the canvas to spotlight");
  const spotlightLayout = layoutSignature();
  assert(spotlightLayout[0].width === 100 && spotlightLayout[0].height === 100, "spotlight host should fill the stage");
  assert(spotlightLayout.length === 3, "spotlight should include three speakers");
  assert(spotlightLayout[1].width < 50 && spotlightLayout[1].height < 50, "spotlight guest1 should be a PiP inset");
  assert(spotlightLayout[2].width < 50 && spotlightLayout[2].height < 50, "spotlight guest2 should be a PiP inset");
  assert(spotlightLayout[2].top < spotlightLayout[1].top, "spotlight guest2 should stack above guest1");
  const spotlightHost = expectRegionVisible("spotlight host", spotlightLayout[0], 35);
  const spotlightGuest1 = expectRegionVisible("spotlight guest1", spotlightLayout[1], 1);
  const spotlightGuest2 = expectRegionVisible("spotlight guest2", spotlightLayout[2], 1);
  assert(JSON.stringify(stackLayout) !== JSON.stringify(spotlightLayout), "spotlight layout should differ from stack");
  assert(playButton.textContent.includes("Pause"), "play state should stay playing when switching stack -> spotlight");
  const spotlightLit = assertCanvasVisible("spotlight preset");

  assert(hostStatus.textContent === hostName, "host filename should survive preset cycling");
  assert(guestStatus.textContent === "guest1.webm", "guest1 filename should survive preset cycling");
  assert(guest2Status.textContent === "guest2.webm", "guest2 filename should survive preset cycling");
  assert(document.querySelector('[data-derived="guest2"]').textContent === "Shown as: guest2person", "guest2 derived name should survive preset cycling");
  playButton.click();
  await sleep(150);
  assert(playButton.textContent.includes("Play"), "pressing pause should transition to paused");
  await clickPreset("split");
  assert(playButton.textContent.includes("Play"), "paused state should survive split -> split");

  return {
    readiness: document.querySelector("#readiness").textContent,
    filledBuckets: [...document.querySelectorAll(".bucket.filled")].map((bucket) => bucket.dataset.bucket),
    beforeSwitch,
    regionLighting: {
      split: splitLitByRegion,
      stack: stackLitByRegion,
      spotlight: [spotlightHost, spotlightGuest1, spotlightGuest2],
    },
    layouts: { split: splitLayout, stack: stackLayout, spotlight: spotlightLayout },
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
