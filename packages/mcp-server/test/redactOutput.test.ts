import { describe, it, expect } from "vitest";
import { redactOutput } from "../src/redactOutput.js";

describe("redactOutput", () => {
  it("redacts a fake AWS key", () => {
    const r = redactOutput("AWS_KEY=AKIAIOSFODNN7EXAMPLE blah");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("redacts a fake Anthropic key", () => {
    const r = redactOutput("ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(r.text).not.toMatch(/sk-ant-api03-[A-Z]/);
  });

  it("passes through clean text unchanged", () => {
    const r = redactOutput("hello world, nothing secret here");
    expect(r.text).toBe("hello world, nothing secret here");
    expect(r.hits).toEqual([]);
  });
});
