#!/bin/bash
# Build, stamp, commit, tag and publish a release on GitHub.
#   ./release.sh [version]        (default: today's date, e.g. 2026.10.19)
# Needs `gh` authenticated for the repo owner. The .plg committed to main points
# at releases/download/<version>/, so the tag and the version must match.
set -euo pipefail
cd "$(dirname "$0")"
NAME=iscsi.manager
VER=${1:-$(date +%Y.%m.%d)}
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

./build.sh "$VER"
PKG=packages/$NAME-$VER.txz

# release notes = the top section of <CHANGES> in the .plg
NOTES=$(awk '/<CHANGES>/{f=1;next} /<\/CHANGES>/{f=0} f' "$NAME.plg" | awk 'NR==1 || !/^###/{print} /^###/ && NR>1{exit}')

git add "$NAME.plg" README.md
git commit -q -m "Release $VER" || true
git tag -f "$VER"
git push origin main
git push -f origin "$VER"
if gh release view "$VER" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$VER" "$PKG" "$PKG.md5" --clobber --repo "$REPO"
else
  gh release create "$VER" "$PKG" "$PKG.md5" --title "$NAME $VER" --notes "$NOTES" --repo "$REPO"
fi
echo "released $VER: https://github.com/$REPO/releases/tag/$VER"
echo "install URL: https://raw.githubusercontent.com/$REPO/main/$NAME.plg"
