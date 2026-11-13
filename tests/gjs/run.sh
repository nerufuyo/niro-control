#!/bin/sh
# Runs the GJS tests against a throw-away settings backend (nothing touches the real settings).
set -e
cd "$(dirname "$0")/../.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
glib-compile-schemas --targetdir="$T" shell/blur/schemas
GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" gjs -m tests/gjs/blurPipeline.test.js
