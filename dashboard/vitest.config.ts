import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts (history-API SPA bootstrap) and feedback-fab.ts (DOM widget)
      // are wiring layers exercised only in the real browser — same rationale
      // as the viewer's ui.ts/main.ts exclusion.
      exclude: ["src/main.ts", "src/components/feedback-fab.ts"],
      thresholds: {
        // Both at the project's 70% standard (gh #107). Do NOT lower
        // these two numbers.
        lines: 70,
        branches: 70,
      },
    },
  },
});
