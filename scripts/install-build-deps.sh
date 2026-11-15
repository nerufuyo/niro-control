#!/bin/sh
# Installs what building Niro Control needs, from the distribution's repositories. Fedora: dnf; Debian and Ubuntu: apt.
# Rust is taken from rustup when the distribution's is older than 1.88 (the workspace uses let chains).
set -eu
if command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y rust cargo gcc gcc-c++ cmake clang-devel gtk4-devel libadwaita-devel glib2-devel \
    vulkan-loader-devel glslc rpm-build cpio nodejs npm gjs dconf fontconfig \
    gnome-shell-extension-appindicator gnome-shell-extension-user-theme
elif command -v apt-get >/dev/null 2>&1; then
  sudo apt-get install -y build-essential cmake libclang-dev libgtk-4-dev libvulkan-dev glslc cpio nodejs npm gjs dconf-cli \
    gnome-shell-extensions gnome-shell-extension-appindicator
else
  echo "Unknown distribution: install a Rust toolchain (1.88+), cmake, a C++ compiler, libclang, GTK 4 headers, Node 20+ and gjs." >&2
  exit 1
fi
