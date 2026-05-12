import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
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
