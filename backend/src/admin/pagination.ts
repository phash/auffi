/**
 * Shared keyset-pagination helpers for the admin list endpoints
 * (users, devices, audit-log). All three paginate on the composite
 * key (created_at DESC, id DESC) with an opaque base64url cursor and
 * the limit+1 trick — extracted here so cursor hardening happens in
 * one place.
 */

export interface Cursor<Id extends string | number> {
  createdAt: number;
  id: Id;
}

export function encodeCursor(c: Cursor<string | number>): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf-8").toString("base64url");
}

export function decodeStringCursor(raw: string): Cursor<string> | null {
  try {
    const s = Buffer.from(raw, "base64url").toString("utf-8");
    const [aStr, id] = s.split("|");
    const createdAt = Number(aStr);
    if (!Number.isFinite(createdAt) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function decodeNumericCursor(raw: string): Cursor<number> | null {
  const c = decodeStringCursor(raw);
  if (!c) return null;
  const id = Number(c.id);
  if (!Number.isFinite(id)) return null;
  return { createdAt: c.createdAt, id };
}

/**
 * Clamp a caller-supplied `?limit=` to [1, maxLimit], falling back to
 * `defaultLimit` for missing / non-numeric / non-positive input.
 */
export function clampLimit(
  raw: string | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  const n = Number(raw ?? defaultLimit);
  return Number.isFinite(n) && n > 0 ? Math.min(n, maxLimit) : defaultLimit;
}

/**
 * Apply the limit+1 trick to a query result that asked for `limit + 1`
 * rows: slice down to `limit` and derive the next cursor from the last
 * visible row when more rows exist.
 */
export function paginate<T>(
  rows: T[],
  limit: number,
  cursorOf: (last: T) => string,
): { visible: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible[visible.length - 1];
  return {
    visible,
    nextCursor: hasMore && last !== undefined ? cursorOf(last) : null,
  };
}
