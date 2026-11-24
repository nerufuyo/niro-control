#!/bin/bash
# Runs the automated E2E suite in a fresh isolated session and renders the report. usage: tests/e2e/run.sh [outdir]   (needs `npm run build` first)
set -u; cd "$(dirname "$0")/../.."
OUT=${1:-$(mktemp -d)}; mkdir -p "$OUT"
tests/e2e/session.sh "$OUT" python3 tests/e2e/suite.py | tee "$OUT/run.log" | grep -vE "libgoa|Authorization"
python3 tests/e2e/report.py "$OUT/report.md" "$OUT/e2e-results.json" && echo "report: $OUT/report.md"
! grep -qE '^\[(Fail|Blocked)' "$OUT/run.log"
