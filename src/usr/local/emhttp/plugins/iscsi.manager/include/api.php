<?php
/* iSCSI Manager for Unraid - JSON API
 *
 * All requests are POST. Unraid's local_prepend.php has already verified the
 * csrf_token before this file runs, and nginx only serves /plugins/ to a
 * logged-in session. The real work happens in iscsi_ctl.py (rtslib); this
 * file only validates the shape of the request and relays JSON.
 */
$docroot = $docroot ?? $_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp';
$plugin  = 'iscsi.manager';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    reply(['ok' => false, 'error' => 'POST required'], 405);
}

$allowed = [
    'state', 'create_target', 'delete_target', 'set_mode', 'set_enabled',
    'create_backstore', 'delete_backstore', 'add_lun', 'delete_lun',
    'add_acl', 'delete_acl', 'set_chap', 'set_mapped_lun_wp',
    'add_portal', 'delete_portal', 'saveconfig', 'restoreconfig',
];

$action = $_POST['action'] ?? '';
if (!in_array($action, $allowed, true)) {
    reply(['ok' => false, 'error' => 'Unknown action'], 400);
}

$params = [];
if (isset($_POST['params']) && $_POST['params'] !== '') {
    $params = json_decode($_POST['params'], true);
    if (!is_array($params)) {
        reply(['ok' => false, 'error' => 'params must be a JSON object'], 400);
    }
}

$helper = "$docroot/plugins/$plugin/include/iscsi_ctl.py";
if (!is_file($helper)) {
    reply(['ok' => false, 'error' => 'Helper script missing'], 500);
}

$spec = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
$proc = proc_open(['/usr/bin/python3', '-I', $helper], $spec, $pipes, '/', ['PATH' => '/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin']);
if (!is_resource($proc)) {
    reply(['ok' => false, 'error' => 'Could not start helper'], 500);
}
fwrite($pipes[0], json_encode(['action' => $action, 'params' => $params]));
fclose($pipes[0]);
$stdout = stream_get_contents($pipes[1]);
$stderr = stream_get_contents($pipes[2]);
fclose($pipes[1]);
fclose($pipes[2]);
$rc = proc_close($proc);

$data = json_decode($stdout, true);
if (!is_array($data)) {
    reply(['ok' => false, 'error' => 'Helper returned no JSON (exit ' . $rc . ')',
           'stderr' => substr($stderr, -2000), 'stdout' => substr($stdout, -2000)], 500);
}
if ($rc !== 0 && !isset($data['ok'])) {
    $data['ok'] = false;
}
if (!$data['ok'] && $action !== 'state') {
    exec('logger -t iscsi.manager -- ' . escapeshellarg("$action failed: " . ($data['error'] ?? 'unknown')));
}
reply($data);
