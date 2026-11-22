# The island's surface in a real shell: geometry every frame through Compact -> Expanded -> Immersive -> Split -> Dismiss, and through
# interrupted transitions, with the springs' value and velocity read at the instant of each interruption.
source "$HERE/island-steps-lib.sh"
RAW="$OUT/motion.json"
isl_set string auto-hide "'off'"
start_player; sleep 3; PLAY Play; sleep 3
echo "BOOT $(ev "$C._surface.state + '/' + $C._presentation + ' activities=' + $C._compact.activityCount")"
rec_start
rec_label compact_idle; sleep 1
rec_label to_expanded; ev "$C.expand('music'); 1" > /dev/null; shots shot-expanding 5; sleep 2.5; shot shot-expanded
rec_label to_immersive; ev "$C._openVoice({typing: true}); 1" > /dev/null; shots shot-immersive-in 3; sleep 2.5; shot shot-immersive
echo "IMMERSIVE $(ev "$C._surface.state + '/' + $C._presentation")"
rec_label immersive_to_compact; ev "$C.collapse(); 1" > /dev/null; sleep 2.5
rec_label to_split; ev "$C._daemon.call('pomodoro', 'Start'); 1" > /dev/null; shots shot-split-in 4; sleep 2.5; shot shot-split
echo "SPLIT $(ev "$C._surface.state + '/' + $C._presentation + ' activities=' + $C._compact.activityCount")"
rec_label split_to_expanded; ev "$C.expand('timer'); 1" > /dev/null; sleep 2.5
rec_label expanded_to_split; ev "$C.collapse(); 1" > /dev/null; sleep 2.5
rec_label to_dismiss; isl_set int auto-hide-delay 1; isl_set string auto-hide "'always'"
# the auto-hide slide moves the layers (lift, opacity), not the springs: sampled while it runs
for i in $(seq 1 14); do echo "DISMISS_$i $(ev "$C._surface.state + ' lift=' + $C._island._lift + ' opacity=' + $C._island.opacity")"; sleep 0.2; done
shot shot-dismissed
echo "DISMISSED $(ev "$C._surface.state + '/' + $C._presentation + ' hidden=' + $C._autoHidden")"
rec_label from_dismiss; isl_set string auto-hide "'off'"; sleep 2.5
echo "BACK $(ev "$C._surface.state + '/' + $C._presentation")"
rec_label split_end; ev "$C._daemon.call('pomodoro', 'Stop'); 1" > /dev/null; sleep 2.5
echo "WHOLE $(ev "$C._surface.state + ' activities=' + $C._compact.activityCount")"
# ---- interruption: the springs' value and velocity just before and just after a retarget, in one call (no frame between)
SNAP="(function(){ const i = $C._island; return [i._width.value, i._height.value, i._width.velocity, i._height.velocity]; })()"
rec_label interrupt_expand_collapse
ev "$C.expand('music'); 1" > /dev/null; sleep 0.14
echo "RETARGET1 $(ev "(function(){ const b = $SNAP; $C.collapse(); const a = $SNAP; return JSON.stringify({before: b, after: a}); })()")"
sleep 2.5
rec_label interrupt_collapse_expand
ev "$C.expand('music'); 1" > /dev/null; sleep 2.5
ev "$C.collapse(); 1" > /dev/null; sleep 0.16
echo "RETARGET2 $(ev "(function(){ const b = $SNAP; $C.expand('music'); const a = $SNAP; return JSON.stringify({before: b, after: a}); })()")"
sleep 2.5
rec_label interrupt_flurry
for i in 1 2 3; do ev "$C.expand('music'); 1" > /dev/null; sleep 0.1; ev "$C.collapse(); 1" > /dev/null; sleep 0.1; done; sleep 2.5
rec_label end; sleep 0.5
rec_stop "$RAW"
echo "TRANSITIONS $(ev "JSON.stringify($C._surfaceLog.map(e => e.from + '>' + e.to))")"
python3 "$HERE/island-motion.py" "$RAW"
