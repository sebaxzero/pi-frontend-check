// Playwright session for frontend testing. One browser, one context, one
// "current page" driven by frontend_open / frontend_act / frontend_screenshot.
// Unlike pi-browser-search there is no SSRF gate and no sanitization: the
// target is the user's own frontend (dev server, static file), which is
// trusted local code, and localhost is exactly what we want to reach.
// Playwright (the npm package) is installed by pi itself — pi runs
// `npm install --omit=dev` after cloning a git package. The Chromium binary
// is downloaded lazily on first launch (see installChromium below).
import { normalizeUrl, summarizeLog, truncate, type LogEntry } from "./report.ts";

export type Cfg = {
  HEADLESS: boolean;
  VIEWPORT_WIDTH: number;
  VIEWPORT_HEIGHT: number;
  NAV_TIMEOUT_MS: number;
  AUTO_SHOT: boolean;
  FULL_PAGE: boolean;
  SHOT_FORMAT: "jpeg" | "png";
  SHOT_QUALITY: number;
  MAX_CONSOLE: number;
  MAX_EVAL_CHARS: number;
};

let pw: any = null;
let browser: any = null;
let context: any = null;
let page: any = null;

// Console messages, page errors, failed requests, and HTTP >= 400 responses,
// collected from every page in the context. Cleared on each frontend_open.
let log: LogEntry[] = [];

// One-time Chromium download (~150 MB) via playwright's own CLI, triggered
// when launch reports a missing executable. Keeps the extension zero-setup.
async function installChromium(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`'playwright install chromium' exited with code ${code}`)),
    );
  });
}

function record(cfg: Cfg, entry: LogEntry) {
  log.push(entry);
  if (log.length > cfg.MAX_CONSOLE) log.splice(0, log.length - cfg.MAX_CONSOLE);
}

