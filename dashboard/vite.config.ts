import { defineConfig } from "vite";

export default defineConfig({
  // The dashboard mounts under /dashboard/* in production (see
  // Caddyfile, gh #38). Vite's `base` rewrites all asset URLs so the
  // built bundle references `/dashboard/assets/…` instead of
  // `/assets/…`, which would otherwise collide with the viewer at
  // auffi.app/.
  base: "/dashboard/",
  server: { port: 5174 },
});
