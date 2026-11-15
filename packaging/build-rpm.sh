#!/bin/bash
# Builds out/niro-control-<VERSION>-<commits>.<dist>.<arch>.rpm for Fedora, from every part of the repo.
# Run it through `make rpm`. Same parts as packaging/build.sh; only the packaging differs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
OUT="$ROOT/out"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
VER="$(cat VERSION)"; REL="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
STAGE="$W/stage"; mkdir -p "$OUT" "$STAGE"

# Everything is staged exactly as the .deb does (build.sh stops short of dpkg-deb when asked).
NIRO_STAGE_ONLY="$STAGE" ./packaging/build.sh >/dev/null

mkdir -p "$W/rpmbuild"/{SPECS,BUILD,RPMS,SRPMS}
sed -e "s/@VERSION@/$VER/" -e "s/@RELEASE@/$REL/" packaging/rpm/niro-control.spec > "$W/rpmbuild/SPECS/niro-control.spec"
rpmbuild -bb --define "_topdir $W/rpmbuild" --define "_stagedir $STAGE" "$W/rpmbuild/SPECS/niro-control.spec" >&2
find "$W/rpmbuild/RPMS" -name '*.rpm' -exec cp {} "$OUT"/ \;
ls -t "$OUT"/niro-control-*.rpm | head -1 | sed 's/^/built /'
