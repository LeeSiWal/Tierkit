import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkRedact } from "../src/usecases/checkRedact.js";
import { checkCommand } from "../src/usecases/checkCommand.js";
import { checkPath } from "../src/usecases/checkPath.js";

describe("checkRedact", () => {
  let tmp: string;
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reads a file and reports redaction hits", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-checkredact-"));
    const file = path.join(tmp, "leak.txt");
    await fs.writeFile(file, "OPENAI_API_KEY=sk-abc1234567890abcdefghij\nGITHUB=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123");
    const r = await checkRedact({ filePath: file });
    expect(r.hits.some((h) => h.ruleId === "openai-api-key")).toBe(true);
    expect(r.hits.some((h) => h.ruleId === "github-token")).toBe(true);
    expect(r.redacted).toContain("[REDACTED:openai-api-key]");
    expect(r.redacted).toContain("[REDACTED:github-token]");
  });

  it("returns zero hits for an innocent file", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-checkredact-"));
    const file = path.join(tmp, "ok.md");
    await fs.writeFile(file, "# Hello\nNothing secret here.");
    const r = await checkRedact({ filePath: file });
    expect(r.hits).toEqual([]);
  });
});

describe("checkCommand", () => {
  it("returns block for a clearly destructive command", async () => {
    const r = await checkCommand({ command: "rm -rf /" });
    expect(r.severity).toBe("block");
  });

  it("returns ok for a harmless command", async () => {
    const r = await checkCommand({ command: "echo hello" });
    expect(r.severity).toBe("ok");
  });
});

describe("checkPath", () => {
  it("flags .env as sensitive", async () => {
    const r = await checkPath({ pathToCheck: ".env" });
    expect(r.sensitive).toBe(true);
    expect(r.matchedPatterns.length).toBeGreaterThan(0);
  });

  it("clears README.md", async () => {
    const r = await checkPath({ pathToCheck: "README.md" });
    expect(r.sensitive).toBe(false);
  });
});
