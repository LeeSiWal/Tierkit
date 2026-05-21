import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubscriptionCliProvider, type SubscriptionCliParsedResult } from "../src/model/providers/subscriptionCli.js";
import type { ModelProfile } from "../src/model/ModelProfile.js";

class EchoProvider extends SubscriptionCliProvider {
  buildArgs(p: ModelProfile): string[] { return [...(p.transport!.args ?? [])]; }
  parseStdout(stdout: string): SubscriptionCliParsedResult {
    const trimmed = stdout.trim();
    try {
      const raw = JSON.parse(trimmed);
      return {
        content: typeof raw.result === "string" ? raw.result : trimmed,
        inputTokens: typeof raw.input === "number" ? raw.input : undefined,
        outputTokens: typeof raw.output === "number" ? raw.output : undefined,
        raw,
      };
    } catch {
      return { content: trimmed, raw: trimmed };
    }
  }
}

let tmpDir: string;
async function writeFake(name: string, body: string): Promise<string> {
  const f = path.join(tmpDir, name + ".mjs");
  await fs.writeFile(f, body, "utf8");
  return f;
}
function profileFor(scriptPath: string): ModelProfile {
  return {
    kind: "private-remote",
    provider: "claude-code",
    model: "auto",
    paymentModel: "flat-rate",
    requiresApproval: true,
    roles: [],
    transport: {
      type: "subprocess",
      command: process.execPath,
      args: [scriptPath],
      healthCheckArgs: [scriptPath, "--version"],
      timeoutMs: 5_000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 50_000,
    },
  } as ModelProfile;
}

beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-subcli-")); });
afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

describe("SubscriptionCliProvider.probe", () => {
  it("returns ok on exit 0", async () => {
    const f = await writeFake("ok-version", `process.exit(0);`);
    const r = await new EchoProvider().probe(profileFor(f), {});
    expect(r.ok).toBe(true);
  });

  it("reports cli-not-found on ENOENT", async () => {
    const p = profileFor("/no/such/script.mjs");
    p.transport!.command = "/nonexistent/binary-zzz";
    const r = await new EchoProvider().probe(p, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cli-not-found");
  });

  it("reports cli-healthcheck-failed on exit !== 0", async () => {
    const f = await writeFake("bad-version", `process.exit(2);`);
    const r = await new EchoProvider().probe(profileFor(f), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cli-healthcheck-failed");
  });
});

describe("SubscriptionCliProvider.chat", () => {
  it("parses provider-reported usage when present", async () => {
    const f = await writeFake("echo-usage", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ result: "OK", input: 5, output: 2 }));
      });
    `);
    const r = await new EchoProvider().chat(profileFor(f), {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe("OK");
    expect(r.usage.inputTokens).toBe(5);
    expect(r.usage.outputTokens).toBe(2);
    expect(r.usageSource).toBe("provider-reported");
  });

  it("falls back to estimated when provider does not report usage", async () => {
    const f = await writeFake("echo-no-usage", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ result: "hello there" }));
      });
    `);
    const r = await new EchoProvider().chat(profileFor(f), {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe("hello there");
    expect(r.usageSource).toBe("estimated");
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
  });

  it("returns cli-empty-output for empty stdout", async () => {
    const f = await writeFake("echo-empty", `process.exit(0);`);
    const r = await new EchoProvider().chat(profileFor(f), {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cli-empty-output");
  });

  it("returns cli-exit-nonzero with stderr", async () => {
    const f = await writeFake("echo-fail", `
      process.stderr.write("boom"); process.exit(3);
    `);
    const r = await new EchoProvider().chat(profileFor(f), {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("cli-exit-nonzero");
      expect(r.message).toContain("boom");
    }
  });

  it("returns cli-timeout when subprocess exceeds timeoutMs", async () => {
    const f = await writeFake("echo-slow", `setTimeout(()=>{},10_000);`);
    const p = profileFor(f);
    p.transport!.timeoutMs = 200;
    const r = await new EchoProvider().chat(p, {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cli-timeout");
  });

  it("returns cli-output-too-large when stdout exceeds maxStdoutBytes", async () => {
    const f = await writeFake("echo-big", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write("x".repeat(200_000));
      });
    `);
    const p = profileFor(f);
    p.transport!.maxStdoutBytes = 10_000;
    const r = await new EchoProvider().chat(p, {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cli-output-too-large");
  });

  it("partial usage (input only) → estimated", async () => {
    const f = await writeFake("echo-partial", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ result: "x", input: 5 }));
      });
    `);
    const r = await new EchoProvider().chat(profileFor(f), {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usageSource).toBe("estimated");
  });

  it("non-finite or negative usage → estimated", async () => {
    const f = await writeFake("echo-bad-usage", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ result: "x", input: -1, output: NaN }));
      });
    `);
    const r = await new EchoProvider().chat(profileFor(f), {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usageSource).toBe("estimated");
  });
});
