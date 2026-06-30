import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");

/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: "./tests",
  timeout: 90_000,
  expect: {
    timeout: 30_000
  },
  use: {
    headless: true,
    launchOptions: {
      executablePath: process.env.PDC_CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"]
    }
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5174",
    cwd: rootDir,
    url: "http://127.0.0.1:5174",
    reuseExistingServer: true,
    timeout: 90_000
  },
  reporter: [["list"]]
};

export default config;
