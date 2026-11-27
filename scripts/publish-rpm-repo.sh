#!/bin/bash
# Puts an RPM in the dnf repository that GitHub Pages serves (the gh-pages branch, rpm/), so Fedora users update with `dnf upgrade`.
# usage: scripts/publish-rpm-repo.sh out/niro-control-X.Y.Z-N.fc45.x86_64.rpm   (needs createrepo_c and a push right to the repository)
# Unsigned unless NIRO_GPG_KEY names a key (its id or e-mail, in the gpg keyring that signs): then the package and the repository's
# metadata are signed, the public key is published beside them, and the .repo file says gpgcheck=1, repo_gpgcheck=1. Unsigned, the
# repository is as trustworthy as the GitHub account that publishes it (see "Updating" in the README). Make a key: scripts/make-signing-key.sh
set -euo pipefail
RPM=$(realpath "$1")
URL=https://github.com/nerufuyo/niro-control.git
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
SITE="$W/site"
if git ls-remote --exit-code --heads "$URL" gh-pages >/dev/null 2>&1; then
    git clone -q --depth 1 --branch gh-pages "$URL" "$SITE"
else
    mkdir "$SITE"; git -C "$SITE" init -q -b gh-pages; git -C "$SITE" remote add origin "$URL"
fi
# A signed repository stays signed: without the key, repomd.xml.asc would go stale and the .repo would turn the checks off.
if [ -z "${NIRO_GPG_KEY:-}" ] && [ -f "$SITE/niro-control.gpg" ]; then
    echo "the published repository is signed: set NIRO_GPG_KEY"; exit 1
fi
mkdir -p "$SITE/rpm"
cp "$RPM" "$SITE/rpm/"
KEY=${NIRO_GPG_KEY:-}
if [ -n "$KEY" ]; then
    command -v rpmsign >/dev/null || { echo "NIRO_GPG_KEY is set but rpmsign is not installed (dnf install rpm-sign)"; exit 1; }
    gpg --list-secret-keys "$KEY" >/dev/null 2>&1 || { echo "no secret key '$KEY' in the keyring"; exit 1; }
    rpmsign --addsign --define "_gpg_name $KEY" "$SITE/rpm/$(basename "$RPM")"
fi
# The three newest stay: an old one a computer still wants is there, the site does not grow for ever.
(cd "$SITE/rpm" && ls -t niro-control-*.rpm | tail -n +4 | xargs -r rm -f)
createrepo_c -q --simple-md-filenames "$SITE/rpm"
CHECK=0
if [ -n "$KEY" ]; then
    rm -f "$SITE/rpm/repodata/repomd.xml.asc"
    gpg --batch --yes --armor --detach-sign --local-user "$KEY" "$SITE/rpm/repodata/repomd.xml"
    gpg --armor --export "$KEY" > "$SITE/niro-control.gpg"
    CHECK=1
fi
{
    echo "[niro-control]"
    echo "name=Niro Control"
    echo "baseurl=https://nerufuyo.github.io/niro-control/rpm/"
    echo "enabled=1"
    echo "gpgcheck=$CHECK"
    echo "repo_gpgcheck=$CHECK"
    [ "$CHECK" = 1 ] && echo "gpgkey=https://nerufuyo.github.io/niro-control/niro-control.gpg"
    echo "metadata_expire=6h"
} > "$SITE/niro-control.repo"
touch "$SITE/.nojekyll"
git -C "$SITE" add -A
git -C "$SITE" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" commit -q -m "RPM repository: $(basename "$RPM")"
git -C "$SITE" push -q origin gh-pages
# The first time: ask GitHub to serve the branch (already serving it is an answer too).
gh api -X POST repos/nerufuyo/niro-control/pages -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null 2>&1 || true
echo "published: https://nerufuyo.github.io/niro-control/niro-control.repo"
