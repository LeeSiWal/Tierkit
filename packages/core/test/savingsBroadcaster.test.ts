import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as broadcaster from "../src/runtime/savingsBroadcaster.js";

class MockRes extends EventEmitter {
  written: string[] = [];
  ended = false;
  shouldThrow = false;
  write(chunk: string): boolean {
    if (this.shouldThrow) throw new Error("EPIPE");
    this.written.push(chunk);
    return true;
  }
  end() { this.ended = true; }
  setHeader() { /* noop */ }
  flushHeaders() { /* noop */ }
  get writableEnded() { return this.ended; }
  get destroyed() { return false; }
}

// Minimal TierkitConfig with a priced baseline so resolveSavingsBaseline
// returns a non-undefined inputUsdPerMillion.
const cfg = {
  modelProfiles: {
    claudeSonnet: { provider: "anthropic", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  },
  routingBaseline: "claudeSonnet",
} as any;

describe("savingsBroadcaster", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-bcast-"));
  });
  afterEach(async () => {
    broadcaster.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("subscribe writes a snapshot immediately", async () => {
    broadcaster.start({ getConfig: () => cfg });
    const res = new MockRes();
    await broadcaster.subscribe(res as any, tmp);
    expect(res.written.length).toBe(1);
    expect(res.written[0]).toMatch(/^data: /);
    const payload = JSON.parse(res.written[0].slice(6).trim());
    expect(payload.type).toBe("savings-snapshot");
    expect(payload.summary).toBeDefined();
  });

  it("broadcast writes to every subscriber", async () => {
    broadcaster.start({ getConfig: () => cfg });
    const a = new MockRes();
    const b = new MockRes();
    await broadcaster.subscribe(a as any, tmp);
    await broadcaster.subscribe(b as any, tmp);
    a.written.length = 0;
    b.written.length = 0;
    await broadcaster.broadcast(tmp);
    expect(a.written.length).toBe(1);
    expect(b.written.length).toBe(1);
  });

  it("write failure removes only the broken subscriber", async () => {
    broadcaster.start({ getConfig: () => cfg });
    const ok = new MockRes();
    const broken = new MockRes();
    broken.shouldThrow = true;
    await broadcaster.subscribe(ok as any, tmp);
    await broadcaster.subscribe(broken as any, tmp).catch(() => { /* expected to swallow */ });
    ok.written.length = 0;
    broken.written.length = 0;
    await broadcaster.broadcast(tmp);
    expect(ok.written.length).toBe(1);
    expect(broken.written.length).toBe(0);
    // Second broadcast — broken is gone, ok still receives.
    await broadcaster.broadcast(tmp);
    expect(ok.written.length).toBe(2);
  });

  it("heartbeat fires every 30s", async () => {
    vi.useFakeTimers();
    try {
      broadcaster.start({ getConfig: () => cfg, workspaceRootForHeartbeat: tmp });
      const res = new MockRes();
      await broadcaster.subscribe(res as any, tmp);
      res.written.length = 0;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(res.written.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop clears the subscriber set and stops the heartbeat", async () => {
    vi.useFakeTimers();
    try {
      broadcaster.start({ getConfig: () => cfg, workspaceRootForHeartbeat: tmp });
      const res = new MockRes();
      await broadcaster.subscribe(res as any, tmp);
      broadcaster.stop();
      res.written.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(res.written.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Cross-module integration with logMcpActivity is covered by the
  // in-process HTTP test in Task 4 (Server.savingsStream.test.ts).
});
