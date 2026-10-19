#!/usr/bin/python3 -I
"""iSCSI Manager control helper for Unraid.

Talks to the LIO kernel target through rtslib_fb (the library behind targetcli)
instead of screen-scraping `targetcli ls`.  Reads one JSON request on stdin:

    {"action": "<name>", "params": {...}}

and prints one JSON response on stdout:

    {"ok": true,  "state": {...}}              on success
    {"ok": false, "error": "message"}          on failure

Every mutating action takes an exclusive lock, applies the change, saves the
configuration to /etc/target/saveconfig.json (LIO config is otherwise only in
memory) and returns the fresh state so the UI needs a single round trip.
"""
import fcntl
import json
import os
import re
import socket
import subprocess
import sys
import traceback

LOCK_FILE = '/var/run/iscsi.manager.lock'
SAVE_FILE = '/etc/target/saveconfig.json'
CONFIGFS = '/sys/kernel/config/target'

RE_IQN = re.compile(r'^(iqn\.\d{4}-\d{2}\.[a-z0-9.-]+(:[A-Za-z0-9.:_-]+)?|naa\.[0-9a-fA-F]{16,32}|eui\.[0-9a-fA-F]{16})$')
RE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
RE_PATH = re.compile(r'^/[^\0]*$')
RE_SIZE = re.compile(r'^\s*(\d+(?:\.\d+)?)\s*([KMGTP]?)(?:i?B)?\s*$', re.I)
RE_CHAP = re.compile(r'^[A-Za-z0-9.:_+-]{1,255}$')
RE_IP = re.compile(r'^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-fA-F:]+\]?)$')


class UserError(Exception):
    """An error caused by bad input or state; the message is shown to the user."""


# ───────────────────────────── helpers ──────────────────────────────

def human(n):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return ''
    for unit in ('B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'):
        if n < 1024 or unit == 'PiB':
            return ('%d %s' if unit == 'B' else '%.1f %s') % (n, unit)
        n /= 1024.0


def parse_size(text):
    m = RE_SIZE.match(str(text))
    if not m:
        raise UserError('Invalid size "%s" (use e.g. 100G, 2T, 500M)' % text)
    mult = {'': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4, 'P': 1024 ** 5}
    return int(float(m.group(1)) * mult[m.group(2).upper()])


def read_file(path, default=''):
    try:
        with open(path) as fh:
            return fh.read()
    except OSError:
        return default


def need(params, key, regex, label=None):
    val = str(params.get(key, '')).strip()
    if not val or not regex.match(val):
        raise UserError('Invalid %s' % (label or key))
    return val


def rtslib():
    try:
        import rtslib_fb
        return rtslib_fb
    except ImportError as exc:
        raise UserError('rtslib_fb is not installed (targetcli runtime missing): %s' % exc)


# ───────────────────────────── state ────────────────────────────────

def unraid_devices():
    """Devices that belong to the Unraid array, pools or the boot flash."""
    used = {}
    ini = read_file('/var/local/emhttp/disks.ini')
    name = None
    for line in ini.splitlines():
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            name = line.strip('[]"')
        elif line.startswith('device=') and name:
            dev = line.split('=', 1)[1].strip('"')
            if dev:
                used[dev] = name
    return used


def block_candidates():
    """Whole disks and partitions that could back a `block` backstore."""
    try:
        out = subprocess.run(
            ['lsblk', '-J', '-b', '-o', 'NAME,PATH,SIZE,TYPE,MODEL,SERIAL,MOUNTPOINT,FSTYPE,PKNAME,RO'],
            capture_output=True, text=True, timeout=15, check=False).stdout
        tree = json.loads(out or '{}').get('blockdevices', [])
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    used = unraid_devices()
    result = []

    def walk(node, parent_model=None):
        name = node.get('name', '')
        typ = node.get('type', '')
        kids = node.get('children') or []
        if typ in ('disk', 'part'):
            reasons = []
            top = name if typ == 'disk' else (node.get('pkname') or name)
            if top in used:
                reasons.append('Unraid %s' % used[top])
            if node.get('mountpoint'):
                reasons.append('mounted at %s' % node['mountpoint'])
            if any(k.get('mountpoint') for k in kids):
                reasons.append('has mounted partitions')
            if name.startswith(('loop', 'zram', 'ram', 'mmcblk0boot')):
                reasons.append('system device')
            if typ == 'part' and node.get('fstype') in ('vfat',) and node.get('mountpoint') == '/boot':
                reasons.append('boot flash')
            result.append({
                'name': name, 'path': node.get('path') or '/dev/%s' % name, 'type': typ,
                'size': node.get('size') or 0, 'size_h': human(node.get('size') or 0),
                'model': node.get('model') or parent_model or '', 'serial': node.get('serial') or '',
                'fstype': node.get('fstype') or '', 'mountpoint': node.get('mountpoint') or '',
                'in_use': reasons,
            })
        for kid in kids:
            walk(kid, node.get('model') or parent_model)

    for node in tree:
        if node.get('type') in ('loop', 'rom'):
            continue
        walk(node)
    return result


