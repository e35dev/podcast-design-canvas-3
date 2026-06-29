import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = resolve(root, "tmp", `rendered-workflow-${process.pid}`);
const chromePath = findChromePath();

async function main() {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const port = await getFreePort();
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--no-first-run",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolve(tmpDir, "profile")}`,
    "about:blank"
  ], { stdio: "ignore" });

  let page;
  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`, 10000);
    const target = await createTarget(port, "about:blank");
    page = new CdpPage(target.webSocketDebuggerUrl || version.webSocketDebuggerUrl);
    await page.ready;
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");

    const runtimeErrors = [];
    page.on("Runtime.exceptionThrown", (event) => {
      runtimeErrors.push(event.exceptionDetails?.text || "Runtime exception");
    });
    page.on("Log.entryAdded", (event) => {
      if (event.entry?.level === "error") {
        runtimeErrors.push(event.entry.text);
      }
    });

    const fixtures = await getMediaFixtures(page);
    await navigate(page, pathToFileURL(resolve(root, "index.html")).href);
    await waitFor(() => page.evaluate("document.readyState === 'complete'"), 8000, "file page did not finish loading");
    if (runtimeErrors.length) {
      throw new Error(`Startup runtime errors: ${runtimeErrors.join("; ")}`);
    }

    await assertInitialControls(page);
    await setFileInput(page, "#file-host", fixtures.host);
    await setFileInput(page, "#file-guest1", fixtures.guest);
    await typeValue(page, "#social-host", "https://x.com/show-host");
    await typeValue(page, "#social-guest1", "https://linkedin.com/in/show-guest");
    await page.evaluate("document.querySelector('input[value=\"spotlight-cycle\"]').click()");

    await page.evaluate("document.querySelector('#compose-preview').click()");
    await waitFor(() => page.evaluate("document.querySelector('#status').textContent.includes('Preview ready')"), 10000, "preview did not become ready");
    const previewProof = await page.evaluate(`(() => {
    const cards = document.querySelectorAll('.native-card video').length;
    const exportEnabled = !document.querySelector('#export-episode').disabled;
    const canvas = document.querySelector('#preview-canvas');
    const ctx = canvas.getContext('2d');
    const sample = ctx.getImageData(120, 120, 16, 16).data;
    let litPixels = 0;
    for (let index = 0; index < sample.length; index += 4) {
      if (sample[index] + sample[index + 1] + sample[index + 2] > 40) {
        litPixels += 1;
      }
    }
    return { cards, exportEnabled, litPixels };
  })()`);
  if (previewProof.cards < 2 || !previewProof.exportEnabled || previewProof.litPixels < 1) {
    throw new Error(`Preview proof failed: ${JSON.stringify(previewProof)}`);
  }
  const mediaDurations = await page.evaluate(`Array.from(document.querySelectorAll('.native-card video')).map((video) => ({
    bucket: video.dataset.bucket,
    duration: video.duration,
    readyState: video.readyState
  }))`);
  console.log(`Preview media durations: ${JSON.stringify(mediaDurations)}`);

  await page.evaluate("document.querySelector('#play-preview').click()");
  await waitFor(() => page.evaluate("document.querySelector('#status').textContent.includes('Preview playing')"), 5000, "preview playback did not start");
  await page.evaluate("document.querySelector('#pause-preview').click()");

  await page.evaluate("document.querySelector('#export-episode').click()");
  await waitFor(
    () => page.evaluate("document.querySelector('#status').textContent.includes('Export ready')"),
    180000,
    async () => `export did not become ready; status=${await page.evaluate("document.querySelector('#status').textContent")}`
  );
  const exportProof = await page.evaluate(`(async () => {
    const link = document.querySelector('#download-export');
    const response = await fetch(link.href);
    const blob = await response.blob();
    const playbackUrl = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.src = playbackUrl;
    document.body.appendChild(video);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('export playback metadata timed out')), 5000);
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      video.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('exported video could not load'));
      }, { once: true });
      video.load();
    });
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stream = video.captureStream ? video.captureStream() : null;
    video.pause();
    return {
      hidden: link.hidden,
      download: link.download,
      size: blob.size,
      type: blob.type,
      duration: video.duration,
      currentTime: video.currentTime,
      audioTracks: stream ? stream.getAudioTracks().length : 0,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight
    };
  })()`);
  if (exportProof.hidden || exportProof.size < 1000 || !exportProof.videoWidth || exportProof.currentTime < 0.1 || exportProof.audioTracks < 1) {
    throw new Error(`Export proof failed: ${JSON.stringify(exportProof)}`);
  }

    console.log(`Rendered workflow passed with export ${exportProof.size} bytes, ${exportProof.videoWidth}x${exportProof.videoHeight}.`);
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    chrome.kill();
  }
}

async function getMediaFixtures(activePage) {
  if (process.env.PDC_HOST_VIDEO && process.env.PDC_GUEST_VIDEO) {
    return {
      host: resolve(process.env.PDC_HOST_VIDEO),
      guest: resolve(process.env.PDC_GUEST_VIDEO)
    };
  }
  return createMediaFixtures(activePage);
}

async function createMediaFixtures(activePage) {
  await navigate(activePage, "about:blank");
  const host = await recordFixture(activePage, "#72ddb6", 440);
  const guest = await recordFixture(activePage, "#f6c85f", 660);
  const hostPath = resolve(tmpDir, "host.webm");
  const guestPath = resolve(tmpDir, "guest.webm");
  writeFileSync(hostPath, Buffer.from(host, "base64"));
  writeFileSync(guestPath, Buffer.from(guest, "base64"));
  return { host: hostPath, guest: guestPath };
}

async function recordFixture(activePage, color, frequency) {
  return activePage.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      ctx.fillStyle = '${color}';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#071013';
      ctx.fillRect(50 + (frame % 90), 80, 210, 120);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 42px Arial';
      ctx.fillText('Speaker ${frequency}', 70, 155);
      frame += 1;
    };
    const interval = setInterval(draw, 33);
    draw();

    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = ${frequency};
    gain.gain.value = 0.08;
    oscillator.connect(gain);
    const destination = audio.createMediaStreamDestination();
    gain.connect(destination);
    oscillator.start();

    const stream = canvas.captureStream(30);
    destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: type });
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) {
        chunks.push(event.data);
      }
    });
    const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
    recorder.start(100);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    recorder.stop();
    await stopped;
    clearInterval(interval);
    oscillator.stop();
    await audio.close();
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type });
    const buffer = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  })()`);
}

