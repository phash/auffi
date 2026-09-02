import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Node environment for file-system tests (design-tokens contrast guard)
        test: {
          name: "node",
          include: ["tests/design-tokens.test.ts"],
          environment: "node",
        },
      },
      {
        // jsdom environment for all other viewer tests
        test: {
          name: "jsdom",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/design-tokens.test.ts"],
          environment: "jsdom",
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Only the Vite bootstrap is unmeasured; ui.ts is driven by the
      // reconnect / connect-timeout / session-guard / fullscreen tests and
      // counts like every other module.
      exclude: ["src/main.ts"],
      thresholds: {
        lines: 70,
        branches: 70,
      },
    },
  },
});
