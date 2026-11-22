#!/bin/sh
# Runs the GJS tests against a throw-away settings backend (nothing touches the real settings).
set -e
cd "$(dirname "$0")/../.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
for d in control shell/island/schemas shell/dock/schemas shell/blur/schemas shell/corners/schemas shell/tile/schemas shell/emoji/schemas; do
  for f in $d/*.gschema.xml; do cp "$f" "$T/"; done
done
glib-compile-schemas "$T"
GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" gjs -m tests/gjs/blurPipeline.test.js
gjs -m tests/gjs/slimeDraw.test.js
GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/controlUi.test.js
GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/profiles.test.js
GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/appearance.test.js
# no shell on the bus: the real session's extension (if it runs) must not answer
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent-niro-test-bus GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/tileBackend.test.js
# no shell on the bus: the real session's extension (if it runs) must not answer
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent-niro-test-bus GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/tilingPage.test.js
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent-niro-test-bus GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/appearanceStudio.test.js
# Flow: the backend against a stand-in daemon on a private bus the test starts itself; the page against a fake backend (no real session bus)
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent-niro-test-bus gjs -m tests/gjs/flowBackend.test.js
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent-niro-test-bus GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/flowPage.test.js
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent-niro-test-bus GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/hubPage.test.js
DEEPSEEK_API_KEY= GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/aiConnections.test.js
# Backup & Restore (fake backend and pickers; the real Gio backend on the throw-away schemas) and niro-plugin check
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent-niro-test-bus GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/backupPage.test.js
# Permissions and Connectivity (stand-in Search on a private bus the test starts itself; the pages against fake backends)
DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent-niro-test-bus GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$T" NIRO_SCHEMA_DIR="$T" gjs -m tests/gjs/permissionsPage.test.js
