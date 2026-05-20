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
