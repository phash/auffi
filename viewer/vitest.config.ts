import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/signaling-client.ts", "src/webrtc-client.ts", "src/input-capture.ts", "src/data-channels.ts", "src/file-transfer.ts"],
      exclude: ["src/main.ts"],
      thresholds: {
        lines: 70,
        branches: 70,
      },
    },
  },
});