def dynamic_sessions(tpg):
    names = []
    for line in read_file(os.path.join(tpg.path, 'dynamic_sessions')).splitlines():
        line = line.strip()
        if line:
            names.append(line.split()[-1] if ':' in line else line)
    return names


def session_info(acl):
    try:
        sess = acl.session
    except Exception:
        sess = None
    if not sess:
        return None
    conns = [{'cid': c.get('cid'), 'state': c.get('cstate'), 'address': c.get('address'),
              'transport': c.get('transport')} for c in (sess.get('connections') or [])]
    return {'alias': sess.get('alias') or '', 'id': sess.get('id'), 'type': sess.get('type'),
            'state': sess.get('state'), 'connections': conns}


def gather_state():
    lib = rtslib()
    root = lib.RTSRoot()
    so_index = {}
    backstores = []
    for so in root.storage_objects:
        entry = {
            'type': so.plugin, 'name': so.name, 'path': getattr(so, 'udev_path', '') or '',
            'size': so.size, 'size_h': human(so.size), 'wwn': so.wwn,
            'write_back': bool(getattr(so, 'write_back', False)),
            'status': so.status, 'attached': [],
        }
        if so.plugin == 'fileio':
            entry['exists'] = os.path.exists(entry['path'])
        so_index['/backstores/%s/%s' % (so.plugin, so.name)] = entry
        backstores.append(entry)

    targets, sessions = [], []
    for tgt in root.targets:
        if tgt.fabric_module.name != 'iscsi':
            continue
        tpgs = []
        for tpg in tgt.tpgs:
            attrs = {}
            for key in ('generate_node_acls', 'authentication', 'demo_mode_write_protect',
                        'cache_dynamic_acls', 'prod_mode_write_protect', 'default_cmdsn_depth'):
                try:
                    attrs[key] = int(tpg.get_attribute(key))
                except Exception:
                    attrs[key] = None
            luns = []
            for lun in tpg.luns:
                so = lun.storage_object
                key = '/backstores/%s/%s' % (so.plugin, so.name)
                luns.append({'index': lun.lun, 'storage_object': key, 'bs_type': so.plugin,
                             'bs_name': so.name, 'path': getattr(so, 'udev_path', '') or '',
                             'size_h': human(so.size)})
                if key in so_index:
                    so_index[key]['attached'].append({'target': tgt.wwn, 'tpg': tpg.tag, 'lun': lun.lun})
            acls = []
            for acl in tpg.node_acls:
                sess = session_info(acl)
                mapped = [{'index': m.mapped_lun, 'tpg_lun': m.tpg_lun.lun, 'write_protect': bool(m.write_protect)}
                          for m in acl.mapped_luns]
                chap = bool(acl.chap_userid)
                acls.append({'node_wwn': acl.node_wwn, 'chap': chap, 'chap_userid': acl.chap_userid or '',
                             'mutual_chap': bool(acl.chap_mutual_userid), 'mapped_luns': mapped, 'session': sess})
                if sess:
                    sessions.append({'target': tgt.wwn, 'tpg': tpg.tag, 'initiator': acl.node_wwn,
                                     'alias': sess['alias'], 'state': sess['state'], 'id': sess['id'],
                                     'addresses': [c['address'] for c in sess['connections'] if c.get('address')],
                                     'luns': [m['tpg_lun'] for m in mapped], 'dynamic': False})
            dyn = dynamic_sessions(tpg)
            for name in dyn:
                sessions.append({'target': tgt.wwn, 'tpg': tpg.tag, 'initiator': name, 'alias': '',
                                 'state': 'LOGGED_IN', 'id': None, 'addresses': [],
                                 'luns': [l['index'] for l in luns], 'dynamic': True})
            portals = [{'ip': p.ip_address, 'port': p.port} for p in tpg.network_portals]
            tpgs.append({'tag': tpg.tag, 'enabled': bool(tpg.enable), 'attributes': attrs,
                         'shared': attrs.get('generate_node_acls') == 1,
                         'auth': attrs.get('authentication') == 1,
                         'luns': sorted(luns, key=lambda x: x['index']), 'acls': acls,
                         'portals': portals, 'dynamic_sessions': dyn})
        targets.append({'wwn': tgt.wwn, 'tpgs': tpgs})

    try:
        live = json.dumps(root.dump(), sort_keys=True)
        saved_doc = json.loads(read_file(SAVE_FILE, 'null'))
        saved = saved_doc is not None and json.dumps(saved_doc, sort_keys=True) == live
    except Exception:
        saved = False

    service = {
        'configfs': os.path.isdir(CONFIGFS),
        'iscsi_module': os.path.isdir('/sys/module/iscsi_target_mod'),
        'rtslib_version': getattr(lib, '__version__', ''),
        'save_file': os.path.realpath(SAVE_FILE),
        'save_exists': os.path.exists(SAVE_FILE),
        'saved': saved,
        'hostname': socket.gethostname(),
    }
    return {'service': service, 'backstores': backstores, 'targets': targets,
            'sessions': sessions, 'disks': block_candidates()}


