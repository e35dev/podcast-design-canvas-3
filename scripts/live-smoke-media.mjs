import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const appUrl = process.env.APP_URL || "http://localhost:5173/";
const remotePort = Number(process.env.REMOTE_DEBUG_PORT || 9367);
const mediaDir = process.env.LIVE_MEDIA_DIR || "/tmp/pdc-media";
const mediaBase = process.env.LIVE_MEDIA_BASE || "http://127.0.0.1:9591";
const hostMedia = process.env.LIVE_MEDIA_HOST || "host.mp4";
const guest1Media = process.env.LIVE_MEDIA_GUEST1 || "guest1.webm";
const guest2Media = process.env.LIVE_MEDIA_GUEST2 || "guest2.mp4";
const hostPath = join(mediaDir, hostMedia);
const guest1Path = join(mediaDir, guest1Media);
const guest2Path = join(mediaDir, guest2Media);

for (const mediaPath of [hostPath, guest1Path, guest2Path]) {
  if (!existsSync(mediaPath)) {
    throw new Error(`Missing required media file: ${mediaPath}`);
  }
}

const mediaServer = createServer((request, response) => {
  const requestedPath =
    request.url === "/host.mp4"
      ? hostPath
      : request.url === "/guest1.webm"
        ? guest1Path
        : request.url === "/guest2.mp4"
          ? guest2Path
          : null;

  if (!requestedPath) {
    response.statusCode = 404;
    response.end("not-found");
    return;
  }

  const stat = statSync(requestedPath);
  response.writeHead(200, {
    "Content-Type": requestedPath.endsWith(".webm") ? "video/webm" : "video/mp4",
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*"
  });
  createReadStream(requestedPath).pipe(response);
});

await new Promise((resolve, reject) => {
  mediaServer.listen(9591, (error) => (error ? reject(error) : resolve()));
});

const checkAppReachable = async (target) => {
  try {
    const response = await fetch(target);
    return response.ok;
  } catch {
    return false;
  }
};

if (!(await checkAppReachable(appUrl))) {
  mediaServer.close();
  throw new Error(`App URL is unreachable at ${appUrl}. Start the app first (npm run dev).`);
}

function createCdpClient(ws) {
  let requestId = 1;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);

    if (message.error) {
      reject(new Error(`${message.error.message || JSON.stringify(message.error)}`));
    } else {
      resolve(message.result);
    }
  });

  const send = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = requestId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const waitFor = async (expression, check, timeoutMs = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true
      });
      const value = result.result?.value;
      if (check(value)) {
        return value;
      }
      await sleep(200);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  };

  return {
    send,
    waitFor
  };
}

const waitForTarget = async () => {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const pages = await fetch(`http://127.0.0.1:${remotePort}/json`).then((response) => response.json());
      const page = pages.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // Retry until debug socket is available.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome debug target on port ${remotePort}`);
};

let profile;
let chrome;
let cdp;

