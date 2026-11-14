gdbus call --session --dest org.mpris.MediaPlayer2.niro_demo --object-path /org/mpris/MediaPlayer2 --method org.mpris.MediaPlayer2.Player.Play >/dev/null 2>&1
sleep 2; shot x-pill
ev "global.__move(1920, 30); 1" > /dev/null; sleep 0.3; ev "global.__move(1922, 32); 1" > /dev/null; sleep 2; shot x-hover
ev "global.__click(); 1" > /dev/null; sleep 2; shot x-click
ev "global.__move(1500, 1100); 1" > /dev/null; sleep 1.5; shot x-away
