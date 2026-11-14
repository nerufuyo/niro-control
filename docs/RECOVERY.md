# Appearance recovery

Nothing in Universal Appearance can leave the desktop unreadable for good, and none of the ways back needs the graphical Control Panel. Pick the lightest one that works.

## 1. From a terminal in your session (or a TTY, or ssh)

```
niro-control --appearance-status                 # what is on, whether the GTK integration is installed
niro-control --appearance-safe-mode on           # solid surfaces, no effects, immediately (and `off` to go back)
niro-control --appearance-global off             # Universal Appearance off for the panel, the shell parts and GTK
niro-control --appearance-legacy-fade off        # the old whole-window fade (off is the default)
niro-control --appearance-restore-gtk            # removes the GTK integration; gtk.css files come back byte for byte
niro-control --appearance-recover                # all at once: safe mode on, shell surfaces off, old fade off, GTK restored
```

Safe mode and the global switch act within a second on the Control Panel, the Shell stylesheet and the blur extension, and rewrite the GTK stylesheets (GTK applications need a restart). The Shell stylesheet is dropped at once when Safe mode makes it solid, and removed for good when "style the shell" is switched off (`--appearance-recover` does that); until a new login the shell code itself stays loaded.

## 2. Without `niro-control` (it is not starting, or not installed)

```
gsettings set org.niro.control safe-mode true
gsettings set org.niro.control universal-enabled false
gsettings set org.niro.control shell-surfaces false
gsettings set org.niro.control legacy-global-fade false
dconf reset -f /org/niro/control/              # every Niro Look setting back to its default
```

## 3. If a GTK application is unreadable

The GTK integration only exists if you installed it. Remove it:

- `niro-control --appearance-restore-gtk`, or
- delete the block between `/* >>> niro-glass` and `/* <<< niro-glass <<< */` from your `gtk.css` files (`~/.config/gtk-4.0/` and `~/.config/gtk-3.0/`; a symlinked `gtk.css` is edited at its target) and delete `niro-glass.css` next to them, or
- copy the saved original back from `~/.config/niro-control/appearance-backups/<date>/` (made before the first change to each file; the folder's `manifest.json` says which file each copy is).

## 4. If the Shell looks wrong

- Turn Safe mode on (above): the Shell surfaces become opaque. High contrast in GNOME's accessibility settings makes Niro drop its Shell stylesheet altogether.
- Disable the island extension: `gnome-extensions disable island@niro.local` (it unloads the stylesheet at once), or delete `~/.cache/niro/shell-appearance.css` and log in again.
- Last resort, from a TTY (Ctrl+Alt+F3): log in, run `niro-control --appearance-recover`, then `gnome-session-quit --logout` or log in on the graphical TTY again.

## 5. Whole-window fade

Before Universal Appearance every window was faded to about 80%. That is gone by default; the value it had is kept in `legacy-window-opacity`, and `niro-control --appearance-legacy-fade on` brings the old behaviour back (text fades with it).

## What cannot happen

- Niro never edits an application's own files or the user's GTK files without the consent dialog showing the file list, and it keeps a backup first.
- A failed GTK install puts every touched file back before reporting the error.
- Profile Undo restores the previous settings, including per-application rules; an interrupted profile apply is offered for recovery on Home and in `--apply-profile`'s journal.
