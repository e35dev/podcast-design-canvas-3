/*
 * Rendered verification -- the gate that matters for this repo.
 *
 * Drives the real running app from file:// and exercises the normal product
 * workflow: create two temporary local WebM speaker files, attach them through
 * the visible file inputs, add social links, preview a non-blank canvas, export
 * a downloadable WebM, and verify the exported blob can be loaded as video.
 *
 * Uses only Node built-ins plus Chrome's DevTools Protocol. If Chrome is not
 * installed it SKIPS (exit 0), so this remains a proof tool rather than a hard
 * dependency gate.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ];
  for (const c of candidates) {
    try {
      const p = execSync("command -v " + c, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (p) return p;
    } catch {
      /* not found */
    }
  }
  for (const p of [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function skip(msg) {
  console.log("rendered-verify: SKIP -- " + msg);
  process.exit(0);
}

const chrome = findChrome();
if (!chrome) skip("no Chrome/Chromium found (set CHROME_PATH to enable).");

const fileUrl = "file://" + resolve("index.html");
const profile = mkdtempSync(join(tmpdir(), "pdc-verify-profile-"));
const mediaDir = mkdtempSync(join(tmpdir(), "pdc-verify-media-"));

const args = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--remote-debugging-port=0",
  "--user-data-dir=" + profile,
  "about:blank",
];

const proc = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
let cleanedUp = false;

function cleanup(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    rmSync(mediaDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(code);
}

function fail(msg) {
  console.error("rendered-verify: FAIL -- " + msg);
  cleanup(1);
}

const overallTimeout = setTimeout(() => fail("timed out after 70s"), 70000);

let buf = "";
proc.stderr.on("data", (d) => {
  buf += d.toString();
  const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
  if (m && !proc.__started) {
    proc.__started = true;
    run(Number(m[1])).catch((e) => fail(String(e && e.message ? e.message : e)));
  }
});
proc.on("exit", (c) => {
  if (!proc.__started) fail("Chrome exited early (code " + c + ")");
});

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else res(msg.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
  function send(method, params) {
    return new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
  }
  return { ready, send };
}

async function openPage(port, url) {
  const res = await fetch(
    "http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent(url),
    { method: "PUT" }
  );
  const target = await res.json();
  if (!target.webSocketDebuggerUrl) fail("could not open a page target");
  const cdp = cdpClient(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  return cdp;
}

async function evalPage(cdp, expression, timeout) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeout || 30000,
  });
  if (res.exceptionDetails) {
    throw new Error("page exception: " + JSON.stringify(res.exceptionDetails));
  }
  return res.result && res.result.value;
}

async function createFixtureFiles(port) {
  const cdp = await openPage(port, "about:blank");
  const clips = await evalPage(cdp, `(async () => {
    async function makeClip(label, color, tone) {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      await ac.resume();
      const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.frequency.value = tone;
      gain.gain.value = 0.04;
      osc.connect(gain).connect(dest);
      osc.start();
      stream.addTrack(dest.stream.getAudioTracks()[0]);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.start(100);
      const start = performance.now();
      function frame(now) {
        const elapsed = Math.max(0, now - start);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 32px system-ui';
        ctx.fillText(label, 28, 82);
        ctx.font = '18px system-ui';
        ctx.fillText('frame ' + Math.floor(elapsed / 100), 28, 120);
        ctx.fillStyle = elapsed % 400 < 200 ? '#111827' : '#f97316';
        ctx.fillRect(250, 30, 40, 120);
        if (elapsed < 1800) requestAnimationFrame(frame);
        else recorder.stop();
      }
      requestAnimationFrame(frame);
      await stopped;
      osc.stop();
      await ac.close();
      const blob = new Blob(chunks, { type: mime });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    }
    return {
      host: await makeClip('HOST', '#2563eb', 330),
      guest: await makeClip('GUEST', '#16a34a', 440),
    };
  })()`, 45000);

  const hostPath = join(mediaDir, "host-review.webm");
  const guestPath = join(mediaDir, "guest-review.webm");
  writeFileSync(hostPath, Buffer.from(clips.host, "base64"));
  writeFileSync(guestPath, Buffer.from(clips.guest, "base64"));
  return { hostPath, guestPath };
}

