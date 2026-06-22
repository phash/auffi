import { defineConfig } from "vite";
import { resolve } from "path";
import { readFileSync } from "fs";

// Single source of truth for the in-app About version: package.json. Without
// this `define`, `import.meta.env.VITE_APP_VERSION` was never set, so every
// release bundle fell back to "Version dev" in the About panel.
const pkgVersion = (
  JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")) as { version: string }
).version;

export default defineConfig({
  clearScreen: false,
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkgVersion),
  },
  server: { port: 5174, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
});
