#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 zickrian
# Removes everything install.sh and island-setup-voice put in place. Your shelf, clipboard history,
# tasks, timer settings and app usage in ~/.local/share/island are kept; delete that folder to remove them.
set -uo pipefail

UUID="island@niro.local"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
# A system-wide package (.deb, .rpm, AUR) stays in use: it keeps the extension on and the voice set-up.
SYSTEM=0
[ -d "/usr/share/gnome-shell/extensions/$UUID" ] && SYSTEM=1

if [ "$SYSTEM" = 0 ]; then
    gnome-extensions disable "$UUID" 2>/dev/null
    # Drop it from the enabled list, in case GNOME Shell never loaded it, and from the disabled
    # one, where disabling put it: left there, it would keep a later install off.
    for key in enabled-extensions disabled-extensions; do
        current=$(gsettings get org.gnome.shell "$key")
        updated=$(printf '%s' "$current" | sed -e "s/, '$UUID'//" -e "s/'$UUID', //" -e "s/\['$UUID'\]/@as []/")
        [ "$updated" != "$current" ] && gsettings set org.gnome.shell "$key" "$updated"
    done
fi
systemctl --user disable --now island-daemon.service 2>/dev/null
# Without a user service manager (install.sh allows that) the disable still succeeds, but D-Bus started
# island-daemon, which would run on from its deleted file.
pkill -u "$(id -u)" -x island-daemon 2>/dev/null
pkill -x island-shelf 2>/dev/null

rm -rf "$DATA/gnome-shell/extensions/$UUID" "$DATA/doc/island" "$DATA/fonts/island"
fc-cache "$DATA/fonts" >/dev/null 2>&1
if [ "$SYSTEM" = 0 ]; then
    # The voice assistant's speech models (and an older setup's Python venv, up to 3 GB with CUDA), Island's
    # caches and its AIs' own homes.
    rm -rf "$DATA/island/models" "$DATA/island/voice-venv" "$DATA/island/island-whisper.py" "$DATA/island/assistant" "$DATA/island/codex" \
           "$DATA/island/agy" "$DATA/island/grok" "$DATA/island/opencode" "$DATA/island/claude-sign-in.json" \
           "$DATA/island/updates.json" "$DATA/island/install.lock" \
           "${XDG_CACHE_HOME:-$HOME/.cache}/island" "${XDG_RUNTIME_DIR:-/nonexistent}/island-covers"
    # The battery charge limit, set with island-charge-limit, would outlive Island: lifted (asks for the password).
    if [ -e /etc/systemd/system/island-charge-limit.service ]; then
        echo "Lifting the battery charge limit Island set (sudo asks for your password)."
        sudo systemctl disable --now island-charge-limit.service 2>/dev/null
        sudo rm -f /etc/systemd/system/island-charge-limit.service
        sudo systemctl daemon-reload 2>/dev/null
        for file in /sys/class/power_supply/BAT*/charge_control_end_threshold; do
            [ -e "$file" ] && echo 100 | sudo tee "$file" >/dev/null
        done
    fi
fi
# The AI alerts' hooks in Claude Code's and Codex's own settings would run an island-daemon that is gone.
[ -x "$HOME/.local/bin/island-daemon" ] && "$HOME/.local/bin/island-daemon" --unhook-all 2>/dev/null
rm -f "$HOME/.local/bin/island-daemon" "$HOME/.local/bin/island-shelf" "$HOME/.local/bin/island-whisper" "$HOME/.local/bin/island-charge-limit" \
      "$HOME/.local/bin/island-setup-voice" "$HOME/.local/bin/island-uninstall" \
      "$DATA/dbus-1/services/org.niro.island.Daemon.service" \
      "$DATA/dbus-1/services/org.niro.island.ShelfWindow.service" \
      "$DATA/dbus-1/services/io.github.island.Daemon.service" \
      "$DATA/dbus-1/services/io.github.island.ShelfWindow.service" \
      "$CONFIG/systemd/user/island-daemon.service"
systemctl --user daemon-reload 2>/dev/null
if [ "$SYSTEM" = 1 ]; then
    echo "Island in your home folder has been removed; the system-wide package now runs instead (remove it with apt, dnf or pacman)."
    exit 0
fi
echo "Island has been removed."
HUB="${HF_HUB_CACHE:-${HF_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/huggingface}/hub}"
if ls -d "$HUB"/models--Systran--faster-whisper-* >/dev/null 2>&1; then
    echo "An older speech model stays in $HUB (models--Systran--faster-whisper-*); delete it to free its space."
fi
