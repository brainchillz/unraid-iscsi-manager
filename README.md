# iSCSI Manager for Unraid

A single-page iSCSI target manager for Unraid 6.12+ / 7.x. One plugin, one
package, nothing else to install: the package carries the web page and the
complete targetcli / rtslib runtime it needs.

It was written as a replacement front end for the
[unraid.iSCSI](https://github.com/SimonFair/unraid.iSCSI) plugin and reads the
same configuration file, so an existing setup is picked up as is.

![screenshot](docs/screenshot-black.png)

## What it does

* **Targets** as cards: enabled/disabled, shared or restricted access mode,
  CHAP state, live session count, and inline tables for LUNs, initiator ACLs
  and portals with add/remove on each.
* **Initiator ACLs** with a live status dot, the initiator's alias and IP when
  it is logged in, per-ACL CHAP (plus mutual CHAP), and per-LUN read-only mapping.
* **Backstores**: image files (sparse fileio) or whole unassigned block devices.
  Devices that belong to the array, pools or the flash drive are never offered.
* **Connected initiators** table across all targets, refreshed every 10 s.
* **Auto-save**: every change is written to `/boot/config/iscsi/saveconfig.json`
  so it survives a reboot and an array stop/start.
* Follows the Unraid theme (white / black / azure / gray) via the webGui's own
  CSS variables.

## Installing

Plugins > Install Plugin, paste the `.plg` URL:

```
https://raw.githubusercontent.com/brainchillz/unraid-iscsi-manager/main/iscsi.manager.plg
```

That fetches the matching release package (a single ~10 MB file) to the flash drive, installs it, loads
the kernel target modules and restores any saved configuration. Open
Settings > iSCSI Manager. A fresh Unraid box needs nothing else.

Removing the plugin never touches live targets: hosts keep their disks until
the next reboot, and the saved configuration stays on the flash drive.

## How it works

```
iSCSIManager.page           Unraid page shell (Settings > iSCSI Manager)
javascript/iscsi.js         renders everything from one JSON state document
include/api.php             POST-only JSON endpoint, CSRF-checked by Unraid
include/iscsi_ctl.py        all the real work, via rtslib_fb (targetcli's library)
event/disks_mounted         restores the saved config when the array starts
event/unmounting_disks      clears the live config so the array can stop
```

Reading state through rtslib takes about 0.15 s and gives structured data, so
there is no parsing of `targetcli` output anywhere. Mutations take a file lock,
apply the change through rtslib, save the config, and return the fresh state in
the same response.

## The package

`build.sh` produces `packages/iscsi.manager-<version>.txz` from:

* `src/` - the plugin files
* `packages/runtime/iSCSI-*-Unraid-*.txz` - Python 3.9, targetcli-fb 2.1.54,
  rtslib-fb 2.1.75, configshell-fb 1.1.29 (the Slackware build ich777 made for
  the unraid.iSCSI plugin, GPL)
* `packages/runtime/libffi-3.3-*.txz` - the libffi.so.7 that Python links against

The runtime is trimmed to what is used (Python's test suite, IDLE, tkinter,
pip, headers, docs and the GObject stack are dropped: 44 MB on disk instead of
220 MB), and targetcli's import of `gi`, needed only for tcmu-runner, is made
optional. The result is a normal Slackware package: `installpkg` puts it in
place, `removepkg` takes it out again while leaving files that another
installed package (such as unraid.iSCSI's runtime) also owns.

## Development

```
./build.sh [version]       # build the package and stamp the .plg
./install-local.sh         # build, copy to the flash drive, install via `plugin install`
./deploy-dev.sh            # rsync src/ into the live webGui (fast loop, not persistent)
./release.sh [version]     # build, commit the stamped .plg, tag, publish a GitHub release
```

Releases carry the package as an asset; the `.plg` in `main` always points at
the release with the same version number.

The two remote scripts read the host from `UNRAID_HOST` (default
`192.168.35.2`) and root credentials from `UNRAID_CREDS` (default `../unraid-cred`).

## Notes and limits

* One TPG per target (tpg1), which is what targetcli creates and what every
  initiator expects.
* CHAP is per initiator ACL. Target-wide CHAP for shared (demo) mode targets is
  not exposed yet.
* A `saveconfig.json` backup is left in `/etc/target/backup/` by rtslib on every save.
