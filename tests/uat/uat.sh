#!/bin/bash
# Desktop UAT helper: a reversible install of THIS checkout's island, dock and search into the user's own extension folder, the rollback,
# an environment report, and two passive recorders (journal, idle CPU). It never uses sudo, never touches /usr or the installed package,
# never pushes anything, and never enables or disables an extension: that stays your decision (see docs/motion/uat/README.md).
#
#   uat.sh preflight                 what is installed and running, what would change, what will block a scenario on this machine
#   uat.sh install [--build] [--dry-run]
#   uat.sh rollback [--restore-settings] [--restore-enabled] [--dry-run]
#   uat.sh status
#   uat.sh env                       writes ~/niro-uat/env-<time>.txt (versions, monitors, scale, refresh rate, GPU, extensions, settings)
#   uat.sh journal [seconds]         follows the shell's journal into ~/niro-uat/journal-<time>.log and prints the error count at the end
#   uat.sh idle [seconds]            gnome-shell CPU% over the interval with the desktop still (0-2% expected)
#
# Why a user-folder copy works: GNOME loads ~/.local/share/gnome-shell/extensions/<uuid> in preference to /usr/share/... for the same uuid,
# so the installed package stays intact underneath and rolling back is deleting three folders. Wayland cannot reload JavaScript in a running
# shell, so install and rollback both take effect at the next login.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"; STATE="${XDG_STATE_HOME:-$HOME/.local/state}"
EXTDIR="$DATA/gnome-shell/extensions"; UATSTATE="$STATE/niro-uat"; OUTDIR="$HOME/niro-uat"
UUIDS=(island@niro.local dock@niro.local search@niro.local)
EXPECT_HEAD="${UAT_EXPECT_HEAD:-ef887b0}"
DRY=0; BUILD=0; RESTORE_SETTINGS=0; RESTORE_ENABLED=0
say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
run() { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }

parse() { for a in "$@"; do case "$a" in --dry-run) DRY=1;; --build) BUILD=1;; --restore-settings) RESTORE_SETTINGS=1;; --restore-enabled) RESTORE_ENABLED=1;; esac; done; }

src_of() {   # source folder of each artefact set, laid out like tests/shell/stage.sh does
    case "$1" in island@niro.local) echo shell/island;; dock@niro.local) echo shell/dock;; search@niro.local) echo shell/search;; esac
}

