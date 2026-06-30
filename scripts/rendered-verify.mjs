/*
 * Rendered verification -- the gate that matters for this repo.
 *
 * Drives the REAL running app from file:// in headless Chrome and proves the
 * #32 acceptance path two ways, because real media must reach the composed
 * preview through a normal product action:
 *
 *   A. Record path  -> click "Record" on two speakers (getUserMedia), pick a
 *      preset, Play, assert the composed canvas shows real (non-blank) pixels,
 *      and that the pixels survive switching presets.
 *   B. Upload path  -> generate two real local WebM files, attach them through
 *      the visible file inputs, Play, assert the canvas shows real pixels.
 *
 * Launched with --use-fake-device-for-media-stream so getUserMedia returns a
 * real (synthetic-source) MediaStream -- real frames, not seeded/mock media.
 *
 * Uses only Node built-ins + Chrome DevTools Protocol. SKIPS (exit 0) if Chrome
 * is absent -- this is a proof tool, never a hard CI gate.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const p = execSync("command -v " + c, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (p) return p;
    } catch {
      /* not found */
    }
  }
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/snap/bin/chromium"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.log("rendered-verify: SKIP -- no Chrome/Chromium found (set CHROME_PATH to enable).");
  process.exit(0);
}

const fileUrl = "file://" + resolve("index.html");
const profile = mkdtempSync(join(tmpdir(), "pdc-verify-profile-"));
const mediaDir = mkdtempSync(join(tmpdir(), "pdc-verify-media-"));

const proc = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

let cleanedUp = false;
function cleanup(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  for (const d of [profile, mediaDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}
function fail(msg) {
  console.error("rendered-verify: FAIL -- " + msg);
  cleanup(1);
}

const overall = setTimeout(() => fail("timed out after 75s"), 75000);

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
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
  return {
    ready,
    send: (method, params) =>
      new Promise((res, rej) => {
        const myId = ++id;
        pending.set(myId, { res, rej });
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
      }),
  };
}

async function openPage(port, url) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/new?" + encodeURIComponent(url), {
    method: "PUT",
  });
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
  if (res.exceptionDetails) throw new Error("page exception: " + JSON.stringify(res.exceptionDetails));
  return res.result && res.result.value;
}

const NONBLANK = `(() => {
  const c = document.getElementById('stage-canvas');
  const ctx = c.getContext('2d');
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 14 || data[i+1] > 14 || data[i+2] > 14) lit++;
  }
  return Math.round((lit / (data.length / 4)) * 100);
})()`;

async function makeFixtures(port) {
  const cdp = await openPage(port, fileUrl); // file:// = secure context for canvas capture
  const b64 = await evalPage(
    cdp,
    `(async () => {
      async function clip(label, color) {
        const c = document.createElement('canvas'); c.width = 320; c.height = 180;
        const x = c.getContext('2d');
        const stream = c.captureStream(30);
        const rec = new MediaRecorder(stream, { mimeType:
          MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm' });
        const chunks = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        const stopped = new Promise(r => rec.onstop = r);
        rec.start(100);
        const t0 = performance.now();
        (function f(now){ const e = now - t0;
          x.fillStyle = color; x.fillRect(0,0,320,180);
          x.fillStyle = '#fff'; x.font = 'bold 30px system-ui'; x.fillText(label, 24, 70);
          x.fillStyle = e % 400 < 200 ? '#111' : '#fb0'; x.fillRect(250, 24, 40, 120);
          if (e < 1600) requestAnimationFrame(f); else rec.stop();
        })(performance.now());
        await stopped;
        const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let s = ''; for (let i=0;i<buf.length;i+=0x8000) s += String.fromCharCode(...buf.subarray(i,i+0x8000));
        return btoa(s);
      }
      return { host: await clip('HOST', '#2563eb'), guest: await clip('GUEST', '#16a34a') };
    })()`,
    45000
  );
  const hostPath = join(mediaDir, "host.webm");
  const guestPath = join(mediaDir, "guest.webm");
  writeFileSync(hostPath, Buffer.from(b64.host, "base64"));
  writeFileSync(guestPath, Buffer.from(b64.guest, "base64"));
  return { hostPath, guestPath };
}

async function recordPath(port) {
  const cdp = await openPage(port, fileUrl);
  await new Promise((r) => setTimeout(r, 800));
  const steps = await evalPage(
    cdp,
    `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const click = sel => document.querySelector(sel).click();
      click('.speaker-card[data-slot="host"] [data-role="record"]');
      click('.speaker-card[data-slot="guest1"] [data-role="record"]');
      await sleep(1500);
      document.querySelector('.preset-card[data-preset="spotlight"] input').click();
      const play = document.getElementById('btn-play');
      const started = Date.now();
      while (play.disabled && Date.now() - started < 5000) await sleep(100);
      if (play.disabled) return { error: 'Play never enabled after recording two speakers' };
      play.click();
      await sleep(1500);
      return { ok: true };
    })()`,
    20000
  );
  if (steps && steps.error) fail("record path: " + steps.error);
  const litSpotlight = await evalPage(cdp, NONBLANK);
  // Persistence: switch preset, media must remain on the canvas.
  await evalPage(cdp, `document.querySelector('.preset-card[data-preset="split"] input').click(); true`);
  await new Promise((r) => setTimeout(r, 700));
  const litSplit = await evalPage(cdp, NONBLANK);
  return { litSpotlight, litSplit };
}

async function uploadPath(port, hostPath, guestPath) {
  const cdp = await openPage(port, fileUrl);
  await new Promise((r) => setTimeout(r, 600));
  const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const found = await cdp.send("DOM.querySelectorAll", {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!found.nodeIds || found.nodeIds.length < 2) fail("upload path: expected >=2 file inputs");
  await cdp.send("DOM.setFileInputFiles", { nodeId: found.nodeIds[0], files: [hostPath] });
  await cdp.send("DOM.setFileInputFiles", { nodeId: found.nodeIds[1], files: [guestPath] });
  const out = await evalPage(
    cdp,
    `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const fi = document.querySelectorAll('input[type="file"]');
      fi[0].dispatchEvent(new Event('change', { bubbles: true }));
      fi[1].dispatchEvent(new Event('change', { bubbles: true }));
      const play = document.getElementById('btn-play');
      const started = Date.now();
      while (play.disabled && Date.now() - started < 5000) await sleep(100);
      if (play.disabled) return { error: 'Play never enabled after uploading two videos' };
      play.click();
      await sleep(1500);
      return { ok: true };
    })()`,
    20000
  );
  if (out && out.error) fail("upload path: " + out.error);
  return await evalPage(cdp, NONBLANK);
}

async function run(port) {
  const rec = await recordPath(port);
  const { hostPath, guestPath } = await makeFixtures(port);
  const litUpload = await uploadPath(port, hostPath, guestPath);

  clearTimeout(overall);
  console.log("rendered-verify: record path  -> spotlight non-blank " + rec.litSpotlight + "%, after preset switch " + rec.litSplit + "%");
  console.log("rendered-verify: upload path  -> non-blank " + litUpload + "%");

  if (rec.litSpotlight < 5) fail("record path: composed canvas blank (no real pixels)");
  if (rec.litSplit < 5) fail("record path: media did not survive a preset switch");
  if (litUpload < 5) fail("upload path: composed canvas blank (no real pixels)");
  console.log("rendered-verify: PASS -- real recorded AND uploaded media compose and play in the preview");
  cleanup(0);
}
