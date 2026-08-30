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
  COLOR_SCHEME: "light" | "dark" | "no-preference" | "no-override";
  BROWSER: "chromium" | "firefox" | "webkit";
  EXECUTABLE_PATH?: string;
  USER_DATA_DIR?: string;
  STORAGE_STATE?: string;
  STORAGE_STATE_JSON?: string;
};

let pw: any = null;
let browser: any = null;
let context: any = null;
let page: any = null;

// Console messages, page errors, failed requests, and HTTP >= 400 responses,
// collected from every page in the context. Cleared on each frontend_open.
let log: LogEntry[] = [];

// One-time browser download (~150 MB) via playwright's own CLI, triggered
// when launch reports a missing executable. Keeps the extension zero-setup.
async function installBrowser(browserType: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  const target = ["chromium", "firefox", "webkit"].includes(browserType) ? browserType : "chromium";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", target], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`'playwright install ${target}' exited with code ${code}`)),
    );
  });
}
// Backward compat alias
async function installChromium(): Promise<void> { return installBrowser("chromium"); }

function record(cfg: Cfg, entry: LogEntry) {
  log.push(entry);
  if (log.length > cfg.MAX_CONSOLE) log.splice(0, log.length - cfg.MAX_CONSOLE);
}

export function normalizeBrowser(raw: string): Cfg["BROWSER"] {
  const v = raw.trim().toLowerCase();
  if (v === "chromium" || v === "firefox" || v === "webkit" || v === "safari") return v === "safari" ? "webkit" : v as any;
  throw new Error(`Invalid browser "${raw}" — use chromium | firefox | webkit`);
}

