import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubscriptionCliProvider, type SubscriptionCliParsedResult } from "../src/model/providers/subscriptionCli.js";
import { ClaudeCodeProvider } from "../src/model/providers/claudeCode.js";
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

describe("SubscriptionCliProvider — guards", () => {
  it("chat returns not-implemented when transport is absent", async () => {
    const p = {
      kind: "private-remote",
      provider: "claude-code",
      model: "auto",
      paymentModel: "flat-rate",
      requiresApproval: true,
      roles: [],
    } as ModelProfile;
    const r = await new EchoProvider().chat(p, {
      messages: [{ role: "user", content: "hi" }],
    }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not-implemented");
  });
});

describe("SubscriptionCliProvider.stream", () => {
  it("emits start → delta → usage → end on success", async () => {
    const f = await writeFake("stream-ok", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({ result: "hello", input: 3, output: 2 }));
      });
    `);
    const events: any[] = [];
    for await (const e of new EchoProvider().stream(profileFor(f), {
      messages: [{ role: "user", content: "hi" }],
    }, {})) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "usage", "end"]);
    expect(events[1].text).toBe("hello");
    expect(events[2].inputTokens).toBe(3);
    expect(events[2].outputTokens).toBe(2);
  });

  it("emits start → error when chat fails", async () => {
    const f = await writeFake("stream-fail", `
      process.stderr.write("nope"); process.exit(1);
    `);
    const events: any[] = [];
    for await (const e of new EchoProvider().stream(profileFor(f), {
      messages: [{ role: "user", content: "hi" }],
    }, {})) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("error");
    const err = events[events.length - 1];
    expect(err.code).toBe("cli-exit-nonzero");
  });

  it("emits start → error when transport is absent", async () => {
    const p = {
      kind: "private-remote", provider: "claude-code", model: "auto",
      paymentModel: "flat-rate", requiresApproval: true, roles: [],
    } as ModelProfile;
    const events: any[] = [];
    for await (const e of new EchoProvider().stream(p, { messages: [{ role: "user", content: "hi" }] }, {})) {
      events.push(e);
    }
    expect(events[0].type).toBe("start");
    expect(events[events.length - 1].type).toBe("error");
    expect(events[events.length - 1].code).toBe("not-implemented");
  });
});

// ─── SubscriptionCliProvider: env propagation (Task 1.3) ─────────────────────

class TestProvider extends SubscriptionCliProvider {
  buildArgs(_profile: ModelProfile): string[] {
    // Echo the value of TIERKIT_INJECT_TEST so the test can detect env propagation.
    return ["-e", "process.stdout.write(process.env.TIERKIT_INJECT_TEST ?? 'absent')"];
  }
  parseStdout(stdout: string): SubscriptionCliParsedResult {
    return { content: stdout, raw: stdout };
  }
}

function testProfile(): ModelProfile {
  return {
    kind: "public-cloud",
    provider: "test",
    model: "test",
    roles: [],
    displayName: "test",
    transport: {
      type: "subprocess" as const,
      command: process.execPath,
      args: [],
      healthCheckArgs: ["--version"],
      timeoutMs: 10_000,
      maxStdoutBytes: 10_000,
      maxStderrBytes: 10_000,
    },
  } as unknown as ModelProfile;
}

describe("SubscriptionCliProvider.chat — env propagation", () => {
  it("propagates caller-supplied env to the child", async () => {
    const provider = new TestProvider();
    const result = await provider.chat(
      testProfile(),
      { messages: [{ role: "user", content: "ignored" }] },
      { TIERKIT_INJECT_TEST: "injected" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("injected");
  });
});

describe("SubscriptionCliProvider.stream — env propagation", () => {
  it("propagates caller-supplied env to the streaming child", async () => {
    const provider = new TestProvider();
    const events: any[] = [];
    for await (const ev of provider.stream(
      testProfile(),
      { messages: [{ role: "user", content: "ignored" }] },
      { TIERKIT_INJECT_TEST: "stream-ok" },
    )) {
      events.push(ev);
    }

    const deltas = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
    expect(deltas).toContain("stream-ok");
  });
});

// ─── ClaudeCodeProvider: streamArgs ────────────────────────────────────────────

describe("ClaudeCodeProvider.streamArgs", () => {
  it("replaces --output-format json with --output-format stream-json --verbose", () => {
    const provider = new ClaudeCodeProvider();
    const profile: ModelProfile = {
      kind: "private-remote", provider: "claude-code", model: "auto",
      paymentModel: "flat-rate", requiresApproval: true, roles: [],
      transport: {
        type: "subprocess", command: "claude",
        args: ["-p", "--output-format", "json"],
        healthCheckArgs: ["--version"],
        timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
      },
    } as ModelProfile;
    const args = provider.streamArgs(profile);
    expect(args).not.toContain("json");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    // --output-format value is stream-json (not json)
    const idx = args.indexOf("--output-format");
    expect(args[idx + 1]).toBe("stream-json");
  });

  it("replaces --output-format=json (equals form) with stream-json", () => {
    const provider = new ClaudeCodeProvider();
    const profile: ModelProfile = {
      kind: "private-remote", provider: "claude-code", model: "auto",
      paymentModel: "flat-rate", requiresApproval: true, roles: [],
      transport: {
        type: "subprocess", command: "claude",
        args: ["-p", "--output-format=json"],
        healthCheckArgs: ["--version"],
        timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
      },
    } as ModelProfile;
    const args = provider.streamArgs(profile);
    expect(args.some((a) => a.startsWith("--output-format=json"))).toBe(false);
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
  });

  it("preserves other args (e.g. -p)", () => {
    const provider = new ClaudeCodeProvider();
    const profile: ModelProfile = {
      kind: "private-remote", provider: "claude-code", model: "auto",
      paymentModel: "flat-rate", requiresApproval: true, roles: [],
      transport: {
        type: "subprocess", command: "claude",
        args: ["-p", "--output-format", "json"],
        healthCheckArgs: ["--version"],
        timeoutMs: 5_000, maxStdoutBytes: 100_000, maxStderrBytes: 50_000,
      },
    } as ModelProfile;
    const args = provider.streamArgs(profile);
    expect(args).toContain("-p");
  });
});

// ─── ClaudeCodeProvider: parseStreamLine ──────────────────────────────────────

describe("ClaudeCodeProvider.parseStreamLine", () => {
  const provider = new ClaudeCodeProvider();

  it("extracts text from assistant message content array", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hel" }] },
    });
    expect(provider.parseStreamLine(line)).toBe("hel");
  });

  it("concatenates multiple text blocks in one assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "text", text: "foo" },
        { type: "text", text: "bar" },
      ]},
    });
    expect(provider.parseStreamLine(line)).toBe("foobar");
  });

  it("extracts text from content_block_delta / text_delta", () => {
    const line = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "lo" },
    });
    expect(provider.parseStreamLine(line)).toBe("lo");
  });

  it("returns undefined for type:result (avoid double-emit)", () => {
    const line = JSON.stringify({
      type: "result", subtype: "success", result: "hello",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    expect(provider.parseStreamLine(line)).toBeUndefined();
  });

  it("returns undefined for type:system", () => {
    const line = JSON.stringify({ type: "system", subtype: "init" });
    expect(provider.parseStreamLine(line)).toBeUndefined();
  });

  it("returns undefined for non-JSON line", () => {
    expect(provider.parseStreamLine("not json {{{")).toBeUndefined();
  });

  it("returns undefined for empty line", () => {
    expect(provider.parseStreamLine("")).toBeUndefined();
    expect(provider.parseStreamLine("   ")).toBeUndefined();
  });

  it("returns undefined for empty text in assistant event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    });
    expect(provider.parseStreamLine(line)).toBeUndefined();
  });
});

// ─── ClaudeCodeProvider: native stream-json streaming ──────────────────────────

function claudeCodeProfileFor(scriptPath: string): ModelProfile {
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
      args: [scriptPath, "--output-format", "json"],
      healthCheckArgs: [scriptPath, "--version"],
      timeoutMs: 5_000,
      maxStdoutBytes: 100_000,
      maxStderrBytes: 50_000,
    },
  } as ModelProfile;
}

describe("ClaudeCodeProvider native stream-json", () => {
  it("emits multiple delta events for a stream-json script", async () => {
    // Fake CLI emits stream-json lines as the model would
    const f = await writeFake("claude-stream-json", `
      const lines = [
        JSON.stringify({type:"system", subtype:"init"}),
        JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"hel"}]}}),
        JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"lo"}]}}),
        JSON.stringify({type:"result", subtype:"success", result:"hello", usage:{input_tokens:5, output_tokens:2}}),
      ];
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        for (const l of lines) process.stdout.write(l + "\\n");
      });
    `);
    const provider = new ClaudeCodeProvider();
    const profile = claudeCodeProfileFor(f);
    // streamArgs will replace --output-format json with stream-json --verbose
    // but since we're using a fake script, the actual args don't matter for parsing.

    const events: any[] = [];
    for await (const e of provider.stream(profile, { messages: [{ role: "user", content: "hi" }] }, {})) {
      events.push(e);
    }

    const types = events.map((e: any) => e.type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("end");

    const deltas = events.filter((e: any) => e.type === "delta");
    // Should have at least 2 real delta events (one per assistant line)
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0].text).toBe("hel");
    expect(deltas[1].text).toBe("lo");

    const usage = events.find((e: any) => e.type === "usage");
    expect(usage).toBeDefined();
    // Usage should come from parseStdout on the full stdout (result line has usage)
    expect(usage.inputTokens).toBe(5);
    expect(usage.outputTokens).toBe(2);
  });

  it("falls back to single delta when no stream-json lines are present (graceful degrade)", async () => {
    // Fake CLI emits non-streaming JSON (like --output-format=json)
    const f = await writeFake("claude-non-stream", `
      let buf=""; process.stdin.on("data", d=>buf+=d);
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify({type:"result", result:"hello world", usage:{input_tokens:5, output_tokens:2}}));
      });
    `);
    const provider = new ClaudeCodeProvider();
    const profile = claudeCodeProfileFor(f);

    const events: any[] = [];
    for await (const e of provider.stream(profile, { messages: [{ role: "user", content: "hi" }] }, {})) {
      events.push(e);
    }

    // Should degrade gracefully: single delta with full content
    const deltas = events.filter((e: any) => e.type === "delta");
    expect(deltas.length).toBe(1);
    expect(deltas[0].text).toBe("hello world");
    expect(events[events.length - 1].type).toBe("end");
  });
});