async function ensureContext(cfg: Cfg) {
  if (context && browser?.isConnected()) return context;
  if (!pw) {
    try {
      pw = await import("playwright");
    } catch {
      throw new Error(
        "Playwright is not installed. In the pi-frontend-check install directory run: npm install",
      );
    }
  }
  try {
    browser = await pw.chromium.launch({ headless: cfg.HEADLESS });
  } catch (err: any) {
    if (!/Executable doesn't exist/i.test(String(err?.message ?? err))) {
      throw new Error(`Could not launch Chromium: ${err?.message ?? err}`);
    }
    try {
      await installChromium(); // first use: download the browser, then retry
      browser = await pw.chromium.launch({ headless: cfg.HEADLESS });
    } catch (err2: any) {
      throw new Error(
        "Chromium download failed — run manually in the pi-frontend-check install directory: " +
          `npx playwright install chromium (${err2?.message ?? err2})`,
      );
    }
  }
  context = await browser.newContext({
    viewport: { width: cfg.VIEWPORT_WIDTH, height: cfg.VIEWPORT_HEIGHT },
    deviceScaleFactor: 1,
  });
  context.setDefaultTimeout(cfg.NAV_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(cfg.NAV_TIMEOUT_MS);

  context.on("page", (p: any) => {
    // Auto-dismiss alert/confirm/prompt so pages never block the session.
    p.on("dialog", (d: any) => d.dismiss().catch(() => {}));
    p.on("console", (msg: any) => {
      const t = msg.type();
      const level = t === "error" ? "error" : t === "warning" ? "warning" : "info";
      record(cfg, { kind: "console", level, text: msg.text(), ts: Date.now() });
    });
    p.on("pageerror", (err: any) => {
      record(cfg, { kind: "pageerror", level: "error", text: String(err?.message ?? err), ts: Date.now() });
    });
    p.on("requestfailed", (req: any) => {
      const failure = req.failure()?.errorText ?? "failed";
      if (failure === "net::ERR_ABORTED") return; // SPAs cancel requests routinely
      record(cfg, {
        kind: "requestfailed",
        level: "error",
        text: `${req.method()} ${req.url()} — ${failure}`,
        ts: Date.now(),
      });
    });
    p.on("response", (res: any) => {
      if (res.status() < 400) return;
      record(cfg, {
        kind: "http",
        level: res.status() >= 500 ? "error" : "warning",
        text: `HTTP ${res.status()} ${res.request().method()} ${res.url()}`,
        ts: Date.now(),
      });
    });
  });
  return context;
}

async function ensurePage(cfg: Cfg) {
  await ensureContext(cfg);
  if (!page || page.isClosed()) page = await context.newPage();
  return page;
}

export async function closeBrowser() {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  browser = context = page = null;
  log = [];
}

export function currentUrl(): string {
  return page && !page.isClosed() ? page.url() : "";
}

export function getLog(): LogEntry[] {
  return log;
}

function requirePage() {
  if (!page || page.isClosed()) throw new Error("No page is open — call frontend_open first.");
  return page;
}

// Title, URL, viewport, and console health of the current page — the text
// half of every open/act result (the screenshot is the other half).
async function describeCurrent(): Promise<string> {
  // A click may have opened a new tab — follow the newest open page.
  const open = context.pages().filter((p: any) => !p.isClosed());
  if (open.length) page = open[open.length - 1];
  const title = await page.title().catch(() => "");
  const size = page.viewportSize();
  return [
    `# ${title || "(untitled)"}`,
    `URL: ${page.url()}`,
    `Viewport: ${size ? `${size.width}x${size.height}` : "unknown"}`,
    summarizeLog(log),
  ].join("\n");
}

export async function openUrl(cfg: Cfg, rawUrl: string, waitFor?: string): Promise<string> {
  const url = normalizeUrl(rawUrl);
  const p = await ensurePage(cfg);
  log = []; // fresh page, fresh log
  try {
    await p.goto(url, { waitUntil: "domcontentloaded" });
  } catch (err: any) {
    if (err?.name !== "TimeoutError") {
      throw new Error(`Navigation failed: ${String(err?.message ?? err).split("\n")[0]}`);
    }
    // Slow page — fall through and inspect whatever rendered so far.
  }
  if (waitFor) await p.locator(waitFor).first().waitFor({ timeout: 10_000 });
  // Give SPAs a moment to render, but never hang on chatty pages.
  await p.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  return describeCurrent();
}

export async function act(
  cfg: Cfg,
  a: { action: string; target?: string; text?: string; key?: string },
): Promise<string> {
  const p = requirePage();
  const loc = a.target ? p.locator(a.target).first() : null;

  switch (a.action) {
    case "click":
      if (!loc) throw new Error("click requires target (CSS selector or text=Visible text)");
      await loc.click({ timeout: 10_000 });
      break;
    case "type":
      if (!loc || a.text == null) throw new Error("type requires target and text");
      await loc.fill(a.text, { timeout: 10_000 });
      break;
    case "press":
      await (loc ? loc.press(a.key ?? "Enter") : p.keyboard.press(a.key ?? "Enter"));
      break;
    case "hover":
      if (!loc) throw new Error("hover requires target");
      await loc.hover({ timeout: 10_000 });
      break;
    case "select":
      if (!loc || a.text == null) throw new Error("select requires target and text (option value or label)");
      await loc.selectOption(a.text, { timeout: 10_000 });
      break;
    case "scroll":
      await p.mouse.wheel(0, 1_500);
      await p.waitForTimeout(500);
      break;
    case "wait_for":
      if (loc) await loc.waitFor({ timeout: 10_000 });
      else await p.waitForTimeout(1_000);
      break;
    default:
      throw new Error(
        `Unknown action: ${a.action} (use click | type | press | hover | select | scroll | wait_for)`,
      );
  }

  await p.waitForLoadState("domcontentloaded", { timeout: cfg.NAV_TIMEOUT_MS }).catch(() => {});
  await p.waitForTimeout(300); // let action-triggered JS settle
  return describeCurrent();
}

export async function screenshot(
  cfg: Cfg,
  opts: { full_page?: boolean; selector?: string; width?: number; height?: number } = {},
): Promise<{ data: string; mimeType: string }> {
  const p = requirePage();
  if (opts.width || opts.height) {
    const cur = p.viewportSize() ?? { width: cfg.VIEWPORT_WIDTH, height: cfg.VIEWPORT_HEIGHT };
    await p.setViewportSize({
      width: opts.width ?? cur.width,
      height: opts.height ?? cur.height,
    });
    await p.waitForTimeout(300); // let responsive layout settle
  }
  const base: any = { type: cfg.SHOT_FORMAT };
  if (cfg.SHOT_FORMAT === "jpeg") base.quality = cfg.SHOT_QUALITY;
  const buf = opts.selector
    ? await p.locator(opts.selector).first().screenshot({ ...base, timeout: 10_000 })
    : await p.screenshot({ ...base, fullPage: opts.full_page ?? cfg.FULL_PAGE });
  return {
    data: buf.toString("base64"),
    mimeType: cfg.SHOT_FORMAT === "png" ? "image/png" : "image/jpeg",
  };
}

export async function evalJs(cfg: Cfg, expression: string): Promise<string> {
  const p = requirePage();
  const result = await p.evaluate(expression);
  let out: string;
  try {
    out = JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    out = String(result);
  }
  return truncate(out, cfg.MAX_EVAL_CHARS);
}
