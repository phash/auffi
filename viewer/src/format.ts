/**
 * Bytes → menschenlesbare Größe. Binäre Divisoren (1024) mit den
 * umgangssprachlichen KB/MB/GB-Labels — dieselbe Konvention wie der
 * Windows-Explorer, damit die Anzeige zu dem passt, was der Nutzer
 * neben der Datei im Dateimanager sieht.
 *
 * Einzige Quelle für Byte-Formatierung im Viewer (Compact-Bar UND
 * Session-Summary) — vorher zwei gedriftete Kopien.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
