// Which files in the Downloads folder are downloads still being written, by the temporary names browsers and download tools use.
// Kept apart from GJS so tests can run it (tests/).

const PARTIAL = /\.(?:crdownload|part|download|opdownload|partial|aria2|!qb|tmp)$/i;

export interface Entry {
  name: string;
  /** Seconds since the epoch when the file last changed. */
  modified: number;
}

/** A download that is really going on keeps changing its file; one left behind (a cancelled or abandoned download) does not. */
export const ACTIVE_SECONDS = 90;

/** How many of these files are unfinished downloads that changed within the last ACTIVE_SECONDS. */
export function partialDownloads(entries: readonly Entry[], nowSeconds: number): number {
  return entries.filter(
    (e) =>
      nowSeconds - e.modified <= ACTIVE_SECONDS &&
      ((PARTIAL.test(e.name) && !e.name.startsWith(".")) ||
        /^\.com\.google\.Chrome\./.test(e.name)),
  ).length;
}

/** The tooltip line for the stack: "Downloads" or "Downloads · 2 downloading". */
export function stackTitle(name: string, downloading: number): string {
  return downloading > 0 ? `${name} · ${downloading} downloading` : name;
}

/** "1.2 GB", "340 MB": a size for a tooltip. */
export function memoryText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** The tooltip of a running app: its name and the memory its processes hold ("Firefox · 1.2 GB"). */
export function appTitle(name: string, residentBytes: number): string {
  return residentBytes > 0 ? `${name} · ${memoryText(residentBytes)}` : name;
}
