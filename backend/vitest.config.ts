import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The auth/me/devices/unattended suites run argon2 at production cost,
    // several hashes per test. On a loaded runner that overruns vitest's
    // 5 s default without anything being wrong.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 70,
      },
      exclude: ["src/index.ts", "**/*.config.*"],
    },
  },
});
