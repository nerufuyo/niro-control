# Reduced motion in a real shell. Three modes, each opened and closed the same way:
#   full     the default: the elastic spring (about 3% overshoot), the axes in turn, the content staggered
#   reduced  the "minimal" preset: the critically damped spring (no overshoot), both axes together, the content all at once
#   off      preset "off", or GNOME's animations switched off: no spring runs, the shape is at its target within a frame
# Judged by tests/shell/island-motion.py (label prefixes full_, reduced_, off_) and tests/shell/island-reveal.py.
source "$HERE/island-steps-lib.sh"
RAW="$OUT/reduced.json"; FR="$OUT/reduced-frames.json"
MP="$C._expanded.pageNamed('music')"
isl_set string auto-hide "'off'"
start_player; sleep 3; PLAY Play; sleep 3
rec_start
frames_start
frames_expr "(function(){ return ($MP._shownPieces() || []).map(a => a.opacity); })()"
cycle() { # name
    rec_label "$1_open"; frames_label "reveal_$1"; ev "$C.expand('music'); 1" > /dev/null; sleep 2.2
    echo "PLAN_$1 $(ev "JSON.stringify($C._island._lastPlan)")"
    rec_label "$1_close"; frames_label "idle_$1"; ev "$C.collapse(); 1" > /dev/null; sleep 2.2
}
echo "MODE_NOW $(ev "JSON.stringify([$C._settings.get_string('motion-preset'), imports.gi.St.Settings.get().enable_animations])")"
cycle full
isl_set string motion-preset "'minimal'"; sleep 0.3; cycle reduced
isl_set string motion-preset "'off'"; sleep 0.3; cycle off
isl_set string motion-preset "'default'"; gsettings set org.gnome.desktop.interface enable-animations false; sleep 0.5
echo "MODE_GNOME $(ev "JSON.stringify([$C._settings.get_string('motion-preset'), imports.gi.St.Settings.get().enable_animations])")"
cycle off_gnome
gsettings set org.gnome.desktop.interface enable-animations true; isl_set string motion-preset "'default'"; sleep 0.5
rec_label end; sleep 0.3
rec_stop "$RAW"; frames_stop "$FR"
python3 "$HERE/island-motion.py" "$RAW"
python3 "$HERE/island-reveal.py" "$FR"
