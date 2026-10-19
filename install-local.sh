#!/bin/bash
# Build the package and install it on an Unraid box through Unraid's own plugin
# installer, without the repo being published anywhere: the package is copied
# to the flash drive first, so the installer finds it with the right MD5 and
# skips the download.
#
#   ./install-local.sh [version]
set -euo pipefail
cd "$(dirname "$0")"

NAME=iscsi.manager
HOST=${UNRAID_HOST:-192.168.35.2}
CREDS=${UNRAID_CREDS:-../unraid-cred}
USER=$(awk -F': ' '/^username/{print $2}' "$CREDS")
export SSHPASS=$(awk -F': ' '/^password/{print $2}' "$CREDS")
SSH="sshpass -e ssh -o StrictHostKeyChecking=no"
SCP="sshpass -e scp -o StrictHostKeyChecking=no"
FLASH=/boot/config/plugins/$NAME

./build.sh "${1:-}"
VER=$(grep -oP '<!ENTITY version\s+"\K[^"]+' "$NAME.plg")

$SSH "$USER@$HOST" "mkdir -p $FLASH"
$SCP "packages/$NAME-$VER.txz" "$USER@$HOST:$FLASH/$NAME-$VER.txz"
$SCP "$NAME.plg" "$USER@$HOST:/tmp/$NAME.plg"
# `plugin install` refuses a plugin that is already installed, and `plugin update`
# would fetch the .plg from its public URL. Re-installing is remove + install;
# our remove step keeps the saved config and never touches live targets.
if $SSH "$USER@$HOST" "[ -f /var/log/plugins/$NAME.plg ]"; then
  $SSH "$USER@$HOST" "plugin remove $NAME.plg" | tail -2
  $SSH "$USER@$HOST" "mkdir -p $FLASH"                                   # remove wiped the flash dir
  $SCP "packages/$NAME-$VER.txz" "$USER@$HOST:$FLASH/$NAME-$VER.txz"
fi
$SSH "$USER@$HOST" "plugin install /tmp/$NAME.plg"
echo "installed: http://$HOST/Settings/iSCSIManager"
