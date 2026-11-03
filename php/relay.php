<?php
/**
 * Recorded — optional relay.
 *
 * GitHub Pages cannot run PHP. This file is for people who self-host Recorded
 * (or just the relay) because their network blocks the public instances.
 *
 * Usage from the app: Settings → Optional relay / proxy
 *   https://relay.example/relay.php?url=
 *
 * The app appends an encoded target, for example:
 *   relay.php?url=https%3A%2F%2Fyt.example%2Fapi%2Fv1%2Ftrending
 *
 * SECURITY
 * --------
 * This is a proxy. If you expose it to the whole internet without a host
 * allowlist it can be abused to reach things your server can reach. Set
 * RECORDED_ALLOWED_HOSTS to a comma-separated list of instance hosts you
 * actually use. The relay also refuses obvious loopback/private targets, but
 * an allowlist is the real protection.
 *
 * Example (Apache):
 *   SetEnv RECORDED_ALLOWED_HOSTS "yt.chocolatemoo53.com,i.ytimg.com"
 *
 * Example (CLI / PHP-FPM pool):
 *   env[RECORDED_ALLOWED_HOSTS] = yt.chocolatemoo53.com,i.ytimg.com
 */

declare(strict_types=1);

@ini_set('zlib.output_compression', '0');
@ini_set('display_errors', '0');
@set_time_limit(0);
ignore_user_abort(true);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, HEAD, OPTIONS');
header('Access-Control-Allow-Headers: Range, If-Range, Accept, Content-Type');
header('Access-Control-Expose-Headers: Content-Type, Content-Length, Content-Range, Content-Disposition, Accept-Ranges');
header('Vary: Origin');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET' && ($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
    http_response_code(405);
    header('Allow: GET, HEAD, OPTIONS');
    echo 'Method not allowed.';
    exit;
}

$target = isset($_GET['url']) ? trim((string) $_GET['url']) : '';
if ($target === '') {
    http_response_code(400);
    echo 'Missing url parameter.';
    exit;
}

if (!filter_var($target, FILTER_VALIDATE_URL) || !preg_match('#^https?://#i', $target)) {
    http_response_code(400);
    echo 'Only http(s) URLs are supported.';
    exit;
}

$parts = parse_url($target);
$host = strtolower((string) ($parts['host'] ?? ''));
$host = trim($host, '[]');
if ($host === '') {
    http_response_code(400);
    echo 'That URL has no host.';
    exit;
}

if ($host === 'localhost' || str_ends_with($host, '.localhost')) {
    http_response_code(403);
    echo 'That host is not allowed.';
    exit;
}

$literalIp = filter_var($host, FILTER_VALIDATE_IP);
if ($literalIp !== false && !recorded_public_ip((string) $literalIp)) {
    http_response_code(403);
    echo 'Private and reserved addresses are not allowed.';
    exit;
}

/**
 * Optional allowlist. Supports exact hosts and ".example.com" or
 * "*.example.com" style suffixes.
 */
$allowedRaw = (string) (getenv('RECORDED_ALLOWED_HOSTS') ?: '');
if ($allowedRaw !== '') {
    $allowed = array_values(array_filter(array_map(
        static fn (string $item): string => strtolower(trim($item)),
        explode(',', $allowedRaw)
    )));

    $ok = false;
    foreach ($allowed as $rule) {
        if ($rule === '') {
            continue;
        }
        if ($rule === $host) {
            $ok = true;
            break;
        }
        $suffix = ltrim($rule, '*');
        if ($suffix !== '' && str_starts_with($suffix, '.') && str_ends_with($host, $suffix)) {
            $ok = true;
            break;
        }
    }

    if (!$ok) {
        http_response_code(403);
        echo 'That host is not on this relay\'s allowlist.';
        exit;
    }
}

$headers = [
    'Accept: */*',
    'User-Agent: RecordedRelay/1.0 (self-hosted)',
];

if (isset($_SERVER['HTTP_RANGE']) && is_string($_SERVER['HTTP_RANGE'])) {
    $headers[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
}
if (isset($_SERVER['HTTP_IF_RANGE']) && is_string($_SERVER['HTTP_IF_RANGE'])) {
    $headers[] = 'If-Range: ' . $_SERVER['HTTP_IF_RANGE'];
}

$status = 200;
$outHeaders = [];
$headersSent = false;

$sendHeaders = static function () use (&$status, &$outHeaders, &$headersSent): void {
    if ($headersSent) {
        return;
    }
    $headersSent = true;
    http_response_code($status >= 100 && $status <= 599 ? $status : 502);
    foreach ($outHeaders as $line) {
        header($line);
    }
};

$ch = curl_init($target);
if ($ch === false) {
    http_response_code(502);
    echo 'Could not start the relay request.';
    exit;
}

curl_setopt_array($ch, [
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 8,
    CURLOPT_CONNECTTIMEOUT => 12,
    CURLOPT_TIMEOUT => 0,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_ENCODING => 'identity',
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_NOBODY => ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD',
    CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$status, &$outHeaders, &$headersSent): int {
        $length = strlen($line);
        if (preg_match('#^HTTP/\S+\s+(\d{3})#i', $line, $match)) {
            $status = (int) $match[1];
            $outHeaders = [];
            return $length;
        }

        if (preg_match('/^(Content-Type|Content-Length|Content-Range|Content-Disposition|Accept-Ranges|ETag|Last-Modified|Cache-Control):\s*(.+)$/i', trim($line), $match)) {
            $name = strtolower($match[1]);
            // Do not let upstream CORS headers conflict with ours.
            if (!str_starts_with($name, 'access-control-')) {
                $outHeaders[] = $match[1] . ': ' . trim($match[2]);
            }
        }
        return $length;
    },
    CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$headersSent, $sendHeaders): int {
        if (!$headersSent) {
            $sendHeaders();
        }
        echo $chunk;
        return strlen($chunk);
    },
]);

$ok = curl_exec($ch);
$error = curl_error($ch);
$code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($ok === false) {
    if (!$headersSent) {
        http_response_code(502);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Relay request failed: ' . ($error !== '' ? $error : 'unknown error');
    }
    exit;
}

if (!$headersSent) {
    $status = $code ?: 502;
    $sendHeaders();
}

/**
 * Reject non-public literal addresses.
 */
function recorded_public_ip(string $ip): bool
{
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
}
