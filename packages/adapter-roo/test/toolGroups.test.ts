import { describe, it, expect } from "vitest";
import { mapToolsToGroups } from "../src/toolGroups.js";
import type { PermissionFlags } from "@tierkit/core";

function perms(overrides: Partial<PermissionFlags> = {}): PermissionFlags {
  return {
    readFiles: false,
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
    ...overrides,
  };
}

describe("mapToolsToGroups", () => {
  it("maps read/edit/search to read+edit when allowed", () => {
    const r = mapToolsToGroups(["read", "edit", "search"], perms({ readFiles: true, editFiles: true }));
    expect(r.groups.sort()).toEqual(["edit", "read"]);
    expect(r.droppedByPermission).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it("drops command group when runCommands is not granted", () => {
    const r = mapToolsToGroups(["read", "terminal"], perms({ readFiles: true }));
    expect(r.groups).toEqual(["read"]);
    expect(r.droppedByPermission).toEqual([
      { tool: "command", group: "command", reason: "plugin manifest does not grant runCommands" },
    ]);
  });

  it("drops mcp when registerMcp is not granted", () => {
    const r = mapToolsToGroups(["mcp"], perms({ readFiles: true }));
    expect(r.groups).not.toContain("mcp");
    expect(r.droppedByPermission.some((d) => d.group === "mcp")).toBe(true);
  });

  it("records unknown tool tokens", () => {
    const r = mapToolsToGroups(["read", "fly"], perms({ readFiles: true }));
    expect(r.groups).toEqual(["read"]);
    expect(r.unknown).toEqual(["fly"]);
  });

  it("defaults to read when tools list is empty and readFiles is granted", () => {
    const r = mapToolsToGroups([], perms({ readFiles: true }));
    expect(r.groups).toEqual(["read"]);
  });

  it("emits no groups when tools list is empty and readFiles is not granted", () => {
    const r = mapToolsToGroups([], perms({}));
    expect(r.groups).toEqual([]);
  });
});
