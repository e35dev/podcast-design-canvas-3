// scripts/verify-timed-moments.mjs
// Verifies active step #118 end-to-end in a real browser workflow:
// upload 2 videos, add timed title/callout moments via shipped UI controls,
// confirm moments appear only in scheduled preview ranges across preset switches,
// then export and confirm overlays are burned into exported frames in-range only.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run timed-moments verification.");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); child.off("exit", onExit); resolve(ok); };
    const onExit = () => finish(true);
    const t = setTimeout(() => finish(false), timeoutMs);
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
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (i === 7) return; await sleep(100 * (i + 1)); }
  }
}
async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
    await sleep(250);
  }
  throw last;
}
function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(20);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = freq;
    const gain = ac.createGain();
    gain.gain.value = 0.05;
    const d = ac.createMediaStreamDestination();
    osc.connect(gain); gain.connect(d); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 170; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "#ffffff";
      ctx.font = "24px sans-serif";
      ctx.fillText(name + " " + i, 18, 98);
      await sleep(50);
    }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name + ".webm", { type: "video/webm" });
  }

  const uploadTo = (input, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const typeInto = (input, v) => {
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const click = (sel) => {
    const el = document.querySelector(sel);
    assert(el, "missing element: " + sel);
    el.click();
  };

  await waitFor(() => document.querySelector('[data-file-bucket="host"]') && document.querySelector("#moment-save"), "new timed-moment UI should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host", "#c53030", 440));
  await sleep(120);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest", "#2f855a", 660));
  await sleep(1200);
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");
  click('[data-preset="split"]');

  // Add title 0-3
  document.querySelector("#moment-type").value = "title";
  typeInto(document.querySelector("#moment-text"), "Episode Title Moment");
  document.querySelector("#moment-start").value = "0";
  document.querySelector("#moment-end").value = "3";
  click("#moment-save");

  // Add callout 4-7
  document.querySelector("#moment-type").value = "callout";
  typeInto(document.querySelector("#moment-text"), "Reference callout");
  document.querySelector("#moment-start").value = "4";
  document.querySelector("#moment-end").value = "7";
  click("#moment-save");

  await waitFor(() => document.querySelectorAll(".moment-item").length >= 2, "two timed moments should be listed");

  const scrub = document.querySelector("#preview-scrub");
  function duration() {
    const vids = [...document.querySelectorAll("video[data-speaker]")];
    const d = vids.map((v) => v.duration).filter((x) => Number.isFinite(x) && x > 0);
    return d.length ? Math.max(...d) : 0;
  }
  async function waitForPreviewDuration() {
    for (let i = 0; i < 200; i++) {
      const d = duration();
      if (d > 0) return d;
      const vids = [...document.querySelectorAll("video[data-speaker]")];
      for (const v of vids) {
        if (v.readyState < 1) {
          // Nudge metadata loading in headless runs where it can lag.
          try { v.load(); } catch {}
        }
      }
      await sleep(60);
    }
    throw new Error("preview duration should be available");
  }
  async function scrubTo(sec) {
    const d = await waitForPreviewDuration();
    scrub.value = String(Math.max(0, Math.min(1000, Math.round((sec / d) * 1000))));
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
    return (document.querySelector("#stage-canvas").dataset.momentText || "");
  }

  const t1 = await scrubTo(1.0);
  const t5 = await scrubTo(5.0);
  const t8 = await scrubTo(8.0);
  assert(/Episode Title Moment/.test(t1), "title should appear in 0-3 range");
  assert(!/Reference callout/.test(t1), "callout should not appear at 1s");
  assert(/Reference callout/.test(t5), "callout should appear in 4-7 range");
  assert(!/Episode Title Moment/.test(t5), "title should not appear at 5s");
  assert(!/Episode Title Moment|Reference callout/.test(t8), "no moment should appear outside ranges");

  click('[data-preset="stack"]');
  await sleep(200);
  assert(/Reference callout/.test(await scrubTo(5)), "callout should persist on stack preset");
  click('[data-preset="spotlight"]');
  await sleep(200);
  assert(/Episode Title Moment/.test(await scrubTo(1)), "title should persist on spotlight preset");

  click("#export");
  await waitFor(() => document.querySelector("#export-download"), "export should produce result", 800);
  const href = document.querySelector("#export-download").getAttribute("href");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported video should have meaningful bytes");

  const exp = document.createElement("video");
  exp.muted = true;
  exp.src = URL.createObjectURL(blob);
  await new Promise((r) => { exp.onloadedmetadata = r; exp.onerror = r; setTimeout(r, 5000); });
  assert(exp.videoWidth > 0 && exp.videoHeight > 0, "export should be playable");

  const probe = document.createElement("canvas");
  probe.width = exp.videoWidth || 1280;
  probe.height = exp.videoHeight || 720;
  const pctx = probe.getContext("2d");
  function regionLuma(x, y, w, h) {
    const data = pctx.getImageData(x, y, w, h).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722);
    return sum / Math.max(1, data.length / 4);
  }
  async function frameSignals(timeSec) {
    exp.currentTime = Math.max(0, timeSec);
    await new Promise((r) => {
      const done = () => { exp.removeEventListener("seeked", done); r(); };
      exp.addEventListener("seeked", done, { once: true });
      setTimeout(done, 800);
    });
    pctx.drawImage(exp, 0, 0, probe.width, probe.height);
    const top = regionLuma(Math.floor(probe.width * 0.2), Math.floor(probe.height * 0.03), Math.floor(probe.width * 0.6), Math.floor(probe.height * 0.1));
    const bottom = regionLuma(Math.floor(probe.width * 0.2), Math.floor(probe.height * 0.8), Math.floor(probe.width * 0.6), Math.floor(probe.height * 0.1));
    return { top, bottom };
  }

  const s1 = await frameSignals(1);   // title on
  const s5 = await frameSignals(5);   // callout on
  const s8 = await frameSignals(8);   // none

  assert((s8.top - s1.top) > 8, "title overlay should darken top region in exported frame");
  assert((s8.bottom - s5.bottom) > 8, "callout overlay should darken bottom region in exported frame");
  assert(Math.abs(s8.top - s8.bottom) < 80, "outside timed ranges should not include strong overlay panels");

  return {
    previewChecks: { t1, t5, t8 },
    exportSignals: { at1: s1, at5: s5, at8: s8 },
    exportBytes: blob.size,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-timed-moments-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, entryUrl,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-timed-moments: OK — timed moments render in preview/export across presets");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-timed-moments: ${e.message}`); process.exit(1); });
