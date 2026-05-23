import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { startServer, type RunningServer } from "@tierkit/core";

let tmp = "";
let server: RunningServer | null = null;
let baseUrl = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-http-digest-"));
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "src/foo.ts"),
    "export function helper() { return 1 }\nexport class Widget {}\n",
  );
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  baseUrl = `http://${server.address}:${server.port}`;
});

afterEach(async () => {
  await server?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function postJson(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /v1/digest/command", () => {
  it("returns 200 with compressed brief + stats", async () => {
    const r = await postJson("/v1/digest/command", { command: "Add CRUD for AdminMenuForm. Keep existing structure intact." });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.digest.compressed).toContain("Task:");
    expect(r.body.digest.stats.beforeTokens).toBeGreaterThan(0);
    expect(r.body.digest.requirements.length).toBeGreaterThan(0);
  });

  it("returns 400 when command missing", async () => {
    const r = await postJson("/v1/digest/command", {});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("bad-request");
  });

  it("returns 404 when refine.profileId not found", async () => {
    const r = await postJson("/v1/digest/command", {
      command: "Add x",
      refine: { profileId: "does-not-exist" },
    });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("profile-not-found");
  });

  it("returns 400 when refine.profileId is not a string", async () => {
    const r = await postJson("/v1/digest/command", {
      command: "Add x",
      refine: { profileId: 42 },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("bad-request");
  });
});

describe("POST /v1/digest/error", () => {
  it("returns 200 with parsed errors", async () => {
    const r = await postJson("/v1/digest/error", { log: "src/foo.ts:1:1 - error TS2345: bad arg" });
    expect(r.status).toBe(200);
    expect(r.body.digest.mainErrors.length).toBe(1);
    expect(r.body.digest.likelyFiles).toContain("src/foo.ts");
  });

  it("returns 400 when log missing", async () => {
    const r = await postJson("/v1/digest/error", {});
    expect(r.status).toBe(400);
  });
});

describe("POST /v1/digest/test", () => {
  it("returns 200 with passed/failed counts", async () => {
    const r = await postJson("/v1/digest/test", { output: "✓ pass 1\n× suite > case\n    Expected: 1\n    Received: 2" });
    expect(r.status).toBe(200);
    expect(r.body.digest.passedCount).toBe(1);
    expect(r.body.digest.failedCount).toBe(1);
  });
});

describe("POST /v1/digest/json", () => {
  it("returns 200 with shape + field paths", async () => {
    const r = await postJson("/v1/digest/json", { json: JSON.stringify({ a: 1, b: { c: 2 } }) });
    expect(r.status).toBe(200);
    expect(r.body.digest.fieldPaths).toContain("b.c");
  });
});

describe("POST /v1/digest/file", () => {
  it("returns 200 with digest for workspace file", async () => {
    const r = await postJson("/v1/digest/file", { path: "src/foo.ts" });
    expect(r.status).toBe(200);
    expect(r.body.digest.importantSymbols).toContain("helper");
    expect(r.body.digest.importantSymbols).toContain("Widget");
  });

  it("returns cacheHit=true on second call", async () => {
    const first = await postJson("/v1/digest/file", { path: "src/foo.ts" });
    expect(first.body.digest.cacheHit).toBe(false);
    const second = await postJson("/v1/digest/file", { path: "src/foo.ts" });
    expect(second.body.digest.cacheHit).toBe(true);
  });

  it("returns 400 outside-workspace for traversal", async () => {
    const r = await postJson("/v1/digest/file", { path: "../../../etc/passwd" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("outside-workspace");
  });

  it("forceRefresh bypasses cache", async () => {
    await postJson("/v1/digest/file", { path: "src/foo.ts" });
    const refreshed = await postJson("/v1/digest/file", { path: "src/foo.ts", forceRefresh: true });
    expect(refreshed.body.digest.cacheHit).toBe(false);
  });
});

describe("POST /v1/digest/diff", () => {
  it("returns 200 for non-git workspace with uncertainty", async () => {
    const r = await postJson("/v1/digest/diff", {});
    expect(r.status).toBe(200);
    expect(r.body.digest.uncertainty.length).toBeGreaterThan(0);
  });
});

describe("GET /v1/digest/cache + POST /v1/digest/cache/clear", () => {
  it("reports empty stats before any digest", async () => {
    const res = await fetch(`${baseUrl}/v1/digest/cache`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stats.empty).toBe(true);
    expect(body.stats.count).toBe(0);
  });

  it("counts cached digests + clears them", async () => {
    // Seed: generate one file digest so the cache has an entry.
    const seed = await postJson("/v1/digest/file", { path: "src/foo.ts" });
    expect(seed.status).toBe(200);

    const statsRes = await fetch(`${baseUrl}/v1/digest/cache`);
    const stats = await statsRes.json();
    expect(stats.stats.count).toBe(1);
    expect(stats.stats.totalBytes).toBeGreaterThan(0);

    const clearRes = await postJson("/v1/digest/cache/clear", {});
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.removedCount).toBe(1);

    const after = await fetch(`${baseUrl}/v1/digest/cache`);
    const afterBody = await after.json();
    expect(afterBody.stats.count).toBe(0);
  });
});

describe("POST /v1/context/pack", () => {
  it("returns 200 with minimal pack when no inputs", async () => {
    const r = await postJson("/v1/context/pack", {});
    expect(r.status).toBe(200);
    expect(r.body.pack.contentMd).toContain("Tierkit Context Pack");
    expect(r.body.pack.contentMd).toContain("Output Policy for Claude Code");
  });

  it("returns 200 with full pack when all inputs provided", async () => {
    const r = await postJson("/v1/context/pack", {
      command: "Update helper to return 2",
      files: ["src/foo.ts"],
      errorLog: "src/foo.ts:1:1 - error TS1: nope",
      testOutput: "× helper > returns 2\n    Expected: 2\n    Received: 1",
      jsonInput: JSON.stringify({ id: 1 }),
      rawContext: "✓ test 1\n✓ test 2",
    });
    expect(r.status).toBe(200);
    expect(r.body.pack.contentMd).toContain("Task Brief");
    expect(r.body.pack.contentMd).toContain("Relevant File Digests");
    expect(r.body.pack.contentMd).toContain("Error Digest");
    expect(r.body.pack.contentMd).toContain("Test Digest");
    expect(r.body.pack.contentMd).toContain("JSON / API Digest");
    expect(r.body.pack.contentMd).toContain("Cleaned Raw Context");
    expect(r.body.pack.relevantFileDigests.length).toBe(1);
  });

  it("returns 400 outside-workspace when files include traversal", async () => {
    const r = await postJson("/v1/context/pack", {
      command: "x",
      files: ["../../etc/hosts"],
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("outside-workspace");
  });

  it("ignores non-string entries in files array", async () => {
    const r = await postJson("/v1/context/pack", {
      command: "x",
      files: ["src/foo.ts", 42, null, undefined],
    });
    expect(r.status).toBe(200);
    expect(r.body.pack.relevantFileDigests.length).toBe(1);
  });
});
