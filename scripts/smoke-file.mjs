import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const chromeBin = process.env.CHROME_BIN || "google-chrome";
const port = Number(process.env.PDC_SMOKE_PORT || 9234);
const profile = await mkdtemp(join(tmpdir(), "pdc-file-smoke-"));
const pageUrl = `file://${join(root, "index.html")}`;
const chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    pageUrl
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

try {
  const result = await runSmoke(port);
  if (!result.scriptLoaded || result.readyCount < 2 || result.blobSize < 10_000) {
    throw new Error(`File smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  chrome.kill("SIGTERM");
  await new Promise((resolve) => chrome.once("exit", resolve));
  await rm(profile, { recursive: true, force: true });
}

async function runSmoke(debugPort) {
  const page = await waitForPage(debugPort);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(JSON.stringify(message.error)));
    } else {
      resolve(message.result);
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) => {
    const messageId = ++id;
    ws.send(JSON.stringify({ id: messageId, method, params }));
    return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
  };

  await send("Runtime.enable");
  const evaluation = await send("Runtime.evaluate", {
    expression: smokeExpression(),
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000
  });

  ws.close();

  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
  }

  return evaluation.result.value;
}

async function waitForPage(debugPort) {
  const started = Date.now();

  while (Date.now() - started < 10000) {
    try {
      const pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
      const page = pages.find((target) => target.type === "page");
      if (page) {
        return page;
      }
    } catch {
      // Chrome may not have opened the debugging endpoint yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for Chrome debugging target.");
}

function smokeExpression() {
  return `
(async () => {
  const waitFor = async (predicate, timeout = 10000) => {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for workflow condition");
  };

  await waitFor(() => document.querySelectorAll("[data-action='file']").length === 3);

  async function makeClip(name, color, frequency) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const videoStream = canvas.captureStream(24);
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.025;
    oscillator.connect(gain).connect(destination);
    const stream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    oscillator.start();
    recorder.start();
    const started = performance.now();
    while (performance.now() - started < 1500) {
      const t = (performance.now() - started) / 1000;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 42px sans-serif";
      ctx.fillText(name, 28, 96);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect(0, 130, Math.min(320, t * 210), 18);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    recorder.stop();
    oscillator.stop();
    stream.getTracks().forEach((track) => track.stop());
    await stopped;
    await audioContext.close();
    return new File([new Blob(chunks, { type: recorder.mimeType || "video/webm" })], name + ".webm", { type: "video/webm" });
  }

  const files = [await makeClip("Host", "#1f8a70", 330), await makeClip("Guest", "#8a3ffc", 440)];
  const inputs = Array.from(document.querySelectorAll("[data-action='file']"));
  for (let index = 0; index < files.length; index += 1) {
    const transfer = new DataTransfer();
    transfer.items.add(files[index]);
    inputs[index].files = transfer.files;
    inputs[index].dispatchEvent(new Event("change", { bubbles: true }));
  }

  await waitFor(() => document.querySelectorAll(".ready-pill").length >= 2);
  const socials = Array.from(document.querySelectorAll("[data-action='social']"));
  socials[0].value = "https://example.com/host";
  socials[0].dispatchEvent(new Event("input", { bubbles: true }));
  socials[1].value = "https://example.com/guest";
  socials[1].dispatchEvent(new Event("input", { bubbles: true }));

  document.querySelector("[data-preset='socialStudio']").click();
  document.querySelector("[data-action='preview']").click();
  await waitFor(() => document.querySelector(".status-row strong")?.textContent.includes("Previewing"));
  document.querySelector("[data-action='export']").click();
  const link = await waitFor(() => document.querySelector(".download-link"), 20000);
  const blob = await fetch(link.href).then((response) => response.blob());

  return {
    pageUrl: location.href,
    scriptLoaded: Boolean(document.querySelector("[data-action='export']")),
    readyCount: document.querySelectorAll(".ready-pill").length,
    selectedPreset: document.querySelector(".preset-card.selected strong")?.textContent,
    status: document.querySelector(".status-row strong")?.textContent,
    downloadName: link.getAttribute("download"),
    blobType: blob.type,
    blobSize: blob.size
  };
})()
`;
}