# ───────────────────────────── lookups ──────────────────────────────

def find_target(root, wwn):
    for tgt in root.targets:
        if tgt.wwn == wwn and tgt.fabric_module.name == 'iscsi':
            return tgt
    raise UserError('Target %s not found' % wwn)


def find_tpg(root, wwn, tag=1):
    tgt = find_target(root, wwn)
    for tpg in tgt.tpgs:
        if tpg.tag == int(tag):
            return tpg
    raise UserError('TPG %s not found on %s' % (tag, wwn))


def find_so(root, btype, name):
    for so in root.storage_objects:
        if so.plugin == btype and so.name == name:
            return so
    raise UserError('Backstore %s/%s not found' % (btype, name))


def find_acl(tpg, initiator):
    for acl in tpg.node_acls:
        if acl.node_wwn == initiator:
            return acl
    raise UserError('Initiator ACL %s not found' % initiator)


def save(root):
    root.save_to_file(SAVE_FILE)


def map_lun_to_all_acls(lib, tpg, lun):
    """Mirror targetcli's auto_add_mapped_luns: every ACL sees every LUN."""
    for acl in tpg.node_acls:
        if any(m.tpg_lun.lun == lun.lun for m in acl.mapped_luns):
            continue
        lib.MappedLUN(acl, lun.lun, tpg_lun=lun, write_protect=False)


# ───────────────────────────── actions ──────────────────────────────

def act_create_target(lib, root, p):
    wwn = str(p.get('wwn', '')).strip() or None
    if wwn and not RE_IQN.match(wwn):
        raise UserError('Invalid IQN')
    mode = p.get('access_mode', 'restricted')
    if mode not in ('shared', 'restricted'):
        raise UserError('Invalid access mode')
    if wwn and any(t.wwn == wwn for t in root.targets):
        raise UserError('Target %s already exists' % wwn)
    fabric = lib.FabricModule('iscsi')
    tgt = lib.Target(fabric, wwn, mode='create')
    tpg = lib.TPG(tgt, 1, mode='create')
    tpg.enable = True
    # LIO defaults a new TPG to authentication=1, which rejects every login
    # until CHAP credentials exist. targetcli turns it off too.
    tpg.set_attribute('authentication', '0')
    set_mode(tpg, mode)
    if p.get('default_portal', True):
        try:
            lib.NetworkPortal(tpg, '0.0.0.0', 3260, mode='create')
        except Exception as exc:
            # Another target already listens on 0.0.0.0:3260; that is fine, LIO shares it.
            if 'exist' not in str(exc).lower() and 'in use' not in str(exc).lower():
                raise
    return {'wwn': tgt.wwn}


def set_mode(tpg, mode):
    if mode == 'shared':
        tpg.set_attribute('generate_node_acls', '1')
        tpg.set_attribute('demo_mode_write_protect', '0')
        tpg.set_attribute('cache_dynamic_acls', '1')
    else:
        tpg.set_attribute('generate_node_acls', '0')
        tpg.set_attribute('demo_mode_write_protect', '1')


