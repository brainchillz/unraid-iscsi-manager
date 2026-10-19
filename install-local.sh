#!/bin/bash
# Build the package and install it on the Unraid box through Unraid's own
# plugin installer, without needing the package to be published anywhere:
# the .txz is copied to the flash first, so the installer's download step
# finds a file with the right MD5 and skips the fetch.
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

./build.sh "${1:-}"
VER=$(grep -oP '<!ENTITY version\s+"\K[^"]+' "$NAME.plg")

# If the original unraid.iSCSI plugin already downloaded the runtime package,
# reuse it so the installer does not fetch 28 MB again (MD5 is verified anyway).
$SSH "$USER@$HOST" "mkdir -p /boot/config/plugins/$NAME/packages; \
  for f in iSCSI-2.1.54b-Unraid-1.txz libffi-3.3-x86_64-3.txz; do \
    [ -f /boot/config/plugins/$NAME/packages/\$f ] || cp /boot/config/plugins/unraid.iSCSI/packages/\$f /boot/config/plugins/$NAME/packages/ 2>/dev/null || true; done"
$SCP "packages/$NAME-$VER.txz" "$USER@$HOST:/boot/config/plugins/$NAME/$NAME-$VER.txz"
$SCP "$NAME.plg" "$USER@$HOST:/boot/config/plugins/$NAME.plg.new"
# Unraid's installer wants the plg outside the plugins dir when installing from a file
$SSH "$USER@$HOST" "mv /boot/config/plugins/$NAME.plg.new /tmp/$NAME.plg && plugin install /tmp/$NAME.plg"
echo "installed: http://$HOST/Settings/iSCSIManager"
