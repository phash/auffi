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
        // Both at the project's 70% standard (gh #107). Every view except
        // the two static pages admin-403.ts and not-found.ts has a test
        // file; the two static pages are what keeps the numbers from
        // being higher. Do NOT lower these two numbers.
        lines: 70,
        branches: 70,
      },
    },
  },
});
