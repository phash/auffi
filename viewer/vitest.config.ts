import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/signaling-client.ts"],
      exclude: ["src/main.ts"],
      thresholds: {
        lines: 70,
        branches: 70,
      },
    },
  },
});
