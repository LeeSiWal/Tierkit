import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mergeEnv, runChild } from "../src/model/providers/runChild.js";

// ── shell:true platform-gate tests (the core Track A.2 acceptance) ────────
//
// ESM note: Node built-in exports are non-configurable live bindings; vi.spyOn
// on them is not supported in ESM mode. Instead we hoist a vi.mock for
// "node:child_process" and capture each call via a module-level spy fn.
// The integration tests in the "runChild" describe below use vi.importActual
// to get real spawn, bypassing the mock, so real child processes can be spawned.

const spawnMock = vi.fn(() => ({
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      // If platform is stubbed (shell-gate tests), use the mock.
      // Otherwise, fall through to the real spawn.
      if ((spawnMock as any).__active) {
        return spawnMock(...args);
      }
      return actual.spawn(...(args as Parameters<typeof actual.spawn>));
    },
  };
});

describe("runChild shell-gate by platform", () => {
  beforeEach(() => {
    (spawnMock as any).__active = true;
    spawnMock.mockClear();
  });
  afterEach(() => {
    (spawnMock as any).__active = false;
    vi.unstubAllGlobals();
  });

  it("sets shell:true on win32 (.cmd shim resolution)", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    runChild("claude", ["--version"], {});
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ shell: true }),
    );
  });

  it("sets shell:false on linux (preserve macOS/Linux quoting semantics)", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    runChild("claude", ["--version"], {});
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("sets shell:false on darwin", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    runChild("claude", ["--version"], {});
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("strips undefined values from spawn env (no literal 'undefined' string leaks)", () => {
    vi.stubGlobal("process", { ...process, platform: "linux", env: { A: "1", B: undefined } as any });
    runChild("x", [], { callerEnv: { C: undefined, D: "ok" } });
    const env = spawnMock.mock.calls[0]![2]!.env as Record<string, string>;
    expect(env.A).toBe("1");
    expect("B" in env).toBe(false);
    expect("C" in env).toBe(false);
    expect(env.D).toBe("ok");
    for (const v of Object.values(env)) expect(v).not.toBe("undefined");
  });
});

describe("mergeEnv", () => {
  it("returns base when extra is omitted", () => {
    const out = mergeEnv({ A: "1", B: "2" });
    expect(out).toEqual({ A: "1", B: "2" });
  });

  it("merges extra over base", () => {
    const out = mergeEnv({ A: "1", B: "2" }, { B: "override", C: "3" });
    expect(out).toEqual({ A: "1", B: "override", C: "3" });
  });

  it("strips undefined values in base", () => {
    const out = mergeEnv({ A: "1", B: undefined as unknown as string });
    expect(out).toEqual({ A: "1" });
    expect("B" in out).toBe(false);
  });

  it("strips undefined values in extra and removes the key from result", () => {
    const out = mergeEnv({ A: "1", B: "2" }, { B: undefined });
    expect(out).toEqual({ A: "1" });
    expect("B" in out).toBe(false);
  });

  it("does not return literal string 'undefined' for any value", () => {
    const out = mergeEnv({ A: "1" }, { B: undefined, C: "3" });
    for (const v of Object.values(out)) expect(v).not.toBe("undefined");
  });
});

describe("runChild", () => {
  it("inherits process.env and propagates callerEnv", async () => {
    const child = runChild(
      process.execPath,
      ["-e", "process.stdout.write((process.env.TIERKIT_TEST ?? 'missing') + '|' + (process.env.PATH ? 'haspath' : 'nopath'))"],
      { callerEnv: { TIERKIT_TEST: "ok" } },
    );
    const stdout: string = await new Promise((resolve) => {
      let buf = "";
      child.stdout!.on("data", (c: Buffer) => { buf += c.toString("utf8"); });
      child.on("close", () => resolve(buf));
    });
    expect(stdout).toBe("ok|haspath");
  });

  it("does not pass undefined values to child env", async () => {
    const child = runChild(
      process.execPath,
      ["-e", "process.stdout.write(process.env.TIERKIT_TEST_UNDEFINED ?? 'absent')"],
      { callerEnv: { TIERKIT_TEST_UNDEFINED: undefined } },
    );
    const stdout: string = await new Promise((resolve) => {
      let buf = "";
      child.stdout!.on("data", (c: Buffer) => { buf += c.toString("utf8"); });
      child.on("close", () => resolve(buf));
    });
    expect(stdout).toBe("absent");
  });
});
