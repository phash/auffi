// Single source of truth for the CSP inline-script hash set.
//
// Both the parity guard (tests/marketing-seo.test.ts) and the regenerator CLI
// (scripts/sync-csp-hashes.ts) import from here, so the "what hashes should the
// Caddyfile whitelist" recipe cannot drift between the check and the fix.
//
// Recipe (must match the python one-liner documented in caddy/Caddyfile): for
// every inline <script> across the served pages, SHA-256 over the VERBATIM
// inner bytes (utf-8, INCLUDING surrounding whitespace — not trimmed, not
// re-serialized), base64, prefixed "sha256-". External (src=) and empty blocks
// are skipped.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export const CADDYFILE_REL = "caddy/Caddyfile";

const INLINE_SCRIPT_RE = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;

export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
    const inner = m[1];
    if (inner.trim() === "" || inner.slice(0, 60).includes("src=")) continue;
    out.push("sha256-" + createHash("sha256").update(inner, "utf-8").digest("base64"));
  }
  return out;
}

function walkIndexHtml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkIndexHtml(p));
    else if (entry.name === "index.html") out.push(p);
  }
  return out;
}

/** Every HTML page the reverse proxy serves with the CSP header applied. */
export function servedPageFiles(repoRoot: string): string[] {
  const f = (p: string) => resolve(repoRoot, p);
  return [f("viewer/index.html"), f("viewer/en/index.html"), ...walkIndexHtml(f("viewer/public"))];
}

/** Sorted, de-duplicated set of inline-script hashes across all served pages. */
export function computeServedHashes(repoRoot: string): string[] {
  const s = new Set<string>();
  for (const file of servedPageFiles(repoRoot)) {
    for (const h of inlineScriptHashes(readFileSync(file, "utf-8"))) s.add(h);
  }
  return [...s].sort();
}

const HASH_TOKEN_RE = /'(sha256-[A-Za-z0-9+/=]+)'/g;

/** The single physical line carrying the CSP directive (not a comment). */
function cspLine(caddyContent: string): string {
  const lines = caddyContent.split("\n").filter((l) => l.includes('Content-Security-Policy "'));
  if (lines.length !== 1) {
    throw new Error(`expected exactly one Content-Security-Policy directive, found ${lines.length}`);
  }
  return lines[0];
}

/** Sorted sha256 hashes currently whitelisted on the CSP line. */
export function caddyScriptSrcHashes(caddyContent: string): string[] {
  return [...cspLine(caddyContent).matchAll(HASH_TOKEN_RE)].map((m) => m[1]).sort();
}

/**
 * Return a copy of `caddyContent` whose script-src hash list is exactly
 * `servedHashes` (sorted, single-quoted), preserving non-hash sources and
 * leaving every other CSP directive byte-identical. No-op (byte-identical) when
 * already in sync, so it is safe to run on every release.
 */
export function rewriteCaddyfileScriptSrc(caddyContent: string, servedHashes: string[]): string {
  const line = cspLine(caddyContent);
  if (!/script-src /.test(line)) throw new Error("CSP line has no script-src directive");

  const newLine = line.replace(/(script-src )([^;]*?)(;)/, (_full, head: string, body: string, tail: string) => {
    const sources = body.trim().split(/\s+/).filter((t) => !t.startsWith("'sha256-"));
    const hashes = [...servedHashes].sort().map((h) => `'${h}'`);
    return head + [...sources, ...hashes].join(" ") + tail;
  });

  const stripScriptSrc = (s: string) => s.replace(/script-src [^;]*;/, "script-src __;");
  if (stripScriptSrc(line) !== stripScriptSrc(newLine)) {
    throw new Error("rewrite would change a directive other than script-src");
  }
  // Function replacement so `$` sequences in the hash list are not interpreted.
  return caddyContent.replace(line, () => newLine);
}
