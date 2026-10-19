#!/bin/bash
# Push the working tree straight into the running Unraid webGui for a fast
# edit/reload loop.  Nothing here survives a reboot: use install-local.sh for
# a real install.
#
#   ./deploy-dev.sh            # rsync src -> /usr/local/emhttp/plugins/iscsi.manager
#
# Host and credentials: UNRAID_HOST (default 192.168.35.2) and a creds file
# (UNRAID_CREDS, default ../unraid-cred) with "username:" / "password:" lines.
set -euo pipefail
cd "$(dirname "$0")"

NAME=iscsi.manager
HOST=${UNRAID_HOST:-192.168.35.2}
CREDS=${UNRAID_CREDS:-../unraid-cred}
USER=$(awk -F': ' '/^username/{print $2}' "$CREDS")
export SSHPASS=$(awk -F': ' '/^password/{print $2}' "$CREDS")
SSH="sshpass -e ssh -o StrictHostKeyChecking=no"

echo "dev" > "src/usr/local/emhttp/plugins/$NAME/VERSION"
chmod +x "src/usr/local/emhttp/plugins/$NAME"/event/* "src/usr/local/emhttp/plugins/$NAME"/include/iscsi_ctl.py

sshpass -e rsync -az --delete --exclude='__pycache__' -e "ssh -o StrictHostKeyChecking=no" \
    "src/usr/local/emhttp/plugins/$NAME/" "$USER@$HOST:/usr/local/emhttp/plugins/$NAME/"
$SSH "$USER@$HOST" "chmod +x /usr/local/emhttp/plugins/$NAME/event/* /usr/local/emhttp/plugins/$NAME/include/iscsi_ctl.py; \
  mkdir -p /etc/target; ls -la /usr/local/emhttp/plugins/$NAME/ | head -3"
echo "deployed to http://$HOST/Settings/iSCSIManager"
