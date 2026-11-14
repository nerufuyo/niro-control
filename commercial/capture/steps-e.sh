PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
PLAY Play
niro-control --apply-profile everyday > /tmp/claude-1000/s/apply.log 2>&1; sleep 2.5
appenv env NIRO_NOBANNER=1 NIRO_SIZE=1180x780 NIRO_PAGE=profiles NIRO_BUILTIN_DIR="$NIRO_BUILTIN_DIR" niro-control > /dev/null 2>&1 &
sleep 8; winpos org.niro.control 740 330 2360 1560; ev "global.__move(3700, 200); 1" > /dev/null; sleep 2; shot e-0
ev "global.__move(2128, 968); 1" > /dev/null; sleep 1; shot e-hover
ev "global.__click(); 1" > /dev/null; sleep 2; shot e-dialog
ev "global.__key(0xff0d); 1" > /dev/null; sleep 3.5; shot e-1                      # Enter: the dialog's default response, Apply
ev "global.__move(3700, 200); 1" > /dev/null; sleep 2; shot e-1b
ev "global.__move(1605, 968); 1" > /dev/null; sleep 1; ev "global.__click(); 1" > /dev/null; sleep 2; ev "global.__key(0xff0d); 1" > /dev/null; sleep 3.5
ev "global.__move(3700, 200); 1" > /dev/null; sleep 2; shot e-2
