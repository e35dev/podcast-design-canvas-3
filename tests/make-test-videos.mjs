// tests/make-test-videos.mjs — generate tiny REAL .webm test videos on disk.
// Uses headless Chromium: draws an animated colored canvas, records it with
// canvas.captureStream + MediaRecorder (the same technique the app's exporter
// uses), and writes the resulting bytes to disk. Also mixes in a tone via
// WebAudio so the files carry a real audio track. These are genuine media
// files used to drive the upload flow — not fixtures baked into the app.
//
// Run from a dir where playwright-core resolves (../podcast-scoring):
//   LD_LIBRARY_PATH=/home/administrator/.local/playwrightlibs \
//   node /abs/pdc3/tests/make-test-videos.mjs <outDir>
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

const outDir = process.argv[2] || ".";
mkdirSync(outDir, { recursive: true });

const CHROME =
  process.env.PW_CHROME ||
  "/home/administrator/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: [
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
  ],
});
const page = await browser.newPage();
page.on("console", (m) => console.log("[video-gen]", m.text()));

async function record(color, freq, label) {
  const b64 = await page.evaluate(
    async ([color, freq, label]) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      let t = 0;
      function draw() {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 28px sans-serif";
        ctx.fillText(label, 20, 120);
        const x = 20 + ((t * 4) % 260);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath();
        ctx.arc(x, 180, 16, 0, Math.PI * 2);
        ctx.fill();
        t++;
      }
      const stream = canvas.captureStream(30);

      // Real audio track via WebAudio oscillator.
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.05;
      osc.frequency.value = freq;
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      for (const at of dest.stream.getAudioTracks()) stream.addTrack(at);

      const mime = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      );
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      let raf;
      const loop = () => {
        draw();
        raf = requestAnimationFrame(loop);
      };
      loop();
      rec.start(100);
      await new Promise((r) => setTimeout(r, 700));
      const done = new Promise((r) => (rec.onstop = r));
      rec.stop();
      await done;
      cancelAnimationFrame(raf);
      osc.stop();
      ac.close();
      const blob = new Blob(chunks, { type: mime });
      const buf = await blob.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    },
    [color, freq, label],
  );
  return Buffer.from(b64, "base64");
}

await page.goto("about:blank");

const specs = [
  { file: "speaker-host.webm", color: "#234e9c", freq: 220, label: "HOST" },
  { file: "speaker-guest1.webm", color: "#9c2348", freq: 330, label: "GUEST 1" },
  { file: "speaker-guest2.webm", color: "#1f7a4d", freq: 440, label: "GUEST 2" },
];

const written = [];
for (const s of specs) {
  const buf = await record(s.color, s.freq, s.label);
  const dest = path.join(outDir, s.file);
  writeFileSync(dest, buf);
  written.push({ file: dest, bytes: buf.length });
  console.log("wrote", dest, buf.length, "bytes");
}

await browser.close();
console.log("VIDEOS_DONE " + JSON.stringify(written));
