import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        border: resolve(__dirname, "border.html"),
      },
    },
  },
});
