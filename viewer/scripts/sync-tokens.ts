// Copy design/tokens.css to viewer/public/tokens.css. Static pages under
// viewer/public are served as-is (not processed by Vite), so they cannot
// @import a file outside the public dir and load this copy instead.
//
//   npm run tokens:sync    write the copy (idempotent)
//   npm run tokens:check   verify only; exit 1 if stale

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(repoRoot, "design/tokens.css");
const copy = resolve(repoRoot, "viewer/public/tokens.css");

function syncTokens(check: boolean): boolean {
  const want = readFileSync(source, "utf-8");
  let have = "";
  try {
    have = readFileSync(copy, "utf-8");
  } catch {
    // missing copy counts as stale
  }
  if (have === want) return true;
  if (!check) writeFileSync(copy, want);
  return false;
}

const check = process.argv.includes("--check");
const inSync = syncTokens(check);
if (inSync) {
  console.log("✓ viewer/public/tokens.css in sync");
} else if (check) {
  console.error("✗ viewer/public/tokens.css is stale — run `npm run tokens:sync`");
  process.exit(1);
} else {
  console.log("↻ wrote viewer/public/tokens.css");
}
