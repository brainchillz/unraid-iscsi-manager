#!/bin/bash
# Build ONE self-contained Slackware-style package for the plugin:
#   our files  +  Python 3.9 / targetcli-fb / rtslib-fb runtime  +  libffi.so.7
# so the .plg has a single download and a fresh Unraid box needs nothing else.
#
#   ./build.sh [version]        (default: today's date)
#
# Runtime inputs live in packages/runtime/ (the Slackware builds ich777 made for
# the unraid.iSCSI plugin). They are unpacked, trimmed of things the manager
# never uses (test suite, IDLE, tkinter, pip, gobject, headers, docs) and
# merged under our package name.
set -euo pipefail
cd "$(dirname "$0")"

NAME=iscsi.manager
VER=${1:-$(date +%Y.%m.%d)}
SRC=src
RT=packages/runtime
OUT=packages
PLUGDIR=$SRC/usr/local/emhttp/plugins/$NAME
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

RUNTIME_PKG=$(ls $RT/iSCSI-*-Unraid-*.txz | head -1)
LIBFFI_PKG=$(ls $RT/libffi-*.txz | head -1)
echo "runtime: $RUNTIME_PKG"
echo "libffi : $LIBFFI_PKG"

# ---- 1. unpack runtime + libffi -----------------------------------------------
tar xJf "$RUNTIME_PKG" -C "$STAGE"
tar xJf "$LIBFFI_PKG" -C "$STAGE" --wildcards 'usr/lib64/libffi.so.*'
rm -rf "$STAGE/install"
( cd "$STAGE/usr/lib64" && ln -sf libffi.so.7.1.0 libffi.so.7 )

# ---- 2. trim what the manager / targetcli never need -------------------------
PY=$STAGE/usr/lib/python3.9
rm -rf "$PY"/test "$PY"/config-3.9-* "$PY"/idlelib "$PY"/tkinter "$PY"/turtledemo "$PY"/turtle.py \
       "$PY"/lib2to3 "$PY"/ensurepip "$PY"/pydoc_data
rm -f  "$PY"/lib-dynload/_test* "$PY"/lib-dynload/_tkinter* "$PY"/lib-dynload/xxlimited* "$PY"/lib-dynload/_ctypes_test*
SP=$PY/site-packages
rm -rf "$SP"/pip "$SP"/pip-* "$SP"/setuptools "$SP"/setuptools-* "$SP"/gi "$SP"/cairo "$SP"/pycairo-* \
       "$SP"/pygtkcompat "$SP"/gobject "$SP"/gobject-* "$SP"/PyGObject-* "$SP"/easy_install.py "$SP"/include "$SP"/README.txt
rm -rf "$STAGE"/usr/include "$STAGE"/usr/share "$STAGE"/usr/man "$STAGE"/usr/doc "$STAGE"/usr/info \
       "$STAGE"/usr/lib64/girepository-1.0 "$STAGE"/usr/lib64/gobject-introspection "$STAGE"/usr/lib64/libgirepository* \
       "$STAGE"/usr/lib64/pkgconfig "$STAGE"/usr/lib/pkgconfig
( cd "$STAGE/usr/bin" && rm -f 2to3* easy_install* g-ir-* idle3* pip3* pydoc3* python3-config python3.9-config )
find "$STAGE" -name '*.pyc' -path '*/__pycache__/*' -name '*.opt-*' -delete   # keep plain .pyc, drop -O variants

# ---- 2b. make targetcli's gi (GObject) import optional ------------------------
# targetcli only uses gi/Gio to talk to tcmu-runner over D-Bus for user-space
# backstores, which Unraid does not have. Without this patch `import targetcli`
# fails once the 15 MB GObject/cairo stack is dropped from the package.
python3 -I - "$SP"/targetcli_fb-*.egg <<'PY'
import sys, zipfile, os
egg = sys.argv[1]; tmp = egg + '.new'
old = b'from gi.repository import Gio\n'
new = (b'try:\n    from gi.repository import Gio\n'
       b'except ImportError:  # gi is only needed for tcmu-runner (user backstores)\n    Gio = None\n')
zin = zipfile.ZipFile(egg); zout = zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED); patched = False
for item in zin.infolist():
    if 'ui_backstore' in item.filename and item.filename.endswith('.pyc'):
        continue                      # stale bytecode of the file we patch
    data = zin.read(item.filename)
    if item.filename == 'targetcli/ui_backstore.py':
        assert old in data, 'gi import line not found; targetcli version changed?'
        data = data.replace(old, new); patched = True
    zout.writestr(item, data)
zin.close(); zout.close()
assert patched, 'ui_backstore.py not found in egg'
os.replace(tmp, egg)
print('patched', os.path.basename(egg))
PY
find "$STAGE" -type d -empty -delete

# ---- 3. overlay our plugin files ----------------------------------------------
echo "$VER" > "$PLUGDIR/VERSION"
chmod +x "$PLUGDIR"/event/* "$PLUGDIR"/include/iscsi_ctl.py
cp -a "$SRC"/. "$STAGE"/
mkdir -p "$STAGE/install"
cat > "$STAGE/install/slack-desc" <<DESC
           |-----handy-ruler------------------------------------------------|
$NAME: $NAME (iSCSI target manager for Unraid)
$NAME:
$NAME: Single-page LIO iSCSI target manager for the Unraid webGui, bundled
$NAME: with its runtime: Python 3.9, targetcli-fb 2.1.54, rtslib-fb 2.1.75,
$NAME: configshell-fb 1.1.29 and libffi 3.3 (builds by ich777 for Unraid).
$NAME:
$NAME: Version $VER
$NAME:
DESC

# ---- 4. package ---------------------------------------------------------------
mkdir -p "$OUT"
rm -f "$OUT/$NAME-"*.txz "$OUT/$NAME-"*.txz.md5
tar --owner=root --group=root --numeric-owner --mtime="@$(date +%s)" \
    -cJf "$OUT/$NAME-$VER.txz" -C "$STAGE" .
MD5=$(md5sum "$OUT/$NAME-$VER.txz" | cut -d' ' -f1)
echo "$MD5" > "$OUT/$NAME-$VER.txz.md5"

sed -i -e "s|^<!ENTITY version    \".*\">|<!ENTITY version    \"$VER\">|" \
       -e "s|^<!ENTITY packageMD5 \".*\">|<!ENTITY packageMD5 \"$MD5\">|" "$NAME.plg"

echo "built $OUT/$NAME-$VER.txz ($(( $(stat -c %s "$OUT/$NAME-$VER.txz") / 1048576 )) MB)  md5=$MD5"
echo "plg   $NAME.plg (version $VER)"