async function setInputFile(cdp, index, filePath) {
  const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const found = await cdp.send("DOM.querySelectorAll", {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!found.nodeIds || found.nodeIds.length <= index) {
    fail("expected at least " + (index + 1) + " file input(s)");
  }
  await cdp.send("DOM.setFileInputFiles", {
    nodeId: found.nodeIds[index],
    files: [filePath],
  });
}

async function run(port) {
  const { hostPath, guestPath } = await createFixtureFiles(port);
  const cdp = await openPage(port, fileUrl);
  await new Promise((r) => setTimeout(r, 1200));

  await setInputFile(cdp, 0, hostPath);
  await setInputFile(cdp, 1, guestPath);

  const out = await evalPage(cdp, `(async () => {
    const out = { steps: [] };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(label, fn, timeoutMs) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (fn()) return;
        await sleep(100);
      }
      throw new Error(label);
    }

    const fileInputs = document.querySelectorAll('input[type="file"]');
    fileInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    fileInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    out.steps.push('local files attached');

    document.getElementById('episode-title').value = 'Rendered upload check';
    document.getElementById('episode-title').dispatchEvent(new Event('input', { bubbles: true }));
    const socials = document.querySelectorAll('[data-role="social"]');
    socials[0].value = 'instagram.com/rendered_host';
    socials[0].dispatchEvent(new Event('input', { bubbles: true }));
    socials[1].value = 'x.com/rendered_guest';
    socials[1].dispatchEvent(new Event('input', { bubbles: true }));
    out.steps.push('social context added');

    await waitFor('preview button did not unlock', () => !document.getElementById('btn-preview').disabled, 4000);
    document.getElementById('btn-preview').click();
    out.steps.push('preview clicked');
    await sleep(2200);

    const canvas = document.getElementById('stage-canvas');
    const c = canvas.getContext('2d');
    const data = c.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) lit++;
    }
    out.nonBlankPct = Math.round((lit / (data.length / 4)) * 100);

    document.getElementById('btn-export-2').click();
    out.steps.push('export clicked');
    const download = document.getElementById('download-link');
    await waitFor('download link did not appear', () => !download.hidden && download.href.startsWith('blob:'), 15000);
    const blob = await fetch(download.href).then((r) => r.blob());
    out.exportBytes = blob.size;

    const video = document.createElement('video');
    video.muted = true;
    video.src = download.href;
    video.load();
    await waitFor('exported WebM did not load as video', () => video.readyState >= 1 && video.videoWidth > 0, 5000);
    out.exportWidth = video.videoWidth;
    out.exportHeight = video.videoHeight;
    out.downloadName = download.download;
    out.speakerStates = Array.from(document.querySelectorAll('[data-role="state"]')).map((el) => el.textContent);
    return out;
  })()`, 30000);

  clearTimeout(overallTimeout);
  console.log("rendered-verify: steps -> " + out.steps.join(" | "));
  console.log("rendered-verify: speaker states -> " + out.speakerStates.join(" | "));
  console.log("rendered-verify: canvas non-blank = " + out.nonBlankPct + "%");
  console.log("rendered-verify: export bytes = " + out.exportBytes);
  console.log(
    "rendered-verify: exported video = " +
      out.exportWidth +
      "x" +
      out.exportHeight +
      " (" +
      out.downloadName +
      ")"
  );

  if (out.nonBlankPct < 5) fail("canvas appears blank after file-input preview");
  if (out.exportBytes <= 1000) fail("export produced no real WebM data");
  if (out.exportWidth !== 1280 || out.exportHeight !== 720) {
    fail("exported video is not the expected 1280x720 canvas output");
  }
  console.log(
    "rendered-verify: PASS -- visible local uploads preview and export a playable WebM"
  );
  cleanup(0);
}
