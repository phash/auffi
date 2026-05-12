import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts is the Tauri-API wiring layer — exercised only inside the
      // real desktop runtime, not unit-testable in vitest.
      exclude: ["src/main.ts"],
      thresholds: {
        lines: 70,
        branches: 70,
      },
    },
  },
});
