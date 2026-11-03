# Optional PHP relay

Recorded is static. It runs perfectly well on GitHub Pages, and **GitHub Pages cannot execute PHP**. This folder is only for people who self-host a relay because their network blocks the public Invidious/Piped instances.

The relay is a small streaming proxy. It does not cache, inspect, or re-upload video. It forwards one request at a time, including `Range` requests, so seeking and downloads keep working.

## Requirements

- PHP 8.1 or newer
- PHP cURL extension
- A host that allows PHP (shared hosting, a VPS, a home server — not GitHub Pages)

## Deploy

1. Copy `relay.php` to a web-accessible path, for example `https://relay.example/recorded/relay.php`.
2. Set an allowlist of hosts the relay is permitted to reach. Do this. An unrestricted proxy is an abuse risk and can expose internal services.
3. Open Recorded → **Settings → Network → Optional relay / proxy**.
4. Enter the relay URL ending with `?url=`:

   ```text
   https://relay.example/recorded/relay.php?url=
   ```

5. Save. Recorded will route API calls, thumbnails, manifests, captions, and media through the relay.

## Allowlist

Set `RECORDED_ALLOWED_HOSTS` to a comma-separated list of hosts. Exact hosts and suffix rules are supported.

```text
yt.chocolatemoo53.com,i.ytimg.com,*.example-instance.net
```

Apache example:

```apache
SetEnv RECORDED_ALLOWED_HOSTS "yt.chocolatemoo53.com,i.ytimg.com"
```

PHP-FPM pool example:

```ini
env[RECORDED_ALLOWED_HOSTS] = yt.chocolatemoo53.com,i.ytimg.com
```

If the variable is not set, the relay falls back to blocking obvious loopback/private literal addresses only. That is **not** a substitute for an allowlist. Run it behind authentication, a firewall rule, or a rate limit if it is publicly reachable.

## CORS

The relay sends permissive CORS headers so the static app can call it from any origin. That is intentional: the relay is meant to be used by your own copy of Recorded. If you want to restrict origins, edit the `Access-Control-Allow-Origin` header in `relay.php`.

## Notes

- HTTPS is strongly recommended. Mixed content will stop a page served over HTTPS from calling an HTTP relay.
- The relay forwards `Range` and `If-Range`, so video seeking and partial downloads work.
- It deliberately does not forward cookies or authorization headers.
- Large media streams can run for a long time; the script disables PHP's execution timeout. Your web server may still enforce its own limit.
- Do not put secrets in the URL. The target URL is visible in logs, as with any proxy.
