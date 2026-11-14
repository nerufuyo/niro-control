cp "$WORK/seed.log" /tmp/claude-1000/s/seed.log
gsettings get org.gnome.desktop.background picture-uri > /tmp/claude-1000/s/dbg.txt; gsettings get org.gnome.shell favorite-apps >> /tmp/claude-1000/s/dbg.txt; gsettings get org.niro.control accent >> /tmp/claude-1000/s/dbg.txt; ls "$WORK/config/dconf" >> /tmp/claude-1000/s/dbg.txt 2>&1; echo "HOME=$HOME" >> /tmp/claude-1000/s/dbg.txt
dconf read /org/gnome/desktop/background/picture-uri >> /tmp/claude-1000/s/dbg.txt
