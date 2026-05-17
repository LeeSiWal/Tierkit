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

});
