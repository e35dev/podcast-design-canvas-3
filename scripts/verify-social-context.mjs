// scripts/verify-social-context.mjs
// Drives the shipped app in headless Chrome and proves issue #63: upload speaker
// videos, enter distinct social links for Host/Guest 1/Guest 2 through the real
// setup inputs, confirm derived names appear in the live composed preview (canvas
// labels + setup hints), survive preset switching, clear/replace per speaker
// only, and keep export available.
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
      ctx.fillStyle = "#fff"; ctx.font = "26px sans-serif"; ctx.fillText(name, 20, 100);
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
  function setLink(bucket, value, eventName) {
    const input = document.querySelector('[data-link-bucket="' + bucket + '"]');
    input.value = value;
    input.dispatchEvent(new Event(eventName || "input", { bubbles: true }));
  }
  const bucketName = (bucket) => {
    const el = document.querySelector('.bucket[data-bucket="' + bucket + '"] .bucket-name');
    return el ? el.textContent : null;
  };
  const derivedHint = (bucket) => {
    const el = document.querySelector('[data-derived="' + bucket + '"]');
    return el ? el.textContent : "";
  };
  const canvasLabels = () => {
    const raw = document.getElementById("stage-canvas").dataset.speakerLabels || "{}";
    return JSON.parse(raw);
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
  function assertPreviewLabels(expected, label) {
    const labels = canvasLabels();
    for (const bucket of Object.keys(expected)) {
      assert(labels[bucket] === expected[bucket], label + ": canvas label for " + bucket + " should be " + expected[bucket] + ", got " + labels[bucket]);
    }
  }
  function assertSetupNames(expected, label) {
    for (const bucket of Object.keys(expected)) {
      assert(bucketName(bucket) === expected[bucket], label + ": setup name for " + bucket + " should be " + expected[bucket] + ", got " + bucketName(bucket));
      if (expected[bucket] !== window.PDC.presets.BUCKET_LABELS[bucket]) {
        assert(derivedHint(bucket).includes(expected[bucket]), label + ": derived hint for " + bucket + " should mention " + expected[bucket]);
      }
    }
  }
  function assertSocialState(expected, label) {
    assertSetupNames(expected, label);
    assertPreviewLabels(expected, label);
    assert(document.querySelectorAll("video[data-speaker]").length >= 2, label + ": uploaded videos should remain");
    assert(canvasLitPct() >= 5, label + ": preview canvas should stay visible");
    const exportBtn = document.querySelector("#export");
    assert(exportBtn && !exportBtn.disabled, label + ": export should remain available");
  }

  const waitFor = async (fn, label) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };
  await waitFor(() => window.PDC && window.PDC.episode && window.PDC.episode.speakerLabels, "PDC.episode social API should load");
  await waitFor(() => document.querySelector("#stage-canvas"), "composed preview canvas should exist");
  await waitFor(() => document.querySelector('[data-file-bucket="host"]'), "Host upload control should exist");
  assert(document.querySelector('[data-link-bucket="host"]'), "Host social link input should exist");
  assert(document.querySelector('[data-link-bucket="guest1"]'), "Guest 1 social link input should exist");
  assert(document.querySelector('[data-link-bucket="guest2"]'), "Guest 2 social link input should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest2"]'), await makeVideo("guest2.webm", "#2563eb"));
  await sleep(1200);
  assert(document.querySelectorAll("video[data-speaker]").length === 3, "three uploaded speaker videos should compose the preview");

  const LINKS = {
    host: "https://x.com/hostperson",
    guest1: "https://x.com/guestperson",
    guest2: "https://www.youtube.com/@guesttwo",
  };
  const NAMES = { host: "hostperson", guest1: "guestperson", guest2: "guesttwo" };

  setLink("host", LINKS.host, "input");
  setLink("guest1", LINKS.guest1, "change");
  setLink("guest2", LINKS.guest2, "input");
  await sleep(400);

  const playButton = document.querySelector("#play");
  if (!playButton.textContent.includes("Pause")) playButton.click();
  await sleep(700);

  assertSocialState(NAMES, "after entering social links");

  for (const presetId of ["stack", "spotlight", "split"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await sleep(500);
    assert(document.querySelector("#stage-canvas").dataset.preset === presetId, "preset should switch to " + presetId);
    assertSocialState(NAMES, presetId + " preset preserves derived names");
  }

  setLink("guest1", "", "change");
  await sleep(300);
  assert(bucketName("guest1") === "Guest 1", "clearing guest1 link should revert only guest1 setup label");
  assert(bucketName("host") === "hostperson", "clearing guest1 link must not change host setup label");
  assert(canvasLabels().guest1 === "Guest 1", "clearing guest1 link should revert only guest1 canvas label");
  assert(canvasLabels().host === "hostperson", "clearing guest1 link must not change host canvas label");

  setLink("guest1", LINKS.guest1, "input");
  await sleep(250);
  assertSocialState(NAMES, "after restoring guest1 link");

  setLink("guest2", "https://instagram.com/replacementguest", "change");
  await sleep(300);
  assert(bucketName("guest2") === "replacementguest", "replacing guest2 link should update only guest2 setup label");
  assert(canvasLabels().guest2 === "replacementguest", "replacing guest2 link should update only guest2 canvas label");
  assert(canvasLabels().host === "hostperson", "replacing guest2 link must not change host canvas label");
  assert(canvasLabels().guest1 === "guestperson", "replacing guest2 link must not change guest1 canvas label");

  return {
    setup: { host: bucketName("host"), guest1: bucketName("guest1"), guest2: bucketName("guest2") },
    canvas: canvasLabels(),
    links: {
      host: document.querySelector('[data-link-bucket="host"]').value,
      guest1: document.querySelector('[data-link-bucket="guest1"]').value,
      guest2: document.querySelector('[data-link-bucket="guest2"]').value,
    },
    presetAfter: document.querySelector("#stage-canvas").dataset.preset,
    exportEnabled: !document.querySelector("#export").disabled,
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
      timeout: 45000,
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
