# Real-session acceptance checklist

Run in a normal GNOME Wayland session after logging in with the current package (`dpkg -s niro-control` shows the version; the Home page's "Log out needed" row must say No). Automated tests and the headless shell cover the logic; only this list covers a real keyboard, real windows and a real compositor. Tick each line and note anything odd.

| # | Check | How | Expect |
|---|---|---|---|
| 1 | Super+Space opens Search | Press it from any app | Palette appears, text field focused; Super+Space again closes it |
| 2 | No shortcut conflict | Press Super+Space; also try the input-source switch you use | Only Search opens; typing languages switch by their own key |
| 3 | Keyboard navigation | Type `set`, then Down, Up, Tab, Ctrl+N/P | The first result is selected at once; selection wraps; the text stays |
| 4 | Esc | Press Esc with text typed | Palette closes |
| 5 | Focus restoration | Focus a text editor, open Search, press Esc | Typing continues in the editor |
| 6 | Hover vs selection | Move the mouse over a row while typing | Hover is a light highlight; the keyboard selection does not jump |
| 7 | Application launch | Type an app name, Enter | The app opens once (not twice) |
| 8 | Window search | Open two windows, type part of a title, Enter | The right window is focused |
| 9 | Calculator | `2*pi+17`, Enter | Result copied; first result of the list |
| 10 | Unit conversion | `20 gb to mb` | Correct result first |
| 11 | Settings navigation | `dock position`, Enter | Control Panel opens on that setting |
| 12 | Profile from Search | `profile gaming`, Enter | Profile applied; a notification confirms |
| 13 | Profile from Home and Profiles | Apply from each | The summary dialog shows headline, areas, expandable old/new values, undo line |
| 14 | Undo | After 12/13 press Undo in the toast (or Profiles > Backups > Restore) | Previous values return, including settings that were never set |
| 15 | Clipboard search | Copy text, type `clip` | The copied text is listed; Enter copies it again |
| 16 | Protected action | `restart` | Enter shows a confirmation; Cancel does nothing; the hint says "Enter asks to confirm" |
| 17 | AI action | Ask the island's assistant to open a setting, then to restart | The setting opens; restart asks for confirmation; an invented action is refused |
| 18 | Duplicate execution | Hold Enter on an app result | One launch only |
| 19 | Settings Health | Open Home | Six rows; states match reality (stop the island service: "Background service" becomes Needs attention) |
| 20 | Recovery | Not easy to stage by hand: run `tests/gjs/profiles.test.js` for the logic; in a session, kill `niro-control --apply-profile gaming` mid-way and reopen Home | A Recovery row offers Restore backup |
| 21 | Log out notice | After installing a new package without logging out | "Log out needed" says which part, with a Log out button |
| 22 | Light and dark | Switch the system theme | Panel and Search stay legible; focus rings visible with Tab |
| 23 | Idle CPU | `top -p $(pgrep -xo gnome-shell)` for a minute with nothing moving | Note the CPU. Two read-only samples on the author's machine gave 17.9% and 2.7% (the first was probably transient load, not reproduced): if yours stays high, bisect with `gnome-extensions disable` one Niro extension at a time |

Nothing in this list has been run by the author yet; the report says so.
