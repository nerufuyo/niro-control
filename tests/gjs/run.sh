#!/bin/sh
# Runs the GJS tests against a throw-away settings backend (nothing touches the real settings).
set -e
cd "$(dirname "$0")/../.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
for d in control shell/island/schemas shell/dock/schemas shell/blur/schemas shell/corners/schemas; do
  for f in $d/*.gschema.xml; do cp "$f" "$T/"; done
done
glib-compile-schemas "$T"
GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" gjs -m tests/gjs/blurPipeline.test.js
GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/controlUi.test.js
