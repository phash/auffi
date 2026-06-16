import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  use: {
    baseURL: process.env.VIEWER_URL ?? "http://localhost:5173",
    headless: true,
    trace: "retain-on-failure",
    // Override the default HeadlessChrome User-Agent — the production
    // Caddy bot filter blocks it (intentionally — real users don't run
    // headless browsers, and the filter discourages drive-by scrapers).
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--disable-web-security",
        "--allow-running-insecure-content",
        // Send raw host (127.0.0.1) ICE candidates instead of mDNS .local
        // hostnames — the node-webrtc mock sharer can't resolve mDNS in CI,
        // so without this ICE never pairs and #remote-video stays hidden.
        "--disable-features=WebRtcHideLocalIpsWithMdns",
      ],
    },
  },
});
