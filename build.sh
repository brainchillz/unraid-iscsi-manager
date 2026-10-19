#!/bin/bash
# Build the Slackware-style package for the plugin and stamp the .plg with the
# version and MD5.  Usage: ./build.sh [version]   (default: today's date)
set -euo pipefail
cd "$(dirname "$0")"

NAME=iscsi.manager
VER=${1:-$(date +%Y.%m.%d)}
SRC=src
PLUGDIR=$SRC/usr/local/emhttp/plugins/$NAME
OUT=packages

echo "$VER" > "$PLUGDIR/VERSION"
chmod +x "$PLUGDIR"/event/* "$PLUGDIR"/include/iscsi_ctl.py

mkdir -p "$OUT"
rm -f "$OUT/$NAME-$VER.txz" "$OUT/$NAME-$VER.txz.md5"
# installpkg just untars into /, so a plain tar.xz with root ownership is a valid package.
tar --owner=root --group=root --numeric-owner --mtime="@$(date +%s)" \
    --exclude='*.pyc' --exclude='__pycache__' \
    -cJf "$OUT/$NAME-$VER.txz" -C "$SRC" .
MD5=$(md5sum "$OUT/$NAME-$VER.txz" | cut -d' ' -f1)
echo "$MD5" > "$OUT/$NAME-$VER.txz.md5"

sed -i -e "s|^<!ENTITY version    \".*\">|<!ENTITY version    \"$VER\">|" \
       -e "s|^<!ENTITY packageMD5 \".*\">|<!ENTITY packageMD5 \"$MD5\">|" "$NAME.plg"

echo "built $OUT/$NAME-$VER.txz  md5=$MD5"
echo "plg   $NAME.plg (version $VER)"