def act_delete_target(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    tgt = find_target(root, wwn)
    for tpg in tgt.tpgs:
        if any(session_info(a) for a in tpg.node_acls) or dynamic_sessions(tpg):
            if not p.get('force'):
                raise UserError('Target has connected initiators; log them out first or force the delete')
    tgt.delete()


def act_set_mode(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    mode = p.get('mode')
    if mode not in ('shared', 'restricted'):
        raise UserError('Invalid access mode')
    set_mode(find_tpg(root, wwn, p.get('tpg', 1)), mode)


def act_set_enabled(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    tpg.enable = bool(p.get('enabled', True))


def act_create_backstore(lib, root, p):
    btype = p.get('type')
    name = need(p, 'name', RE_NAME, 'backstore name')
    path = need(p, 'path', RE_PATH, 'path')
    if any(so.name == name and so.plugin == btype for so in root.storage_objects):
        raise UserError('Backstore %s/%s already exists' % (btype, name))
    write_back = bool(p.get('write_back', False))
    if btype == 'fileio':
        if os.path.isdir(path):
            raise UserError('%s is a directory; give the image file path' % path)
        size = None
        if os.path.exists(path):
            if not os.path.isfile(path):
                raise UserError('%s exists and is not a regular file' % path)
            size = os.path.getsize(path)   # rtslib insists on a size even for existing files
            if size <= 0:
                raise UserError('%s is empty; give a size to create a new image instead' % path)
        else:
            if not str(p.get('size', '')).strip():
                raise UserError('Size is required when creating a new image file')
            size = parse_size(p.get('size'))
            parent = os.path.dirname(path)
            if not os.path.isdir(parent):
                raise UserError('Directory %s does not exist' % parent)
            try:
                st = os.statvfs(parent)
                free = st.f_bavail * st.f_frsize
            except OSError:
                free = None
            if free is not None and size > free and not p.get('allow_overcommit', True):
                raise UserError('Not enough free space: %s needed, %s free' % (human(size), human(free)))
        lib.FileIOStorageObject(name, dev=path, size=size, write_back=write_back)
    elif btype == 'block':
        if not os.path.exists(path):
            raise UserError('Device %s does not exist' % path)
        for dev in block_candidates():
            if dev['path'] == path and dev['in_use'] and not p.get('force'):
                raise UserError('%s is in use (%s)' % (path, ', '.join(dev['in_use'])))
        lib.BlockStorageObject(name, dev=path, readonly=bool(p.get('readonly', False)),
                               write_back=write_back)
    else:
        raise UserError('Unknown backstore type')


def act_delete_backstore(lib, root, p):
    btype = p.get('type')
    if btype not in ('fileio', 'block', 'ramdisk', 'pscsi'):
        raise UserError('Unknown backstore type')
    name = need(p, 'name', RE_NAME, 'backstore name')
    so = find_so(root, btype, name)
    attached = [l for l in so.attached_luns]
    if attached and not p.get('force'):
        raise UserError('Backstore is attached to %d LUN(s); remove those first' % len(attached))
    path = getattr(so, 'udev_path', '') or ''
    so.delete()
    if btype == 'fileio' and p.get('delete_file') and path and os.path.isfile(path):
        os.remove(path)


def act_add_lun(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    added = []
    for item in p.get('backstores', []):
        btype, _, name = str(item).partition('/')
        if btype not in ('fileio', 'block', 'ramdisk', 'pscsi') or not RE_NAME.match(name):
            raise UserError('Invalid backstore reference %s' % item)
        so = find_so(root, btype, name)
        lun = lib.LUN(tpg, storage_object=so)
        map_lun_to_all_acls(lib, tpg, lun)
        added.append(lun.lun)
    if not added:
        raise UserError('Select at least one backstore')
    return {'luns': added}


def act_delete_lun(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    index = int(p.get('lun', -1))
    for lun in tpg.luns:
        if lun.lun == index:
            lun.delete()   # rtslib also removes the mapped LUNs that point at it
            return
    raise UserError('LUN %s not found' % index)


def act_add_acl(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    initiator = need(p, 'initiator', RE_IQN, 'initiator IQN')
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    if any(a.node_wwn == initiator for a in tpg.node_acls):
        raise UserError('ACL for %s already exists' % initiator)
    acl = lib.NodeACL(tpg, initiator, mode='create')
    for lun in tpg.luns:
        lib.MappedLUN(acl, lun.lun, tpg_lun=lun, write_protect=False)


def act_delete_acl(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    initiator = need(p, 'initiator', RE_IQN, 'initiator IQN')
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    find_acl(tpg, initiator).delete()


def act_set_chap(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    initiator = need(p, 'initiator', RE_IQN, 'initiator IQN')
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    acl = find_acl(tpg, initiator)
    if p.get('clear'):
        acl.chap_userid = ''
        acl.chap_password = ''
        acl.chap_mutual_userid = ''
        acl.chap_mutual_password = ''
        if not any(a.chap_userid for a in tpg.node_acls):
            tpg.set_attribute('authentication', '0')
        return
    userid = need(p, 'userid', RE_CHAP, 'CHAP user')
    password = need(p, 'password', RE_CHAP, 'CHAP password')
    if len(password) < 12 or len(password) > 16:
        raise UserError('CHAP password must be 12 to 16 characters (iSCSI initiators such as VMware and Windows require this)')
    acl.chap_userid = userid
    acl.chap_password = password
    mu = str(p.get('mutual_userid', '')).strip()
    mp = str(p.get('mutual_password', '')).strip()
    if mu or mp:
        if not (RE_CHAP.match(mu) and RE_CHAP.match(mp)):
            raise UserError('Invalid mutual CHAP credentials')
        if len(mp) < 12 or len(mp) > 16:
            raise UserError('Mutual CHAP password must be 12 to 16 characters')
        acl.chap_mutual_userid = mu
        acl.chap_mutual_password = mp
    tpg.set_attribute('authentication', '1')


def act_set_mapped_lun_wp(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    initiator = need(p, 'initiator', RE_IQN, 'initiator IQN')
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    acl = find_acl(tpg, initiator)
    index = int(p.get('mapped_lun', -1))
    for m in acl.mapped_luns:
        if m.mapped_lun == index:
            m.write_protect = bool(p.get('write_protect'))
            return
    raise UserError('Mapped LUN %s not found' % index)


def act_add_portal(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    ip = need(p, 'ip', RE_IP, 'IP address').strip('[]')
    port = int(p.get('port', 3260))
    if not 1 <= port <= 65535:
        raise UserError('Invalid port')
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    lib.NetworkPortal(tpg, ip, port, mode='create')


def act_delete_portal(lib, root, p):
    wwn = need(p, 'wwn', RE_IQN, 'target IQN')
    ip = need(p, 'ip', RE_IP, 'IP address').strip('[]')
    port = int(p.get('port', 3260))
    tpg = find_tpg(root, wwn, p.get('tpg', 1))
    for portal in tpg.network_portals:
        if portal.ip_address == ip and int(portal.port) == port:
            portal.delete()
            return
    raise UserError('Portal %s:%s not found' % (ip, port))


def act_saveconfig(lib, root, p):
    pass  # the common path saves after every mutation


def act_restoreconfig(lib, root, p):
    if not os.path.exists(SAVE_FILE):
        raise UserError('No saved configuration at %s' % SAVE_FILE)
    if list(root.targets) and not p.get('force'):
        raise UserError('Targets are already loaded; restore would duplicate them')
    root.restore_from_file(SAVE_FILE, clear_existing=False)


MUTATIONS = {
    'create_target': act_create_target,
    'delete_target': act_delete_target,
    'set_mode': act_set_mode,
    'set_enabled': act_set_enabled,
    'create_backstore': act_create_backstore,
    'delete_backstore': act_delete_backstore,
    'add_lun': act_add_lun,
    'delete_lun': act_delete_lun,
    'add_acl': act_add_acl,
    'delete_acl': act_delete_acl,
    'set_chap': act_set_chap,
    'set_mapped_lun_wp': act_set_mapped_lun_wp,
    'add_portal': act_add_portal,
    'delete_portal': act_delete_portal,
    'saveconfig': act_saveconfig,
    'restoreconfig': act_restoreconfig,
}


def main():
    try:
        req = json.loads(sys.stdin.read() or '{}')
        action = req.get('action', 'state')
        params = req.get('params') or {}
        if action == 'state':
            return {'ok': True, 'state': gather_state()}
        if action not in MUTATIONS:
            raise UserError('Unknown action %s' % action)
        lib = rtslib()
        with open(LOCK_FILE, 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            root = lib.RTSRoot()
            result = MUTATIONS[action](lib, root, params) or {}
            save(lib.RTSRoot())
        out = {'ok': True, 'result': result, 'state': gather_state()}
        return out
    except UserError as exc:
        return {'ok': False, 'error': str(exc)}
    except Exception as exc:  # rtslib raises RTSLibError and friends
        return {'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc),
                'trace': traceback.format_exc()}


if __name__ == '__main__':
    print(json.dumps(main()))
