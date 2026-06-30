// scripts/verify-rendered-preview.mjs
// Drives the shipped app in headless Chrome and proves the active #41 workflow:
// upload two local video files through the real file input, assign Host/Guest
// buckets, enter distinct per-speaker social links, render decoded uploaded
// pixels in the composed preview, then ACTIVELY switch between Split, Stack, and
// Spotlight while the preview is playing and assert that the composed layout
// actually CHANGES per preset (each speaker video's on-screen bounding rect is
// distinct across all three presets) while the videos keep playing/non-blank and
// the uploads, bucket assignments, and social-derived names are all preserved.
// No fixtures or product-only shortcuts are used; the WebM files are generated
// in-browser and uploaded as real File objects through the visible input.
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

  // Wait for the app's classic scripts to finish wiring the DOM (the page may
  // still be loading when this evaluates), then assert the controls exist.
  const waitFor = async (fn, label) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };
  await waitFor(() => window.PDC && window.PDC.preview, "PDC namespace should load");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  assert(window.PDC, "PDC namespace should load");
  assert(document.querySelector("#files"), "multi-speaker upload input should exist");
  assert(document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  assert(document.querySelector('[data-file-bucket="guest1"]'), "Guest 1 upload control should exist");
  assert(document.querySelector("#play").disabled, "play should start disabled before uploads");

  const hostName = "<img src=x onerror=document.body.dataset.injected=1>.webm";
  const host = await makeVideo(hostName, "#b91c1c");
  const guest = await makeVideo("guest.webm", "#047857");

  function uploadTo(input, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function typeInto(input, value) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);

  await sleep(1200);

  // Enter DISTINCT social links so we can prove the social context survives the
  // active preset switching required by #41.
  const HOST_URL = "https://x.com/hostperson";
  const GUEST_URL = "https://x.com/guestperson";
  typeInto(document.querySelector('[data-link-bucket="host"]'), HOST_URL);
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), GUEST_URL);
  await sleep(200);
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

  // --- #41: actively switch Split -> Stack -> Spotlight while the preview is
  // playing and prove the composed layout actually CHANGES per preset, that the
  // videos keep playing/non-blank, and that uploads + bucket assignments +
  // social-derived names are preserved across every switch. The on-screen
  // geometry is read from each speaker video's getBoundingClientRect so the
  // assertion reflects what a maintainer literally sees, not just model state.
  const tagText = (bucket) => {
    const el = document.querySelector('[data-speaker-tag="' + bucket + '"]');
    return el ? el.textContent : null;
  };
  const rectKey = (r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(",");

  async function applyPreset(presetId) {
    const btn = document.querySelector('[data-preset="' + presetId + '"]');
    assert(btn, "preset control " + presetId + " should exist");
    btn.click();
    await sleep(350);
    assert(document.querySelector("#stage").dataset.preset === presetId, "preset switch should update the stage to " + presetId);
    const vids = [...document.querySelectorAll("#stage video")];
    assert(vids.length === 2, "preset " + presetId + " should preserve both uploaded videos");
    const geom = {};
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      assert(v.src.startsWith("blob:"), "preset " + presetId + ": video must stay backed by uploaded blob URL");
      assert(v.videoWidth > 0 && v.videoHeight > 0, "preset " + presetId + ": video must stay decoded (non-blank)");
      assert(!v.paused, "preset " + presetId + ": video must keep playing across re-layout");
      assert(r.width > 1 && r.height > 1, "preset " + presetId + ": video must have a visible on-screen rect");
      geom[v.dataset.speaker] = rectKey(r);
    }
    // Uploads + bucket assignments preserved.
    assert(document.querySelectorAll(".bucket.filled").length === 2, "preset " + presetId + ": both buckets must stay filled");
    assert(document.querySelector('[data-file-bucket="host"]'), "preset " + presetId + ": host control preserved");
    // Social-derived names preserved.
    assert(tagText("host") === "hostperson", "preset " + presetId + ": host derived name must persist, got " + tagText("host"));
    assert(tagText("guest1") === "guestperson", "preset " + presetId + ": guest1 derived name must persist, got " + tagText("guest1"));
    // Link inputs still hold their values.
    assert(document.querySelector('[data-link-bucket="host"]').value === HOST_URL, "preset " + presetId + ": host link must persist");
    assert(document.querySelector('[data-link-bucket="guest1"]').value === GUEST_URL, "preset " + presetId + ": guest1 link must persist");
    return geom;
  }

  const layouts = {
    split: await applyPreset("split"),
    stack: await applyPreset("stack"),
    spotlight: await applyPreset("spotlight"),
  };

  // The composed preview must visibly change layout: each speaker's on-screen
  // rect must be DISTINCT across all three presets (not just a label/data swap).
  for (const speaker of ["host", "guest1"]) {
    const keys = [layouts.split[speaker], layouts.stack[speaker], layouts.spotlight[speaker]];
    const distinct = new Set(keys).size;
    assert(distinct === 3, speaker + " composed geometry must differ for split/stack/spotlight, got " + JSON.stringify(keys));
  }

  // Switching back to the first preset must restore its geometry (a real
  // re-layout of the same elements, not a one-way transition).
  const splitAgain = await applyPreset("split");
  assert(splitAgain.host === layouts.split.host && splitAgain.guest1 === layouts.split.guest1, "switching back to split must restore its layout");

  return {
    readiness: document.querySelector("#readiness").textContent,
    filledBuckets: [...document.querySelectorAll(".bucket.filled")].map((bucket) => bucket.dataset.bucket),
    derivedNames: { host: tagText("host"), guest1: tagText("guest1") },
    beforeSwitch,
    layouts,
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
      timeout: 15000,
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
