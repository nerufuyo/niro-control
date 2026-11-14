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

## 2.0: what changed

- **No whole-window fade by default.** Before, every application window was faded to 80% (applications opacity 204), text included. The first run now saves that value once (`legacy-window-opacity`), sets windows back to 255, and offers **Old whole-window fade for every application** (Advanced) as the way back. Per-application Window fade is Advanced-only, with its warning, and needs "Window-level effects for other applications".
- **Scheme follows what the application follows.** GTK 4 / libadwaita apps follow GNOME's colour scheme; GTK 3 apps follow their theme (guessed from its name, so the GTK 3 stylesheet also sets the text colour on the surfaces it paints). Niro's own light/dark choice is for its panel only. The shell extension listens to GNOME's `color-scheme`, `gtk-theme` and `high-contrast` (signals, no polling) and rewrites the generated stylesheets atomically, only when their content would change. Applications need a restart to pick it up (GTK does not reload user CSS in a running app): the Compatibility page says so.
- **Shell surfaces** (Look > Universal Appearance > Blur the top bar, Overview, menus, notifications and quick settings): switches the blur extension's panel, Overview and popup blur on in step with the look (off in safe mode, performance mode and high contrast) and puts your previous values back when switched off. Off by default: it changes blur settings you may have chosen yourself.
- **Profiles carry the per-application rules** (`niro.app-rules`, a registered setting): saved, applied, undone, validated on import (an invalid rule is an import error), shown as "N rules" in the preview, and a profile that would remove one of your exclusions says so before it is applied. Profile format version 1 is unchanged.
- **Compatibility manager**: per application the id (window class, never the title), family, status, when a change reaches it (live, restart, login), what can be set, filters, undo per application.

## 2.1: GNOME Shell surfaces

`control/src/shellTheme.ts` (pure, tested) generates one narrow stylesheet, loaded by `NiroSync` when **Look > Universal Appearance > Style the top bar, menus, notifications, Quick Settings and Overview** is on (off by default: it overrides parts of your shell theme). It touches only these selectors: `#panel`, `.popup-menu-content`, `.candidate-popup-content`, `.quick-settings`, `.datemenu-popover`, `.notification-banner`, `.message-list .message`, `.search-entry`, `.app-folder-dialog`, `.switcher-list`, `.workspace-thumbnails .workspace-thumbnail`, and the accent on `.quick-toggle:checked`, `.popup-menu-item:focus/:active` and `.slider`. Backgrounds, borders, shadows and corner radii only: no text colour, no opacity, no transition.

- **Light or dark follows the shell theme, measured.** The extension reads the text colour the shell theme actually draws on each group of surfaces (top bar clock, date menu, Quick Settings, Overview search) and picks a dark or light surface to match, so a theme's text is never put on a background it was not made for (the first attempt, always dark, made a light shell's notification unreadable: that is why). The top bar keeps a dark bar when its own text is light.
- **Solid when it must be**: surfaces are fully opaque in safe mode and the Solid preset; with GNOME high contrast the stylesheet is unloaded and GNOME's own look is left alone; reduced motion needs nothing because the stylesheet has no motion.
- **Accent and tint**: the Look accent colours the checked toggles, the focused menu item and sliders; the Look tint is the dark surface colour when it is dark.
- Verified in a headless shell with the stock Yaru shell, light and dark (`scripts/shell-shots.sh`, `reports/ui/shell`, `reports/ui/shell-dark`) and by `tests/shell/niroSync.sh`. **Not verified**: your own shell theme (MacTahoe-Dark), the date menu and the app grid in the screenshots beyond a look, workspace thumbnails beyond the radius, other extensions' surfaces.
- Island, dock and search already follow the shared opacity, tint and accent; their corner radii and shadows were not changed here.

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
| GTK 3 apps | Limited | The GTK 3 stylesheet of the integration; scheme from the theme name | Seen on a GTK 3 test window only (GNOME Terminal did not start in the headless shell and has its own transparency setting); a theme in `~/.config/gtk-3.0` is applied first | partly tested |
| Chrome / Chromium | Compositor effects only | Blur behind, corners by the shell | Page and toolbar are opaque: only a window fade is possible, and it fades text | documented, not tested here |
| Firefox | Compositor effects only | Same | Styling needs a profile stylesheet, which Niro does not write | documented, not tested here |
| Electron (VS Code and others) | Compositor effects only | Same | Opaque content; a fade also fades text | documented, not tested here (VS Code is not installed here) |
| Qt 5 / Qt 6 | Unsupported | Would need a Qt platform theme (qt5ct, Kvantum) | None is installed here and Niro writes none | documented, not tested here |
| XWayland windows | Compositor effects only | Same | Same | not tested |

The shell side: the island, dock and search follow the shared opacity, tint and accent (existing integration). The top bar, Overview, notifications, quick settings and menus are blurred by the blur extension's own component settings; Universal Appearance does not drive them yet (not claimed).

## Investigated, not implemented

- **Qt 5 / Qt 6**: no Qt platform theme (qt5ct, qt6ct, Kvantum, adwaita-qt) and no Qt platform theme plugin folder is installed on this machine, so nothing could be tried. Installing one changes how every Qt application looks and needs your approval; Niro does not do it.
- **Chrome 157 and Firefox 155** are installed. Both draw opaque page content. The supported routes (Chrome: its own theme/colour; Firefox: a `userChrome.css` after setting `toolkit.legacyUserProfileCustomizations.stylesheets`) edit the application's own profile, which Niro does not touch, and neither gives a see-through page. Only the shell's blur and rounded corners, and the opt-in window fade, apply. None of this was tried here beyond reading the versions.
- **Electron (VS Code)**: not installed here; same position as Chrome. No code is injected into any process and no binary is patched.
- **Per-application blur strength, corner radius, tint and shadow**: not offered, because the blur extension applies one pipeline to all windows and the corner extension keeps global settings; a control that did nothing would be decoration.

## Known limits

- Foreground colours of third-party GTK applications are left to the application. The generated stylesheet follows one colour scheme (the one at install time); if GNOME switches scheme the glass is wrong until Reinstall.
- A compositor can only fade or blur a whole window: it cannot tell content from chrome inside it. That is why a window fade is opt-in per application and says so.
- The blur extension's new code (and the end of the old whole-window fade, which also resets the extension's `opacity` to 255) loads at the next login.
- Custom per-application blur strength and corner radius are not implemented (blur on/off, exclusion and opt-in fade are).
- Performance: see `reports/performance/` (`scripts/benchmark-appearance.sh`).
