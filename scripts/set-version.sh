#!/bin/bash
# Sets the one version everywhere it is kept: VERSION (the package's), the Rust workspace and the extension's metadata.json (what Settings
# shows). usage: scripts/set-version.sh 1.2.0
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 X.Y.Z"; exit 1; }
echo "$1" > VERSION
sed -i -E '0,/^version = "[^"]*"/s//version = "'"$1"'"/' Cargo.toml
sed -i -E 's/("version-name": ")[^"]*"/\1'"$1"'"/' shell/island/metadata.json
cargo update --workspace --offline >/dev/null 2>&1 || cargo metadata --offline >/dev/null
echo "version $1"
