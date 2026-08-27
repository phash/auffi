import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";

/**
 * Argon2id parameters tuned for ~250 ms on a 1 vCPU VPS (per gh #10
 * acceptance criteria). The defaults `argon2` ships with — 19 MiB memory,
 * 2 iterations, 1 lane — finish in <50 ms on commodity hardware and are
 * too cheap. These values bring a single hash close to 250 ms on a single
 * vCPU AMD EPYC core (the IONOS VPS host).
 *
 * If you change these, also pull every existing hash through `verify`
 * with the new defaults — argon2id encoded strings carry their own
 * params so old hashes verify correctly without a migration.
 */
const ARGON_OPTS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 1 << 16, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

/**
 * Hash a password with argon2id. Returns the standard encoded string
 * (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`) — store it as-is in
 * `accounts.password_hash`.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON_OPTS);
}

/**
 * Verify `plaintext` against an encoded argon2id hash. Returns false on
 * mismatch or malformed/missing hash. Always argon2-verifies — even when
 * the account doesn't exist — by passing a synthetic placeholder hash;
 * see verifyPasswordTimingSafe below.
 */
export async function verifyPassword(encodedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(encodedHash, plaintext);
  } catch {
    // Malformed hash, missing dependency, OOM — none of these should leak
    // through to "auth succeeded" so collapse them all into a deny.
    return false;
  }
}

/**
 * A pre-computed argon2id hash of a random throw-away password. Used by
 * the login path as the verify target when the lookup-by-email returns
 * no row — without it, the response time would differ measurably between
 * "email exists" and "email does not exist" (timing oracle).
 *
 * Computed once at module load. The value's plaintext is intentionally
 * unguessable + unused — verifyPassword against this returns false for
 * every realistic input, so the comparator costs ~250 ms either way.
 */
let TIMING_DECOY: string | null = null;

async function getTimingDecoy(): Promise<string> {
  if (TIMING_DECOY === null) {
    // Lazy-init on first call so the import-time cost doesn't slow boot.
    TIMING_DECOY = await hashPassword(
      // 256 bits of plaintext — never used for actual auth, just to feed
      // argon2 enough work that the timing matches a real hash compare.
      // CSPRNG (not Math.random) keeps this auth file free of weak-random
      // smells even though the value is throw-away.
      "auffi-timing-decoy-" + randomBytes(16).toString("hex"),
    );
  }
  return TIMING_DECOY;
}

/**
 * Verify `plaintext` against `maybeHash`. When `maybeHash` is null/undefined
 * (no account matched the email), spend the same argon2 budget against a
 * decoy hash and always return false. This makes "wrong email" and "wrong
 * password" indistinguishable to a timing attacker, per spec §4.3 step 3.
 */
export async function verifyPasswordTimingSafe(
  maybeHash: string | null | undefined,
  plaintext: string,
): Promise<boolean> {
  const target = maybeHash ?? (await getTimingDecoy());
  const ok = await verifyPassword(target, plaintext);
  // If we used the decoy, force a deny regardless of (impossible) match.
  return maybeHash ? ok : false;
}
