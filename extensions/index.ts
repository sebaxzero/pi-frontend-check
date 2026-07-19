import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  act,
  closeBrowser,
  currentUrl,
  evalJs,
  getLog,
  openUrl,
  screenshot,
  type Cfg,
} from "./browser.ts";
import { formatLog } from "./report.ts";
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
};

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
    }),
    async execute(_id, params) {
      const text = await openUrl(cfg, params.url, params.wait_for);
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
    }),
    async execute(_id, params) {
      const shot = await screenshot(cfg, params);
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
    description: "Show status; /frontend-check set KEY=VAL [...]; /frontend-check save; /frontend-check reset",
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

      if (trimmed === "reset") {
        await closeBrowser();
        ctx.ui.notify("Frontend Check: browser closed; next tool call relaunches it", "info");
        return;
      }

      if (trimmed.startsWith("set ")) {
        const results: string[] = [];
        let needsRestart = false;
        for (const pair of trimmed.slice(4).trim().split(/\s+/)) {
          const eq = pair.indexOf("=");
          const key = pair.slice(0, eq).toUpperCase();
          const val = pair.slice(eq + 1);
          if (eq <= 0 || val === "") continue;
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
          "  /frontend-check reset — close the browser",
        ].join("\n"),
        "info",
      );
    },
  });
}
