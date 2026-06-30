// scripts/verify-social-context.mjs
// Drives the shipped app in headless Chrome and proves the active #39 workflow:
// upload Host + Guest 1 videos through the real file inputs, enter DISTINCT
// social/profile links for each speaker through the visible link inputs, confirm
// the links are stored per speaker and surface as derived names in the composed
// preview, and confirm both the links and the uploaded media survive a preset
// switch. No fixtures or product-only shortcuts: the WebM files are generated
// in-browser and uploaded as real File objects, and the links are typed into the
// real inputs. Mirrors scripts/verify-rendered-preview.mjs's CDP harness.
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
    const el = document.querySelector('[data-speaker-tag="' + bucket + '"]');
    return el ? el.textContent : null;
  };
  const ensureNames = () => {
    assert(tagText("host") === "hostperson", "host preview tag should show derived name, got: " + tagText("host"));
    assert(tagText("guest1") === "guestperson", "guest1 preview tag should show derived name, got: " + tagText("guest1"));
    assert(tagText("host") !== tagText("guest1"), "derived names must be distinct per speaker");
  };

  // Wait for the app's classic scripts to finish wiring the DOM (the page may
  // still be loading when this evaluates), then assert the controls exist.
  const waitFor = async (fn, label) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };
  await waitFor(() => window.PDC && window.PDC.episode && window.PDC.episode.setSocialLink, "PDC.episode social API should load");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  await waitFor(() => document.querySelector('[data-link-bucket="host"]'), "Host social link input should exist");
  assert(document.querySelector('[data-link-bucket="host"]'), "Host social link input should exist");
  assert(document.querySelector('[data-link-bucket="guest1"]'), "Guest 1 social link input should exist");

  // Upload two real speaker videos.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(1200);
  let videos = [...document.querySelectorAll("#stage video")];
  assert(videos.length === 2, "two uploaded speaker videos should compose the preview");

  // Enter DISTINCT social links for each speaker through the real inputs.
  const HOST_URL = "https://x.com/hostperson";
  const GUEST_URL = "https://x.com/guestperson";
  typeInto(document.querySelector('[data-link-bucket="host"]'), HOST_URL);
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), GUEST_URL);
  await sleep(300);

  // Links stored per speaker and surfaced as distinct derived names in preview.
  ensureNames();
  assert(document.querySelector('[data-link-bucket="host"]').value === HOST_URL, "host link input should hold its value");
  assert(document.querySelector('[data-link-bucket="guest1"]').value === GUEST_URL, "guest1 link input should hold its value");
  assert(/hostperson/.test((document.querySelector('[data-derived="host"]') || {}).textContent || ""), "host derived-name hint should show");

  // Switch preset: links + uploaded media + derived names must both survive.
  ["split", "stack", "spotlight"].forEach((presetId) => {
    document.querySelector('[data-preset="' + presetId + '"]').click();
  });
  await sleep(800);
  videos = [...document.querySelectorAll("#stage video")];
  assert(document.querySelector("#stage").dataset.preset === "spotlight", "preset should end on spotlight");
  assert(videos.length === 2, "both uploaded videos should survive the preset switch");
  assert(videos.every((v) => v.src.startsWith("blob:") && v.videoWidth > 0), "uploaded media should still be decoded after switch");
  assert(videos.every((v) => v.videoWidth === 320), "uploaded media dimensions should remain stable");
  assert(document.querySelector("#stage").dataset.speakers === "2", "composed stage should still track both speakers");
  ensureNames();

  // Final focused check that spotlight is visible with derived names.
  document.querySelector('[data-preset="spotlight"]').click();
  await sleep(300);
  await sleep(120);
  assert(document.querySelector("#stage").dataset.preset === "spotlight", "preset should stay on spotlight");
  ensureNames();
  videos = [...document.querySelectorAll("#stage video")];
  assert(videos.length === 2, "both uploaded videos should survive the preset switch");
  assert(videos.every((v) => v.src.startsWith("blob:") && v.videoWidth > 0), "uploaded media should still be decoded after switch");
  assert(document.querySelector('[data-link-bucket="host"]').value === HOST_URL, "host link must persist across preset switch");

  return {
    tags: { host: tagText("host"), guest1: tagText("guest1") },
    links: {
      host: document.querySelector('[data-link-bucket="host"]').value,
      guest1: document.querySelector('[data-link-bucket="guest1"]').value,
    },
    presetAfter: document.querySelector("#stage").dataset.preset,
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
      timeout: 20000,
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
