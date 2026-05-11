import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  use: {
    baseURL: process.env.VIEWER_URL ?? "http://localhost:5173",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--disable-web-security",
        "--allow-running-insecure-content",
      ],
    },
  },
});
