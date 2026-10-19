/* iSCSI Manager for Unraid - page logic
 *
 * One JSON "state" document (see include/iscsi_ctl.py) drives the whole page.
 * Every mutation POSTs to include/api.php and receives the fresh state back,
 * so the UI re-renders from a single source of truth after each change.
 */
var iSCSI = (function () {
  'use strict';

  var API_URL = '/plugins/iscsi.manager/include/api.php';
  var POLL_MS = 10000;

  var app, root, state = null, collapsed = {}, pollTimer = null, modalOpen = false;

  // ── small utilities ──────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function attr(s) { return esc(s); }
  function el(id) { return document.getElementById(id); }
  function shortName(iqn) {
    var i = iqn.indexOf(':');
    return i > 0 ? iqn.slice(i + 1) : iqn;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fmtBytes(n) {
    n = Number(n) || 0;
    var u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + ' ' + u[i];
  }
  function iqnDefault() {
    var d = new Date();
    var host = (app.dataset.hostname || 'unraid').toLowerCase().replace(/[^a-z0-9-]/g, '');
    var n = (state && state.targets ? state.targets.length : 0) + 1;
    return 'iqn.' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '.unraid.' + host + ':target' + n;
  }

  // ── API ──────────────────────────────────────────────────────────
  function api(action, params) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        type: 'POST', url: API_URL, dataType: 'json', timeout: 120000,
        data: { action: action, params: JSON.stringify(params || {}), csrf_token: window.csrf_token }
      }).done(function (d) {
        if (d && d.ok) {
          if (d.state) { state = d.state; render(); }
          resolve(d);
        } else {
          reject(new Error((d && d.error) || 'Request failed'));
        }
      }).fail(function (xhr) {
        var msg = (xhr.responseJSON && xhr.responseJSON.error) || xhr.statusText || 'Request failed';
        if (xhr.status === 0 && xhr.statusText === 'error') msg = 'No response from server (session expired?)';
        reject(new Error(msg));
      });
    });
  }

  function refresh(silent) {
    return api('state').catch(function (e) {
      if (!silent) toast(e.message, 'error');
      if (!state) root.innerHTML = '<div class="iscsi-notice error"><b>Could not read the iSCSI configuration.</b> ' + esc(e.message) + '</div>';
    });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (document.hidden || modalOpen) return;
      refresh(true);
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // ── toasts ───────────────────────────────────────────────────────
  function toast(msg, type) {
    var box = document.querySelector('.is-toasts');
    if (!box) { box = document.createElement('div'); box.className = 'is-toasts'; document.body.appendChild(box); }
    var t = document.createElement('div');
    t.className = 'is-toast ' + (type || 'ok');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; }, type === 'error' ? 7000 : 3500);
    setTimeout(function () { t.remove(); }, type === 'error' ? 7400 : 3900);
  }

  // ── modal ────────────────────────────────────────────────────────
  // opts: {title, body (html), buttons:[{label, cls, onClick(modal) -> promise|void, close:boolean}], wide, onOpen(modal)}
  function modal(opts) {
    closeModal();
    modalOpen = true;
    var ov = document.createElement('div');
    ov.className = 'is-overlay';
    var btns = (opts.buttons || []).map(function (b, i) {
      return '<button type="button" class="btn ' + (b.cls || '') + '" data-i="' + i + '">' + esc(b.label) + '</button>';
    }).join('');
    ov.innerHTML =
      '<div class="is-modal ' + (opts.wide ? 'wide' : '') + '" role="dialog">' +
        '<div class="is-modal-head"><h3>' + esc(opts.title) + '</h3><button type="button" class="x" aria-label="Close">&times;</button></div>' +
        '<div class="is-modal-body">' + opts.body + '<div class="err" id="is-modal-err"></div></div>' +
        (btns ? '<div class="is-modal-foot">' + btns + '</div>' : '') +
      '</div>';
    document.body.appendChild(ov);
    var m = { el: ov, close: closeModal, err: function (msg) { el('is-modal-err').textContent = msg || ''; } };
    ov.querySelector('.x').addEventListener('click', closeModal);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModal(); });
    ov.querySelectorAll('.is-modal-foot .btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var b = opts.buttons[+btn.dataset.i];
        if (!b.onClick) { if (b.close !== false) closeModal(); return; }
        m.err('');
        btn.classList.add('working');
        Promise.resolve().then(function () { return b.onClick(m); }).then(function (keep) {
          btn.classList.remove('working');
          if (keep !== true && b.close !== false) closeModal();
        }).catch(function (e) {
          btn.classList.remove('working');
          m.err(e.message || String(e));
        });
      });
    });
    document.addEventListener('keydown', escHandler);
    var first = ov.querySelector('input:not([type=checkbox]), select');
    if (first) setTimeout(function () { first.focus(); first.select && first.select(); }, 30);
    if (opts.onOpen) opts.onOpen(m);
    return m;
  }
  function escHandler(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    var ov = document.querySelector('.is-overlay');
    if (ov) ov.remove();
    document.removeEventListener('keydown', escHandler);
    modalOpen = false;
  }
  function confirmModal(title, html, label, action, danger) {
    return modal({
      title: title, body: html,
      buttons: [
        { label: 'Cancel', cls: 'btn-outline' },
        { label: label || 'Confirm', cls: danger === false ? '' : 'btn-danger', onClick: action }
      ]
    });
  }
  function val(id) { var e = el(id); return e ? e.value.trim() : ''; }
  function checked(id) { var e = el(id); return !!(e && e.checked); }

  // ── rendering ────────────────────────────────────────────────────
  function render() {
    if (!state) return;
    var s = state, svc = s.service || {};
    var tpgs = [];
    s.targets.forEach(function (t) { t.tpgs.forEach(function (g) { tpgs.push(g); }); });
    var lunCount = tpgs.reduce(function (n, g) { return n + g.luns.length; }, 0);
    var totalBytes = s.backstores.reduce(function (n, b) { return n + (Number(b.size) || 0); }, 0);
    var sessions = s.sessions || [];

    var html = '';
    html += '<div class="is-cards">' +
      card('Targets', s.targets.length, plural(lunCount, 'LUN') + ' exported') +
      card('Backstores', s.backstores.length, fmtBytes(totalBytes) + ' provisioned') +
      card('Connected initiators', sessions.length, sessions.length ? uniq(sessions.map(function (x) { return x.alias || shortName(x.initiator); })).slice(0, 3).join(', ') : 'none logged in') +
      card('Configuration', svc.saved ? '<span class="badge green">saved</span>' : '<span class="badge yellow">unsaved changes</span>',
        (svc.iscsi_module ? 'kernel target loaded' : 'kernel target not loaded') + ' &middot; rtslib ' + esc(svc.rtslib_version || '?')) +
      '</div>';

    html += '<div class="is-toolbar">' +
      '<button type="button" class="btn" data-act="new-target">+ New target</button>' +
      '<button type="button" class="btn" data-act="new-backstore">+ New backstore</button>' +
      '<span class="spacer"></span>' +
      (svc.saved ? '' : '<button type="button" class="btn btn-outline" data-act="save">Save config</button>') +
      '<button type="button" class="btn btn-outline" data-act="refresh">Refresh</button>' +
      '</div>';

    // targets
    html += '<h3 class="is-h">Targets <span class="count">' + s.targets.length + '</span></h3>';
    if (!s.targets.length) {
      html += '<div class="iscsi-notice info">No iSCSI targets yet. Create a backstore (the disk or image file to export), then a target, then attach the backstore to the target as a LUN.</div>';
    }
    s.targets.forEach(function (t) { html += renderTarget(t, sessions); });

    // backstores
    html += '<h3 class="is-h">Backstores <span class="count">' + s.backstores.length + '</span></h3>';
    html += '<div class="is-card" style="padding:0"><div class="is-tablewrap"><table class="is-table"><thead><tr>' +
      '<th>Type</th><th>Name</th><th>Backing store</th><th class="right">Size</th><th>Cache</th><th>Used by</th><th></th></tr></thead><tbody>';
    if (!s.backstores.length) html += '<tr class="empty"><td colspan="7">No backstores. A backstore is an image file or a block device that a target exports as a LUN.</td></tr>';
    s.backstores.forEach(function (b) {
      var used = b.attached.map(function (a) { return '<span class="nowrap"><code>' + esc(shortName(a.target)) + '</code> lun' + a.lun + '</span>'; }).join('<br>');
      var status = b.attached.length ? '<span class="badge gray plain">in use</span>' : '<span class="badge green">free</span>';
      var missing = (b.type === 'fileio' && b.exists === false) ? ' <span class="badge red">file missing</span>' : '';
      html += '<tr>' +
        '<td><span class="badge plain">' + esc(b.type) + '</span></td>' +
        '<td><b>' + esc(b.name) + '</b>' + missing + '</td>' +
        '<td><code>' + esc(b.path) + '</code></td>' +
        '<td class="num right">' + esc(b.size_h) + '</td>' +
        '<td class="muted">' + (b.write_back ? 'write-back' : 'write-through') + '</td>' +
        '<td>' + (used || status) + '</td>' +
        '<td class="actions"><button type="button" class="btn btn-sm btn-ghost danger" data-act="del-backstore" data-type="' + attr(b.type) + '" data-name="' + attr(b.name) + '">Delete</button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div></div>';

    // sessions
    html += '<h3 class="is-h">Connected initiators <span class="count">' + sessions.length + '</span></h3>';
    html += '<div class="is-card" style="padding:0"><div class="is-tablewrap"><table class="is-table"><thead><tr>' +
      '<th>Initiator</th><th>IQN</th><th>Target</th><th>Address</th><th>LUNs</th><th>State</th></tr></thead><tbody>';
    if (!sessions.length) html += '<tr class="empty"><td colspan="6">No initiators are logged in.</td></tr>';
    sessions.forEach(function (x) {
      html += '<tr>' +
        '<td><span class="dot on"></span><b>' + esc(x.alias || '-') + '</b>' + (x.dynamic ? ' <span class="badge gray plain">dynamic</span>' : '') + '</td>' +
        '<td><code>' + esc(x.initiator) + '</code></td>' +
        '<td><code>' + esc(shortName(x.target)) + '</code></td>' +
        '<td class="num">' + esc((x.addresses || []).join(', ') || '-') + '</td>' +
        '<td class="num">' + esc((x.luns || []).slice().sort(function (a, b) { return a - b; }).join(', ') || '-') + '</td>' +
        '<td>' + (x.state === 'LOGGED_IN' ? '<span class="badge green">logged in</span>' : '<span class="badge yellow">' + esc(x.state || '?') + '</span>') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div></div>';

    html += '<div class="is-foot"><span>Config file: <code>' + esc(svc.save_file || '') + '</code></span>' +
      '<span>Changes are saved to the config file automatically.</span>' +
      '<span>iSCSI Manager ' + esc(app.dataset.version || '') + '</span></div>';

    root.innerHTML = html;
  }

  function card(label, big, sub) {
    return '<div class="is-card"><div class="lbl">' + esc(label) + '</div><div class="big">' + big + '</div><div class="sub">' + sub + '</div></div>';
  }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  function renderTarget(t, sessions) {
    var g = t.tpgs[0];
    if (!g) return '';
    var w = attr(t.wwn);
    var sess = sessions.filter(function (x) { return x.target === t.wwn; });
    var isCollapsed = !!collapsed[t.wwn];
    var badges =
      (g.enabled ? '<span class="badge green">enabled</span>' : '<span class="badge red">disabled</span>') +
      (g.shared ? '<span class="badge orange">shared &middot; any initiator</span>' : '<span class="badge gray">restricted &middot; ACLs only</span>') +
      (g.auth ? '<span class="badge yellow">CHAP</span>' : '') +
      (sess.length ? '<span class="badge green">' + plural(sess.length, 'session') + '</span>' : '');

    // LUNs
    var luns = '<table class="is-table"><thead><tr><th>LUN</th><th>Backstore</th><th class="right">Size</th><th></th></tr></thead><tbody>';
    if (!g.luns.length) luns += '<tr class="empty"><td colspan="4">No LUNs. Attach a backstore to export it.</td></tr>';
    g.luns.forEach(function (l) {
      luns += '<tr><td class="num">lun' + l.index + '</td>' +
        '<td><b>' + esc(l.bs_name) + '</b> <span class="muted">' + esc(l.bs_type) + '</span><br><code class="muted">' + esc(l.path) + '</code></td>' +
        '<td class="num right">' + esc(l.size_h) + '</td>' +
        '<td class="actions"><button type="button" class="btn btn-sm btn-ghost danger" data-act="del-lun" data-wwn="' + w + '" data-lun="' + l.index + '">Remove</button></td></tr>';
    });
    luns += '</tbody></table>';

    // ACLs
    var acls = '<table class="is-table"><thead><tr><th>Initiator</th><th>Access</th><th></th></tr></thead><tbody>';
    if (!g.acls.length) {
      acls += '<tr class="empty"><td colspan="3">' + (g.shared ? 'Shared mode: every initiator may connect. Add ACLs to pin CHAP or LUN mapping per host.' : 'No initiator ACLs. Nothing can connect until you add one.') + '</td></tr>';
    }
    g.acls.forEach(function (a) {
      var on = !!a.session;
      var conn = on ? '<div class="sess-line">' + esc(a.session.alias || '') + (a.session.connections || []).map(function (c) { return ' @ ' + esc(c.address); }).join('') + '</div>' : '';
      var mapped = a.mapped_luns.slice().sort(function (x, y) { return x.index - y.index; }).map(function (m) {
        return '<span class="' + (m.write_protect ? 'ro' : '') + '">lun' + m.tpg_lun + (m.write_protect ? ' ro' : '') + '</span>';
      }).join(', ') || '<span class="muted">no LUNs mapped</span>';
      acls += '<tr><td><span class="dot ' + (on ? 'on' : '') + '" title="' + (on ? 'logged in' : 'not connected') + '"></span><code>' + esc(a.node_wwn) + '</code>' + conn + '</td>' +
        '<td><div class="acl-luns">' + mapped + '</div>' + (a.chap ? '<span class="badge yellow">CHAP ' + esc(a.chap_userid) + (a.mutual_chap ? ' +mutual' : '') + '</span>' : '') + '</td>' +
        '<td class="actions">' +
          '<button type="button" class="btn btn-sm btn-ghost" data-act="chap" data-wwn="' + w + '" data-init="' + attr(a.node_wwn) + '">CHAP</button>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-act="map" data-wwn="' + w + '" data-init="' + attr(a.node_wwn) + '">Mapping</button>' +
          '<button type="button" class="btn btn-sm btn-ghost danger" data-act="del-acl" data-wwn="' + w + '" data-init="' + attr(a.node_wwn) + '">Remove</button>' +
        '</td></tr>';
    });
    (g.dynamic_sessions || []).forEach(function (name) {
      acls += '<tr><td><span class="dot on"></span><code>' + esc(name) + '</code> <span class="badge gray plain">dynamic</span></td><td class="muted">all LUNs (shared mode)</td><td class="actions"><button type="button" class="btn btn-sm btn-ghost" data-act="add-acl" data-wwn="' + w + '" data-init="' + attr(name) + '">Pin as ACL</button></td></tr>';
    });
    acls += '</tbody></table>';

    // portals
    var portals = '<table class="is-table"><thead><tr><th>Portal</th><th></th></tr></thead><tbody>';
    if (!g.portals.length) portals += '<tr class="empty"><td colspan="2">No portals. The target is not reachable.</td></tr>';
    g.portals.forEach(function (p) {
      portals += '<tr><td class="num">' + esc(p.ip) + ':' + esc(p.port) + (p.ip === '0.0.0.0' ? ' <span class="muted">(all IPv4)</span>' : '') + '</td>' +
        '<td class="actions"><button type="button" class="btn btn-sm btn-ghost danger" data-act="del-portal" data-wwn="' + w + '" data-ip="' + attr(p.ip) + '" data-port="' + attr(p.port) + '">Remove</button></td></tr>';
    });
    portals += '</tbody></table>';

    return '<div class="tgt ' + (isCollapsed ? 'collapsed' : '') + (g.enabled ? '' : ' disabled') + '" data-wwn="' + w + '">' +
      '<div class="tgt-head">' +
        '<button type="button" class="toggle" data-act="toggle" data-wwn="' + w + '" title="Collapse / expand">&#9662;</button>' +
        '<div class="tgt-title"><span class="name">' + esc(shortName(t.wwn)) + '</span><span class="iqn">' + esc(t.wwn) + '</span></div>' +
        '<div class="tgt-badges">' + badges + '</div>' +
        '<div class="tgt-actions">' +
          '<button type="button" class="btn btn-sm btn-outline" data-act="mode" data-wwn="' + w + '" data-mode="' + (g.shared ? 'restricted' : 'shared') + '">' + (g.shared ? 'Make restricted' : 'Make shared') + '</button>' +
          '<button type="button" class="btn btn-sm btn-outline" data-act="enable" data-wwn="' + w + '" data-on="' + (g.enabled ? '0' : '1') + '">' + (g.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button type="button" class="btn btn-sm btn-ghost danger" data-act="del-target" data-wwn="' + w + '">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div class="tgt-body">' +
        '<div class="tgt-col"><h4 class="is-h4">LUNs <button type="button" class="btn btn-sm btn-outline" data-act="add-lun" data-wwn="' + w + '">+ Attach backstore</button></h4>' + luns + '</div>' +
        '<div class="tgt-col"><h4 class="is-h4">Initiator ACLs <button type="button" class="btn btn-sm btn-outline" data-act="add-acl" data-wwn="' + w + '">+ Add initiator</button></h4>' + acls + '</div>' +
        '<div class="tgt-col"><h4 class="is-h4">Portals <button type="button" class="btn btn-sm btn-outline" data-act="add-portal" data-wwn="' + w + '">+ Add</button></h4>' + portals + '</div>' +
      '</div>' +
    '</div>';
  }

  // ── actions ──────────────────────────────────────────────────────
  function findTarget(wwn) { return state.targets.filter(function (t) { return t.wwn === wwn; })[0]; }
  function findAcl(wwn, init) {
    var t = findTarget(wwn);
    return t && t.tpgs[0].acls.filter(function (a) { return a.node_wwn === init; })[0];
  }

  function run(action, params, okMsg) {
    return api(action, params).then(function () { if (okMsg) toast(okMsg); }).catch(function (e) { toast(e.message, 'error'); throw e; });
  }
  function runIn(action, params, okMsg) {
    // same as run() but lets the modal show the error instead of a toast
    return api(action, params).then(function () { if (okMsg) toast(okMsg); });
  }

  var actions = {
    'refresh': function () { refresh().then(function () { toast('Refreshed', 'info'); }); },
    'save': function () { run('saveconfig', {}, 'Configuration saved'); },
    'toggle': function (d) { collapsed[d.wwn] = !collapsed[d.wwn]; render(); },

    'new-target': function () {
      modal({
        title: 'Create iSCSI target',
        body:
          '<div class="fg"><label>Target IQN</label><input type="text" id="f-iqn" class="mono" value="' + attr(iqnDefault()) + '" placeholder="iqn.YYYY-MM.reversed.domain:name"></div>' +
          '<p class="help">Leave the field empty to let LIO generate a name. Only lowercase letters, digits, dots, dashes and colons are valid.</p>' +
          '<div class="fg"><label>Access mode</label><select id="f-mode">' +
            '<option value="restricted">Restricted: only initiators with an ACL may connect</option>' +
            '<option value="shared">Shared: any initiator may connect and write (clusters)</option>' +
          '</select></div>' +
          '<div class="fg inline"><input type="checkbox" id="f-portal" checked><label for="f-portal">Listen on all IPv4 addresses, port 3260</label></div>',
        buttons: [{ label: 'Cancel', cls: 'btn-outline' }, { label: 'Create target', onClick: function () {
          return runIn('create_target', { wwn: val('f-iqn'), access_mode: val('f-mode'), default_portal: checked('f-portal') }, 'Target created');
        } }]
      });
    },

    'del-target': function (d) {
      var t = findTarget(d.wwn), g = t.tpgs[0];
      var live = state.sessions.filter(function (x) { return x.target === d.wwn; }).length;
      confirmModal('Delete target',
        '<p>Delete <code>' + esc(d.wwn) + '</code>?</p>' +
        '<p class="muted">' + plural(g.luns.length, 'LUN') + ', ' + plural(g.acls.length, 'ACL') + ' and ' + plural(g.portals.length, 'portal') + ' are removed. Backstores and their data are kept.</p>' +
        (live ? '<div class="iscsi-notice warn" style="margin:0 0 10px"><b>' + plural(live, 'initiator is', 'initiators are') + ' logged in.</b> They will lose the disk immediately.</div><div class="fg inline"><input type="checkbox" id="f-force"><label for="f-force">I understand, delete anyway</label></div>' : ''),
        'Delete target', function () {
          if (live && !checked('f-force')) throw new Error('Tick the confirmation box first');
          return runIn('delete_target', { wwn: d.wwn, force: live ? true : false }, 'Target deleted');
        });
    },

    'mode': function (d) {
      var toShared = d.mode === 'shared';
      confirmModal(toShared ? 'Switch to shared mode' : 'Switch to restricted mode',
        toShared
          ? '<p>Any initiator that can reach the portal will be able to log in and <b>read and write every LUN</b> on this target without an ACL.</p><p class="muted">Use this for trusted networks and hypervisor clusters where you do not want to maintain ACLs.</p>'
          : '<p>Only initiators listed in the ACLs will be able to log in. Initiators currently connected dynamically will be dropped.</p>',
        toShared ? 'Make shared' : 'Make restricted',
        function () { return runIn('set_mode', { wwn: d.wwn, mode: d.mode }, 'Access mode updated'); }, toShared);
    },

    'enable': function (d) {
      var on = d.on === '1';
      if (on) return run('set_enabled', { wwn: d.wwn, enabled: true }, 'Target enabled');
      confirmModal('Disable target', '<p>Disabling <code>' + esc(d.wwn) + '</code> logs out every connected initiator. The configuration is kept.</p>', 'Disable',
        function () { return runIn('set_enabled', { wwn: d.wwn, enabled: false }, 'Target disabled'); });
    },

    'new-backstore': function () {
      var free = state.disks.filter(function (x) { return !x.in_use.length; });
      var busy = state.disks.filter(function (x) { return x.in_use.length; });
      var devOpts = free.map(function (x) {
        return '<option value="' + attr(x.path) + '">' + esc(x.path) + ' &middot; ' + esc(x.size_h) + (x.model ? ' &middot; ' + esc(x.model) : '') + (x.fstype ? ' &middot; ' + esc(x.fstype) : '') + '</option>';
      }).join('');
      var busyOpts = busy.map(function (x) {
        return '<option value="" disabled>' + esc(x.path) + ' &middot; ' + esc(x.size_h) + ' &middot; ' + esc(x.in_use.join(', ')) + '</option>';
      }).join('');
      modal({
        title: 'Create backstore',
        body:
          '<div class="fg"><label>Type</label><select id="f-type">' +
            '<option value="fileio">Image file (fileio): a file on a share, thin-provisioned</option>' +
            '<option value="block">Block device: a whole unassigned disk or partition</option>' +
          '</select></div>' +
          '<div class="fg"><label>Name</label><input type="text" id="f-name" class="mono" placeholder="vmstore" maxlength="64"></div>' +
          '<div id="f-fileio">' +
            '<div class="fg"><label>Image file path</label><input type="text" id="f-path" class="mono" value="/mnt/user/iscsi/" placeholder="/mnt/user/share/disk.img"></div>' +
            '<div class="fg"><div class="row"><div><label>Size (new file only)</label><input type="text" id="f-size" class="mono" placeholder="500G"></div>' +
            '<div><label>Cache</label><select id="f-wb"><option value="0">Write-through (safe)</option><option value="1">Write-back (faster, risk on power loss)</option></select></div></div></div>' +
            '<p class="help">A new file is created sparse, so it only consumes space as the initiator writes. Point at an existing image to re-use it; its size is detected.</p>' +
          '</div>' +
          '<div id="f-block" style="display:none">' +
            '<div class="fg"><label>Device</label><select id="f-dev">' + (devOpts || '<option value="">No free devices</option>') + (busyOpts ? '<optgroup label="In use">' + busyOpts + '</optgroup>' : '') + '</select></div>' +
            '<div class="fg inline"><input type="checkbox" id="f-ro"><label for="f-ro">Export read-only</label></div>' +
            '<p class="help">The whole device is handed to the initiator raw. Anything already on it will be overwritten by the initiator\'s filesystem. Devices that belong to the array, pools or the flash drive are not offered.</p>' +
          '</div>',
        onOpen: function () {
          el('f-type').addEventListener('change', function () {
            var f = this.value === 'fileio';
            el('f-fileio').style.display = f ? '' : 'none';
            el('f-block').style.display = f ? 'none' : '';
          });
          el('f-name').addEventListener('input', function () {
            var p = el('f-path');
            if (/\/$/.test(p.value) || /\/[^\/]*\.img$/.test(p.value)) p.value = p.value.replace(/[^\/]*$/, '') + this.value + (this.value ? '.img' : '');
          });
        },
        buttons: [{ label: 'Cancel', cls: 'btn-outline' }, { label: 'Create backstore', onClick: function () {
          var type = val('f-type');
          var p = { type: type, name: val('f-name'), write_back: val('f-wb') === '1' };
          if (!p.name) throw new Error('Name is required');
          if (type === 'fileio') { p.path = val('f-path'); p.size = val('f-size'); if (!p.path || /\/$/.test(p.path)) throw new Error('Give the full image file path'); }
          else { p.path = val('f-dev'); p.readonly = checked('f-ro'); if (!p.path) throw new Error('Select a device'); }
          return runIn('create_backstore', p, 'Backstore created');
        } }]
      });
    },

    'del-backstore': function (d) {
      var b = state.backstores.filter(function (x) { return x.type === d.type && x.name === d.name; })[0];
      if (!b) return;
      if (b.attached.length) {
        return modal({ title: 'Backstore in use', body: '<p><b>' + esc(b.name) + '</b> is attached as a LUN on ' + b.attached.map(function (a) { return '<code>' + esc(shortName(a.target)) + '</code>'; }).join(', ') + '. Remove those LUNs first.</p>', buttons: [{ label: 'OK', cls: 'btn-outline' }] });
      }
      confirmModal('Delete backstore',
        '<p>Delete backstore <b>' + esc(b.name) + '</b> (<code>' + esc(b.path) + '</code>)?</p>' +
        (b.type === 'fileio' ? '<div class="fg inline"><input type="checkbox" id="f-delfile"><label for="f-delfile">Also delete the image file from disk (' + esc(b.size_h) + ', cannot be undone)</label></div>' : '<p class="muted">The device itself and its data are left untouched.</p>'),
        'Delete backstore', function () {
          return runIn('delete_backstore', { type: d.type, name: d.name, delete_file: checked('f-delfile') }, 'Backstore deleted');
        });
    },

    'add-lun': function (d) {
      var t = findTarget(d.wwn), g = t.tpgs[0];
      var attached = {};
      g.luns.forEach(function (l) { attached[l.storage_object] = true; });
      var items = state.backstores.map(function (b) {
        var key = '/backstores/' + b.type + '/' + b.name;
        var here = attached[key];
        var elsewhere = b.attached.filter(function (a) { return a.target !== d.wwn; });
        var why = here ? 'already on this target' : (elsewhere.length ? 'also on ' + shortName(elsewhere[0].target) : '');
        return '<label class="' + (here ? 'off' : '') + '"><input type="checkbox" name="f-bs" value="' + attr(b.type + '/' + b.name) + '" ' + (here ? 'disabled' : '') + '> <b>' + esc(b.name) + '</b> <span class="muted">' + esc(b.type) + ' &middot; ' + esc(b.size_h) + '</span>' + (why ? '<span class="why">' + esc(why) + '</span>' : '') + '</label>';
      }).join('');
      modal({
        title: 'Attach backstore as LUN',
        body: '<p class="muted mono">' + esc(d.wwn) + '</p>' +
          '<div class="fg"><label>Backstores</label><div class="checklist">' + (items || '<label class="off">No backstores exist yet</label>') + '</div></div>' +
          '<p class="help">Each selected backstore becomes its own LUN, numbered automatically, and is mapped to every existing initiator ACL. Sharing one backstore between targets is only safe with a cluster-aware filesystem.</p>',
        buttons: [{ label: 'Cancel', cls: 'btn-outline' }, { label: 'Attach', onClick: function () {
          var sel = Array.prototype.map.call(document.querySelectorAll('input[name=f-bs]:checked'), function (x) { return x.value; });
          if (!sel.length) throw new Error('Select at least one backstore');
          return runIn('add_lun', { wwn: d.wwn, backstores: sel }, plural(sel.length, 'LUN') + ' attached');
        } }]
      });
    },

    'del-lun': function (d) {
      var live = state.sessions.filter(function (x) { return x.target === d.wwn && (x.luns || []).indexOf(+d.lun) >= 0; }).length;
      confirmModal('Remove LUN', '<p>Remove <b>lun' + esc(d.lun) + '</b> from <code>' + esc(shortName(d.wwn)) + '</code>? The backstore and its data are kept.</p>' +
        (live ? '<div class="iscsi-notice warn" style="margin:0"><b>' + plural(live, 'initiator', 'initiators') + ' currently use this LUN.</b> The disk disappears from them immediately.</div>' : ''),
        'Remove LUN', function () { return runIn('delete_lun', { wwn: d.wwn, lun: +d.lun }, 'LUN removed'); });
    },

    'add-acl': function (d) {
      var known = uniq(state.sessions.map(function (x) { return x.initiator; }).concat(state.targets.reduce(function (a, t) { return a.concat(t.tpgs[0].acls.map(function (x) { return x.node_wwn; })); }, [])));
      modal({
        title: 'Add initiator ACL',
        body: '<p class="muted mono">' + esc(d.wwn) + '</p>' +
          '<div class="fg"><label>Initiator IQN</label><input type="text" id="f-init" class="mono" list="f-init-list" value="' + attr(d.init || '') + '" placeholder="iqn.1998-01.com.vmware:esxi01-12345678"><datalist id="f-init-list">' + known.map(function (x) { return '<option value="' + attr(x) + '">'; }).join('') + '</datalist></div>' +
          '<p class="help">Find it on the initiator: ESXi <i>Storage &rsaquo; Adapters &rsaquo; iSCSI</i>, Proxmox/Linux <code>/etc/iscsi/initiatorname.iscsi</code>, Windows <i>iSCSI Initiator &rsaquo; Configuration</i>. All existing LUNs are mapped to the new ACL.</p>',
        buttons: [{ label: 'Cancel', cls: 'btn-outline' }, { label: 'Add ACL', onClick: function () {
          return runIn('add_acl', { wwn: d.wwn, initiator: val('f-init') }, 'Initiator added');
        } }]
      });
    },

    'del-acl': function (d) {
      var a = findAcl(d.wwn, d.init);
      confirmModal('Remove initiator ACL', '<p>Remove <code>' + esc(d.init) + '</code> from <code>' + esc(shortName(d.wwn)) + '</code>?</p>' +
        (a && a.session ? '<div class="iscsi-notice warn" style="margin:0"><b>This initiator is logged in right now</b> and will be disconnected.</div>' : ''),
        'Remove ACL', function () { return runIn('delete_acl', { wwn: d.wwn, initiator: d.init }, 'Initiator removed'); });
    },

    'chap': function (d) {
      var a = findAcl(d.wwn, d.init) || {};
      modal({
        title: 'CHAP authentication',
        body: '<dl class="kv"><dt>Target</dt><dd>' + esc(shortName(d.wwn)) + '</dd><dt>Initiator</dt><dd>' + esc(d.init) + '</dd></dl>' +
          '<div class="fg"><div class="row"><div><label>CHAP user</label><input type="text" id="f-cu" class="mono" autocomplete="off" value="' + attr(a.chap_userid || '') + '"></div><div><label>CHAP secret (12 to 16 chars)</label><input type="text" id="f-cp" class="mono" autocomplete="off"></div></div></div>' +
          '<div class="fg"><div class="row"><div><label>Mutual CHAP user (optional)</label><input type="text" id="f-mu" class="mono" autocomplete="off"></div><div><label>Mutual secret (12 to 16 chars)</label><input type="text" id="f-mp" class="mono" autocomplete="off"></div></div></div>' +
          '<p class="help">Setting CHAP turns on authentication for the whole target, so every ACL on it then needs credentials. Letters, digits and <code>. : _ + -</code> only. Current secrets are not shown.</p>',
        buttons: [
          { label: 'Cancel', cls: 'btn-outline' },
          { label: 'Clear CHAP', cls: 'btn-outline', onClick: function () { return runIn('set_chap', { wwn: d.wwn, initiator: d.init, clear: true }, 'CHAP cleared'); } },
          { label: 'Set CHAP', onClick: function () {
            return runIn('set_chap', { wwn: d.wwn, initiator: d.init, userid: val('f-cu'), password: val('f-cp'), mutual_userid: val('f-mu'), mutual_password: val('f-mp') }, 'CHAP updated');
          } }
        ]
      });
    },

    'map': function (d) {
      var a = findAcl(d.wwn, d.init);
      if (!a) return;
      var rows = a.mapped_luns.slice().sort(function (x, y) { return x.index - y.index; }).map(function (m) {
        return '<label><input type="checkbox" data-ml="' + m.index + '" ' + (m.write_protect ? 'checked' : '') + '> lun' + m.tpg_lun + ' <span class="muted">mapped as lun' + m.index + '</span><span class="why">read-only</span></label>';
      }).join('');
      modal({
        title: 'LUN mapping',
        body: '<dl class="kv"><dt>Initiator</dt><dd>' + esc(d.init) + '</dd></dl>' +
          '<div class="fg"><label>Tick a LUN to make it read-only for this initiator</label><div class="checklist">' + (rows || '<label class="off">No LUNs mapped</label>') + '</div></div>',
        buttons: [{ label: 'Close', cls: 'btn-outline' }, { label: 'Apply', onClick: function () {
          var changes = [];
          a.mapped_luns.forEach(function (m) {
            var cb = document.querySelector('input[data-ml="' + m.index + '"]');
            if (cb && cb.checked !== !!m.write_protect) changes.push({ wwn: d.wwn, initiator: d.init, mapped_lun: m.index, write_protect: cb.checked });
          });
          return changes.reduce(function (p, c) { return p.then(function () { return api('set_mapped_lun_wp', c); }); }, Promise.resolve())
            .then(function () { if (changes.length) toast('Mapping updated'); });
        } }]
      });
    },

    'add-portal': function (d) {
      modal({
        title: 'Add portal',
        body: '<p class="muted mono">' + esc(d.wwn) + '</p>' +
          '<div class="fg"><div class="row"><div style="flex:2"><label>IP address</label><input type="text" id="f-ip" class="mono" value="0.0.0.0"></div><div><label>Port</label><input type="number" id="f-port" class="mono" value="3260" min="1" max="65535"></div></div></div>' +
          '<p class="help"><code>0.0.0.0</code> listens on every IPv4 address. Use a specific address to pin the target to one interface, for example a dedicated storage VLAN.</p>',
        buttons: [{ label: 'Cancel', cls: 'btn-outline' }, { label: 'Add portal', onClick: function () {
          return runIn('add_portal', { wwn: d.wwn, ip: val('f-ip'), port: +val('f-port') }, 'Portal added');
        } }]
      });
    },

    'del-portal': function (d) {
      confirmModal('Remove portal', '<p>Remove <code>' + esc(d.ip) + ':' + esc(d.port) + '</code> from <code>' + esc(shortName(d.wwn)) + '</code>? Initiators connected through it are dropped.</p>',
        'Remove portal', function () { return runIn('delete_portal', { wwn: d.wwn, ip: d.ip, port: +d.port }, 'Portal removed'); });
    }
  };

  function onClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    var fn = actions[btn.dataset.act];
    if (fn) fn(Object.assign({}, btn.dataset));
  }

  // ── bootstrap ────────────────────────────────────────────────────
  function init(appEl) {
    app = appEl;
    root = el('iscsi-root');
    root.addEventListener('click', onClick);
    refresh().then(startPolling);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(true); });
  }

  return { init: init, refresh: refresh, api: api, get state() { return state; } };
})();
