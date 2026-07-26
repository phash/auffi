// Regenerate the caddy/Caddyfile CSP `script-src` hash allow-list from the
// inline scripts of every served page. Run it after any JSON-LD edit — most
// importantly on every release, because the download pages embed the sharer
// version in their SoftwareApplication JSON-LD, so their hash changes each bump
// (see docs/footguns.md § Cluster-Ops and the CSP-drift memory).
//
//   npm run csp:sync     rewrite the repo Caddyfile in place (idempotent)
//   npm run csp:check    verify only; exit 1 if stale (for the release gate)
//
// The PROD Caddyfile is out-of-band (cluster mode) — this only fixes the repo
// copy. After a viewer deploy, hand-sync /opt/caddyserver/Caddyfile and restart
// caddy-proxy, or the newly-hashed block gets CSP-blocked live.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CADDYFILE_REL,
  caddyScriptSrcHashes,
  computeServedHashes,
  rewriteCaddyfileScriptSrc,
} from "./csp-hashes";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const caddyPath = resolve(repoRoot, CADDYFILE_REL);
const checkOnly = process.argv.includes("--check");

const before = readFileSync(caddyPath, "utf-8");
const served = computeServedHashes(repoRoot);
const after = rewriteCaddyfileScriptSrc(before, served);

if (before === after) {
  console.log(`✓ ${CADDYFILE_REL} script-src already in sync (${served.length} hashes)`);
  process.exit(0);
}

const had = new Set(caddyScriptSrcHashes(before));
const now = new Set(served);
for (const h of [...had].filter((h) => !now.has(h))) console.log(`  − ${h}  (orphaned — removed)`);
for (const h of served.filter((h) => !had.has(h))) console.log(`  + ${h}  (served — added)`);

if (checkOnly) {
  console.error(`\n✗ ${CADDYFILE_REL} CSP script-src is STALE. Run: npm run csp:sync`);
  process.exit(1);
}

writeFileSync(caddyPath, after);
console.log(
  `\n✓ synced ${CADDYFILE_REL} (${served.length} hashes).\n` +
    `  Prod Caddyfile is out-of-band: after deploying the viewer, hand-sync\n` +
    `  /opt/caddyserver/Caddyfile + restart caddy-proxy (docs/footguns.md § Cluster-Ops).`,
);
