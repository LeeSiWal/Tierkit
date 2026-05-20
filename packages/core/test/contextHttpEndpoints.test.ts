import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { startServer, type RunningServer } from "@tierkit/core";

let tmp = "";
let server: RunningServer | null = null;
let baseUrl = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-http-ctx-"));
  // Minimal workspace + a couple of source files so rg finds candidates.
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "src/foo.ts"),
    "export function payment() { return 'paid' }\n",
  );
  // Extra fixture files so the GET /v1/context/recent tests can build artifacts for
  // tasks containing "bar" / "baz" / "tests" — the recent tests build three artifacts
  // with distinct tasks and need each one to produce ≥1 candidate.
  await fs.writeFile(
    path.join(tmp, "src/bar.ts"),
    "export function bar() { return 'bar' }\n",
  );
  await fs.writeFile(
    path.join(tmp, "src/baz.test.ts"),
    "export function baz() { return 'baz' }\n",
  );
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  baseUrl = `http://${server.address}:${server.port}`;
});
afterEach(async () => {
  await server?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("POST /v1/context/build", () => {
  it("creates an artifact and returns 200 + workspace-relative prompt path", async () => {
    const res = await fetch(`${baseUrl}/v1/context/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix the payment function" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.artifact.id).toMatch(/^ctx_[a-f0-9]{10}$/);
    expect(body.promptMdWorkspacePath).toContain(".tierkit/runtime/context-artifacts/");
    expect(body.promptMdWorkspacePath).toContain("/prompt.md");
    // artifact.json + prompt.md should actually exist on disk
    const dir = path.join(tmp, ".tierkit/runtime/context-artifacts", body.artifact.id);
    await expect(fs.access(path.join(dir, "artifact.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "prompt.md"))).resolves.toBeUndefined();
  });

  it("returns 400 with no-keywords code when task is stopwords only", async () => {
    const res = await fetch(`${baseUrl}/v1/context/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "the and is of" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no-keywords");
  });

  it("returns 400 bad-request when extraIgnoreGlobs is not an array", async () => {
    const res = await fetch(`${baseUrl}/v1/context/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix the payment function", extraIgnoreGlobs: "not-an-array" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("bad-request");
  });

  it("returns 400 bad-request when body is missing entirely", async () => {
    const res = await fetch(`${baseUrl}/v1/context/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("bad-request");
  });
});

describe("GET /v1/context/:id", () => {
  it("returns artifact + verdict null for an existing artifact without verdict", async () => {
    // First build an artifact
    const buildRes = await fetch(`${baseUrl}/v1/context/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix the payment function" }),
    });
    const { artifact } = await buildRes.json();

    const res = await fetch(`${baseUrl}/v1/context/${artifact.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.artifact.id).toBe(artifact.id);
    expect(body.verdict).toBeNull();
  });

  it("returns 404 not-found for an unknown id", async () => {
    const res = await fetch(`${baseUrl}/v1/context/ctx_ffffffffff`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not-found");
  });
});

describe("GET /v1/context/recent", () => {
  it("returns empty list when no artifacts exist", async () => {
    const res = await fetch(`${baseUrl}/v1/context/recent`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recent).toEqual([]);
    expect(body.totalCount).toBe(0);
  });

  it("returns recent artifacts sorted by createdAt DESC with normalized task preview", async () => {
    // Build three with different tasks (newest last)
    const ids: string[] = [];
    for (const task of [
      "fix the\n\npayment\nfunction",  // task with whitespace to test normalization
      "rename foo to bar",
      "add tests for baz",
    ]) {
      const r = await fetch(`${baseUrl}/v1/context/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const { artifact } = await r.json();
      ids.push(artifact.id);
      await new Promise((rr) => setTimeout(rr, 10)); // ensure distinct createdAt
    }

    const res = await fetch(`${baseUrl}/v1/context/recent`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recent.length).toBe(3);
    expect(body.totalCount).toBe(3);
    // Sorted by createdAt DESC: newest (last built) first
    expect(body.recent[0].id).toBe(ids[2]);
    expect(body.recent[2].id).toBe(ids[0]);
    // Task with newlines should be normalized to single spaces
    expect(body.recent[2].task).toBe("fix the payment function");
    expect(body.recent[2].task).not.toContain("\n");
  });

  it("skips malformed artifact dirs and excludes them from totalCount", async () => {
    // Build one valid
    await fetch(`${baseUrl}/v1/context/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix the payment function" }),
    });
    // Create a malformed dir
    const dir = path.join(tmp, ".tierkit/runtime/context-artifacts/ctx_bad0000000");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "artifact.json"), "{not json");

    const res = await fetch(`${baseUrl}/v1/context/recent`);
    const body = await res.json();
    expect(body.recent.length).toBe(1);          // malformed skipped
    expect(body.totalCount).toBe(1);             // malformed excluded from count too
  });
});

describe("POST /v1/context/:id/verdict", () => {
  // Helper: seed an artifact with a compare result, since verdict requires it.
  async function seedArtifactWithCompare(): Promise<string> {
    const buildRes = await fetch(`${baseUrl}/v1/context/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix the payment function" }),
    });
    const { artifact } = await buildRes.json();
    // Directly mutate the artifact to add a compare result (simulating a
    // completed compare without actually running providers).
    const dir = path.join(tmp, ".tierkit/runtime/context-artifacts", artifact.id);
    const ajsonPath = path.join(dir, "artifact.json");
    const ajson = JSON.parse(await fs.readFile(ajsonPath, "utf8"));
    ajson.baselineMdPath = "baseline.md";
    ajson.baselineEstimatedTokens = 100;
    ajson.compare = {
      ranAt: new Date().toISOString(),
      profileId: "claudeSonnet",
      baseline: { inputPath: "baseline.md", estimatedInputTokens: 100, responsePath: "response-baseline.md" },
      compressed: { inputPath: "prompt.md", estimatedInputTokens: 30, responsePath: "response-compressed.md" },
      savedInputTokensEstimate: 70,
    };
    await fs.writeFile(ajsonPath, JSON.stringify(ajson, null, 2));
    return artifact.id;
  }

  it("writes verdict and returns it with server-stamped reviewedAt", async () => {
    const id = await seedArtifactWithCompare();
    const res = await fetch(`${baseUrl}/v1/context/${id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qualityVerdict: "same", missingContext: false, notes: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verdict.artifactId).toBe(id);
    expect(body.verdict.qualityVerdict).toBe("same");
    expect(typeof body.verdict.reviewedAt).toBe("string");
  });

  it("returns 409 compare-not-run when artifact has no compare", async () => {
    // Build without compare
    const buildRes = await fetch(`${baseUrl}/v1/context/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "fix the payment function" }),
    });
    const { artifact } = await buildRes.json();
    const res = await fetch(`${baseUrl}/v1/context/${artifact.id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qualityVerdict: "same" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("compare-not-run");
  });

  it("returns 404 when artifact does not exist", async () => {
    const res = await fetch(`${baseUrl}/v1/context/ctx_ffffffffff/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ qualityVerdict: "same" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("artifact-not-found");
  });

  it("returns 400 on missing qualityVerdict", async () => {
    const id = await seedArtifactWithCompare();
    const res = await fetch(`${baseUrl}/v1/context/${id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
