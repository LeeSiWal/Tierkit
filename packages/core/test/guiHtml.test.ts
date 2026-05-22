import { describe, it, expect } from "vitest";
import { GUI_HTML } from "../src/runtime/ui/gui.js";

/**
 * Regression test for a class of bug that took out the entire sidebar in 0.8.x:
 *
 *   GUI_HTML is a single huge backtick template literal. Any single-backslash escape
 *   inside that literal (e.g. `\n`, `\s`, `\w` in regex/string code) gets processed
 *   by the OUTER TS template literal — `\n` becomes a raw newline, `\s` loses its
 *   backslash entirely. The output is invalid JavaScript, so the IIFE throws on
 *   parse, no event handlers register, and every click/tap in the sidebar becomes
 *   a no-op.
 *
 * The fix is to double-escape (`\\n`, `\\s`) in TS source. These tests make sure we
 * never silently regress that fix.
 */
describe("GUI_HTML inline script", () => {
  function extractScript(): string {
    const start = GUI_HTML.indexOf("<script>");
    const end = GUI_HTML.lastIndexOf("</script>");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return GUI_HTML.slice(start + "<script>".length, end);
  }

  it("parses as syntactically valid JavaScript", () => {
    const script = extractScript();
    // `new Function(...)` parses (but does not execute) — any SyntaxError surfaces here.
    expect(() => new Function(script)).not.toThrow();
  });

  it("preserves regex escape sequences (no swallowed backslashes)", () => {
    const script = extractScript();
    // Backslash-letter escapes that must survive into the runtime JS as-is. If any of
    // these are missing it means the outer TS template literal ate the backslash.
    const requiredEscapes = ["\\s", "\\w", "\\n", "\\r"];
    for (const esc of requiredEscapes) {
      expect(script).toContain(esc);
    }
  });

  /**
   * VS Code webview API: `acquireVsCodeApi()` may be called AT MOST ONCE per page.
   * The second call throws "An instance of the VS Code API has already been acquired",
   * which kills the IIFE → no event handlers register → sidebar is completely dead.
   *
   * This regressed in 0.9.0 when we hoisted `vsApi` to the outer IIFE scope without
   * realizing `createVsCodeTransport` already calls `acquireVsCodeApi`. Both branches
   * called it, and only one is allowed.
   *
   * The stub used in this test enforces the real webview contract: a counter that throws
   * on the second call. If the inline script calls `acquireVsCodeApi` more than once,
   * the IIFE will throw and this test fails.
   */
  it("does not call acquireVsCodeApi more than once (VS Code webview API contract)", () => {
    const script = extractScript();
    let acquireCount = 0;
    // We synthesize a tiny browser-shaped global so the IIFE can execute. The key piece
    // is the acquireVsCodeApi mock: it counts calls and throws on call #2, matching the
    // real webview behaviour.
    const stub = `
      var __acquireCount = { n: 0 };
      function acquireVsCodeApi() {
        __acquireCount.n++;
        if (__acquireCount.n > 1) {
          throw new Error("An instance of the VS Code API has already been acquired");
        }
        return { postMessage: function(){}, getState: function(){}, setState: function(){} };
      }
      // Minimal DOM stubs — enough for getElementById/createElement chains in the IIFE.
      var __el = function () {
        var el = {
          onclick: null, style: {}, className: "", innerHTML: "", textContent: "",
          firstElementChild: { innerHTML: "" }, value: "",
          addEventListener: function () {}, removeEventListener: function () {},
          appendChild: function () {}, removeChild: function () {},
          querySelector: function () { return null; },
          querySelectorAll: function () { return []; },
          classList: { add: function(){}, remove: function(){} },
          setAttribute: function () {}, removeAttribute: function () {},
          getBoundingClientRect: function () { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
          focus: function () {}, blur: function () {}, click: function () {},
        };
        return el;
      };
      var document = {
        getElementById: function () { return __el(); },
        createElement: function () { return __el(); },
        body: { appendChild: function(){}, removeChild: function(){} },
        querySelectorAll: function () { return []; },
        documentElement: { setAttribute: function () {} },
        addEventListener: function () {},
      };
      var window = {
        __TIERKIT_BASE_URL__: "",
        __TIERKIT_DAEMON_ERROR__: null,
        __TIERKIT_HOST__: "vscode",
        __TIERKIT_SAMPLES__: [],
        addEventListener: function () {},
      };
      var navigator = { language: "en" };
      var setInterval = function () { return 0; };
      var setTimeout = function () { return 0; };
      var fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); };
      var requestAnimationFrame = function () {};
      var btoa = function (s) { return Buffer.from(s, "binary").toString("base64"); };
      // v0.20.8+: webview now reads/writes localStorage (auto-forward toggle,
      // refine profile id, chat session id). Stub a minimal in-memory store so
      // top-level evaluation doesn't crash.
      var __ls = {};
      var localStorage = {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(__ls, k) ? __ls[k] : null; },
        setItem: function (k, v) { __ls[k] = String(v); },
        removeItem: function (k) { delete __ls[k]; },
      };
    `;
    // The IIFE must run to completion without throwing. We capture `__acquireCount` by
    // returning it from the synthesised Function.
    const runner = new Function(stub + script + "; return __acquireCount;");
    let count: { n: number } | undefined;
    expect(() => { count = runner() as { n: number }; }).not.toThrow();
    expect(count?.n ?? 0).toBeLessThanOrEqual(1);
  });
});
