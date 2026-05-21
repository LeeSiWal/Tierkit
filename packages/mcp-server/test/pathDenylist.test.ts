import { describe, it, expect } from "vitest";
import { isDenied, DENIED_PATTERNS } from "../src/pathDenylist.js";

describe("pathDenylist", () => {
  it("denies .env and variants", () => {
    expect(isDenied(".env")).toBe(true);
    expect(isDenied(".env.local")).toBe(true);
    expect(isDenied("config/.env.production")).toBe(true);
  });

  it("denies key/cert files", () => {
    expect(isDenied("certs/server.pem")).toBe(true);
    expect(isDenied("keys/private.key")).toBe(true);
    expect(isDenied("home/.ssh/id_rsa")).toBe(true);
    expect(isDenied("home/.ssh/id_ed25519")).toBe(true);
  });

  it("denies secrets.json regardless of directory", () => {
    expect(isDenied("secrets.json")).toBe(true);
    expect(isDenied("config/secrets.json")).toBe(true);
  });

  it("denies .tierkit/runtime/", () => {
    expect(isDenied(".tierkit/runtime/usage.jsonl")).toBe(true);
    expect(isDenied(".tierkit/runtime/mcp/patches/foo.json")).toBe(true);
  });

  it("allows ordinary source files", () => {
    expect(isDenied("src/index.ts")).toBe(false);
    expect(isDenied("README.md")).toBe(false);
    expect(isDenied("package.json")).toBe(false);
  });

  it("exports DENIED_PATTERNS for diagnostics", () => {
    expect(Array.isArray(DENIED_PATTERNS)).toBe(true);
    expect(DENIED_PATTERNS.length).toBeGreaterThan(0);
  });
});