async function assertInitialControls(activePage) {
  const controls = await activePage.evaluate(`(() => ({
    hostFile: Boolean(document.querySelector('#file-host')),
    guestFile: Boolean(document.querySelector('#file-guest1')),
    guest2File: Boolean(document.querySelector('#file-guest2')),
    hostSocial: Boolean(document.querySelector('#social-host')),
    guestSocial: Boolean(document.querySelector('#social-guest1')),
    preset: Boolean(document.querySelector('input[value="conversation-grid"]')),
    preview: !document.querySelector('#compose-preview').disabled,
    exportExists: Boolean(document.querySelector('#export-episode'))
  }))()`);
  if (!Object.values(controls).every(Boolean)) {
    throw new Error(`Initial controls missing: ${JSON.stringify(controls)}`);
  }
}

async function setFileInput(activePage, selector, filePath) {
  const rootNode = await activePage.send("DOM.getDocument", {});
  const node = await activePage.send("DOM.querySelector", {
    nodeId: rootNode.root.nodeId,
    selector
  });
  if (!node.nodeId) {
    throw new Error(`Missing file input ${selector}`);
  }
  await activePage.send("DOM.setFileInputFiles", {
    nodeId: node.nodeId,
    files: [filePath]
  });
  await activePage.evaluate(`(() => {
    const input = document.querySelector('${selector}');
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

async function typeValue(activePage, selector, value) {
  await activePage.evaluate(`(() => {
    const input = document.querySelector('${selector}');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function navigate(activePage, url) {
  const loaded = activePage.waitForEvent("Page.loadEventFired", 10000);
  await activePage.send("Page.navigate", { url });
  await loaded;
}

async function createTarget(portNumber, url) {
  const response = await fetch(`http://127.0.0.1:${portNumber}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Could not create Chrome target: ${response.status}`);
  }
  return response.json();
}

async function waitForJson(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {
      await delay(100);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitFor(fn, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await delay(100);
  }
  throw new Error(typeof message === "function" ? await message() : message);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChromePath() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) {
    return found;
  }
  return process.platform === "win32" ? "chrome.exe" : "google-chrome";
}

class CdpPage {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result || {});
        }
        return;
      }
      if (message.method && this.listeners.has(message.method)) {
        for (const listener of this.listeners.get(message.method)) {
          listener(message.params || {});
        }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Evaluation failed");
    }
    return result.result.value;
  }

  on(method, listener) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, []);
    }
    this.listeners.get(method).push(listener);
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      this.on(method, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  }

  close() {
    this.socket.close();
    return Promise.resolve();
  }
}

await main();
