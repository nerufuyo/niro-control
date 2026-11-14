# Universal Appearance

One shared look (Look in the control panel, `org.niro.control`) reaching the parts of the desktop that can be reached safely. The principle: **opacity belongs to the background material, never to the text.** No window or widget tree is faded by default.

## Architecture

| Layer | What it is | Who draws it |
|---|---|---|
| A. Glass | The window's own background: opacity, tint, blur, rounded corners, shadow | The application's own background (Niro panel, GTK theme integration) or the compositor's blur behind it (blur extension) |
| B. Surfaces | Sidebar, content, groups, raised things, with fixed solidity (floors: sidebar 62, content 70, elevated 80) | The same stylesheet |
| C. Foreground | Text, icons, controls | Never touched by A or B. Contrast comes from colours |

Adapters (each separate, each with its own off switch):

| Adapter | Files | What it does |
|---|---|---|
| Tokens | `control/src/appearanceTokens.ts`, `control/src/appearance.ts` | Colours and alphas of the layers, presets, safety rules (floors, high contrast, safe mode, performance mode), per-application rules, the compatibility matrix. Pure and tested, including WCAG contrast over black, white and mid wallpapers |
| Control panel | `control/src/window.ts` | Paints the three layers; follows the Look; reduced motion and high contrast respected |
| GTK adapter | `control/src/gtkAdapter.ts`, `control/src/compatPage.ts` | A generated stylesheet for GTK 3 and GTK 4 (backgrounds only), hooked into your gtk.css by one marked block, **only with your consent**, after a backup. Restore removes the block (byte-identical result) |
| Shell | `shell/island/src/niroSync.ts`, `shell/blur/...` | Island, dock and search follow the shared look; the blur extension applies per-application rules (blur, exclusion, opt-in window fade) |

## Presets

Balanced glass (default), Crystal glass, Solid, Performance; any hand edit makes it "custom". They are ordinary settings, so Niro Profiles carry them. Per-application rules are not part of profiles.

## Reverting

- Global switch: Look > Universal Appearance > Enable system-wide appearance.
- Safe mode: solid surfaces, no compositor effects, whatever else is set.
- GTK integration: Compatibility > Restore original (backups of your gtk.css files stay in `~/.config/niro-control/appearance-backups`).
- Per application: Compatibility > Exclude, or the undo button on its row.
- Nothing is ever written into another application's files.

## Status labels

Live in the panel, the Shell parts and the blur extension rules (a settings change is picked up at once; the blur extension's new code needs one new login). GTK applications need a restart. Qt, browsers and Electron: see the matrix.

## Compatibility matrix

Evidence is what was actually done: **tested** (seen working in a headless GNOME Shell or by automated test), **partly tested**, or **documented, not tested here** (what is known about the toolkit, not verified on this machine).

| Family | Status | How | Cannot | Evidence |
|---|---|---|---|---|
| Niro Control | Native | Paints its own three layers | Nothing known | tested |
| GNOME apps, GTK 4 / libadwaita (Files, Text Editor, Settings) | Theme integration | The GTK adapter styles window, sidebar and content backgrounds | Needs the integration installed; restart; an application's own opaque backgrounds (for example a source editor's text area) stay as they are | partly tested: Files, Text Editor and Settings were screenshotted in a headless shell, dark and light; other apps not |
| GTK 3 apps | Limited | The GTK 3 stylesheet of the integration | GNOME Terminal has its own transparency setting; a theme in `~/.config/gtk-3.0` is applied first | documented, not tested here |
| Chrome / Chromium | Compositor effects only | Blur behind, corners by the shell | Page and toolbar are opaque: only a window fade is possible, and it fades text | documented, not tested here |
| Firefox | Compositor effects only | Same | Styling needs a profile stylesheet, which Niro does not write | documented, not tested here |
| Electron (VS Code and others) | Compositor effects only | Same | Opaque content; a fade also fades text | documented, not tested here (VS Code is not installed here) |
| Qt 5 / Qt 6 | Unsupported | Would need a Qt platform theme (qt5ct, Kvantum) | None is installed here and Niro writes none | documented, not tested here |
| XWayland windows | Compositor effects only | Same | Same | not tested |

The shell side: the island, dock and search follow the shared opacity, tint and accent (existing integration). The top bar, Overview, notifications, quick settings and menus are blurred by the blur extension's own component settings; Universal Appearance does not drive them yet (not claimed).

## Known limits

- Foreground colours of third-party GTK applications are left to the application. The generated stylesheet follows one colour scheme (the one at install time); if GNOME switches scheme the glass is wrong until Reinstall.
- A compositor can only fade or blur a whole window: it cannot tell content from chrome inside it. That is why a window fade is opt-in per application and says so.
- The blur extension's new code (and the end of the old whole-window fade, which also resets the extension's `opacity` to 255) loads at the next login.
- Custom per-application blur strength and corner radius are not implemented (blur on/off, exclusion and opt-in fade are).
- Performance: see `reports/performance/` (`scripts/benchmark-appearance.sh`).
