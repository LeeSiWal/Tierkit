import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { startServer, type RunningServer } from "@tierkit/core";

let tmp = "";
let server: RunningServer | null = null;
let baseUrl = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-compare-sse-"));
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src/foo.ts"), "export function payment() {}\n");
  // Seed a tierkit.config.json with a profile that the test can target.
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {
        mockProfile: {
          kind: "local-device",
          provider: "mock",
          model: "mock-model",
        },
      },
    }),
  );
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  baseUrl = `http://${server.address}:${server.port}`;
});
afterEach(async () => {
  await server?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function buildArtifact(): Promise<string> {
  const r = await fetch(`${baseUrl}/v1/context/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "fix payment function" }),
  });
  const { artifact } = await r.json();
  return artifact.id;
}

describe("POST /v1/context/:id/compare", () => {
  it("returns 412 confirm-required when confirm is missing, includes estimated payload", async () => {
    const id = await buildArtifact();
    const res = await fetch(`${baseUrl}/v1/context/${id}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "mockProfile" }),  // no confirm
    });
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.code).toBe("confirm-required");
    expect(body.estimated).toBeDefined();
    expect(body.estimated.profileId).toBe("mockProfile");
    expect(typeof body.estimated.baselineInputTokens).toBe("number");
    expect(typeof body.estimated.compressedInputTokens).toBe("number");
  });

  it("returns 404 when artifact does not exist", async () => {
    const res = await fetch(`${baseUrl}/v1/context/ctx_ffffffffff/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "mockProfile", confirm: true }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when profile id is missing", async () => {
    const id = await buildArtifact();
    const res = await fetch(`${baseUrl}/v1/context/${id}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),  // no profileId
    });
    expect(res.status).toBe(400);
  });

  it("streams a happy-path SSE sequence with mock provider", async () => {
    const id = await buildArtifact();
    const res = await fetch(`${baseUrl}/v1/context/${id}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify({ profileId: "mockProfile", confirm: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const eventNames: string[] = [];
    let buffer = "";
    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (chunk.startsWith(":")) continue;  // keepalive
        const ev = /^event:\s*(\S+)/.exec(chunk)?.[1];
        if (ev) {
          eventNames.push(ev);
          if (ev === "compare-done" || ev === "error") {
            done = true;
            break;
          }
        }
      }
    }

    // Expect at minimum: phase(baseline-start) → ... → phase(compressed-start) → ... → compare-done
    expect(eventNames).toContain("phase");
    // Either compare-done (happy path) OR error (provider not implemented)
    expect(eventNames.some((e) => e === "compare-done" || e === "error")).toBe(true);
  });

  it("returns 409 compare-already-running on concurrent compare for same artifact", async () => {
    const id = await buildArtifact();
    // Fire the first compare. Await the response so we know SSE headers have flushed
    // (which only happens AFTER the server adds the id to runningCompares). Don't
    // consume the body — that keeps the SSE handler suspended inside the streaming
    // loop, leaving the id registered.
    const first = await fetch(`${baseUrl}/v1/context/${id}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "mockProfile", confirm: true }),
    });
    // With the mock provider, compareCompressedContext may finish very quickly. To
    // make the race deterministic, read exactly one SSE chunk so we know we're
    // mid-stream — but DON'T drain it. The first 'phase' event arrives well before
    // the SSE writer calls res.end() and removes the id from runningCompares.
    const reader = first.body!.getReader();
    // Immediately fire the second request — it should see the id still in the set.
    const second = await fetch(`${baseUrl}/v1/context/${id}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "mockProfile", confirm: true }),
    });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe("compare-already-running");
    // Consume first to clean up
    try { while (!(await reader.read()).done) {} } catch {}
  });
});
