import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const appUrl = process.env.APP_URL || "http://127.0.0.1:5174/";
const mediaDir = process.env.LIVE_MEDIA_DIR || "/tmp/pdc-media";
const hostPath = path.join(mediaDir, process.env.LIVE_MEDIA_HOST || "host.mp4");
const guest1Path = path.join(mediaDir, process.env.LIVE_MEDIA_GUEST1 || "guest1.webm");
const guest2Path = path.join(mediaDir, process.env.LIVE_MEDIA_GUEST2 || "guest2.mp4");

function ensureMediaFiles() {
  [hostPath, guest1Path, guest2Path].forEach((filePath) => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing media fixture for live workflow test: ${filePath}`);
    }
  });
}

function waitForReadyPills(page, min = 2) {
  return page.waitForFunction(
    (target) => document.querySelectorAll(".ready-pill").length >= target,
    min,
    { timeout: 30_000 }
  );
}

test("issue #25 import-to-export workflow", async ({ page }) => {
  ensureMediaFiles();

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(page.locator('[data-action="file"]')).toHaveCount(3);

  await page.setInputFiles('[data-role="host"][data-action="file"]', hostPath);
  await page.setInputFiles('[data-role="guest1"][data-action="file"]', guest1Path);
  await page.setInputFiles('[data-role="guest2"][data-action="file"]', guest2Path);

  await waitForReadyPills(page, 3);
  await expect(page.locator(".empty-preview")).toHaveCount(0);
  await expect(page.locator(".speaker-card").nth(0)).toContainText("host.mp4");
  await expect(page.locator(".speaker-card").nth(1)).toContainText("guest1.webm");
  await expect(page.locator(".speaker-card").nth(2)).toContainText("guest2.mp4");

  await page.fill('[data-action="social"][data-role="host"]', "https://example.com/host");
  await page.fill('[data-action="social"][data-role="guest1"]', "https://example.com/guest1");
  await page.fill('[data-action="social"][data-role="guest2"]', "https://example.com/guest2");

  await page.click('[data-preset="socialStudio"]');
  await page.click('[data-action="preview"]');

  await expect(page.locator(".status-row strong")).toContainText("Previewing");

  await page.click('[data-action="export"]');

  const downloadName = await page.waitForFunction(
    () => document.querySelector(".download-link")?.getAttribute("download") || "",
    { timeout: 30_000 }
  );
  expect(await downloadName.jsonValue()).not.toBe("");

  const artifact = await page.evaluate(async () => {
    const link = document.querySelector(".download-link");
    if (!link) {
      return null;
    }
    const blob = await fetch(link.href).then((response) => response.blob());
    return {
      name: link.getAttribute("download"),
      size: blob.size,
      type: blob.type
    };
  });

  expect(artifact).not.toBeNull();
  expect(artifact.size).toBeGreaterThan(0);

  await page.screenshot({
    path: "test-results/issue-25-issue25-flow.png",
    fullPage: true
  });

  await page.click('[data-action="new-episode"]');
  await expect(page.locator('[data-action="title"]')).toHaveValue("New podcast episode");
  await page.waitForFunction(() => document.querySelectorAll(".ready-pill").length === 0);
  await page.waitForFunction(() => document.querySelectorAll(".bucket-preview--empty").length >= 3);
});
