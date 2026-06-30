// scripts/verify-social-context.mjs
// Drives the shipped app in headless Chrome and proves issue #41's full workflow:
// upload Host + Guest videos, enter distinct social links, confirm derived names
// in the preview, cycle Split → Stack → Spotlight with nonblank video, and keep
// uploads + social context intact throughout.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run social-context verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(ok);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
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
        console.warn(`verify-social-context: could not remove temp profile ${dir}: ${error.message}`);
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
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
    for (let i = 0; i < 24; i++) {
      ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff"; ctx.font = "26px sans-serif"; ctx.fillText("frame " + i, 20, 100);
      await sleep(45);
    }
    await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  function uploadTo(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function typeInto(input, value) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const tagText = (bucket) => {
    const el = document.querySelector('.bucket[data-bucket="' + bucket + '"] .bucket-name');
    return el ? el.textContent : null;
  };
  const ensureNames = () => {
    assert(tagText("host") === "hostperson", "host label should show derived name, got: " + tagText("host"));
    assert(tagText("guest1") === "guestperson", "guest1 label should show derived name, got: " + tagText("guest1"));
    assert(tagText("guest2") === "guest2person", "guest2 label should show derived name, got: " + tagText("guest2"));
    assert(tagText("host") !== tagText("guest1"), "derived names must be distinct per speaker");
    assert(tagText("host") !== tagText("guest2"), "derived names must be distinct per speaker");
    assert(tagText("guest1") !== tagText("guest2"), "derived names must be distinct per speaker");
  };
  function canvasLitPct() {
    const c = document.getElementById("stage-canvas");
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 14 || data[i + 1] > 14 || data[i + 2] > 14) lit++;
    }
    return Math.round((lit / (data.length / 4)) * 100);
  }
  function assertSocialState(label) {
    ensureNames();
    assert(document.querySelector('[data-link-bucket="host"]').value === HOST_URL, label + ": host link must persist");
    assert(document.querySelector('[data-link-bucket="guest1"]').value === GUEST_URL, label + ": guest1 link must persist");
    assert(document.querySelector('[data-link-bucket="guest2"]').value === GUEST2_URL, label + ": guest2 link must persist");
    videos = [...document.querySelectorAll("video[data-speaker]")];
    assert(videos.length === 3, label + ": all uploaded videos should remain");
    assert(videos.every((v) => v.src.startsWith("blob:") && v.videoWidth > 0), label + ": uploaded media should stay decoded");
    const lit = canvasLitPct();
    assert(lit >= 5, label + ": composed canvas should show nonblank pixels (" + lit + "%)");
  }

  // Wait for the app's classic scripts to finish wiring the DOM (the page may
  // still be loading when this evaluates), then assert the controls exist.
  const waitFor = async (fn, label) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };
  await waitFor(() => window.PDC && window.PDC.episode && window.PDC.episode.setSocialLink, "PDC.episode social API should load");
  await waitFor(() => document.querySelector("#stage-canvas"), "composed preview canvas should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  assert(document.querySelector('[data-link-bucket="host"]'), "Host social link input should exist");
  assert(document.querySelector('[data-link-bucket="guest1"]'), "Guest 1 social link input should exist");
  assert(document.querySelector('[data-link-bucket="guest2"]'), "Guest 2 social link input should exist");

  // Upload three real speaker videos.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest2"]'), await makeVideo("guest2.webm", "#2563eb"));
  await sleep(1200);
  let videos = [...document.querySelectorAll("video[data-speaker]")];
  assert(videos.length === 3, "three uploaded speaker videos should compose the preview");

  // Enter DISTINCT social links for each speaker through the real inputs.
  const HOST_URL = "https://x.com/hostperson";
  const GUEST_URL = "https://x.com/guestperson";
  const GUEST2_URL = "https://x.com/guest2person";
  typeInto(document.querySelector('[data-link-bucket="host"]'), HOST_URL);
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), GUEST_URL);
  typeInto(document.querySelector('[data-link-bucket="guest2"]'), GUEST2_URL);
  await sleep(300);

  // Links stored per speaker and surfaced as distinct derived names in preview.
  ensureNames();
  assert(document.querySelector('[data-link-bucket="host"]').value === HOST_URL, "host link input should hold its value");
  assert(document.querySelector('[data-link-bucket="guest1"]').value === GUEST_URL, "guest1 link input should hold its value");
  assert(document.querySelector('[data-link-bucket="guest2"]').value === GUEST2_URL, "guest2 link input should hold its value");
  assert(/hostperson/.test((document.querySelector('[data-derived="host"]') || {}).textContent || ""), "host derived-name hint should show");
  assert(/guestperson/.test((document.querySelector('[data-derived="guest1"]') || {}).textContent || ""), "guest1 derived-name hint should show");
  assert(/guest2person/.test((document.querySelector('[data-derived="guest2"]') || {}).textContent || ""), "guest2 derived-name hint should show");

  const playButton = document.querySelector("#play");
  if (!playButton.textContent.includes("Pause")) playButton.click();
  await sleep(700);
  assertSocialState("split preset with social links");

  for (const presetId of ["stack", "spotlight", "split"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await sleep(500);
    assert(document.querySelector("#stage-canvas").dataset.preset === presetId, "preset should switch to " + presetId);
    assertSocialState(presetId + " preset with social links");
  }

  // Replacing one link updates only that speaker's derived name.
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/newhostperson");
  await sleep(250);
  assert(tagText("host") === "newhostperson", "host derived label should update when host link is replaced");
  assert(tagText("guest1") === "guestperson", "guest1 derived label should remain unchanged");
  assert(tagText("guest2") === "guest2person", "guest2 derived label should remain unchanged");

  // Clearing one link falls back to bucket label and keeps other names intact.
  typeInto(document.querySelector('[data-link-bucket="guest2"]'), "");
  await sleep(250);
  assert(tagText("guest2") === "Guest 2", "guest2 should fall back after clearing its link");
  assert(tagText("host") === "newhostperson", "host derived label should remain after clearing another speaker");
  assert(tagText("guest1") === "guestperson", "guest1 derived label should remain after clearing another speaker");

  return {
    tags: {
      host: tagText("host"),
      guest1: tagText("guest1"),
      guest2: tagText("guest2"),
    },
    links: {
      host: document.querySelector('[data-link-bucket="host"]').value,
      guest1: document.querySelector('[data-link-bucket="guest1"]').value,
      guest2: document.querySelector('[data-link-bucket="guest2"]').value,
    },
    presetAfter: document.querySelector("#stage-canvas").dataset.preset,
    videoCount: videos.length,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-social-context-"));
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
      timeout: 30000,
    });
    ws.close();

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    console.log("verify-social-context: OK");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((error) => {
  console.error(`verify-social-context: ${error.message}`);
  process.exit(1);
});
