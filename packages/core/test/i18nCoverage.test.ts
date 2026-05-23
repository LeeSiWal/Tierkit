import { describe, it, expect } from "vitest";
import { GUI_HTML } from "../src/runtime/ui/gui.js";

describe("i18n coverage", () => {
  /**
   * Extract every key referenced by data-i18n / data-i18n-title /
   * data-i18n-placeholder attributes inside the GUI_HTML constant.
   */
  function collectKeys(html: string): Set<string> {
    const re = /\bdata-i18n(?:-title|-placeholder)?\s*=\s*["']([^"']+)["']/g;
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) out.add(m[1]!);
    return out;
  }

  /**
   * Collect every Korean key across all `ko: { … }` blocks inside GUI_HTML.
   * Approach: find each occurrence of `ko: {`, then walk the source forward
   * tracking brace depth until the matching close. Inside the body, match
   * every `<identifier>:` token regardless of position on the line (so inline
   * `a: '..', b: '..'` definitions are both caught). Robust to multiple
   * LOCALES tables, varying indentation, and string escapes — strings are
   * skipped via a simple quote-tracking pass.
   */
  function collectKoKeys(html: string): Set<string> {
    const keys = new Set<string>();
    const blockOpenRe = /\bko\s*:\s*\{/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = blockOpenRe.exec(html)) !== null) {
      // Walk forward from after the opening `{`, tracking brace depth
      // while ignoring braces inside strings.
      let i = blockMatch.index + blockMatch[0].length;
      let depth = 1;
      let inSingle = false, inDouble = false, inBack = false, escaped = false;
      const start = i;
      while (i < html.length && depth > 0) {
        const ch = html[i]!;
        if (escaped) { escaped = false; i++; continue; }
        if (ch === "\\") { escaped = true; i++; continue; }
        if (!inSingle && !inDouble && !inBack) {
          if (ch === "'") inSingle = true;
          else if (ch === '"') inDouble = true;
          else if (ch === "`") inBack = true;
          else if (ch === "{") depth++;
          else if (ch === "}") depth--;
        } else if (inSingle && ch === "'") inSingle = false;
        else if (inDouble && ch === '"') inDouble = false;
        else if (inBack && ch === "`") inBack = false;
        i++;
      }
      const body = html.slice(start, i - 1); // exclude the closing `}`
      // Extract identifiers followed by ':' — but only when NOT inside a
      // string literal in the body. Use the same quote-tracking pass to
      // mask out string regions, then run a simple identifier-colon scan.
      const masked = maskStrings(body);
      const keyRe = /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = keyRe.exec(masked)) !== null) keys.add(m[1]!);
    }
    return keys;
  }

  /** Replace all string-literal contents with spaces so identifiers inside
   *  string values don't get picked up by the colon scanner. */
  function maskStrings(src: string): string {
    let out = "";
    let inSingle = false, inDouble = false, inBack = false, escaped = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i]!;
      if (escaped) { out += (inSingle || inDouble || inBack) ? " " : ch; escaped = false; continue; }
      if (ch === "\\" && (inSingle || inDouble || inBack)) { escaped = true; out += " "; continue; }
      if (!inSingle && !inDouble && !inBack) {
        if (ch === "'") { inSingle = true; out += " "; continue; }
        if (ch === '"') { inDouble = true; out += " "; continue; }
        if (ch === "`") { inBack = true; out += " "; continue; }
        out += ch;
      } else {
        if (inSingle && ch === "'") { inSingle = false; out += " "; continue; }
        if (inDouble && ch === '"') { inDouble = false; out += " "; continue; }
        if (inBack && ch === "`") { inBack = false; out += " "; continue; }
        out += " ";
      }
    }
    return out;
  }

  it("every data-i18n* attribute resolves to a LOCALES.ko entry", () => {
    const htmlKeys = collectKeys(GUI_HTML);
    const koKeys = collectKoKeys(GUI_HTML);
    const missing = [...htmlKeys].filter((k) => !koKeys.has(k));
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} HTML i18n key(s) have no Korean translation in LOCALES.ko:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        `\nAdd Korean entries for these keys, or change the HTML to use a key that exists.`,
      );
    }
    expect(htmlKeys.size).toBeGreaterThan(0);
  });

  it("ko block discovery picks up >100 keys (smoke test)", () => {
    // Sanity: ensure the extractor actually walks the LOCALES.ko block(s).
    // If it broke, this would near-zero and the main test would emit hundreds
    // of false positives.
    const koKeys = collectKoKeys(GUI_HTML);
    expect(koKeys.size).toBeGreaterThan(100);
  });
});
