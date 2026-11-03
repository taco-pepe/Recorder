# Recorded

A quiet, fast, static front-end for YouTube. Search, watch, and download through public Invidious and Piped instances. No build step, no accounts, no analytics, no server of its own.

**Live shape:** plain HTML, CSS, and ES modules. Drop the folder on GitHub Pages and it works.

> Recorded is not affiliated with YouTube, Invidious, or Piped. It does not host or re-upload video. Public instances fetch and proxy the streams; respect creators, copyright, and the rules where you live.

## Features

- **Trending, search, and suggestions** with region and category controls.
- **Watch pages** with DASH playback through Invidious, a muxed MP4 fallback through Piped, captions, quality selection, speed control, and an audio-only mode.
- **Downloads** for muxed, video-only, and audio-only streams straight from the instance.
- **Failover between instances**, with health checks and a quick instance picker.
- **Resume positions** kept in `localStorage`, never on a server.
- **Theme studio** with a copyable Stylus userstyle and stable `.rc-*` hooks.
- **Installable shell** with a small service worker for offline UI, no offline video.
- **Optional PHP relay** for networks where the public instances are blocked.

## Quick start

Because the app uses ES modules, it needs to be served over HTTP — opening `index.html` from `file://` will not work.

```bash
cd recorded
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

Or use any static file server:

```bash
npx serve .
```

## Deploy to GitHub Pages

1. Push the folder to a repository.
2. Go to **Settings → Pages**.
3. Choose **Deploy from a branch**, then the branch and `/ (root)`.
4. Open the published URL.

Everything uses relative paths and hash routing (`#/search`, `#/watch?v=…`, `#/settings`, `#/theme`), so project pages such as `https://name.github.io/recorded/` work without rewrite rules. `.nojekyll` is included so GitHub Pages serves the files as-is.

PHP cannot run on GitHub Pages. The `php/` folder is optional and only for self-hosting a relay.

## How it works

Recorded is a shell around public APIs:

- **Invidious** — primary provider. Gives search, video details, proxied DASH manifests (`?local=true`), captions, and download endpoints (`/latest_version`).
- **Piped** — fallback. Gives search, video details, and usually a proxied 360p muxed stream.

The instance list in `assets/api.js` is a starting point, not a guarantee. Public instances go up and down constantly. When one fails, Recorded records the failure in `sessionStorage`, cools it down briefly, and tries the next healthy instance.

You can add your own instance in **Settings → Network**. Use an instance you trust: it sees your requests, just like any website you visit.

### If playback fails

- **"The stream stumbled"** — the instance returned a manifest but its segments are unreachable. Try another instance in the picker.
- **A Piped instance asks for a sign-in** — some Piped servers now refuse anonymous stream requests. Recorded falls through to another provider automatically.
- **No playable streams** — the instance may be out of quota, the video may be region-locked or live, or the API may be disabled.
- **Everything is blocked where you are** — use the optional relay, or self-host an instance. Recorded deliberately has no hidden server of its own.

## Optional relay

If the public instances are unreachable from your network, self-host the tiny PHP relay in [`php/relay.php`](php/relay.php). It forwards one request at a time, including `Range` requests, so seeking and downloads keep working.

```text
https://relay.example/recorded/relay.php?url=
```

Paste that into **Settings → Network → Optional relay / proxy**. Read [`php/README.md`](php/README.md) before exposing it. **Do not deploy an unrestricted open proxy.**

## Theming

Recorded was built to be restyled. Every colour and spacing token starts with `--rc-`, and every visual class starts with `.rc-`. Use the in-app **Theme studio** (`#/theme`) to tweak tokens and copy a Stylus-ready userstyle, or read [THEMING.md](THEMING.md).

```css
:root {
  --rc-accent: #ff3b5c;
  --rc-bg: #0a0a0d;
  --rc-surface: #14141b;
  --rc-radius: 14px;
}
```

## Keyboard

| Key | Action |
| --- | --- |
| `/` | Focus search |
| `k` / `Space` | Play or pause |
| `j` / `l` | Seek 10 seconds |
| `m` | Mute |
| `f` | Fullscreen |
| `d` | Downloads |
| `a` | Audio mode |
| `,` / `.` | Slower / faster |
| `?` | Shortcut sheet |

## Project layout

```text
index.html                  app shell, SVG sprite, dialogs
404.html                    static fallback page
manifest.webmanifest        installable shell metadata
sw.js                       offline UI shell, not offline video
assets/
  app.css                   styles and --rc-* design tokens
  app.js                    router, views, settings, theme studio
  api.js                    instances, failover, normalizers, downloads
  player.js                 DASH/native/audio controller
  vendor/dash.all.min.js    vendored dash.js 5.2.1 (BSD)
  icon.svg / icon-*.png     icons
php/
  relay.php                 optional self-hosted relay
  README.md                 relay deployment notes
```

## Privacy

- No analytics, accounts, trackers, external fonts, or CDNs.
- Preferences and watch positions live in `localStorage` / `sessionStorage`.
- Requests go directly to the instance you choose, or through the relay you configure. Those servers see your IP and request, as any website would.
- dash.js is vendored locally, so playback does not call a third-party script host.

## License

MIT. dash.js is distributed under its own BSD license; see [`assets/vendor/dash.LICENSE.md`](assets/vendor/dash.LICENSE.md).
