// Run: node --test test.mjs
// Pure-logic functions are imported from the real .ts module (Node ≥ 22.18
// strips types natively — same zero-build philosophy as the extension).
// report.ts has no playwright import, so it loads standalone.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, summarizeLog, formatLog, truncate } from "./extensions/report.ts";

describe("normalizeUrl", () => {
  test("passes through http(s) URLs", () => {
    assert.equal(normalizeUrl("http://localhost:5173/"), "http://localhost:5173/");
    assert.equal(normalizeUrl("https://example.com/x"), "https://example.com/x");
  });

  test("adds http:// to scheme-less host:port shorthand", () => {
    assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
    assert.equal(normalizeUrl("127.0.0.1:8080/app"), "http://127.0.0.1:8080/app");
  });

  test("allows localhost and private addresses (dev servers are the point)", () => {
    assert.equal(normalizeUrl("http://127.0.0.1:5173/"), "http://127.0.0.1:5173/");
    assert.equal(normalizeUrl("http://192.168.1.10:3000/"), "http://192.168.1.10:3000/");
  });

  test("converts absolute filesystem paths to file:// URLs", () => {
    assert.ok(normalizeUrl("C:/site/index.html").startsWith("file:"));
    assert.ok(normalizeUrl("C:\\site\\index.html").startsWith("file:"));
    assert.ok(normalizeUrl("/srv/site/index.html").startsWith("file:"));
  });

  test("passes through file:// URLs", () => {
    assert.equal(normalizeUrl("file:///C:/site/index.html"), "file:///C:/site/index.html");
  });

  test("rejects unsupported schemes and garbage", () => {
    assert.throws(() => normalizeUrl("ftp://example.com/"), /Unsupported scheme/);
    assert.throws(() => normalizeUrl("javascript:alert(1)"), /Unsupported scheme/);
    assert.throws(() => normalizeUrl(""), /Empty URL/);
    assert.throws(() => normalizeUrl("http://"), /Not a valid URL/);
  });
});

const entry = (level, text, kind = "console") => ({ kind, level, text, ts: 0 });

describe("summarizeLog", () => {
  test("clean log", () => {
    assert.match(summarizeLog([]), /clean/);
    assert.match(summarizeLog([entry("info", "app started")]), /clean/);
  });

  test("counts errors and warnings, inlines first errors", () => {
    const s = summarizeLog([
      entry("error", "TypeError: x is undefined", "pageerror"),
      entry("warning", "deprecated API"),
    ]);
    assert.match(s, /1 error\(s\), 1 warning\(s\)/);
    assert.match(s, /TypeError: x is undefined/);
  });

  test("caps inlined errors at 5 and reports the overflow", () => {
    const log = Array.from({ length: 8 }, (_, i) => entry("error", `err ${i}`));
    const s = summarizeLog(log);
    assert.match(s, /8 error\(s\)/);
    assert.match(s, /and 3 more error\(s\)/);
    assert.doesNotMatch(s, /err 6/);
  });
});

describe("formatLog", () => {
  const log = [
    entry("info", "hello"),
    entry("error", "boom", "pageerror"),
    entry("warning", "HTTP 404 GET /favicon.ico", "http"),
  ];

  test("formats all entries with level and kind", () => {
    const s = formatLog(log);
    assert.match(s, /\[info\] \(console\) hello/);
    assert.match(s, /\[error\] \(pageerror\) boom/);
    assert.match(s, /\[warning\] \(http\) HTTP 404/);
  });

  test("filters by level", () => {
    const s = formatLog(log, "error");
    assert.match(s, /boom/);
    assert.doesNotMatch(s, /hello/);
  });

  test("empty results", () => {
    assert.match(formatLog([], "all"), /empty/);
    assert.match(formatLog([entry("info", "x")], "error"), /No error entries/);
  });

  test("caps output and reports omissions", () => {
    const big = Array.from({ length: 10 }, (_, i) => entry("info", `line ${i}`));
    const s = formatLog(big, "all", 3);
    assert.match(s, /7 older entries omitted/);
    assert.match(s, /line 9/);
    assert.doesNotMatch(s, /line 0/);
  });
});

describe("truncate", () => {
  test("short strings pass through", () => {
    assert.equal(truncate("abc", 10), "abc");
  });

  test("long strings are cut with a marker", () => {
    const s = truncate("a".repeat(100), 10);
    assert.ok(s.startsWith("a".repeat(10)));
    assert.match(s, /truncated, 100 chars total/);
  });
});
