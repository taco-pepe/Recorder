# Theming Recorded

Recorded is designed for [Stylus](https://add0n.com/stylus.html) and other userstyle managers. There are no hashed class names, no shadow DOM, and no CSS-in-JS. The app's own theme studio (`#/theme`) writes the same kind of snippet for you.

Two rules cover almost everything:

1. Change a **token** (`--rc-*`) for colours, shape, spacing, and type.
2. Target a **stable class** (`.rc-*`) for layout or component tweaks.

## Design tokens

Tokens are defined on `:root`, and a light palette is applied through `:root[data-theme="light"]`. Override them in your userstyle.

| Token | What it does | Dark default |
| --- | --- | --- |
| `--rc-bg` | Page background | `#0a0a0d` |
| `--rc-bg-soft` | Slightly raised background | `#0e0e13` |
| `--rc-surface` | Cards, menus, dialogs | `#14141b` |
| `--rc-surface-2` | Secondary surface | `#1a1a23` |
| `--rc-surface-3` | Hover and pressed surface | `#20202b` |
| `--rc-line` | Default border | `#2a2a36` |
| `--rc-line-strong` | Emphasised border | `#3a3a49` |
| `--rc-text` | Primary text | `#f2f2f6` |
| `--rc-text-2` | Secondary text | `#c9c9d4` |
| `--rc-muted` | Muted text | `#9797a8` |
| `--rc-faint` | Faint text and metadata | `#6d6d7e` |
| `--rc-accent` | Accent / play / link colour | `#ff3b5c` |
| `--rc-accent-ink` | Text on accent | `#ffffff` |
| `--rc-accent-soft` | Accent tint | derived |
| `--rc-good` | Healthy status | `#45d483` |
| `--rc-warn` | Warning status | `#f4b740` |
| `--rc-bad` | Error status | `#ff5d6c` |
| `--rc-radius` | Base corner radius | `14px` |
| `--rc-radius-sm` | Small radius | `9px` |
| `--rc-radius-lg` | Large radius | `22px` |
| `--rc-font` | UI font stack | system UI |
| `--rc-font-mono` | Monospace stack | system mono |
| `--rc-shadow` | Dialog / menu shadow | dark shadow |
| `--rc-header` | Sticky header background | translucent black |
| `--rc-shell` | Max content width | `1440px` |
| `--rc-gap` | Feed spacing | `18px` |
| `--rc-density` | Density multiplier | `1` |
| `--rc-dot` | Brand dot glow scale | `1` |

`--rc-accent-soft` is recalculated with `color-mix()` from `--rc-accent`, so changing the accent usually tints the whole app without extra work. If you need to support a very old browser, set `--rc-accent-soft` explicitly too.

The in-app settings also set `--rc-bg`, `--rc-surface`, `--rc-text`, and `--rc-muted` as inline styles when you pick custom colours. A userstyle should use `!important` on those tokens only if you need to beat an in-app override.

## Stable hooks

These class names are part of the public look and are safe to target:

- Chrome: `.rc-header`, `.rc-brand`, `.rc-search`, `.rc-suggest`, `.rc-nav`, `.rc-instance`, `.rc-footer`
- Layout: `.rc-shell`, `.rc-main`, `.rc-page-head`, `.rc-page-title`, `.rc-toolbar`, `.rc-section`
- Feeds: `.rc-grid`, `.rc-list`, `.rc-card`, `.rc-card__thumb`, `.rc-card__dur`, `.rc-card__body`, `.rc-card__title`, `.rc-card__meta`, `.rc-card--row`, `.rc-card--related`
- Controls: `.rc-btn`, `.rc-chip`, `.rc-select`, `.rc-input`, `.rc-range`, `.rc-switch`, `.rc-iconbtn`, `.rc-menu`, `.rc-menu__item`
- Watch: `.rc-watch`, `.rc-player`, `.rc-playerbar`, `.rc-videohead`, `.rc-author`, `.rc-desc`, `.rc-related`, `.rc-seg`, `.rc-audio-stage`
- Overlays: `.rc-dialog`, `.rc-toast`, `.rc-empty`, `.rc-error`, `.rc-skel`

Semantic hooks also exist where they matter: `[data-rc="header"]`, `[data-rc="footer"]`, `[data-rc="search"]`, `[data-theme="dark"]`, `[data-theme="light"]`, and `data-state="ok|busy|bad"` on instance indicators.

## A complete userstyle

The theme studio's copy button produces something close to this. Replace the URL prefix with your deployment.

```css
/* Recorded — custom theme */
@-moz-document url-prefix("https://name.github.io/recorded/") {
  :root {
    --rc-accent: #7c5cff;
    --rc-bg: #08080c;
    --rc-surface: #12121a;
    --rc-text: #f4f2ff;
    --rc-muted: #a09ab8;
    --rc-radius: 6px;
    --rc-gap: 14px;
  }

  /* A few component-level changes. */
  .rc-header {
    border-bottom-color: transparent;
    backdrop-filter: blur(18px);
  }

  .rc-card {
    transition: transform 140ms ease;
  }

  .rc-card:hover {
    transform: translateY(-2px);
  }

  .rc-card__thumb {
    border-radius: 4px;
  }

  .rc-brand__name {
    letter-spacing: -0.06em;
  }

  .rc-btn--accent {
    box-shadow: 0 8px 28px rgb(124 92 255 / 0.28);
  }
}
```

Stylus accepts `@-moz-document url-prefix(...)` in Chromium-based browsers too, so one snippet works everywhere. If you prefer Stylus's own domain syntax, use its "Applies to" field instead and drop the wrapper.

## Light and dark

Recorded uses `data-theme` on `<html>`, not a media query alone:

- `html[data-theme="dark"]` — dark tokens
- `html[data-theme="light"]` — light tokens

The header script applies the saved preference before first paint, so there is no flash. Users can choose dark, light, or system in Settings.

To style only one mode:

```css
html[data-theme="dark"] .rc-card { border-color: #26263a; }
html[data-theme="light"] .rc-card { box-shadow: 0 10px 28px rgb(40 30 20 / 0.08); }
```

## Practical notes

- Keep selectors scoped. A broad `header { ... }` rule will also hit the watch-page video header.
- Prefer tokens over repainting every component. One `--rc-accent` change is more future-proof than twenty colour rules.
- Do not hide security or consent messages for aesthetics. Recorded has no cookie banner, but your browser or extensions might.
- Keep keyboard focus visible. If you restyle `:focus-visible`, preserve a clear outline.
- Respect reduced motion. Recorded already gates the spinning audio disc behind `prefers-reduced-motion`.
- Responsive breakpoints are in `assets/app.css`. Test a narrow viewport before shipping a layout-changing style.
- If a rule stops working after an update, check the class still exists in `assets/app.css`. The `.rc-*` surface is deliberately stable, but layout internals can change.
