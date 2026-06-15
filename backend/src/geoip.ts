import { readFileSync } from "node:fs";
import { Reader, type CountryResponse } from "maxmind";

/**
 * Minimal slice of the maxmind Reader we depend on. Lets the lookup logic be
 * unit-tested with an in-memory fake — a country MMDB is an in-process file
 * reader, not a database service, so dependency injection is the right shape.
 */
export interface CountryLookup {
  get(ip: string): { country?: { iso_code?: string } } | null;
}

/**
 * Resolve an IP to its ISO-3166-1-alpha-2 country code, or null when the
 * reader is absent, the IP is private/unknown, or the input is malformed.
 * Never throws: country context is a nice-to-have for the confirm dialog,
 * never load-bearing for signaling.
 */
export function lookupCountry(reader: CountryLookup | null, ip: string): string | null {
  if (!reader) return null;
  try {
    const iso = reader.get(ip)?.country?.iso_code;
    return typeof iso === "string" && iso.length === 2 ? iso.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Open the country MMDB synchronously from disk. Returns null (with a single
 * warning) when the path is unset or unreadable, so a build without the DB
 * (local dev) silently disables country resolution.
 */
export function openCountryDb(path: string | undefined): CountryLookup | null {
  if (!path) return null;
  try {
    return new Reader<CountryResponse>(readFileSync(path));
  } catch {
    // eslint-disable-next-line no-console -- one-shot startup degradation notice
    console.warn(`[geoip] country DB not loaded from ${path}; country disabled`);
    return null;
  }
}
