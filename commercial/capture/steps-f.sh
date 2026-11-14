PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
PLAY Play
appenv gnome-text-editor /tmp/Studio/notes.md > /dev/null 2>&1 &
sleep 7; winpos texteditor 1960 520 1500 1050
appenv nautilus --new-window /tmp/Studio > /dev/null 2>&1 &
sleep 7; winpos nautilus 520 700 1700 1100
ev "global.__move(3700, 200); 1" > /dev/null
niro-control --apply-profile everyday > /dev/null 2>&1; sleep 4; shot f-everyday
niro-control --apply-profile deep-work > /dev/null 2>&1; sleep 5; shot f-deepwork
niro-control --apply-profile everyday > /dev/null 2>&1; sleep 4; shot f-everyday2
