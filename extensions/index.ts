import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  act,
  ariaSnapshot,
  closeBrowser,
  currentUrl,
  describeCurrent,
  evalJs,
  getLog,
  normalizeBrowser,
  openUrl,
  saveStorageState,
  screenshot,
  setColorScheme,
  type Cfg,
} from "./browser.ts";
import { formatLog, summarizeLog } from "./report.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Config lives next to the extension file: ./extensions/frontend-check.json
// Auto-created on first load with defaults; travels with the extension.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXT_DIR, "frontend-check.json");

const DEFAULTS: Cfg = {
  HEADLESS: true,
  VIEWPORT_WIDTH: 1280,
  VIEWPORT_HEIGHT: 900,
  NAV_TIMEOUT_MS: 30000,
  AUTO_SHOT: true,
  FULL_PAGE: false,
  SHOT_FORMAT: "jpeg",
  SHOT_QUALITY: 80,
  MAX_CONSOLE: 200,
  MAX_EVAL_CHARS: 4000,
  COLOR_SCHEME: "light",
  BROWSER: "firefox",
  EXECUTABLE_PATH: "",
  USER_DATA_DIR: "",
  STORAGE_STATE: "",
} as Cfg;

const cfg: Cfg = (() => {
  if (!existsSync(CONFIG_PATH)) {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf-8");
    } catch {
      // If we can't write (e.g. permissions), just use defaults in memory
    }
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULTS };
  }
})();

type Shot = { data: string; mimeType: string };

// Text + screenshot in one result: the model reads the console health line
// and *sees* the rendered page in the same tool call.
function withShot(text: string, shot: Shot | null) {
  const content: any[] = [{ type: "text", text }];
  if (shot) content.push({ type: "image", data: shot.data, mimeType: shot.mimeType });
  return { content, details: {} };
}

