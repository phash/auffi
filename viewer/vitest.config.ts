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
      exclude: [
        "src/main.ts",
        // ui.ts is the top-level wiring layer — exercised by the
        // reconnect/fullscreen DOM integration tests but not directly
        // measured because v8 doesn't track listener-driven branches
        // well and the file would otherwise dilute the rest of the
        // picture.
        "src/ui.ts",
      ],
      thresholds: {
        lines: 70,
        branches: 70,
      },
    },
  },
});
