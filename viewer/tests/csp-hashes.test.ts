import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  inlineScriptHashes,
  caddyScriptSrcHashes,
  rewriteCaddyfileScriptSrc,
  computeServedHashes,
  CADDYFILE_REL,
} from "../scripts/csp-hashes";

const REPO = resolve(__dirname, "../..");

// A minimal Caddyfile-shaped fixture: one CSP directive with two hashes plus
// non-hash sources, flanked by other directives that must never be touched.
const FIXTURE = `{
	header {
		Content-Security-Policy "default-src 'self'; script-src 'self' https://musikersuche.org 'sha256-AAA=' 'sha256-BBB='; style-src 'self'; connect-src 'self' wss://x;"
	}
}
`;

describe("inlineScriptHashes", () => {
  it("hashes the VERBATIM inner bytes — whitespace is significant, not trimmed", () => {
    // Same JSON, different surrounding whitespace → different hash. This is the
    // exact property that makes the hash change on unrelated re-indentation.
    const spaced = inlineScriptHashes("<script> a </script>");
    const tight = inlineScriptHashes("<script>a</script>");
    expect(spaced).toHaveLength(1);
    expect(tight).toHaveLength(1);
    expect(spaced[0]).not.toEqual(tight[0]);
    expect(spaced[0]).toMatch(/^sha256-[A-Za-z0-9+/=]+$/);
  });

  it("skips empty/whitespace-only blocks and external (src=) scripts", () => {
    expect(inlineScriptHashes("<script></script>")).toEqual([]);
    expect(inlineScriptHashes("<script>   \n  </script>")).toEqual([]);
    expect(inlineScriptHashes('<script src="/x.js"></script>')).toEqual([]);
    expect(
      inlineScriptHashes('<script type="application/ld+json">{"a":1}</script>'),
    ).toHaveLength(1);
  });
});

describe("caddyScriptSrcHashes", () => {
  it("returns the sorted sha256 set, ignoring non-hash sources", () => {
    expect(caddyScriptSrcHashes(FIXTURE)).toEqual(["sha256-AAA=", "sha256-BBB="]);
  });
  it("throws when there is not exactly one CSP directive", () => {
    expect(() => caddyScriptSrcHashes("no csp here")).toThrow();
    expect(() => caddyScriptSrcHashes(FIXTURE + FIXTURE)).toThrow();
  });
});

describe("rewriteCaddyfileScriptSrc", () => {
  it("replaces the hash list with the served set, sorted, sources preserved", () => {
    const out = rewriteCaddyfileScriptSrc(FIXTURE, ["sha256-CCC=", "sha256-BBB="]);
    expect(caddyScriptSrcHashes(out)).toEqual(["sha256-BBB=", "sha256-CCC="]);
    expect(out).toContain("script-src 'self' https://musikersuche.org 'sha256-BBB=' 'sha256-CCC=';");
  });

  it("is a byte-identical no-op when already in sync (idempotent)", () => {
    const served = caddyScriptSrcHashes(FIXTURE);
    expect(rewriteCaddyfileScriptSrc(FIXTURE, served)).toBe(FIXTURE);
    const once = rewriteCaddyfileScriptSrc(FIXTURE, ["sha256-CCC=", "sha256-BBB="]);
    expect(rewriteCaddyfileScriptSrc(once, ["sha256-BBB=", "sha256-CCC="])).toBe(once);
  });

  it("never mutates a directive other than script-src", () => {
    const out = rewriteCaddyfileScriptSrc(FIXTURE, ["sha256-ZZZ="]);
    expect(out).toContain("style-src 'self';");
    expect(out).toContain("connect-src 'self' wss://x;");
  });

  it("throws when the CSP line has no script-src directive", () => {
    const noScript = FIXTURE.replace(/script-src[^;]*;/, "");
    expect(() => rewriteCaddyfileScriptSrc(noScript, ["sha256-AAA="])).toThrow();
  });
});

describe("computeServedHashes (real repo)", () => {
  it("is sorted, de-duplicated, non-empty and agrees with the checked-in Caddyfile", () => {
    const served = computeServedHashes(REPO);
    expect(served.length).toBeGreaterThan(0);
    expect([...served]).toEqual([...served].sort());
    expect(new Set(served).size).toBe(served.length);
    // The repo Caddyfile was reconciled — parity must hold here too.
    const caddy = caddyScriptSrcHashes(readFileSync(resolve(REPO, CADDYFILE_REL), "utf-8"));
    expect(caddy).toEqual(served);
  });
});
