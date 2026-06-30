// scripts/verify-rendered-preview.mjs
// Drives the shipped app in headless Chrome and proves issue #41: upload Host +
// Guest videos, confirm nonblank decoded pixels, and visibly recompose across
// Split, Stack, and Spotlight without losing uploaded media.
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
  await waitFor(() => document.querySelector("#files"), "multi-speaker upload input should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="guest1"]'), "Guest 1 upload control should exist");
  await waitFor(() => document.querySelector("#play") && document.querySelector("#play").disabled, "play should start disabled before uploads");

  function layoutSignature() {
    return [...document.querySelectorAll("#stage .speaker-frame")].map((frame) => ({
      speaker: frame.dataset.speaker,
      left: Number.parseFloat(frame.style.left || "0"),
      top: Number.parseFloat(frame.style.top || "0"),
      width: Number.parseFloat(frame.style.width || "0"),
      height: Number.parseFloat(frame.style.height || "0"),
    }));
  }

  function videoHasVisiblePixels(video) {
    if (!video || !video.videoWidth || !video.videoHeight) return false;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) return true;
    }
    return false;
  }

  function assertVideosVisible(label) {
    const stageVideos = [...document.querySelectorAll("#stage video")];
    assert(stageVideos.length === 2, label + ": stage should contain two speaker videos");
    assert(
      stageVideos.every((video) => video.src.startsWith("blob:") && video.videoWidth > 0 && videoHasVisiblePixels(video)),
      label + ": uploaded videos should render nonblank pixels",
    );
    return stageVideos;
  }

  async function clickPreset(id) {
    document.querySelector('[data-preset="' + id + '"]').click();
    await sleep(400);
  }

  const hostName = "<img src=x onerror=document.body.dataset.injected=1>.webm";
  const host = await makeVideo(hostName, "#b91c1c");
  const guest = await makeVideo("guest.webm", "#047857");

  function uploadTo(input, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);

  await sleep(1200);
  const videos = [...document.querySelectorAll("#stage video")];
  assert(videos.length === 2, "stage should contain two speaker videos after upload");
  await Promise.all(
    videos.map((video) =>
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ? null
        : new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true })),
    ),
  );

  const hostStatus = document.querySelector('[data-status="host"]');
  const guestStatus = document.querySelector('[data-status="guest1"]');
  assert(hostStatus && hostStatus.textContent === hostName, "host bucket should show uploaded filename as text");
  assert(hostStatus.innerHTML.includes("&lt;img"), "host filename markup should be escaped");
  assert(document.body.dataset.injected !== "1", "host filename must not execute markup");
  assert(guestStatus && guestStatus.textContent === "guest.webm", "guest bucket should show uploaded filename");
  assert(document.querySelectorAll(".bucket.filled").length === 2, "two buckets should be filled");

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
  assertVideosVisible("split preset");

  const splitLayout = layoutSignature();
  assert(splitLayout.length === 2, "split should render two speaker frames");
  assert(splitLayout[0].left === 0 && splitLayout[1].left === 50, "split should place speakers side by side");

  await clickPreset("stack");
  assert(document.querySelector("#stage").dataset.preset === "stack", "preset switch should update the stage to stack");
  const stackLayout = layoutSignature();
  assert(stackLayout.length === 2, "stack should render two speaker frames");
  assert(stackLayout[0].top === 0 && stackLayout[1].top === 50, "stack should place speakers in rows");
  assert(JSON.stringify(splitLayout) !== JSON.stringify(stackLayout), "stack layout should differ from split");
  assertVideosVisible("stack preset");

  await clickPreset("spotlight");
  assert(document.querySelector("#stage").dataset.preset === "spotlight", "preset switch should update the stage to spotlight");
  const spotlightLayout = layoutSignature();
  assert(spotlightLayout.length === 2, "spotlight should render two speaker frames");
  assert(spotlightLayout[0].width === 100 && spotlightLayout[0].height === 100, "spotlight host should fill the stage");
  assert(spotlightLayout[1].width < 50 && spotlightLayout[1].height < 50, "spotlight guest should be a PiP inset");
  assert(JSON.stringify(stackLayout) !== JSON.stringify(spotlightLayout), "spotlight layout should differ from stack");
  const afterSpotlight = assertVideosVisible("spotlight preset");

  assert(hostStatus.textContent === hostName, "host filename should survive preset cycling");
  assert(guestStatus.textContent === "guest.webm", "guest filename should survive preset cycling");

  return {
    readiness: document.querySelector("#readiness").textContent,
    filledBuckets: [...document.querySelectorAll(".bucket.filled")].map((bucket) => bucket.dataset.bucket),
    beforeSwitch,
    layouts: { split: splitLayout, stack: stackLayout, spotlight: spotlightLayout },
    afterSpotlight: afterSpotlight.map((video) => ({
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