async function ensureContext(cfg: Cfg) {
  // For persistent contexts, browser may be null (context is top-level). Check context liveness instead.
  if (context) {
    try {
      const closed = typeof context.isClosed === "function" ? context.isClosed() : false;
      if (!closed && (browser ? browser.isConnected() : true)) return context;
    } catch { /* recreate */ }
  }
  if (!pw) {
    try {
      pw = await import("playwright");
    } catch {
      throw new Error(
        "Playwright is not installed. In the pi-frontend-check install directory run: npm install",
      );
    }
  }
  const browserType = normalizeBrowser(cfg.BROWSER ?? "chromium");
  const launchOpts: any = { headless: cfg.HEADLESS };
  if (cfg.EXECUTABLE_PATH) launchOpts.executablePath = cfg.EXECUTABLE_PATH;

  // Persistent profile (e.g. Zen/Firefox userDataDir) — loads cookies/storage from disk.
  // Caveat: the source browser must be closed, or use a copy ("lock" file). We detect
  // the lock and surface a helpful error.
  const persistentDir = cfg.USER_DATA_DIR?.trim() || "";
  if (persistentDir) {
    const { existsSync } = await import("node:fs");
    // Detect Firefox/Zen lock (profile in use by running browser)
    if (existsSync(persistentDir + "/lock") || existsSync(persistentDir + "/.parentlock")) {
      // Not fatal for all setups, but warn — Playwright will fail with cryptic error.
      // We still try; if it fails we rewrite the error with guidance below.
    }
    const ctxOpts: any = {
      viewport: { width: cfg.VIEWPORT_WIDTH, height: cfg.VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: cfg.COLOR_SCHEME as any,
    };
    try {
      context = await (pw[browserType] as any).launchPersistentContext(persistentDir, {
        ...launchOpts,
        ...ctxOpts,
      });
      // launchPersistentContext returns a BrowserContext; browser handle is parent
      try { browser = (context as any).browser?.() ?? null; } catch { browser = null; }
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/Executable doesn't exist/i.test(msg)) {
        try {
          await installBrowser(browserType);
          context = await (pw[browserType] as any).launchPersistentContext(persistentDir, {
            ...launchOpts,
            ...ctxOpts,
          });
          try { browser = (context as any).browser?.() ?? null; } catch { browser = null; }
        } catch (err2: any) {
          throw new Error(
            `${browserType} download failed — run manually in the pi-frontend-check install directory: ` +
              `npx playwright install ${browserType} (${err2?.message ?? err2})`,
          );
        }
      } else if (/Failed to launch.*lock|Target closed|another instance/i.test(msg)) {
        throw new Error(
          `Could not launch ${browserType} with USER_DATA_DIR="${persistentDir}": ${msg.split("\n")[0]}\n` +
            `The profile is likely in use — close Zen/Firefox first, or copy the profile to a temp dir and point USER_DATA_DIR there:\n` +
            `  cp -r "${persistentDir}" /tmp/zen-copy && chmod -R u+w /tmp/zen-copy && rm -f /tmp/zen-copy/lock /tmp/zen-copy/.parentlock\n` +
            `Then: /frontend-check set USER_DATA_DIR=/tmp/zen-copy` ,
        );
      } else {
        throw new Error(`Could not launch ${browserType} (persistent): ${msg.split("\n")[0]}`);
      }
    }
    // persistent context already has a page maybe? Ensure one
    context.setDefaultTimeout(cfg.NAV_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(cfg.NAV_TIMEOUT_MS);
  } else {
    try {
      browser = await (pw[browserType] as any).launch(launchOpts);
    } catch (err: any) {
      if (!/Executable doesn't exist/i.test(String(err?.message ?? err))) {
        throw new Error(`Could not launch ${browserType}: ${err?.message ?? err}`);
      }
      try {
        await installBrowser(browserType); // first use: download the browser, then retry
        browser = await (pw[browserType] as any).launch(launchOpts);
      } catch (err2: any) {
        throw new Error(
          `${browserType} download failed — run manually in the pi-frontend-check install directory: ` +
            `npx playwright install ${browserType} (${err2?.message ?? err2})`,
        );
      }
    }
    const ctxOpts: any = {
      viewport: { width: cfg.VIEWPORT_WIDTH, height: cfg.VIEWPORT_HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: cfg.COLOR_SCHEME as any,
    };
    // storageState: path to JSON file or inline JSON string
    if (cfg.STORAGE_STATE?.trim()) {
      // Playwright accepts a path; if STORAGE_STATE is JSON object string, we write to temp
      ctxOpts.storageState = cfg.STORAGE_STATE.trim();
    } else if ((cfg as any).STORAGE_STATE_JSON?.trim()) {
      try { ctxOpts.storageState = JSON.parse((cfg as any).STORAGE_STATE_JSON); } catch {}
    }
    context = await browser.newContext(ctxOpts);
    context.setDefaultTimeout(cfg.NAV_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(cfg.NAV_TIMEOUT_MS);
  }

  const attachPage = (p: any) => {
    // Inherit current color scheme for new tabs/popups (context's colorScheme
    // is fixed at creation, so we override via emulateMedia for later changes).
    if (cfg.COLOR_SCHEME) {
      const target = cfg.COLOR_SCHEME === "no-override" ? null : cfg.COLOR_SCHEME;
      p.emulateMedia({ colorScheme: target as any }).catch(() => {});
    }
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
  };
  context.on("page", attachPage);
  // Attach to any existing pages (persistent contexts start with one)
  try { for (const p of context.pages()) attachPage(p); } catch {}
  return context;
}

async function ensurePage(cfg: Cfg) {
  await ensureContext(cfg);
  if (!page || page.isClosed()) {
    page = await context.newPage();
    // Apply current color scheme to the new page (new pages inherit context's
    // colorScheme, but if cfg was changed after context creation we need to
    // override via emulateMedia).
    if (cfg.COLOR_SCHEME && cfg.COLOR_SCHEME !== "no-override") {
      await page.emulateMedia({ colorScheme: cfg.COLOR_SCHEME as any }).catch(() => {});
    } else if (cfg.COLOR_SCHEME === "no-override") {
      await page.emulateMedia({ colorScheme: null as any }).catch(() => {});
    }
  }
  return page;
}

// --- Color-scheme emulation --------------------------------------------
export type ColorScheme = "light" | "dark" | "no-preference" | "no-override";

export function normalizeColorScheme(raw: string): ColorScheme {
  const v = raw.trim().toLowerCase().replace(/_/g, "-");
  if (v === "light" || v === "dark" || v === "no-preference" || v === "no-override") return v;
  throw new Error(`Invalid color scheme "${raw}" — use light | dark | no-preference | no-override`);
}

export async function setColorScheme(cfg: Cfg, scheme: string): Promise<ColorScheme> {
  const normalized = normalizeColorScheme(scheme);
  cfg.COLOR_SCHEME = normalized;
  // Apply to all existing pages in the context (current + any popups/tabs)
  const targetScheme = normalized === "no-override" ? null : normalized;
  if (context) {
    const pages: any[] = context.pages();
    for (const p of pages) {
      if (!p.isClosed()) {
        try { await p.emulateMedia({ colorScheme: targetScheme as any }); } catch {}
      }
    }
    // Also ensure the current page (may not be in context.pages() yet if just created)
    if (page && !page.isClosed() && !pages.includes(page)) {
      try { await page.emulateMedia({ colorScheme: targetScheme as any }); } catch {}
    }
    // Let media query listeners and CSS recompute before the next screenshot
    if (pages.length || (page && !page.isClosed())) {
      try { await (pages[0] ?? page).waitForTimeout(150); } catch {}
    }
  } else if (page && !page.isClosed()) {
    try { await page.emulateMedia({ colorScheme: targetScheme as any }); } catch {}
    try { await page.waitForTimeout(150); } catch {}
  }
  return normalized;
}

export function getColorScheme(cfg: Cfg): ColorScheme {
  return cfg.COLOR_SCHEME;
}

export async function closeBrowser() {
  // Persistent contexts: closing the context closes the browser.
  try {
    if (context && typeof context.close === "function") {
      // If this is a persistent context, context.close() is enough; otherwise browser.close()
      const isPersistent = !!(browser == null && context);
      if (isPersistent) await context.close();
      else await browser?.close();
    } else {
      await browser?.close();
    }
  } catch {
    /* already gone */
  }
  browser = context = page = null;
  log = [];
}

export async function saveStorageState(outPath: string): Promise<string> {
  if (!context) throw new Error("No browser context — open a page first.");
  const { writeFileSync } = await import("node:fs");
  const state = await context.storageState();
  writeFileSync(outPath, JSON.stringify(state, null, 2), "utf-8");
  return outPath;
}

export function currentUrl(): string {
  return page && !page.isClosed() ? page.url() : "";
}

export function getLog(): LogEntry[] {
  return log;
}

function syncPage() {
  if (!context) return;
  const open = context.pages().filter((p: any) => !p.isClosed());
  if (open.length) page = open[open.length - 1];
}

// --- Aria / accessibility snapshot -------------------------------------
// Playwright's accessibility tree (via Chrome) gives role/name/value/level/
// checked/disabled/selected + children. We format it as an indented text tree
// with getByRole hints — the same signal T3's preview_snapshot provides.
// Falls back to a DOM walker when accessibility.snapshot is unavailable.

export type AriaOpts = {
  selector?: string;
  compact?: boolean;
  maxNodes?: number;
  maxChars?: number;
};

async function fallbackDomAria(p: any, selector?: string, compact = true): Promise<string> {
  return await p.evaluate(
    ({ sel, compactMode }: { sel?: string; compactMode: boolean }) => {
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return `(selector "${sel}" not found)`;
      const lines: string[] = [];
      const MAX = 300;
      let count = 0;
      const actionable = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "tab", "option", "heading", "searchbox"]);
      function ariaName(el: Element): string {
        const labelled = el.getAttribute("aria-label");
        if (labelled) return labelled.trim().slice(0,80);
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const ref = document.getElementById(labelledBy);
          if (ref?.innerText) return ref.innerText.trim().slice(0,80);
        }
        const he = el as HTMLElement;
        // Prefer visible text, then placeholder/alt
        const t = he.innerText?.split("\n")[0]?.trim();
        if (t && t.length <= 80 && !he.querySelector("input,button,a")) return t.slice(0,80);
        // For inputs, use placeholder/aria-label/value
        const inp = el as HTMLInputElement;
        if (inp.placeholder) return inp.placeholder.slice(0,80);
        const img = el as HTMLImageElement;
        if (img.alt) return img.alt.slice(0,80);
        return "";
      }
      function roleOf(el: Element): string {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type?.toLowerCase();
        if (tag === "a" && el.hasAttribute("href")) return "link";
        if (tag === "button") return "button";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "header") return "banner";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "footer") return "contentinfo";
        if (tag === "aside") return "complementary";
        if (tag === "form") return "form";
        if (tag === "ul" || tag === "ol") return "list";
        if (tag === "li") return "listitem";
        if (tag === "img") return "img";
        if (tag === "input") {
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "search") return "searchbox";
          if (type === "button" || type === "submit") return "button";
          return "textbox";
        }
        if (tag === "textarea") return "textbox";
        if (tag === "select") return "combobox";
        if (tag === "table") return "table";
        return tag; // fallback: use tag as role hint (generic/div/span stay generic)
      }
      function levelOf(el: Element): string {
        const tag = el.tagName;
        if (/^H[1-6]$/.test(tag)) return ` level=${tag[1]}`;
        const ariaLevel = el.getAttribute("aria-level");
        if (ariaLevel) return ` level=${ariaLevel}`;
        return "";
      }
      function walk(el: Element, depth: number) {
        if (count >= MAX) return;
        if (!(el instanceof HTMLElement)) return;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
        const role = roleOf(el);
        const nameRaw = ariaName(el);
        // For headings, prefer text content
        let name = nameRaw;
        if (role === "heading" && !name) {
          name = (el.textContent || "").trim().split("\n")[0]?.slice(0,80) || "";
        }
        if (role === "link" && !name) {
          name = (el.textContent || "").trim().slice(0,80);
        }
        if (role === "button" && !name) {
          name = (el.textContent || "").trim().slice(0,80);
        }
        const isGeneric = role === "div" || role === "span" || role === "generic" || role === "section";
        const hasChildren = el.children.length > 0;
        if (compactMode && isGeneric && !name && hasChildren) {
          for (const c of Array.from(el.children)) { if (count < MAX) walk(c, depth); }
          return;
        }
        // Skip empty wrappers that just pass through
        if (compactMode && isGeneric && !name && el.children.length === 1) {
          for (const c of Array.from(el.children)) walk(c, depth);
          return;
        }
        const indent = "  ".repeat(depth);
        let line = `${indent}- ${role}`;
        if (name) line += ` "${name.replace(/"/g, '\\"')}"`;
        const val = (el as HTMLInputElement).value;
        if (val && typeof val === "string" && val.trim().slice(0, 40)) line += ` [value="${val.trim().slice(0, 40).replace(/"/g, '\\"')}"]`;
        if ((el as HTMLElement).hasAttribute("disabled")) line += " disabled";
        const ariaChecked = el.getAttribute("aria-checked");
        if (ariaChecked) line += ` checked=${ariaChecked}`;
        else if ((el as HTMLInputElement).checked && role === "checkbox") line += " checked=true";
        if (el.getAttribute("aria-selected")) line += ` selected=${el.getAttribute("aria-selected")}`;
        line += levelOf(el);
        if (actionable.has(role) && name) line += `  -> getByRole('${role}', {name: "${name.slice(0, 40).replace(/"/g, '\\"')}"})`;
        const id = el.id ? `#${el.id}` : "";
        const testId = el.getAttribute("data-testid") ? `[data-testid="${el.getAttribute("data-testid")}"]` : "";
        if (id || testId) line += `  // ${id || testId}`;
        lines.push(line);
        count++;
        for (const c of Array.from(el.children)) { if (count < MAX) walk(c, depth + 1); }
      }
      walk(root as Element, 0);
      if (!lines.length) return "(empty — no detectable roles)";
      let out = lines.join("\n");
      if (count >= MAX) out += `\n… [truncated to ${MAX} nodes — use selector to focus]`;
      return out;
    },
    { sel: selector, compactMode: compact },
  );
}

