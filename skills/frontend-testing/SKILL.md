---
name: frontend-testing
description: "Visually verify and test JS frontends headlessly with frontend_open / frontend_act / frontend_screenshot / frontend_console / frontend_eval: open dev-server pages or HTML files in Chromium, see rendered screenshots, walk user flows, check console/network errors, and test responsive layouts. Use after editing UI code, when reproducing a reported frontend bug, or when asked to review how a page looks or behaves."
homepage: https://github.com/sebaxzero/pi-frontend-check
license: MIT
---

# Frontend Testing

You have a headless Chromium browser pointed at the frontend under test. Five
tools drive it:

| Tool | What it does |
|------|-------------|
| `frontend_open` | Navigate to a URL / host:port / HTML file → title, console health, screenshot |
| `frontend_act` | click / type / press / hover / select / scroll / wait_for → updated state + screenshot |
| `frontend_screenshot` | Capture viewport, full page, or one element; optionally resize viewport first |
| `frontend_console` | Full log: console messages, uncaught errors, failed requests, HTTP 4xx/5xx |
| `frontend_eval` | Evaluate a JS expression in the page, get the JSON result |

The browser keeps **one current page**. `frontend_open` replaces it and resets
the console log. Screenshots come back as images you can actually see — judge
them.

## Standard flow

1. **Start the app yourself.** These tools do not launch dev servers. Run it
   with bash in the background (`npm run dev &` or equivalent), wait for the
   "ready" output, note the port. For a static build or single HTML file, no
   server is needed — pass the absolute file path to `frontend_open`.
2. `frontend_open` the page. Read both halves of the result:
   - **Console line** — JS errors and failed requests since load. Clean means
     no uncaught exceptions; it does not mean the page is correct.
   - **Screenshot** — actually look at it: layout, overlap, missing content,
     unstyled flash, broken images, contrast.
3. Exercise the change. Use `frontend_act` to walk the user flow being tested:
   fill the form, open the menu, click the button. Every act returns a fresh
   screenshot — verify the UI reacted the way the code intends.
4. Assert exact values with `frontend_eval` where a screenshot is ambiguous:
   element counts, text content, class lists, computed styles, localStorage.
5. On errors, `frontend_console` with `level="error"` for the full detail
   (stack traces, failing request URLs).

## Verifying a code change

After editing frontend code: reload with `frontend_open` (dev servers with HMR
still serve the new code on a fresh navigation), reproduce the exact scenario
the change addresses, and confirm both the visual result and a clean console.
A change is not verified by the code diff — it is verified by seeing the
rendered page do the right thing.

## Responsive review

Capture the same page at several widths with `frontend_screenshot`:

- `width=375, height=812` — phone
- `width=768, height=1024` — tablet
- `width=1280, height=900` — desktop (default)

The resize persists, so follow-up acts/screenshots stay at that size until you
resize again. Use `full_page=true` to see below the fold, `selector` to zoom
into one component.

## What to look for in screenshots

- Overlapping or clipped elements, text overflowing its container
- Missing images/icons (check `frontend_console` for 404s)
- Unreadable contrast, elements rendered with no styling
- Layout shifts between viewport sizes; horizontal scrollbars on mobile widths
- Empty regions where data should be (API call failed → console shows it)

## Ground rules

- **Local targets only by design**: this tool is for the user's own frontend
  (localhost dev server, static build, file). It has no SSRF protection or
  content sanitization — do not use it to browse the open web; use the
  web-browsing tools for that.
- **Don't loop**: if an element can't be found twice, `frontend_eval`
  `document.body.innerHTML.length` / query the DOM to understand the actual
  structure instead of guessing more selectors.
- A timeout on `frontend_open` still returns whatever rendered — inspect the
  screenshot before retrying.
