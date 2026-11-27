#!/bin/bash
# Publishes a release of the version in VERSION: builds the RPM, makes the GitHub release v<VERSION> with it attached (this is what the
# island's "a newer version is out" looks for), and puts the RPM in the dnf repository.
# usage: NOTES="what changed" scripts/release.sh      (from an up-to-date main; raise VERSION first: scripts/set-version.sh X.Y.Z)
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(tr -d '[:space:]' < VERSION); TAG="v$VER"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "release from main"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "the working tree is not clean"; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main is not origin/main"; exit 1; }
if gh release view "$TAG" >/dev/null 2>&1; then echo "$TAG is already released: raise VERSION first"; exit 1; fi
# The same refusal as publish-rpm-repo.sh, here before there is a GitHub release to be left half done.
if [ -z "${NIRO_GPG_KEY:-}" ] && git fetch -q origin gh-pages 2>/dev/null && git cat-file -e FETCH_HEAD:niro-control.gpg 2>/dev/null; then
    echo "the published repository is signed: set NIRO_GPG_KEY"; exit 1
fi
# A key that cannot sign (no rpmsign, no secret key, no passphrase) must stop here, not after the GitHub release exists.
if [ -n "${NIRO_GPG_KEY:-}" ]; then
    command -v rpmsign >/dev/null || { echo "NIRO_GPG_KEY is set but rpmsign is not installed (dnf install rpm-sign)"; exit 1; }
    echo test | gpg --local-user "$NIRO_GPG_KEY" --detach-sign >/dev/null || { echo "cannot sign with $NIRO_GPG_KEY"; exit 1; }
fi
make test      # npm test and the Rust tests
make rpm
RPM=$(ls -t out/niro-control-"$VER"-*.rpm | head -1)
gh release create "$TAG" "$RPM" --target main --title "Niro Control $VER" --notes "${NOTES:-Niro Control $VER}"
scripts/publish-rpm-repo.sh "$RPM"