stage_ext() {   # stage_ext <uuid> <target dir>   (same layout as tests/shell/stage.sh and packaging/build.sh)
    local u=$1 X=$2; cd "$ROOT"
    mkdir -p "$X"
    case "$u" in
    island@niro.local)
        (cd shell/island && find . -type f ! -name '*.ts' ! -name tsconfig.json ! -name gschemas.compiled ! -path './build/*' -print0 | cpio -0pdm "$X" 2>/dev/null)
        cp -r shell/island/build/. "$X/"; mkdir -p "$X/src/shared"; cp shell/shared/tokens.js shell/shared/motionEngine.js "$X/src/shared/";;
    dock@niro.local)
        cp -r shell/dock/dist/. "$X/"; cp shell/dock/metadata.json shell/dock/stylesheet.css "$X/"; cp -r shell/dock/schemas "$X/"
        mkdir -p "$X/shared"; cp shell/shared/motionEngine.js "$X/shared/";;
    search@niro.local)
        cp shell/search/build/*.js shell/search/metadata.json shell/search/stylesheet.css "$X/"
        mkdir -p "$X/shared"; cp shell/shared/*.js "$X/shared/";;
    esac
    rm -f "$X/schemas/gschemas.compiled"; [ -d "$X/schemas" ] && glib-compile-schemas "$X/schemas"
    return 0
}

rpm_ver() { rpm -q --qf '%{VERSION}-%{RELEASE}' niro-control 2>/dev/null || dpkg-query -W -f='${Version}' niro-control 2>/dev/null || echo "not installed from a package"; }

build_fresh() {   # 0 when every build dir exists and is newer than the newest source
    local ok=0 d newest built
    for d in island dock search; do
        case $d in dock) built=shell/dock/dist/extension.js;; *) built=shell/$d/build/extension.js;; esac
        [ -f "$ROOT/$built" ] || { warn "$built is missing: run 'npm run build' (or install --build)"; ok=1; continue; }
        newest=$(find "$ROOT/shell/$d" "$ROOT/shell/shared" \( -name '*.ts' -o -name '*.js' \) ! -path '*/build/*' ! -path '*/dist/*' ! -path '*/node_modules/*' -newer "$ROOT/$built" -print -quit)
        [ -z "$newest" ] || { warn "$newest is newer than $built: the build is stale"; ok=1; }
    done
    return $ok
}

cmd_preflight() {
    cd "$ROOT"
    say "== checkout"; say "branch $(git rev-parse --abbrev-ref HEAD)  HEAD $(git rev-parse --short HEAD)  (UAT is written for $EXPECT_HEAD)"
    case "$(git rev-parse HEAD)" in "$EXPECT_HEAD"*) ;; *) warn "HEAD is not $EXPECT_HEAD: evidence from this run does not describe the reviewed build";; esac
    [ -z "$(git status --porcelain)" ] || warn "working tree is not clean: record what differs in the UAT report"
    build_fresh && say "build: present and newer than the sources" || true
    say "== running session"
    say "session type: ${XDG_SESSION_TYPE:-?}  shell: $(gnome-shell --version 2>/dev/null || echo ?)  package: $(rpm_ver)  repo VERSION: $(cat VERSION)"
    [ "${XDG_SESSION_TYPE:-}" = wayland ] || warn "not a Wayland session: shell-restart scenarios and screencast behave differently; note it in the report"
    say "enabled: $(gsettings get org.gnome.shell enabled-extensions)"
    say "disable-user-extensions: $(gsettings get org.gnome.shell disable-user-extensions)"
    for u in "${UUIDS[@]}"; do
        if [ -d "$EXTDIR/$u" ]; then say "user copy present: $EXTDIR/$u ($( [ -f "$EXTDIR/$u/.niro-uat" ] && echo 'installed by uat.sh' || echo 'NOT installed by uat.sh: install will move it aside'))"; fi
        say "$u: $(gnome-extensions info "$u" 2>/dev/null | grep -E 'State|Version|Path' | tr '\n' ' ' || true)"
    done
    say "== what blocks scenarios on this machine (environment limitations, not failures)"
    env_blockers
}

monitors_json() {   # one line per logical monitor: connector x y scale refresh
    python3 - <<'PY' 2>/dev/null || true
import gi
from gi.repository import Gio
b = Gio.bus_get_sync(Gio.BusType.SESSION, None)
r = b.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None, None, 0, -1, None).unpack()
mons = {m[0][0]: m for m in r[1]}
for l in r[2]:
    for ref in l[5]:
        m = mons[ref[0]]
        cur = [md for md in m[1] if md[6].get('is-current')]
        md = cur[0] if cur else m[1][0]
        print(f"{ref[0]} {md[1]}x{md[2]} @{md[3]:.2f}Hz scale {l[2]:g} at {l[0]},{l[1]} {'primary' if l[4] else ''} {m[2].get('display-name', '')}")
PY
}

env_blockers() {
    local lines n hz maxhz scales
    lines=$(monitors_json); n=$(printf '%s\n' "$lines" | grep -c . || true)
    [ -n "$lines" ] && printf '%s\n' "$lines" | sed 's/^/monitor: /' || warn "could not read monitors from Mutter"
    [ "$n" -ge 2 ] || say "BLOCKED-ENV: one monitor only -> multi-monitor scenarios (UAT-MM-*) and mixed scaling need a second display"
    scales=$(printf '%s\n' "$lines" | grep -oP 'scale \K[0-9.]+' | sort -u | tr '\n' ' ')
    case " $scales" in *" 2 "*|*" 1.5 "*|*" 1.25 "*|*" 1.75 "*) ;; *) say "BLOCKED-ENV: every monitor is at scale 1 -> HiDPI scenarios (UAT-HD-*) need Settings > Displays > Scale 200% (and 125%)";; esac
    maxhz=$(printf '%s\n' "$lines" | grep -oP '@\K[0-9]+' | sort -n | tail -1)
    [ "${maxhz:-0}" -gt 70 ] || say "NOTE: highest refresh rate is ${maxhz:-?} Hz -> the 120/144 Hz pacing run (UAT-FP-03) is blocked unless another display provides it"
    command -v ffmpeg >/dev/null || say "BLOCKED-ENV: ffmpeg missing -> video frame analysis unavailable"
    [ "$(id -u)" = 0 ] || id -nG | grep -qw input || say "NOTE: not in the 'input' group -> 'libinput debug-events' cannot time raw key events; the in-shell probe and the phone video are the methods"
}

cmd_install() {
    parse "$@"; cd "$ROOT"
    [ "$BUILD" = 1 ] && { say "building"; run npm run --silent build; }
    [ "$DRY" = 1 ] || build_fresh || { say "refusing to install a stale or missing build (run: tests/uat/uat.sh install --build)"; exit 1; }
    local id; id="$(date +%Y%m%d-%H%M%S)"; local B="$UATSTATE/$id"
    say "run id $id; backup and manifest in $B"
    run mkdir -p "$B/moved" "$EXTDIR"
    if [ "$DRY" = 0 ]; then
        gsettings get org.gnome.shell enabled-extensions > "$B/enabled-extensions"
        gsettings get org.gnome.shell disable-user-extensions > "$B/disable-user-extensions"
        dconf dump /org/gnome/shell/extensions/ > "$B/dconf-extensions.ini" 2>/dev/null || warn "dconf dump failed: settings are not backed up"
        { echo "head $(git rev-parse HEAD)"; echo "branch $(git rev-parse --abbrev-ref HEAD)"; echo "package $(rpm_ver)"; echo "repo_version $(cat VERSION)"; date -Is; } > "$B/manifest.txt"
        echo "$id" > "$UATSTATE/current"
    fi
    for u in "${UUIDS[@]}"; do
        if [ -d "$EXTDIR/$u" ] && [ ! -f "$EXTDIR/$u/.niro-uat" ]; then say "moving your existing $u aside"; run mv "$EXTDIR/$u" "$B/moved/$u"; fi
        say "installing $u"
        if [ "$DRY" = 1 ]; then say "  [dry-run] stage $u into $EXTDIR/$u"; continue; fi
        rm -rf "$EXTDIR/$u"; stage_ext "$u" "$EXTDIR/$u"
        echo "$id" > "$EXTDIR/$u/.niro-uat"
        (cd "$EXTDIR/$u" && find . -type f ! -name .niro-uat -print0 | sort -z | xargs -0 sha256sum) > "$B/$u.sha256"
    done
    say
    [ "$DRY" = 1 ] && { say "Dry run: nothing was changed."; return 0; }
    say "Installed (not enabled or disabled: enabled-extensions is unchanged). Log out and back in for the new code to load."
    say "Rollback any time:  tests/uat/uat.sh rollback     Emergency from a TTY:  rm -rf $EXTDIR/{island,dock,search}@niro.local"
    say "Kill switch if the session misbehaves at login:  gsettings set org.gnome.shell disable-user-extensions true"
}

cmd_rollback() {
    parse "$@"
    local id B; id="$(cat "$UATSTATE/current" 2>/dev/null || true)"; B="$UATSTATE/$id"
    for u in "${UUIDS[@]}"; do
        if [ -f "$EXTDIR/$u/.niro-uat" ]; then say "removing the UAT copy of $u"; run rm -rf "$EXTDIR/$u"
        elif [ -d "$EXTDIR/$u" ]; then say "$u in the user folder was not installed by uat.sh: leaving it"; fi
        if [ -n "$id" ] && [ -d "$B/moved/$u" ]; then say "restoring your earlier $u"; run mv "$B/moved/$u" "$EXTDIR/$u"; fi
    done
    if [ "$RESTORE_ENABLED" = 1 ] && [ -f "$B/enabled-extensions" ]; then say "restoring enabled-extensions"; run gsettings set org.gnome.shell enabled-extensions "$(cat "$B/enabled-extensions")"; fi
    if [ "$RESTORE_SETTINGS" = 1 ] && [ -f "$B/dconf-extensions.ini" ]; then say "restoring extension settings (dconf load)"; if [ "$DRY" = 1 ]; then say "  [dry-run] dconf load /org/gnome/shell/extensions/ < $B/dconf-extensions.ini"; else dconf load /org/gnome/shell/extensions/ < "$B/dconf-extensions.ini"; fi; fi
    say "Rolled back. Log out and in so the shell loads the packaged versions again. Settings and enabled list were left alone unless you passed --restore-*."
}

cmd_status() {
    say "state dir: $UATSTATE  current run: $(cat "$UATSTATE/current" 2>/dev/null || echo none)"
    for u in "${UUIDS[@]}"; do
        if [ -f "$EXTDIR/$u/.niro-uat" ]; then
            local B="$UATSTATE/$(cat "$EXTDIR/$u/.niro-uat")"
            if [ -f "$B/$u.sha256" ] && (cd "$EXTDIR/$u" && sha256sum --quiet -c "$B/$u.sha256" 2>/dev/null); then say "$u: UAT copy, files match the manifest"; else say "$u: UAT copy, files DIFFER from the manifest (or manifest missing)"; fi
        elif [ -d "$EXTDIR/$u" ]; then say "$u: user copy not from uat.sh"; else say "$u: packaged version"; fi
    done
}

cmd_env() {
    mkdir -p "$OUTDIR"; local f="$OUTDIR/env-$(date +%Y%m%d-%H%M%S).txt"
    {
        echo "# UAT environment $(date -Is)"
        echo "kernel $(uname -r)"; echo "distro $(. /etc/os-release; echo "$PRETTY_NAME")"
        echo "session ${XDG_SESSION_TYPE:-?} desktop ${XDG_CURRENT_DESKTOP:-?}"; gnome-shell --version 2>/dev/null || true
        echo "mutter/gjs: $(rpm -q mutter gjs 2>/dev/null | tr '\n' ' ')"
        echo "package: $(rpm_ver)  repo: $(cat "$ROOT/VERSION")  head: $(git -C "$ROOT" rev-parse --short HEAD)  dirty: $(git -C "$ROOT" status --porcelain | wc -l) files"
        echo "## GPU"; lspci 2>/dev/null | grep -Ei 'vga|3d|display' || true
        glxinfo -B 2>/dev/null | grep -E 'OpenGL (renderer|version)|Device|Vendor' || true
        echo "## monitors (Mutter DisplayConfig)"; monitors_json
        echo "## input"; echo "layout/sources: $(gsettings get org.gnome.desktop.input-sources sources)"; echo "input group: $(id -nG | grep -qw input && echo yes || echo no)"
        echo "## desktop settings"
        for k in enable-animations color-scheme text-scaling-factor; do echo "interface $k: $(gsettings get org.gnome.desktop.interface $k 2>/dev/null)"; done
        echo "workspaces dynamic: $(gsettings get org.gnome.mutter dynamic-workspaces 2>/dev/null)  experimental: $(gsettings get org.gnome.mutter experimental-features 2>/dev/null)"
        echo "## extensions"; echo "enabled: $(gsettings get org.gnome.shell enabled-extensions)"
        for u in "${UUIDS[@]}"; do echo "$u: $(gnome-extensions info "$u" 2>/dev/null | tr '\n' ' ')"; done
        echo "## extension settings that change motion"; dconf dump /org/gnome/shell/extensions/ 2>/dev/null | grep -Ei 'motion|preset|slow|animation|magnif|^\[' || true
        echo "## other extensions that draw on the shell (can distort pacing)"; gsettings get org.gnome.shell enabled-extensions | tr ',' '\n' | grep -v niro.local | tr -d " []'" || true
        echo "## load: $(cut -d' ' -f1-3 /proc/loadavg)"
        echo "## blockers on this machine"; env_blockers 2>&1
    } > "$f"
    say "$f"; cat "$f"
}

cmd_journal() {
    local secs="${1:-0}"; mkdir -p "$OUTDIR"; local f="$OUTDIR/journal-$(date +%Y%m%d-%H%M%S).log"
    say "following gnome-shell into $f ${secs:+for ${secs}s} (Ctrl+C to stop)"
    local since; since="$(date '+%Y-%m-%d %H:%M:%S')"
    if [ "$secs" -gt 0 ] 2>/dev/null; then timeout "$secs" journalctl --user -f -o short-iso _COMM=gnome-shell > "$f" 2>&1 || true
    else trap : INT; journalctl --user -f -o short-iso _COMM=gnome-shell > "$f" 2>&1 || true; fi
    # the same counting rule the headless tests use, plus the niro prefix of the probe
    say "since $since"
    say "errors: $(grep -cE 'JS ERROR|Gjs-CRITICAL|TypeError|ReferenceError|JS WARNING' "$f" || true)  (lines in $f)"
    grep -E 'JS ERROR|Gjs-CRITICAL|TypeError|ReferenceError|JS WARNING' "$f" | head -20 || true
}

cmd_idle() {
    local secs="${1:-20}" pid; pid="$(pgrep -u "$(id -u)" -x gnome-shell | head -1)"; [ -n "$pid" ] || { say "gnome-shell not found"; exit 1; }
    local hz; hz="$(getconf CLK_TCK)"
    local a b; a=$(awk '{print $14+$15}' "/proc/$pid/stat"); local t0; t0=$(date +%s.%N)
    sleep "$secs"
    b=$(awk '{print $14+$15}' "/proc/$pid/stat"); local t1; t1=$(date +%s.%N)
    awk -v a="$a" -v b="$b" -v t0="$t0" -v t1="$t1" -v hz="$hz" -v pid="$pid" 'BEGIN{printf "gnome-shell pid %s: %.2f %% of one core over %.1f s (desktop must be still; expect about 0-2 %%)\n", pid, (b-a)/hz/(t1-t0)*100, t1-t0}'
}

sub="${1:-}"; shift || true
case "$sub" in
    preflight) cmd_preflight;; install) cmd_install "$@";; rollback) cmd_rollback "$@";; status) cmd_status;;
    env) cmd_env;; journal) cmd_journal "$@";; idle) cmd_idle "$@";;
    *) sed -n '2,17p' "$0"; exit 2;;
esac
