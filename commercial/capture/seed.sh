# written into this session's private dconf database before the shell starts (nothing of your own settings is read or written)
W="file://$ROOT/commercial/assets/wallpaper.png"
gs() { gsettings "$@"; }
gs set org.gnome.desktop.background picture-uri "$W"; gs set org.gnome.desktop.background picture-uri-dark "$W"; gs set org.gnome.desktop.background picture-options zoom
gs set org.gnome.desktop.interface color-scheme prefer-dark
gs set org.gnome.shell enabled-extensions "['island@niro.local', 'dock@niro.local', 'search@niro.local', 'blur@niro.local', 'corners@niro.local']"
gs set org.gnome.shell favorite-apps "['org.gnome.Nautilus.desktop', 'firefox_firefox.desktop', 'org.gnome.TextEditor.desktop', 'org.gnome.Settings.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.Terminal.desktop']"
gs set org.niro.control accent "'${ACCENT:-#8E9BFF}'"; gs set org.niro.control tint "'${TINT:-#0A1030}'"; gs set org.niro.control opacity ${GLASS:-70}; gs set org.gnome.desktop.interface cursor-blink false; gs set org.niro.control blur true
DS=/usr/share/gnome-shell/extensions/dock@niro.local/schemas
gsettings --schemadir "$DS" set org.gnome.shell.extensions.dock auto-hide false
gsettings --schemadir "$DS" set org.gnome.shell.extensions.dock icon-size ${DOCK_ICON:-60}
gsettings --schemadir "$DS" set org.gnome.shell.extensions.dock magnification-enabled true
BS=/usr/share/gnome-shell/extensions/blur@niro.local/schemas
gsettings --schemadir "$BS" set org.gnome.shell.extensions.blur-my-shell.applications blur true
gsettings --schemadir "$BS" set org.gnome.shell.extensions.blur-my-shell.applications enable-all true
gsettings --schemadir "$BS" set org.gnome.shell.extensions.blur-my-shell.applications blacklist "[]"
gsettings --schemadir "$BS" set org.gnome.shell.extensions.blur-my-shell.applications dynamic-opacity false
