# A: desktop, island, dock
PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
ev "global.__move(2800, 1400); 1" > /dev/null
sleep 2; shot d-idle                       # no player yet: the quiet pill
PLAY Play; sleep 3; shot d-pill            # the pill with the album and the live bars
ev "global.__move(1920, 30); 1" > /dev/null; sleep 0.3; ev "global.__move(1923, 33); 1" > /dev/null; sleep 2.5; shot d-open
ev "global.__move(2800, 1300); 1" > /dev/null; sleep 2; shot d-closed
# dock magnification: the pointer sweeps along the dock, one picture per stop
for i in 0 1 2 3 4 5 6 7 8 9 10 11; do X=$((1560 + i * 60)); ev "global.__move($X, 2105); 1" > /dev/null; sleep 0.9; shot m-$(printf %02d $i); done
