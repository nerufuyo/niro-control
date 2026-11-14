# Universal Appearance 2.0: real-session acceptance

**Nothing below has been run in a real session yet.** Every result is "Not Tested" until you (or a session with you at the keyboard) fill it in. Automated and headless evidence is listed separately and is *not* a result.

Before you start: the package `niro-control` current version must be installed, and one **new login** is needed for the shell code (blur extension rules, NiroSync) to load. Do not install the GTK integration without reading the file list it shows; it backs up your gtk.css files first.

| # | Check | How | Expect | Result | Automated / headless evidence |
|---|---|---|---|---|---|
| 1 | Niro Control readability | Open the panel over bright and dark wallpapers; move Look > Opacity 0 to 100 | Text and controls never fade; only the window background changes | Not Tested | contrast tests; headless screenshots |
| 2 | GNOME Files | Install the GTK integration (Compatibility), restart Files | Sidebar and content follow the glass, text readable | Not Tested | headless screenshots (Files) |
| 3 | GNOME Settings | Same | Same | Not Tested | headless screenshots (Settings) |
| 4 | GNOME Text Editor | Same | Same; the source view may stay opaque | Not Tested | headless screenshots (Text Editor) |
| 5 | A GTK 3 application | Restart a real GTK 3 app (for example GNOME Terminal) | Readable; note whether the scheme matches your GTK 3 theme | Not Tested | a GTK 3 test window only |
| 6 | Top bar | Turn on "Blur the top bar, Overview, menus…" | Top bar is blurred and readable | Not Tested | blur switches verified headless (not the look) |
| 7 | Overview | Same, open the Overview | Blurred, readable, nothing missing | Not Tested | switches only |
| 8 | Notifications | Same, trigger one | Blurred popup, readable | Not Tested | switches only |
| 9 | Quick Settings | Same, open the menu | Blurred, readable | Not Tested | switches only |
| 10 | Island | Change Look opacity and tint | Island follows | Not Tested | existing integration |
| 11 | Dock | Same | Dock follows | Not Tested | existing integration |
| 12 | Search | Super+Space after changing Look | Palette follows | Not Tested | existing integration |
| 13 | Profile switching | Save a profile, change a preset and an exclusion, apply the profile, then Undo | Appearance and rules return; the dialog names any exclusion it would remove | Not Tested | node + GJS tests |
| 14 | Application exclusions | Exclude Files in Compatibility | No blur on Files; others unchanged | Not Tested | headless shell test |
| 15 | Light/dark switching | Switch GNOME's appearance in Settings | GTK 4 apps follow after restart; the stylesheet file changes once, not repeatedly | Not Tested | headless shell test |
| 16 | Fullscreen | Fullscreen a video or a browser | No blur artefacts; no flicker | Not Tested | none |
| 17 | Safe mode | Turn it on | Everything solid at once; off restores | Not Tested | headless shell test |
| 18 | Restore defaults | Compatibility > Restore original; Look > Enable system-wide appearance off | gtk.css files byte-identical to before; old look back | Not Tested | GJS test (byte-identical) |
| 19 | Performance monitoring | `top -p $(pgrep -xo gnome-shell)` with and without effects, several windows | No noticeable CPU or lag; note numbers | Not Tested | headless benchmark only |
| 20 | Compatibility Manager | Open it; filter, search, set a rule, undo it; read the status labels | Labels match reality; Window fade only in Advanced, with its warning | Not Tested | GJS UI test |

Record Pass / Fail / Blocked / Not Tested in the Result column, with a line of what you saw.
