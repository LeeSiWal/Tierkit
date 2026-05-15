import { describe, it, expect } from "vitest";
import { resolveEffectiveFreedom, checkSessionGate } from "../src/runtime/session/sessionPolicy.js";
import type { ExecutionSession } from "../src/runtime/session/ExecutionSession.js";
import type { PluginManifest, FreedomLevel } from "../src/plugin/PluginManifest.js";

function manifest(id: string, level: FreedomLevel): PluginManifest {
  return {
    schemaVersion: "0.1",
    id,
    name: id,
    version: "0.1.0",
    description: "x",
    author: "t",
    license: "MIT",
    compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
    components: { commands: [], modes: [], rules: [], workflows: [], hooks: [] },
    permissions: {
      readFiles: true,
      editFiles: false,
      runCommands: false,
      registerMcp: false,
      useLocalDeviceModel: true,
      usePrivateRemoteModel: false,
      usePublicCloudModel: false,
      accessSecrets: false,
      modifyAgentSettings: false,
      installDependencies: false,
      useNetwork: false,
    },
    freedom: { level },
  };
}

function session(state: ExecutionSession["state"], planApproved = false): ExecutionSession {
  return {
    id: "s1",
    task: "t",
    createdAt: "now",
    updatedAt: "now",
    state,
    planApproved,
    reviewApproved: false,
    freedom: "strict",
    history: [],
  };
}

describe("resolveEffectiveFreedom", () => {
  it("returns 'free' when no active plugins", () => {
    expect(resolveEffectiveFreedom([], new Map())).toBe("free");
  });

  it("returns the strictest level across active plugins", () => {
    const map = new Map([
      ["a", manifest("a", "guided")],
      ["b", manifest("b", "balanced")],
    ]);
    expect(resolveEffectiveFreedom(["a", "b"], map)).toBe("balanced");
  });

  it("ignores inactive plugins even if installed", () => {
    const map = new Map([["a", manifest("a", "strict")]]);
    expect(resolveEffectiveFreedom([], map)).toBe("free");
  });

  it("strict beats balanced beats guided beats free", () => {
    const map = new Map([
      ["a", manifest("a", "guided")],
      ["b", manifest("b", "strict")],
      ["c", manifest("c", "balanced")],
    ]);
    expect(resolveEffectiveFreedom(["a", "b", "c"], map)).toBe("strict");
  });
});

describe("checkSessionGate", () => {
  it("free always passes", () => {
    expect(checkSessionGate({ freedom: "free", mode: "execute", multiFile: true }).allowed).toBe(true);
  });

  it("guided always passes but warns when no session and not plan mode", () => {
    const r = checkSessionGate({ freedom: "guided", mode: "execute", multiFile: false });
    expect(r.allowed).toBe(true);
    expect(r.warning).toBeDefined();
  });

  it("balanced refuses multi-file execute without a session", () => {
    const r = checkSessionGate({ freedom: "balanced", mode: "execute", multiFile: true });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("no-session");
  });

  it("balanced allows single-file execute without a session", () => {
    expect(
      checkSessionGate({ freedom: "balanced", mode: "execute", multiFile: false }).allowed,
    ).toBe(true);
  });

  it("balanced refuses multi-file execute when session is in planning", () => {
    const r = checkSessionGate({
      freedom: "balanced",
      mode: "execute",
      multiFile: true,
      session: session("planning"),
    });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("wrong-state");
  });

  it("balanced permits multi-file execute when session is in implementing", () => {
    expect(
      checkSessionGate({
        freedom: "balanced",
        mode: "execute",
        multiFile: true,
        session: session("implementing"),
      }).allowed,
    ).toBe(true);
  });

  it("strict refuses execute without an active session", () => {
    const r = checkSessionGate({ freedom: "strict", mode: "execute", multiFile: false });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("no-session");
  });

  it("strict refuses execute when planApproved=false", () => {
    const r = checkSessionGate({
      freedom: "strict",
      mode: "execute",
      multiFile: false,
      session: session("planning", false),
    });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("plan-not-approved");
  });

  it("strict refuses execute when planApproved=true but state != implementing", () => {
    const r = checkSessionGate({
      freedom: "strict",
      mode: "execute",
      multiFile: false,
      session: session("planning", true),
    });
    expect(r.allowed).toBe(false);
    expect(r.code).toBe("wrong-state");
  });

  it("strict permits execute when planApproved and state=implementing", () => {
    expect(
      checkSessionGate({
        freedom: "strict",
        mode: "execute",
        multiFile: false,
        session: session("implementing", true),
      }).allowed,
    ).toBe(true);
  });

  it("strict refuses review when state is not implementing or reviewing", () => {
    expect(
      checkSessionGate({
        freedom: "strict",
        mode: "review",
        multiFile: false,
        session: session("planning"),
      }).allowed,
    ).toBe(false);
  });

  it("strict refuses any mode when session is done or abandoned", () => {
    const done = session("done");
    expect(
      checkSessionGate({ freedom: "strict", mode: "plan", multiFile: false, session: done }).allowed,
    ).toBe(false);
    const abandoned = session("abandoned");
    expect(
      checkSessionGate({ freedom: "strict", mode: "execute", multiFile: false, session: abandoned }).allowed,
    ).toBe(false);
  });
});
