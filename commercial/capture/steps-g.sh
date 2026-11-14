PLAY() { gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.$1 >/dev/null 2>&1; }
ev "global.__move(2800, 1400); 1" > /dev/null
PLAY Pause; sleep 3; shot g-pill-paused
ev "global.__move(1920, 30); 1" > /dev/null; sleep 0.3; ev "global.__move(1923, 33); 1" > /dev/null; sleep 2.5; shot g-open-paused
ev "global.__move(2800, 1300); 1" > /dev/null; sleep 1.5
PLAY Play; sleep 2; ev "global.__move(1920, 30); 1" > /dev/null; sleep 0.3; ev "global.__move(1923, 33); 1" > /dev/null; sleep 2.5; shot g-open-playing
ev "global.__move(2800, 1300); 1" > /dev/null; sleep 2; shot g-pill-playing
