import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Multi-page build: the German landing (index.html) and the English mirror
// (en/index.html) are both Vite entries so each gets the hashed app bundle
// injected. The static marketing subpages (download, vergleich, en/download,
// en/compare, legal) live in public/ and are copied as-is.
export default defineConfig({
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        en: fileURLToPath(new URL("./en/index.html", import.meta.url)),
      },
    },
  },
});