export async function ariaSnapshot(cfg: Cfg, opts: AriaOpts = {}): Promise<string> {
  const p = requirePage();
  syncPage();
  const compact = opts.compact ?? true;
  const maxNodes = opts.maxNodes ?? 300; // used for fallback only
  const maxChars = opts.maxChars ?? 12000;

  // Prefer native Playwright aria snapshots (1.61+) — they include correct
  // roles, names, refs and handle iframes. We enrich with getByRole hints.
  let lastError = "";
  let yaml: string | null = null;
  try {
    if (opts.selector) {
      const loc: any = p.locator(opts.selector).first();
      if (typeof loc.ariaSnapshot === "function") {
        yaml = await loc.ariaSnapshot().catch((e:any) => { lastError = e?.message ?? String(e); return null; });
      } else if (typeof p.ariaSnapshot === "function") {
        // fallback: snapshot whole page and filter? just use fallback
        yaml = null;
      }
    } else {
      if (typeof p.ariaSnapshot === "function") {
        yaml = await p.ariaSnapshot().catch((e:any) => { lastError = e?.message ?? String(e); return null; });
      }
    }
  } catch (e:any) { lastError = e?.message ?? String(e); yaml = null; }

  if (yaml && typeof yaml === "string" && yaml.trim()) {
    // Enrich YAML with getByRole hints for actionable roles
    const actionable = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "tab", "option", "heading"]);
    const lines = yaml.split("\n");
    const enriched = lines.map((line) => {
      const m = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]+)")?/);
      if (!m) return line;
      const role = m[1];
      const name = m[2];
      if (role && name && actionable.has(role) && !line.includes("getByRole")) {
        return line + `  -> getByRole('${role}', {name: "${name.slice(0,40).replace(/"/g, '\\"')}"})`;
      }
      return line;
    });
    let out = enriched.join("\n");
    // Respect compact by not pruning YAML — it is already semantic; just truncate
    out = truncate(out, maxChars);
    if (yaml.length > maxChars) out += `\n… [truncated ${yaml.length} chars — use selector to focus]`;
    return out;
  }

  // Native snapshot unavailable or empty — use accessibility/fallback path
  // Try legacy accessibility.snapshot if present (older Playwright), otherwise DOM fallback
  if (typeof (p as any).accessibility?.snapshot === "function") {
    try {
      let root: any = null;
      if (opts.selector) {
        const loc = p.locator(opts.selector).first();
        const handle = await loc.elementHandle().catch((e:any) => { lastError = e?.message ?? String(e); return null; });
        if (handle) root = await (p as any).accessibility.snapshot({ interestingOnly: compact, root: handle }).catch((e:any) => { lastError = e?.message ?? String(e); return null; });
      } else {
        root = await (p as any).accessibility.snapshot({ interestingOnly: compact }).catch((e:any) => { lastError = e?.message ?? String(e); return null; });
      }
      if (root) {
        const lines: string[] = [];
        let count = 0;
        const actionable2 = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "tab", "option", "heading"]);
        function walk(n: any, depth: number) {
          if (count >= maxNodes || !n) return;
          const role: string = n.role || "generic";
          const name: string = (n.name || "").replace(/\s+/g, " ").trim().slice(0, 120);
          const value: string = n.value != null ? String(n.value).slice(0, 60) : "";
          const level = n.level != null ? ` level=${n.level}` : "";
          const checked = n.checked != null ? ` checked=${n.checked}` : "";
          const disabled = n.disabled ? " disabled" : "";
          const selected = n.selected ? " selected" : "";
          const expanded = n.expanded != null ? ` expanded=${n.expanded}` : "";
          const isGeneric = role === "generic" || role === "";
          const hasKids = Array.isArray(n.children) && n.children.length > 0;
          if (compact && isGeneric && !name && !value && hasKids) {
            for (const c of n.children) { if (count < maxNodes) walk(c, depth); }
            return;
          }
          if (compact && isGeneric && !name && n.children?.length === 1) {
            for (const c of n.children) walk(c, depth);
            return;
          }
          const indent = "  ".repeat(depth);
          let line = `${indent}- ${role}`;
          if (name) line += ` "${name.replace(/"/g, '\\"')}"`;
          if (value) line += ` [value="${value.replace(/"/g, '\\"')}"]`;
          if (level) line += level;
          if (checked) line += checked;
          if (disabled) line += disabled;
          if (selected) line += selected;
          if (expanded) line += expanded;
          if (actionable2.has(role) && name) line += `  -> getByRole('${role}', {name: "${name.slice(0, 40).replace(/"/g, '\\"')}"})`;
          lines.push(line);
          count++;
          for (const c of n.children || []) {
            if (count >= maxNodes) break;
            walk(c, depth + 1);
          }
        }
        walk(root, 0);
        if (lines.length) {
          let out = lines.join("\n");
          out = truncate(out, maxChars);
          if (count >= maxNodes && !out.includes("truncated to")) out += `\n… [truncated to ${maxNodes} nodes — use selector to focus subtree or compact:false]`;
          return out;
        }
      }
    } catch (e:any) { lastError = e?.message ?? String(e); }
  }

  // Final fallback: DOM walker with semantic mapping
  const fb = await fallbackDomAria(p, opts.selector, compact);
  const note = lastError ? `(aria snapshot via fallback — native failed: ${lastError})\n` : "";
  // Truncate fallback too
  const truncated = truncate(fb, maxChars);
  return note + truncated + (fb.length > maxChars ? `\n… [truncated ${fb.length} chars]` : "");
}

