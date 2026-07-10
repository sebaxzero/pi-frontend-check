// Pure helpers shared by the extension and test.mjs — no playwright import,
// so tests run without a browser.
import { pathToFileURL } from "node:url";

export type LogEntry = {
  kind: "console" | "pageerror" | "requestfailed" | "http";
  level: "error" | "warning" | "info";
  text: string;
  ts: number;
};

// Accepts http(s)/file URLs, scheme-less host:port shorthand ("localhost:5173"),
// and absolute filesystem paths to HTML files. This tool targets the user's own
// frontend (dev server, static build), so localhost is the point — unlike
// pi-browser-search there is deliberately no SSRF blocking.
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) throw new Error("Empty URL");
  // Absolute path (Windows drive, UNC, or POSIX) → file:// URL
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("/")) {
    return pathToFileURL(s).toString();
  }
  // "localhost:3000" is host:port shorthand, not a "localhost:" scheme
  const looksHostPort = /^[a-z0-9.-]+:\d+([/?#]|$)/i.test(s);
  const hasScheme = !looksHostPort && /^[a-z][a-z0-9+.-]*:/i.test(s);
  const withScheme = hasScheme ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") {
    throw new Error(`Unsupported scheme ${u.protocol}// (use http, https, or file)`);
  }
  return u.toString();
}

// Compact one-look health line for open/act results; first errors inline so
// the model usually doesn't need a frontend_console round-trip.
export function summarizeLog(log: LogEntry[]): string {
  const errors = log.filter((e) => e.level === "error");
  const warnings = log.filter((e) => e.level === "warning");
  if (errors.length === 0 && warnings.length === 0) {
    return "Console: clean (no errors or warnings since load)";
  }
  const lines = [
    `Console: ${errors.length} error(s), ${warnings.length} warning(s) since load — full log via frontend_console`,
    ...errors.slice(0, 5).map((e) => `  [${e.kind}] ${e.text.slice(0, 200)}`),
  ];
  if (errors.length > 5) lines.push(`  … and ${errors.length - 5} more error(s)`);
  return lines.join("\n");
}

export function formatLog(log: LogEntry[], level: string = "all", max = 100): string {
  const filtered = level === "all" ? log : log.filter((e) => e.level === level);
  if (filtered.length === 0) {
    return level === "all" ? "Console log is empty." : `No ${level} entries in the console log.`;
  }
  const shown = filtered.slice(-max);
  const skipped = filtered.length - shown.length;
  const header = skipped > 0 ? `(${skipped} older entries omitted)\n` : "";
  return header + shown.map((e) => `[${e.level}] (${e.kind}) ${e.text}`).join("\n");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + ` … [truncated, ${s.length} chars total]`;
}
