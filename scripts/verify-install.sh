#!/bin/sh
# Package integrity: every file the installed niro-control package owns exists and matches its recorded md5; the installed
# extension code is identical to the freshly built code. Exit 1 on any mismatch.
set -u
fail=0
dpkg -V niro-control || fail=1
root=$(cd "$(dirname "$0")/.." && pwd)
for ext in search island dock; do
  b="$root/shell/$ext/build"; [ -d "$b" ] || continue
  d=$(ls -d /usr/share/gnome-shell/extensions/$ext@niro.local 2>/dev/null) || continue
  for f in "$b"/*.js; do cmp -s "$f" "$d/$(basename "$f")" || { echo "differs from build: $d/$(basename "$f")"; fail=1; }; done
done
for p in "$root"/control/profiles/*.json; do cmp -s "$p" "/usr/share/niro-control/profiles/$(basename "$p")" || { echo "profile differs: $p"; fail=1; }; done
cmp -s "$root/target/release/island-daemon" /usr/bin/island-daemon || { echo "island-daemon differs from target/release"; fail=1; }
[ $fail = 0 ] && echo "install matches build: ok"
exit $fail