function requirePage() {
  if (!page || page.isClosed()) throw new Error("No page is open — call frontend_open first.");
  return page;
}

// Title, URL, viewport, and console health of the current page — the text
// half of every open/act result (the screenshot is the other half).
export async function describeCurrent(): Promise<string> {
  // A click may have opened a new tab — follow the newest open page.
  const open = context?.pages().filter((p: any) => !p.isClosed()) ?? [];
  if (open.length) page = open[open.length - 1];
  const title = await page.title().catch(() => "");
  const size = page.viewportSize();
  // Resolve effective color scheme: page emulation overrides context
  let effectiveScheme: string | undefined;
  try {
    effectiveScheme = await page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "no-preference").catch(() => undefined);
  } catch {}
  return [
    `# ${title || "(untitled)"}`,
    `URL: ${page.url()}`,
    `Viewport: ${size ? `${size.width}x${size.height}` : "unknown"}`,
    `Color scheme: ${effectiveScheme ?? "unknown"}`,
    summarizeLog(log),
  ].join("\n");
}

export async function openUrl(cfg: Cfg, rawUrl: string, waitFor?: string, colorScheme?: string): Promise<string> {
  const url = normalizeUrl(rawUrl);
  // If a color scheme is requested for this navigation, apply it before
  // creating the page so new contexts inherit it, and after navigation for
  // existing contexts.
  if (colorScheme) {
    normalizeColorScheme(colorScheme); // validate early
    cfg.COLOR_SCHEME = normalizeColorScheme(colorScheme);
  }
  const p = await ensurePage(cfg);
  // Ensure the page reflects the desired scheme (covers existing context case)
  if (colorScheme) {
    await setColorScheme(cfg, colorScheme).catch(() => {});
  } else if (cfg.COLOR_SCHEME) {
    const target = cfg.COLOR_SCHEME === "no-override" ? null : cfg.COLOR_SCHEME;
    await p.emulateMedia({ colorScheme: target as any }).catch(() => {});
  }
  log = []; // fresh page, fresh log
  try {
    await p.goto(url, { waitUntil: "domcontentloaded" });
  } catch (err: any) {
    if (err?.name !== "TimeoutError") {
      throw new Error(`Navigation failed: ${String(err?.message ?? err).split("\n")[0]}`);
    }
    // Slow page — fall through and inspect whatever rendered so far.
  }
  // Re-apply after navigation (some pages reset emulation on navigation)
  if (cfg.COLOR_SCHEME) {
    const target = cfg.COLOR_SCHEME === "no-override" ? null : cfg.COLOR_SCHEME;
    await p.emulateMedia({ colorScheme: target as any }).catch(() => {});
    await p.waitForTimeout(150).catch(() => {});
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
  opts: { full_page?: boolean; selector?: string; width?: number; height?: number; color_scheme?: string; colorScheme?: string } = {},
): Promise<{ data: string; mimeType: string }> {
  const p = requirePage();
  const requestedScheme = opts.color_scheme ?? (opts as any).colorScheme;
  if (requestedScheme) {
    await setColorScheme(cfg, requestedScheme);
    // setColorScheme already waited 150ms; extra buffer for layout
    await p.waitForTimeout(50).catch(() => {});
  }
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
