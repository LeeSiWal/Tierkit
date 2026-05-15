import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runRoute } from "../src/usecases/runRoute.js";
import { MockModelClient } from "../src/model/providers/mock.js";

async function makeProject(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-runroute-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

const localProfile = { kind: "local-device", provider: "ollama", model: "qwen", baseUrl: "http://example" };

describe("runRoute", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("returns ok and streams deltas; writes a usage record on completion", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: { localFast: localProfile },
    });
    const mock = new MockModelClient({ chunks: ["hel", "lo"], inputTokens: 4, outputTokens: 5 });
    const result = await runRoute({
      cwd: root,
      env: {},
      task: "rename a helper",
      clientFactory: () => mock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events: string[] = [];
    for await (const evt of result.stream) {
      if (evt.type === "delta") events.push(evt.text);
    }
    expect(events.join("")).toBe("hello");

    const done = await result.done;
    expect(done.text).toBe("hello");
    expect(done.inputTokens).toBe(4);
    expect(done.outputTokens).toBe(5);

    const log = await fs.readFile(path.join(root, ".tierkit/runtime/usage.jsonl"), "utf8");
    expect(log).toContain('"ok":true');
    expect(log).toContain("localFast");
  });

  it("respects --profile override and emits a reason explaining the force", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: {
        localFast: localProfile,
        localStrong: { ...localProfile, model: "big" },
      },
    });
    const mock = new MockModelClient({ chunks: ["ok"] });
    const result = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      profileId: "localStrong",
      clientFactory: () => mock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.profileId).toBe("localStrong");
      expect(result.context.decision.reasons.some((r) => r.includes("forced"))).toBe(true);
    }
    // drain stream
    for await (const _ of (result as { stream: AsyncIterable<unknown> }).stream) {/* no-op */}
  });

  it("rejects unknown profile id", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: { localFast: localProfile },
    });
    const result = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      profileId: "ghost",
      clientFactory: () => new MockModelClient({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown-profile");
  });

  it("tierConstraint=local-only forces local-device even on high-risk task", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: {
        localFast: localProfile,
        cloud: {
          kind: "public-cloud",
          provider: "anthropic",
          model: "claude",
          apiKeyEnv: "AK",
          requiresApproval: true,
          defaultMode: "review-only",
        },
      },
    });
    const mock = new MockModelClient({ chunks: ["ok"] });
    const result = await runRoute({
      cwd: root,
      env: { AK: "abc" },
      task: "audit production secret rotation",
      involvesSecrets: true,
      involvesProductionInfra: true,
      filesTouchedEstimate: 12,
      tierConstraint: "local-only",
      clientFactory: () => mock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.decision.tier).toBe("local-device");
      expect(result.context.profileId).toBe("localFast");
    }
    for await (const _ of (result as { stream: AsyncIterable<unknown> }).stream) {/* no-op */}
  });

  it("applies redaction when going to a remote tier", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: {
        priv: {
          kind: "private-remote",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "m",
          apiKeyEnv: "K",
        },
      },
    });
    const mock = new MockModelClient({ chunks: ["ok"] });
    const taskWithSecret = "review key=sk-abcdefghijklmnopqrstuvw0";
    const result = await runRoute({
      cwd: root,
      env: { K: "x" },
      task: taskWithSecret,
      profileId: "priv",
      clientFactory: () => mock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const userMsg = result.context.messages.find((m) => m.role === "user");
      expect(userMsg?.content).toContain("[REDACTED:openai-api-key]");
      expect(result.context.redactionHits.length).toBeGreaterThan(0);
    }
    for await (const _ of (result as { stream: AsyncIterable<unknown> }).stream) {/* no-op */}
  });

  it("emits the configured mode's system prompt in messages[0]", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: { localFast: localProfile },
    });
    const mock = new MockModelClient({ chunks: ["ok"] });
    const result = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      mode: "plan",
      clientFactory: () => mock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.messages[0]?.role).toBe("system");
      expect(result.context.messages[0]?.content).toContain("PLAN mode");
    }
    for await (const _ of (result as { stream: AsyncIterable<unknown> }).stream) {/* no-op */}
  });

  it("writes ok=false to usage log when the stream errors", async () => {
    root = await makeProject({
      version: "0.1",
      modelProfiles: { localFast: localProfile },
    });
    const mock = new MockModelClient({
      failWith: { code: "bad-status", message: "boom", status: 500 },
    });
    const result = await runRoute({
      cwd: root,
      env: {},
      task: "x",
      clientFactory: () => mock,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      for await (const _ of result.stream) {/* drain */}
      const done = await result.done;
      expect(done.failureCode).toBe("bad-status");
      const log = await fs.readFile(path.join(root, ".tierkit/runtime/usage.jsonl"), "utf8");
      expect(log).toContain('"ok":false');
      expect(log).toContain("bad-status");
    }
  });
});
