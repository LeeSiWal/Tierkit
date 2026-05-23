import { describe, it, expect } from "vitest";
import { GUI_HTML } from "../src/runtime/ui/gui.js";

describe("i18n coverage", () => {
  /**
   * Extract every key referenced by data-i18n / data-i18n-title /
   * data-i18n-placeholder attributes inside the GUI_HTML constant. The
   * pattern is forgiving: matches both single and double quotes.
   */
  function collectKeys(html: string): Set<string> {
    const re = /\bdata-i18n(?:-title|-placeholder)?\s*=\s*["']([^"']+)["']/g;
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) out.add(m[1]!);
    return out;
  }

  /**
   * Read the LOCALES.ko keys directly out of the JS source. The block is a
   * static object literal; a regex on its inside is the cheapest reliable
   * extraction without evaluating the script. The match is intentionally
   * loose — we only need to know which key names exist.
   */
  function collectKoKeys(html: string): Set<string> {
    // Find the ko block — opens with `ko: {` after `LOCALES = {`
    const blockMatch = /ko:\s*\{([\s\S]*?)\n\s{4}\}/.exec(html);
    if (!blockMatch) throw new Error("LOCALES.ko block not found in GUI_HTML");
    const body = blockMatch[1]!;
    const keyRe = /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/gm;
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(body)) !== null) out.add(m[1]!);
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
});
