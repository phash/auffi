import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The Tauri-API / DOM wiring layers — exercised only inside the real
      // desktop webview runtime (DOM construction + `invoke()` round-trips),
      // not unit-testable in vitest. Same rationale as the viewer's excluded
      // ui.ts/main.ts. The testable pure helpers (tabs, monitor-display,
      // trusted-peers, update-banner) stay measured and sit at ~100%.
      exclude: ["src/main.ts", "src/feedback-fab.ts", "src/unattended.ts", "src/vite-env.d.ts"],
      thresholds: {
        lines: 70,
        branches: 70,
      },
    },
  },
});
