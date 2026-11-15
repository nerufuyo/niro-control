// Dock icons from an icon theme of the user's choice (Settings → Dock → Icon theme), whatever the desktop's own theme is.
// St has no per-actor theme, so the icon is looked up here by the freedesktop rules (index.theme: Directories, Size, Type,
// Inherits) and handed to St as a file.
import Gio from "gi://Gio";
import GLib from "gi://GLib";

interface Dir {
  path: string;
  size: number;
  scale: number;
  type: string;
  min: number;
  max: number;
}

interface Theme {
  name: string;
  roots: string[];
  dirs: Dir[];
  inherits: string[];
}

export function iconRoots(): string[] {
  return [
    `${GLib.get_home_dir()}/.icons`,
    `${GLib.get_user_data_dir()}/icons`,
    ...GLib.get_system_data_dirs().map((dir) => `${dir}/icons`),
  ];
}

function loadTheme(name: string): Theme | null {
  const roots = iconRoots().filter((root) => GLib.file_test(`${root}/${name}/index.theme`, GLib.FileTest.EXISTS));
  if (roots.length === 0) return null;
  const file = new GLib.KeyFile();
  // index.theme separates its lists with commas, not GLib's semicolons.
  file.set_list_separator(",".charCodeAt(0));
  try {
    file.load_from_file(`${roots[0]}/${name}/index.theme`, GLib.KeyFileFlags.NONE);
  } catch (_e) {
    return null;
  }
  const list = (group: string, key: string): string[] => {
    try {
      return file.get_string_list(group, key);
    } catch (_e) {
      return [];
    }
  };
  const number = (group: string, key: string, fallback: number): number => {
    try {
      return file.get_integer(group, key);
    } catch (_e) {
      return fallback;
    }
  };
  const dirs: Dir[] = [];
  for (const path of [...list("Icon Theme", "Directories"), ...list("Icon Theme", "ScaledDirectories")]) {
    if (!file.has_group(path)) continue;
    const size = number(path, "Size", 0);
    let type = "Threshold";
    try {
      type = file.get_string(path, "Type");
    } catch (_e) {
      /* the default */
    }
    dirs.push({
      path,
      size,
      scale: number(path, "Scale", 1),
      type,
      min: number(path, "MinSize", size),
      max: number(path, "MaxSize", size),
    });
  }
  return { name, roots, dirs, inherits: list("Icon Theme", "Inherits") };
}

function distance(dir: Dir, want: number): number {
  const size = dir.size * dir.scale;
  if (dir.type === "Fixed") return Math.abs(size - want);
  if (dir.type === "Scalable") {
    const lo = dir.min * dir.scale;
    const hi = dir.max * dir.scale;
    return want < lo ? lo - want : want > hi ? want - hi : 0;
  }
  const lo = (dir.size - 2) * dir.scale;
  const hi = (dir.size + 2) * dir.scale;
  return want < lo ? lo - want : want > hi ? want - hi : 0;
}

/** Finds icons by name in one theme and the themes it inherits, the way a toolkit would. */
export class ThemeResolver {
  private _themes: Theme[] = [];
  private _cache = new Map<string, Gio.Icon | null>();

  constructor(readonly name: string) {
    const seen = new Set<string>();
    const walk = (theme: string): void => {
      if (seen.has(theme) || seen.size > 8) return;
      seen.add(theme);
      const loaded = loadTheme(theme);
      if (!loaded) return;
      this._themes.push(loaded);
      for (const parent of loaded.inherits) walk(parent);
    };
    walk(name);
  }

  /** Whether the theme is installed and has icons to offer. */
  get usable(): boolean {
    return this._themes.length > 0 && this._themes[0].dirs.length > 0;
  }

  lookup(names: string[], size: number): Gio.Icon | null {
    for (const iconName of names) {
      const key = `${iconName}@${size}`;
      if (this._cache.has(key)) {
        const hit = this._cache.get(key);
        if (hit) return hit;
        continue;
      }
      const found = this._find(iconName, size);
      this._cache.set(key, found);
      if (found) return found;
    }
    return null;
  }

  private _find(iconName: string, want: number): Gio.Icon | null {
    for (const theme of this._themes) {
      let best: { path: string; score: number } | null = null;
      for (const dir of theme.dirs) {
        for (const root of theme.roots) {
          for (const ext of ["svg", "png"]) {
            const path = `${root}/${theme.name}/${dir.path}/${iconName}.${ext}`;
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) continue;
            const score = distance(dir, want) * 2 + (ext === "svg" ? 0 : 1);
            if (!best || score < best.score) best = { path, score };
          }
        }
      }
      if (best) return new Gio.FileIcon({ file: Gio.File.new_for_path(best.path) });
    }
    return null;
  }
}
