# neru-desktop

Local .deb packages that make Isle, the dock and DigUp's panel part of the system (dpkg owns the files).

- `neru-isle`, `neru-macos-dock`: extensions in /usr/share/gnome-shell/extensions
- `neru-digup-shell`: our digup-shell in place of dig-up's (dpkg-divert), plus the inotify limit
- `neru-desktop-defaults`: /etc/dconf defaults (extensions on, dock favourites)

`./build.sh` (NERU_REV=n bumps the version), then `sudo dpkg -i out/*.deb`. Log out and in to load changes.
