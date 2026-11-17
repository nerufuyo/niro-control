#!/bin/bash
# Puts an RPM in the dnf repository that GitHub Pages serves (the gh-pages branch, rpm/), so Fedora users update with `dnf upgrade`.
# usage: scripts/publish-rpm-repo.sh out/niro-control-X.Y.Z-N.fc45.x86_64.rpm   (needs createrepo_c and a push right to the repository)
# The repository is not signed (see "Updating" in the README): it is as trustworthy as the GitHub account that publishes it.
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
mkdir -p "$SITE/rpm"
cp "$RPM" "$SITE/rpm/"
# The three newest stay: an old one a computer still wants is there, the site does not grow for ever.
(cd "$SITE/rpm" && ls -t niro-control-*.rpm | tail -n +4 | xargs -r rm -f)
createrepo_c -q --simple-md-filenames "$SITE/rpm"
cat > "$SITE/niro-control.repo" <<'R'
[niro-control]
name=Niro Control
baseurl=https://nerufuyo.github.io/niro-control/rpm/
enabled=1
gpgcheck=0
repo_gpgcheck=0
metadata_expire=6h
R
touch "$SITE/.nojekyll"
git -C "$SITE" add -A
git -C "$SITE" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" commit -q -m "RPM repository: $(basename "$RPM")"
git -C "$SITE" push -q origin gh-pages
# The first time: ask GitHub to serve the branch (already serving it is an answer too).
gh api -X POST repos/nerufuyo/niro-control/pages -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null 2>&1 || true
echo "published: https://nerufuyo.github.io/niro-control/niro-control.repo"
