export interface PeerOrigin {
  ipPrefix: string;
  country: string | null;
  trusted: boolean;
}

/**
 * ISO-3166-1-alpha-2 → German region name via Intl.DisplayNames. Falls back to
 * the upper-cased code for unknown regions, and null for absent/invalid input.
 * No flag emoji on purpose — Windows does not render regional-indicator flags.
 */
export function countryName(iso: string | null): string | null {
  if (!iso || !/^[A-Za-z]{2}$/.test(iso)) return null;
  const code = iso.toUpperCase();
  try {
    // Use the English locale as a sentinel: if ICU resolves the code to
    // "Unknown Region" in English, it has no real entry for that code and
    // we fall back to the raw code string instead of a translated
    // "Unbekannte Region" / "Unknown Region" placeholder.
    const enName = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    if (!enName || enName === "Unknown Region") return code;
    const name = new Intl.DisplayNames(["de"], { type: "region" }).of(code);
    return name ?? code;
  } catch {
    return code;
  }
}

export function formatConnectionRequest(o: PeerOrigin): string {
  const name = countryName(o.country);
  const origin = name
    ? `Verbindungsanfrage aus ${name} · ${o.ipPrefix}`
    : `Verbindungsanfrage von ${o.ipPrefix}`;
  return o.trusted ? `${origin} · bekannter Helfer (frühere Verbindung)` : origin;
}
