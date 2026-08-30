# pi-frontend-check

[![npm](https://img.shields.io/npm/v/pi-frontend-check)](https://www.npmjs.com/package/pi-frontend-check)

A [pi](https://pi.dev) extension that lets the model **review and test JS frontends headlessly, with screenshots it can actually see**: `frontend_open`, `frontend_act`, `frontend_screenshot`, `frontend_console`, and `frontend_eval` drive a Playwright Chromium/Firefox/WebKit against your dev server, static build, or a plain HTML file.

Editing UI code without looking at the result is guesswork. With this extension the agent opens the page after a change, *sees* the rendered screenshot, walks the user flow (click, type, select), reads the browser console and failed network requests, and checks responsive layouts at phone/tablet/desktop widths — all headless.

## Install

From npm:

```bash
pi install npm:pi-frontend-check
```

Or from git:

```bash
pi install git:github.com/sebaxzero/pi-frontend-check.git
```

Add `-l` to either form to install project-locally (adds to `.pi/settings.json` only).

No manual setup: the `playwright` npm dependency installs automatically with the package, and the browser binary (~150 MB) downloads once on the first launch. To pre-download it instead, run `npx playwright install chromium` or `npx playwright install firefox` in the install directory.

## Tools

| Tool | What it does |
|------|-------------|
| `frontend_open` | Navigate to a URL, `host:port` shorthand, or HTML file path → title, console health line, screenshot; `color_scheme` emulates `prefers-color-scheme`; `browser`/`storage_state`/`user_data_dir` select Firefox and authenticated sessions |
| `frontend_act` | click / type / press / hover / select / scroll / wait_for on the open page → updated state + fresh screenshot |
| `frontend_screenshot` | Capture the viewport, the full page, or one element; optionally resize the viewport first (e.g. 375×812) for responsive testing; `color_scheme` switches light/dark without reload |
| `frontend_console` | Full collected log: console messages, uncaught page errors, failed requests, HTTP 4xx/5xx responses |
| `frontend_eval` | Evaluate a JS expression in the page and return the JSON result — exact assertions (counts, text, computed styles) |

Every `frontend_open` / `frontend_act` result pairs a **text half** (title, URL, viewport, console error summary with the first errors inlined) with an **image half** (a screenshot of the rendered page), so one tool call answers both "does it error?" and "does it look right?".

## What it deliberately is not

This is a **testing tool for your own frontend**, not a web browser:

- **No SSRF protection, no sanitization** — `localhost`, private addresses, and `file://` are the whole point. For browsing the open web with prompt-injection and SSRF defenses, use [pi-browser-search](https://github.com/sebaxzero/pi-browser-search) or [pi-safe-search](https://github.com/sebaxzero/pi-safe-search).
- **No dev-server management** — the agent starts your dev server itself (bash, background) and then points `frontend_open` at it.

## Commands

```
/frontend-check                 — show current status and config
/frontend-check set KEY=VAL     — override config for the current session only
/frontend-check save            — write the current config to frontend-check.json
/frontend-check save-storage [PATH] — save current cookies/localStorage as storageState JSON for auth
/frontend-check use-zen         — copy live Zen profile to /tmp and use it (Firefox, avoids lock while Zen is running)
/frontend-check reset           — close the browser
```

## Configuration

Persistent configuration lives in `extensions/frontend-check.json` next to the installed extension (auto-created on first load with defaults). You can ask the agent to edit it, or tune values live with `/frontend-check set`.

| Key | Default | Description |
|-----|---------|-------------|
| `HEADLESS` | `true` | Set `false` to watch the browser during a session |
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` | `1280` / `900` | Initial viewport |
| `NAV_TIMEOUT_MS` | `30000` | Navigation timeout |
| `AUTO_SHOT` | `true` | Attach a screenshot to every open/act result (set `false` for non-vision models) |
| `FULL_PAGE` | `false` | Default screenshot mode |
| `SHOT_FORMAT` / `SHOT_QUALITY` | `jpeg` / `80` | Screenshot encoding (`png` for lossless) |
| `MAX_CONSOLE` | `200` | Console log ring-buffer size |
| `MAX_EVAL_CHARS` | `4000` | Truncation limit for `frontend_eval` results |
| `COLOR_SCHEME` | `light` | Emulated `prefers-color-scheme`: `light` \| `dark` \| `no-preference` \| `no-override` (also `color_scheme` param on `frontend_open`/`frontend_screenshot`) |
| `BROWSER` | `firefox` | Browser engine: `chromium` \| `firefox` \| `webkit` (also `browser` param on `frontend_open`) |
| `EXECUTABLE_PATH` | `""` | Optional path to a custom browser binary (e.g. system Firefox/Zen) |
| `USER_DATA_DIR` | `""` | Optional persistent profile dir (e.g. `~/.zen/wov77lu2.Default Profile` copy). Loads that profile's cookies — use `use-zen` to copy the live Zen profile safely. |
| `STORAGE_STATE` | `""` | Optional path to Playwright `storageState` JSON (cookies + localStorage) for authenticated pages. Create via `save-storage` after logging in, or via `frontend_open({storage_state: "..."})` per-call. |

## Dependencies

`playwright` (^1.53.0) — installed automatically with the package, whether via `pi install npm:` or a git-based install. The browser binary is downloaded separately on first launch (see Install above). Use `npx playwright install firefox` for Firefox, `npx playwright install --help` for all browsers.

### Authenticated pages & Zen Browser

Two workflows for pages behind login:

1. **storageState (recommended, works while Zen is running):** open the login page with `frontend_open`, log in via `frontend_act` (fill + click), then `/frontend-check save-storage ./auth.json` and `/frontend-check set STORAGE_STATE=./auth.json` + `save`. Future `frontend_open` calls reuse those cookies/localStorage.
2. **Live Zen profile:** `/frontend-check use-zen` copies `~/.zen/wov77lu2.Default Profile` to `/tmp/zen-copy-…` (removes `lock`) and sets `USER_DATA_DIR` + `BROWSER=firefox`. Next `frontend_open` sees the same session as your Zen window. While Zen stays running the copy is a snapshot — re-run `use-zen` after logging in elsewhere to refresh. Pointing `USER_DATA_DIR` directly at the live profile requires closing Zen first (Firefox locks the profile).

## License

MIT
