// Which files in the Downloads folder are downloads still being written, by the temporary names browsers and download tools use.
// Kept apart from GJS so tests can run it (tests/).

const PARTIAL = /\.(?:crdownload|part|download|opdownload|partial|aria2|!qb|tmp)$/i;

/** How many of these file names are unfinished downloads. */
export function partialDownloads(names: readonly string[]): number {
  return (
    names.filter((n) => PARTIAL.test(n) && !n.startsWith(".")).length +
    names.filter((n) => /^\.com\.google\.Chrome\./.test(n)).length
  );
}

/** The tooltip line for the stack: "Downloads" or "Downloads · 2 downloading". */
export function stackTitle(name: string, downloading: number): string {
  return downloading > 0 ? `${name} · ${downloading} downloading` : name;
}