async function autoShot(): Promise<Shot | null> {
  if (!cfg.AUTO_SHOT) return null;
  try {
    return await screenshot(cfg);
  } catch {
    return null; // a missing screenshot should never fail the main action
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "frontend_open",
    label: "Frontend Open",
    description:
      "Open a frontend page in headless Chromium for testing: a dev-server URL (localhost:5173), " +
      "any http(s) URL, or a local HTML file path. Returns the page title, console health " +
      "(JS errors, failed requests), and a screenshot of the rendered page. " +
      "Resets the console log. Start the dev server yourself (bash, background) before opening it.",
    promptSnippet: "Open a frontend page headlessly and see it rendered",
    promptGuidelines: [
      "Use frontend_open to visually verify a frontend: after editing UI code, to reproduce a reported bug, or to review a page's rendering.",
      "It accepts localhost URLs, plain host:port shorthand, and absolute paths to HTML files.",
      "The dev server must already be running — start it with bash in the background first.",
      "Check both halves of the result: the console summary for JS errors and the screenshot for visual problems.",
      "Switch light/dark mode with color_scheme='dark'|'light' (emulates prefers-color-scheme) — or use /frontend-check set COLOR_SCHEME=dark",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: 'URL, host:port shorthand ("localhost:3000"), or absolute path to an HTML file',
      }),
      wait_for: Type.Optional(
        Type.String({
          description: "CSS selector to wait for before capturing (for slow-rendering SPAs)",
        }),
      ),
      color_scheme: Type.Optional(
        Type.String({
          description: "Preferred color scheme: 'light' | 'dark' | 'no-preference' | 'no-override' — emulates prefers-color-scheme media query",
        }),
      ),
      browser: Type.Optional(
        Type.String({ description: "Browser: chromium | firefox | webkit (overrides BROWSER config for this call)" }),
      ),
      storage_state: Type.Optional(
        Type.String({ description: "Path to Playwright storageState JSON file (cookies+localStorage) for authenticated pages" }),
      ),
      executable_path: Type.Optional(
        Type.String({ description: "Path to Firefox/Chromium binary (e.g. Zen: /etc/profiles/per-user/bsag/bin/zen-beta)" }),
      ),
      user_data_dir: Type.Optional(
        Type.String({ description: "Path to browser profile dir (e.g. Zen: ~/.zen/wov77lu2.Default Profile). Loads that profile's cookies — close the source browser or copy the profile first." }),
      ),
    }),
    async execute(_id, params) {
      const p: any = params;
      // Per-call overrides — restart context if changed so next openUrl picks them up
      let needsRestart = false;
      if (p.browser && p.browser !== cfg.BROWSER) {
        try { cfg.BROWSER = normalizeBrowser(p.browser); needsRestart = true; } catch (e:any) { throw new Error(e.message); }
      }
      if (p.storage_state !== undefined && p.storage_state !== cfg.STORAGE_STATE) {
        (cfg as any).STORAGE_STATE = p.storage_state;
        needsRestart = true;
      }
      if (p.executable_path !== undefined && p.executable_path !== (cfg as any).EXECUTABLE_PATH) {
        (cfg as any).EXECUTABLE_PATH = p.executable_path;
        needsRestart = true;
      }
      if (p.user_data_dir !== undefined && p.user_data_dir !== (cfg as any).USER_DATA_DIR) {
        (cfg as any).USER_DATA_DIR = p.user_data_dir;
        needsRestart = true;
      }
      if (needsRestart) await closeBrowser();
      const text = await openUrl(cfg, params.url, params.wait_for, (params as any).color_scheme);
      return withShot(text, await autoShot());
    },
  });

  pi.registerTool({
    name: "frontend_act",
    label: "Frontend Act",
    description:
      "Interact with the open page: click, type, press a key, hover, select an option, scroll, " +
      "or wait for an element. Returns the updated console health and a fresh screenshot, " +
      "so you can verify the UI reacted correctly.",
    promptSnippet: "Click, type, or scroll on the page under test",
    promptGuidelines: [
      "frontend_act requires a page opened with frontend_open first.",
      'Target elements with a CSS selector ("#id", "button[type=submit]") or visible text ("text=Submit").',
      "Use it to walk user flows: fill forms, open menus, trigger the interaction being tested — then judge the screenshot and console output.",
      "hover reveals tooltips/dropdowns; select picks an <option> by value or label.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "One of: click | type | press | hover | select | scroll | wait_for",
      }),
      target: Type.Optional(
        Type.String({
          description:
            'Playwright locator: CSS selector or "text=Visible text". Required for click/type/hover/select.',
        }),
      ),
      text: Type.Optional(
        Type.String({ description: "Text to type (action=type) or option to select (action=select)" }),
      ),
      key: Type.Optional(Type.String({ description: 'Key to press, e.g. "Enter" (action=press)' })),
    }),
    async execute(_id, params) {
      const text = await act(cfg, params);
      return withShot(text, await autoShot());
    },
  });

  pi.registerTool({
    name: "frontend_screenshot",
    label: "Frontend Screenshot",
    description:
      "Capture a screenshot of the open page: the viewport, the full scrollable page, or a single " +
      "element. Optionally resize the viewport first (e.g. 375x812 for mobile) to test responsive " +
      "layouts — the new size persists for later calls.",
    promptSnippet: "Screenshot the page under test",
    promptGuidelines: [
      "Use full_page=true to inspect the whole page beyond the fold, or selector to zoom into one component.",
      "For responsive review, capture the same page at several widths: 375 (phone), 768 (tablet), 1280 (desktop).",
      "Switch light/dark at any time with color_scheme='dark'|'light' — persists until changed (also via /frontend-check set COLOR_SCHEME=dark)",
    ],
    parameters: Type.Object({
      full_page: Type.Optional(
        Type.Boolean({ description: "Capture the full scrollable page instead of the viewport" }),
      ),
      selector: Type.Optional(
        Type.String({ description: "CSS selector — capture only this element" }),
      ),
      width: Type.Optional(
        Type.Number({ description: "Resize viewport width before capturing", minimum: 200, maximum: 3840 }),
      ),
      height: Type.Optional(
        Type.Number({ description: "Resize viewport height before capturing", minimum: 200, maximum: 2160 }),
      ),
      color_scheme: Type.Optional(
        Type.String({
          description: "Emulate prefers-color-scheme: 'light' | 'dark' | 'no-preference' | 'no-override' — persists until changed",
        }),
      ),
    }),
    async execute(_id, params) {
      const shot = await screenshot(cfg, params as any);
      const label = params.selector
        ? `Screenshot of ${params.selector}`
        : params.full_page
          ? "Full-page screenshot"
          : "Viewport screenshot";
      return {
        content: [
          { type: "text", text: `${label} — ${currentUrl()}` },
          { type: "image", data: shot.data, mimeType: shot.mimeType },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "frontend_snapshot",
    label: "Frontend Snapshot",
    description:
      "Inspect the open page before interacting. Returns title, URL, viewport, console health, a semantic aria tree (roles/names/values with getByRole hints), and a PNG screenshot. " +
      "Use this before frontend_act to discover correct selectors — copy the getByRole hint instead of guessing CSS. Accepts optional selector to focus a subtree.",
    promptSnippet: "Inspect page with aria tree + screenshot",
    promptGuidelines: [
      "Use frontend_snapshot before frontend_act to discover selectors: the aria tree shows role + name + getByRole hint for every actionable element.",
      "Pass selector to focus a subtree (e.g. \"main\", \"[data-testid=sidebar]\") and reduce noise.",
      "compact:true (default) prunes generic wrappers; set false for the full tree.",
      "The result also includes a screenshot — check both the tree (what to target) and the image (does it look right).",
    ],
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({ description: "CSS selector to snapshot a subtree only, e.g. \"main\" or \"[data-testid=dialog]\"" }),
      ),
      compact: Type.Optional(
        Type.Boolean({ description: "Prune generic wrappers (default true). Set false for full tree." }),
      ),
      max_nodes: Type.Optional(
        Type.Number({ description: "Max nodes to return (default 300)", minimum: 10, maximum: 1000 }),
      ),
      color_scheme: Type.Optional(
        Type.String({
          description: "Emulate prefers-color-scheme: 'light' | 'dark' | 'no-preference' | 'no-override' — persists until changed",
        }),
      ),
    }),
    async execute(_id, params) {
      const url = currentUrl();
      if (!url) throw new Error("No page is open — call frontend_open first.");
      if ((params as any).color_scheme) {
        await setColorScheme(cfg, (params as any).color_scheme);
      }
      const header = await describeCurrent();
      const aria = await ariaSnapshot(cfg, {
        selector: params.selector,
        compact: params.compact ?? true,
        maxNodes: params.max_nodes ?? 300,
      });
      const titleLine = params.selector ? `Aria tree for \`${params.selector}\`` : "Aria tree (compact)";
      const text = `${header}\n\n## ${titleLine}\n${aria}`;
      // Always attach a fresh screenshot
      let shot: { data: string; mimeType: string } | null = null;
      try { shot = await screenshot(cfg); } catch {}
      if (!shot) shot = await autoShot();
      return withShot(text, shot);
    },
  });

  pi.registerTool({
    name: "frontend_console",
    label: "Frontend Console",
    description:
      "Read the collected browser console log for the open page: console messages, uncaught page " +
      "errors, failed network requests, and HTTP 4xx/5xx responses. Collected since the last " +
      "frontend_open.",
    promptSnippet: "Read the page's console and network errors",
    promptGuidelines: [
      "Use frontend_console when the summary from frontend_open/frontend_act reports errors and you need the full detail.",
      'Filter with level="error" or level="warning" to skip informational noise.',
    ],
    parameters: Type.Object({
      level: Type.Optional(
        Type.String({ description: "Filter: all | error | warning | info (default all)" }),
      ),
      max: Type.Optional(
        Type.Number({ description: "Maximum entries to return (default 100)", minimum: 1 }),
      ),
    }),
    async execute(_id, params) {
      const text = formatLog(getLog(), params.level ?? "all", params.max ?? 100);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "frontend_eval",
    label: "Frontend Eval",
    description:
      "Evaluate a JavaScript expression in the open page and return the JSON-serialized result. " +
      "Use it to assert on DOM state, computed styles, or app state that a screenshot can't show.",
    promptSnippet: "Run JS in the page to assert on DOM/app state",
    promptGuidelines: [
      "Return serializable values: strings, numbers, arrays, plain objects — DOM nodes serialize to null.",
      'Examples: "document.querySelectorAll(\'.item\').length", "getComputedStyle(document.querySelector(\'h1\')).fontSize", "localStorage.getItem(\'theme\')".',
      "Prefer frontend_eval over screenshots for exact values (counts, text content, class lists).",
    ],
    parameters: Type.Object({
      expression: Type.String({ description: "JavaScript expression to evaluate in the page" }),
    }),
    async execute(_id, params) {
      const text = await evalJs(cfg, params.expression);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerCommand("frontend-check", {
    description: "Show status; /frontend-check set KEY=VAL [...]; /frontend-check save[-storage PATH]; /frontend-check reset; /frontend-check use-zen",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (trimmed === "save") {
        try {
          writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
          ctx.ui.notify(`Frontend Check: saved ${CONFIG_PATH}`, "info");
        } catch (e) {
          ctx.ui.notify(`Frontend Check: could not save: ${e}`, "error");
        }
        return;
      }

      // Save current session cookies/localStorage to a storageState file for reuse
      if (trimmed.startsWith("save-storage")) {
        const out = trimmed.slice("save-storage".length).trim() || (cfg as any).STORAGE_STATE || "./storageState.json";
        try {
          const saved = await saveStorageState(out);
          ctx.ui.notify(`Frontend Check: storageState saved to ${saved} — set with /frontend-check set STORAGE_STATE=${saved}`, "info");
        } catch (e:any) { ctx.ui.notify(`save-storage failed: ${e?.message ?? e}`, "error"); }
        return;
      }

      // Convenience: copy Zen profile to /tmp and point USER_DATA_DIR there (avoids lock while Zen is running).
      // Uses Playwright's Firefox (not Zen binary) with the copied profile — cookies are compatible.
      // If you truly need the Zen binary itself, set EXECUTABLE_PATH manually, but Playwright's Firefox is more reliable.
      if (trimmed === "use-zen" || trimmed === "copy-zen-profile") {
        const zenProfile = "/home/bsag/.zen/wov77lu2.Default Profile";
        const tmp = "/tmp/zen-copy-" + Date.now();
        const { execSync } = await import("node:child_process");
        try {
          execSync(`cp -r "${zenProfile}" "${tmp}" && chmod -R u+w "${tmp}" && rm -f "${tmp}/lock" "${tmp}/.parentlock"`, { stdio: "pipe" });
          (cfg as any).USER_DATA_DIR = tmp;
          cfg.BROWSER = "firefox";
          (cfg as any).EXECUTABLE_PATH = ""; // use Playwright's Firefox — Zen binary lacks Juggler support
          await closeBrowser();
          ctx.ui.notify(`Frontend Check: copied Zen profile to ${tmp} and set USER_DATA_DIR, BROWSER=firefox. /frontend-check save to persist. Next frontend_open will use Zen cookies. ` +
            `Note: Playwright's Firefox reads the profile; Zen stays running. To use Zen's binary itself set EXECUTABLE_PATH, but it requires Juggler patches.`, "info");
        } catch (e:any) { ctx.ui.notify(`copy-zen-profile failed: ${e?.message ?? e}`, "error"); }
        return;
      }

      if (trimmed === "reset") {
        await closeBrowser();
        ctx.ui.notify("Frontend Check: browser closed; next tool call relaunches it", "info");
        return;
      }

      if (trimmed.startsWith("set ")) {
        const results: string[] = [];
        let needsRestart = false;
        // Parse KEY=VALUE pairs, handling values with spaces (e.g. Zen profile "wov77lu2.Default Profile"):
        // tokens without "=" are continuations of the previous value.
        const raw = trimmed.slice(4).trim();
        const tokens = raw.split(/\s+/);
        const pairs: string[] = [];
        for (const tok of tokens) {
          if (tok.includes("=")) pairs.push(tok);
          else if (pairs.length) pairs[pairs.length-1] += " " + tok;
        }
        for (const pair of pairs) {
          const eq = pair.indexOf("=");
          let key = pair.slice(0, eq).toUpperCase();
          let val = pair.slice(eq + 1);
          if (eq <= 0) continue;
          // Allow clearing with empty value: KEY= clears path keys
          const isPathKey = key === "STORAGE_STATE" || key === "EXECUTABLE_PATH" || key === "USER_DATA_DIR";
          if (val === "" && !isPathKey) continue;
          // Alias: COLORSCHEME -> COLOR_SCHEME
          if (key === "COLORSCHEME") key = "COLOR_SCHEME";
          if (key === "COLOR_SCHEME") {
            try {
              await setColorScheme(cfg, val);
              results.push(`${key}=${cfg.COLOR_SCHEME}`);
            } catch (e: any) {
              results.push(`invalid ${key}: ${val} (${e?.message ?? e})`);
            }
            continue;
          }
          if (key === "BROWSER") {
            try {
              cfg.BROWSER = normalizeBrowser(val);
              needsRestart = true;
              results.push(`${key}=${cfg.BROWSER}`);
            } catch (e:any) { results.push(`invalid ${key}: ${val} (${e.message})`); }
            continue;
          }
          if (key === "STORAGE_STATE" || key === "EXECUTABLE_PATH" || key === "USER_DATA_DIR") {
            // Expand ~ and validate existence lightly
            if (val.startsWith("~/")) { const { homedir } = await import("node:os"); val = homedir() + val.slice(1); }
            (cfg as any)[key] = val;
            needsRestart = true;
            results.push(`${key}=${val || "(cleared)"}`);
            continue;
          }
          if (key === "HEADLESS" || key === "AUTO_SHOT" || key === "FULL_PAGE") {
            if (val === "true" || val === "false") {
              (cfg as any)[key] = val === "true";
              if (key === "HEADLESS") needsRestart = true;
              results.push(`${key}=${val}`);
            } else results.push(`invalid ${key}: ${val} (true|false)`);
          } else if (key === "SHOT_FORMAT") {
            if (val === "jpeg" || val === "png") {
              cfg.SHOT_FORMAT = val;
              results.push(`${key}=${val}`);
            } else results.push(`invalid ${key}: ${val} (jpeg|png)`);
          } else if (key in DEFAULTS) {
            const n = parseInt(val, 10);
            if (Number.isFinite(n) && n > 0) {
              (cfg as any)[key] = n;
              if (key === "NAV_TIMEOUT_MS" || key.startsWith("VIEWPORT_")) needsRestart = true;
              results.push(`${key}=${n}`);
            } else results.push(`invalid ${key}: ${val}`);
          } else {
            results.push(`unknown: ${key}`);
          }
        }
        if (needsRestart) await closeBrowser(); // relaunch picks up launch/context options
        ctx.ui.notify(`Frontend Check: ${results.join(", ")} (session only; /frontend-check save to persist)`, "info");
        return;
      }

      ctx.ui.notify(
        [
          "Frontend Check status",
          "",
          `  current page: ${currentUrl() || "(none)"}`,
          `  console entries: ${getLog().length}`,
          "",
          "  config (/set = session only; /frontend-check save to persist):",
          ...Object.entries(cfg).map(([k, v]) => `    ${k}=${v}`),
          "",
          "  BROWSER=chromium|firefox|webkit  EXECUTABLE_PATH=/path/to/binary  USER_DATA_DIR=/path/to/profile",
          "  STORAGE_STATE=/path/to/storageState.json  (cookies+localStorage for auth)",
          "",
          "  /frontend-check save-storage [PATH] — save current session for STORAGE_STATE",
          "  /frontend-check use-zen          — copy live Zen profile to /tmp and use it (avoids lock)",
          "  /frontend-check reset — close the browser",
        ].join("\n"),
        "info",
      );
    },
  });
}
