// Finding a file by name: "f invoice", "file budget", "cari skripsi". Only when asked for, and only names are matched, on this computer.
// Pure helpers (the query, the `find` command line, the order of the answers); the search itself runs in extension.ts.

/** The words to look for, or null unless the query starts with the file trigger. */
export function fileNeedle(query: string): string | null {
    const m = /^(?:f|file|files|find|cari)\s+(\S.*)$/i.exec(query.trim());
    return m ? m[1].trim().slice(0, 80) : null;
}

const SKIPPED_DIRS = ['node_modules', 'target', '.git', '.cache', '.local', '.cargo', '.npm', 'build', 'dist', 'venv', '__pycache__'];

/** `find` arguments (no shell is involved): hidden and build folders are not entered, names are matched without case, and every word must be in the name. */
export function findArgs(home: string, needle: string, depth = 6): string[] {
    const words = needle.split(/\s+/).filter(Boolean).slice(0, 4);
    const glob = (w: string) => `*${w.replace(/[\\*?[\]]/g, '\\$&')}*`;
    const skip = ['(', '-type', 'd', '(', ...SKIPPED_DIRS.flatMap((d, i) => (i ? ['-o', '-name', d] : ['-name', d])), '-o', '-name', '.?*', ')', ')', '-prune'];
    const match = words.flatMap(w => ['-iname', glob(w)]);
    return [home, '-maxdepth', String(depth), ...skip, '-o', '(', ...match, '-not', '-name', '.?*', ')', '-print'];
}

export interface FoundFile {path: string; name: string; folder: string}

/** The best few: names that start with the first word first, then shorter paths (nearer the top of the folder tree). */
export function rankFiles(paths: string[], needle: string, home: string, limit = 8): FoundFile[] {
    const first = needle.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const parsed = [...new Set(paths.filter(Boolean))].map(path => {
        const i = path.lastIndexOf('/');
        const name = path.slice(i + 1);
        const folder = path.slice(0, i).replace(home, '~') || '/';
        return {path, name, folder, score: (name.toLowerCase().startsWith(first) ? 0 : 100) + path.split('/').length * 4 + name.length * 0.1};
    });
    return parsed.sort((a, b) => a.score - b.score).slice(0, limit).map(({path, name, folder}) => ({path, name, folder}));
}
