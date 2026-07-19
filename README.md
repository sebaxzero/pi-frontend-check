# pi-frontend-check

[![test](https://github.com/sebaxzero/pi-frontend-check/actions/workflows/test.yml/badge.svg)](https://github.com/sebaxzero/pi-frontend-check/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/pi-frontend-check)](https://www.npmjs.com/package/pi-frontend-check)

A [pi](https://pi.dev) extension that lets the model **review and test JS frontends headlessly, with screenshots it can actually see**: `frontend_open`, `frontend_act`, `frontend_screenshot`, `frontend_console`, and `frontend_eval` drive a Playwright Chromium against your dev server, static build, or a plain HTML file.

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

No manual setup: the `playwright` npm dependency installs automatically with the package, and the Chromium binary (~150 MB) downloads once on the first browser launch. To pre-download it instead, run `npx playwright install chromium` in the install directory.

## Tools

| Tool | What it does |
|------|-------------|
| `frontend_open` | Navigate to a URL, `host:port` shorthand, or HTML file path → title, console health line, screenshot |
| `frontend_act` | click / type / press / hover / select / scroll / wait_for on the open page → updated state + fresh screenshot |
| `frontend_screenshot` | Capture the viewport, the full page, or one element; optionally resize the viewport first (e.g. 375×812) for responsive testing |
| `frontend_console` | Full collected log: console messages, uncaught page errors, failed requests, HTTP 4xx/5xx responses |
| `frontend_eval` | Evaluate a JS expression in the page and return the JSON result — exact assertions (counts, text, computed styles) |

Every `frontend_open` / `frontend_act` result pairs a **text half** (title, URL, viewport, console error summary with the first errors inlined) with an **image half** (a screenshot of the rendered page), so one tool call answers both "does it error?" and "does it look right?".

## What it deliberately is not

This is a **testing tool for your own frontend**, not a web browser:

- **No SSRF protection, no sanitization** — `localhost`, private addresses, and `file://` are the whole point. For browsing the open web with prompt-injection and SSRF defenses, use [pi-browser-search](https://github.com/sebaxzero/pi-browser-search) or [pi-safe-search](https://github.com/sebaxzero/pi-safe-search).
- **No dev-server management** — the agent starts your dev server itself (bash, background) and then points `frontend_open` at it.

## Configuration

`/frontend-check` shows status, `/frontend-check set KEY=VAL` changes settings for the session, `/frontend-check save` writes them to the config file, `/frontend-check reset` closes the browser. Persistent config lives in `extensions/frontend-check.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `HEADLESS` | `true` | Set `false` to watch the browser during a session |
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` | `1280` / `900` | Initial viewport |
| `NAV_TIMEOUT_MS` | `30000` | Navigation timeout |
| `AUTO_SHOT` | `true` | Attach a screenshot to every open/act result (set `false` for non-vision models) |
| `FULL_PAGE` | `false` | Default screenshot mode |
| `SHOT_FORMAT` / `SHOT_QUALITY` | `jpeg` / `80` | Screenshot encoding (`png` for lossless) |
| `MAX_CONSOLE` | `200` | Console log ring-buffer size |
| `MAX_EVAL_CHARS` | `4000` | Truncation limit for `frontend_eval` results |

## Tests

```bash
node --test test.mjs
```

Pure logic (URL normalization, log formatting) lives in `extensions/report.ts` with no Playwright import, so tests run without a browser.

## License

MIT
