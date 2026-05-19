import { describe, expect, it } from "vitest";
import { extractKeywords, KEYWORD_CAP } from "../src/context-compression/extractKeywords.js";

describe("extractKeywords", () => {
  it("returns empty array for empty string", () => {
    expect(extractKeywords("")).toEqual([]);
  });

  it("returns empty array when task is only stopwords", () => {
    expect(extractKeywords("the and is of in on")).toEqual([]);
  });

  it("lowercases and splits on whitespace", () => {
    const result = extractKeywords("Fix the Payment Bug");
    expect(result).toContain("fix");
    expect(result).toContain("payment");
    expect(result).toContain("bug");
    expect(result).not.toContain("the");
  });

  it("preserves quoted phrases as single tokens", () => {
    const result = extractKeywords('fix "premium report" access');
    expect(result).toContain("premium report");
    expect(result).toContain("fix");
    expect(result).toContain("access");
  });

  it("extracts camelCase identifiers as-is", () => {
    const result = extractKeywords("debug useAuthToken hook");
    expect(result).toContain("useAuthToken");
  });

  it("extracts snake_case identifiers as-is", () => {
    const result = extractKeywords("rename get_user_id to getUserId");
    expect(result).toContain("get_user_id");
    expect(result).toContain("getUserId");
  });

  it("extracts kebab-case identifiers as-is", () => {
    const result = extractKeywords("update premium-report-card style");
    expect(result).toContain("premium-report-card");
  });

  it("drops 1-2 character non-identifier words", () => {
    const result = extractKeywords("fix it on the api");
    expect(result).not.toContain("it");
    expect(result).not.toContain("on");
    expect(result).toContain("api");  // 3 chars, kept
    expect(result).toContain("fix");
  });

  it("caps at KEYWORD_CAP, preserving priority: quoted > identifier > general", () => {
    const longTask = [
      '"important phrase"',
      "useAuthHook",
      "fetchPaymentStatus",
      "calculate_total_amount",
      "premium-report-card",
      "fix",
      "bug",
      "payment",
      "report",
      "session",
      "redirect",
      "callback",
      "validate",
      "approve",
      "submit",
      "handler",
    ].join(" ");
    const result = extractKeywords(longTask);
    expect(result).toHaveLength(KEYWORD_CAP);
    expect(KEYWORD_CAP).toBe(12);
    expect(result).toContain("important phrase");
    expect(result).toContain("useAuthHook");
    expect(result).toContain("fetchPaymentStatus");
    expect(result).toContain("calculate_total_amount");
    expect(result).toContain("premium-report-card");
  });

  it("dedupes case-insensitively for general words but keeps original casing for identifiers", () => {
    const result = extractKeywords("Payment payment useAuth useAuth");
    expect(result.filter((k) => k.toLowerCase() === "payment")).toHaveLength(1);
    expect(result.filter((k) => k === "useAuth")).toHaveLength(1);
  });
});
