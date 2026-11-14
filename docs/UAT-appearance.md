# Universal Appearance 2.1: real-session acceptance

**Nothing here has been run in a real session yet.** Every Result is "Not Tested". The Evidence column lists automated and headless evidence only; it is not a result and is never a reason to mark Pass.

Before you start: package current (`dpkg -s niro-control`), one **new login** done (the shell code is cached per login), and `docs/RECOVERY.md` read once. Do not install the GTK integration before reading its file list. Statuses: Pass / Fail / Blocked / Not Tested.

| # | Area | Expected behaviour | Procedure | Actual result | Evidence available | Status |
|---|---|---|---|---|---|---|
| 1 | Niro Control readability | Text, icons and controls stay solid at every Look opacity; sidebar and content readable over bright and dark wallpapers; window buttons at the left | Open the panel; Look > Opacity 0 to 100 over a bright and a dark wallpaper | _(fill in)_ | contrast tests; headless screenshots `reports/ui/after/` | Not Tested |
| 2 | GNOME Files | With the GTK integration installed and Files restarted: sidebar and content follow the glass, text readable, menus and popovers normal | Compatibility > GTK theme integration > Install…, read the file list, install; restart Files | _(fill in)_ | headless screenshots `reports/ui/gtk/files-*`; popovers/dialogs not shown in the headless test | Not Tested |
| 3 | GNOME Settings | Same | Same; restart Settings | _(fill in)_ | headless screenshots `reports/ui/gtk/settings-*` | Not Tested |
| 4 | GNOME Text Editor | Same; the text area may stay opaque | Same; restart Text Editor | _(fill in)_ | headless screenshots `reports/ui/gtk/editor-*` | Not Tested |
| 5 | A GTK 3 application | Readable; the glass follows the GTK 3 theme's real scheme; if unsure, opaque | Restart a real GTK 3 app (GNOME Terminal, Software); change the GTK theme and restart it | _(fill in)_ | probe test (real GTK 3); a GTK 3 test window screenshot; no real GTK 3 app (GNOME Terminal did not start headless) | Not Tested |
| 6 | Top bar | With "Style the top bar, menus…" on: bar follows the look; text readable; MacTahoe's transparent bar left as it is | Turn the setting on (needs the new login); look at the bar over bright and dark wallpapers | _(fill in)_ | stylesheet verified headless on Yaru and in an isolated MacTahoe-Dark session | Not Tested |
| 7 | Overview | Search entry, workspace thumbnails and folders consistent; native interactions unchanged | Open the Overview, type in search, open an app folder, drag a window to a workspace | _(fill in)_ | headless screenshots `reports/ui/shell*/overview-*`; folders/drag not tested | Not Tested |
| 8 | Application launcher | App grid and folders readable and unchanged in behaviour | Show applications; open and close a folder | _(fill in)_ | headless screenshot `app-grid-*` only | Not Tested |
| 9 | Notifications | Banner readable in light and dark; actions work | Trigger a notification (`notify-send hello`); click its close and an action | _(fill in)_ | headless screenshots `notification-*` | Not Tested |
| 10 | Quick Settings | Menu readable; accent on toggles and sliders; toggles work | Open the menu; toggle Wi-Fi/Do not disturb; move the sliders | _(fill in)_ | headless screenshots `quick-settings-*` | Not Tested |
| 11 | Island | Follows opacity, tint and accent | Change the Look; hover and open the Island | _(fill in)_ | existing integration; no new test | Not Tested |
| 12 | Dock | Follows opacity, tint and accent | Change the Look | _(fill in)_ | existing integration; no new test | Not Tested |
| 13 | Search | Palette follows the Look; same radius, border and shadow as the Shell surfaces; Super+Space, arrows, Enter, Esc | Open Search after changing the Look | _(fill in)_ | tests of the shared edge tokens; earlier palette tests | Not Tested |
| 14 | Theme switching | GTK 4 apps follow GNOME's scheme after a restart; the stylesheet file is rewritten once, not repeatedly; Shell surfaces follow the shell theme | Settings > Appearance: switch Light/Dark; restart a GTK 4 app | _(fill in)_ | headless shell test (scheme, theme, high contrast, unrelated change rewrites nothing) | Not Tested |
| 15 | Profiles | A profile carries preset, surfaces and per-app rules; the dialog names exclusions it would remove; Undo returns everything | Save a profile; change a preset and an exclusion; apply the profile; press Undo | _(fill in)_ | node + GJS tests | Not Tested |
| 16 | Compatibility Manager | Per app: id, family, status (Not verified when unknown), when it applies, what can be set, what is true now; filters; Window fade only in Advanced with its warning; undo per app | Open Compatibility; filter, search, set a rule, undo it; switch Simple/Advanced | _(fill in)_ | GJS UI test; screenshot `reports/ui/compatibility.png` | Not Tested |
| 17 | Per-app exclusion | Excluded app: no blur; others unchanged; an excluded app is not restyled by the Shell | Exclude Files; open it next to another window | _(fill in)_ | headless shell test (blur actor hidden) | Not Tested |
| 18 | Fullscreen behaviour | No blur artefacts, no flicker, no stuck overlay when a video or browser goes fullscreen and back | Play a video fullscreen; leave fullscreen; repeat with the Overview | _(fill in)_ | none | Not Tested |
| 19 | Safe Mode | Everything solid at once (panel, Shell surfaces, GTK stylesheet, blur off); off restores | `niro-control --appearance-safe-mode on` then `off`; also in Look | _(fill in)_ | headless shell test; CLI test | Not Tested |
| 20 | High contrast | Niro drops its Shell stylesheet and goes solid; GNOME's own look is left | Settings > Accessibility > High contrast on and off | _(fill in)_ | headless shell test | Not Tested |
| 21 | Restore and recovery | `--appearance-recover` and Restore original leave gtk.css files byte-identical to the backup; no graphical panel needed | Follow `docs/RECOVERY.md` sections 1 and 3 on a copy of your config first | _(fill in)_ | GJS tests (byte-identical restore, CLI recovery, rollback) | Not Tested |
| 22 | Legacy opacity | First login after the update: windows are opaque; `legacy-window-opacity` holds the old value; the old-fade switch brings it back | `gsettings get org.niro.control legacy-window-opacity`; switch the old fade on and off | _(fill in)_ | unit test; headless shell test | Not Tested |
| 23 | Performance | No noticeable lag or CPU with effects on and several windows | `top -p $(pgrep -xo gnome-shell)` and moving windows with and without effects; note numbers | _(fill in)_ | headless benchmarks only (`reports/performance/`) | Not Tested |

## Expected visual changes after the login

- Windows are no longer faded: apps look more solid than before (text fully opaque). Nothing else changes until you turn a feature on.
- With "Style the top bar, menus, notifications, Quick Settings and Overview" on: popups, notification banners and the Overview search take the shared surfaces and accent; a glass theme such as MacTahoe-Dark keeps its own top bar and Quick Settings.
- With the GTK integration installed (never automatic): GTK application backgrounds take the glass after they are restarted.

## Roll back

See `docs/RECOVERY.md`: `niro-control --appearance-recover` from any terminal, then log in again for the shell.