try {
  profile = await mkdtemp(join(tmpdir(), "pdc-live-smoke-"));
  chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${remotePort}`,
      `--user-data-dir=${profile}`,
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      appUrl
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  chrome.stderr.on("data", (chunk) => process.stderr.write(`[chrome] ${chunk}`));
  chrome.stdout.on("data", (chunk) => process.stdout.write(`[chrome] ${chunk}`));

  const page = await waitForTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  cdp = createCdpClient(ws);
  const { send, waitFor } = cdp;
  const waitForUi = async (expression, check, timeoutMs) => waitFor(expression, check, timeoutMs);

  await send("Runtime.enable");

  await waitForUi("document.querySelectorAll('[data-action=\"file\"]').length", (count) => count >= 3, 20000);

  const uploadSummary = await send("Runtime.evaluate", {
    expression: `
      (async () => {
        const files = [
          ['[data-role="host"][data-action="file"]', "${mediaBase}/host.mp4", "video/mp4", "host.mp4"],
          ['[data-role="guest1"][data-action="file"]', "${mediaBase}/guest1.webm", "video/webm", "guest1.webm"],
          ['[data-role="guest2"][data-action="file"]', "${mediaBase}/guest2.mp4", "video/mp4", "guest2.mp4"]
        ];

        const result = {};
        for (const [selector, url, type, fileName] of files) {
          const input = document.querySelector(selector);
          const response = await fetch(url);
          const blob = await response.blob();
          const file = new File([blob], fileName, { type });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          result[fileName] = { size: file.size };
        }
        return result;
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  const readyPills = await waitForUi("document.querySelectorAll('.ready-pill').length", (count) => count >= 2, 30000);
  const fileInputCount = await send("Runtime.evaluate", {
    expression: "document.querySelectorAll('[data-action=\"file\"]').length",
    returnByValue: true
  }).then((result) => result.result.value);

  await send("Runtime.evaluate", {
    expression: `
      (function () {
        const values = ["https://example.com/host", "https://example.com/guest1", "https://example.com/guest2"];
        const socials = document.querySelectorAll('[data-action="social"]');
        socials.forEach((social, index) => {
          social.value = values[index] || "";
          social.dispatchEvent(new Event("input", { bubbles: true }));
        });
        return socials.length;
      })()
    `,
    returnByValue: true
  });

  await send("Runtime.evaluate", { expression: `document.querySelector('[data-preset="socialStudio"]').click();` });
  await send("Runtime.evaluate", { expression: `document.querySelector('[data-action="preview"]').click();` });

  const previewStatus = await waitForUi("document.querySelector('.status-row strong')?.textContent || ''", (value) => {
    return (
      typeof value === "string" &&
      (value.includes("Previewing") ||
        value.includes("Upload at least two") ||
        value.includes("Wait for at least two") ||
        value.includes("Loading uploaded media"))
    );
  }, 30000);

  const postPreview = await send("Runtime.evaluate", {
    expression: `
      (() => ({
        previewError: document.querySelector('.notice.error')?.textContent || "",
        exportEnabled: !document.querySelector('[data-action="export"]')?.disabled,
        acceptanceItems: Array.from(document.querySelectorAll('.acceptance-item')).map((item) => ({
          label: item.textContent.trim(),
          done: item.classList.contains("done")
        }))
      }))
    `,
    returnByValue: true
  });

  if (postPreview.result.value.previewError) {
    throw new Error(`Preview failed: ${postPreview.result.value.previewError}`);
  }

  await send("Runtime.evaluate", { expression: `document.querySelector('[data-action="export"]').click();` });
  const downloadName = await waitForUi(
    "document.querySelector('.download-link')?.getAttribute('download') || ''",
    (value) => Boolean(value),
    30000
  );

  const artifact = await send("Runtime.evaluate", {
    expression: `
      (async () => {
        const link = document.querySelector('.download-link');
        if (!link) {
          return { error: "missing-download-link" };
        }
        const blob = await fetch(link.href).then((response) => response.blob());
        return { name: link.getAttribute('download'), size: blob.size, type: blob.type };
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  const resetResult = await send("Runtime.evaluate", {
    expression: `
      (() => {
        const button = document.querySelector('[data-action="new-episode"]');
        if (!button) {
          return false;
        }
        button.click();
        return true;
      })()
    `,
    returnByValue: true
  });

  if (!resetResult.result.value) {
    throw new Error("Could not find Start new episode control.");
  }

  const postResetReadyPills = await waitForUi("document.querySelectorAll('.ready-pill').length", (value) => value === 0, 10000);
  const postResetEmptyCards = await waitForUi("document.querySelectorAll('.bucket-preview--empty').length", (value) => value >= 3, 10000);
  const newEpisodeState = await send("Runtime.evaluate", {
    expression: `
      (() => {
        const titleInput = document.querySelector('[data-action=\"title\"]');
        const fileInputs = Array.from(document.querySelectorAll('[data-action=\"file\"]'));
        return {
          title: titleInput?.value || "",
          readyPills: ${postResetReadyPills},
          emptyCards: ${postResetEmptyCards},
          fileInputs: fileInputs.length,
          fileInputsCleared: fileInputs.every((input) => !(input.files && input.files.length))
        };
      })()
    `,
    returnByValue: true
  });

  const summary = {
    appUrl,
    mediaInputs: fileInputCount,
    readyPills,
    uploadedFiles: {
      host: { name: hostMedia, size: statSync(hostPath).size },
      guest1: { name: guest1Media, size: statSync(guest1Path).size },
      guest2: { name: guest2Media, size: statSync(guest2Path).size }
    },
    uploadSummary: uploadSummary.result.value,
    previewStatus,
    exportButtonEnabledBeforeExport: postPreview.result.value.exportEnabled,
    acceptanceItems: postPreview.result.value.acceptanceItems,
    downloadName,
    artifact: artifact.result.value,
    newEpisodeState: newEpisodeState.result.value
  };

  console.log(JSON.stringify(summary, null, 2));

  ws.close();
} finally {
  if (chrome && !chrome.killed) {
    chrome.kill("SIGTERM");
    await new Promise((resolve) => chrome.once("exit", resolve));
  }
  if (profile) {
    await rm(profile, { recursive: true, force: true });
  }
  mediaServer.close();
}
