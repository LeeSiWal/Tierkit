import { describe, it, expect } from "vitest";
import { renderPermissionContract } from "../src/permissionContract.js";
import { makePlugin } from "./fixtures.js";

describe("renderPermissionContract", () => {
  it("emits MUST NOT rules for every permission not granted", () => {
    const plugin = makePlugin({ id: "minimal", permissions: { readFiles: true } });
    const text = renderPermissionContract(plugin.manifest);
    expect(text).toMatch(/^# Permission contract — minimal/);
    expect(text).toContain("Read files in the workspace.");
    expect(text).toContain("Run shell commands of any kind.");
    expect(text).toContain("Register MCP servers.");
    expect(text).toContain("Access secrets");
    expect(text).toContain("Use public-cloud models");
  });

  it("flips Run shell commands to MAY when granted", () => {
    const plugin = makePlugin({
      id: "with-cmd",
      permissions: { readFiles: true, runCommands: true },
    });
    const text = renderPermissionContract(plugin.manifest);
    expect(text).toContain("Run shell commands — always surface what will run");
    expect(text).not.toContain("Run shell commands of any kind. Even read-only");
  });

  it("calls out public-cloud as review-only when granted", () => {
    const plugin = makePlugin({
      id: "cloud",
      permissions: {
        readFiles: true,
        usePrivateRemoteModel: true,
        usePublicCloudModel: true,
      },
    });
    const text = renderPermissionContract(plugin.manifest);
    expect(text).toMatch(/public-cloud model — only in review-only mode/);
  });

  it("always renders the Escalation section with redaction guidance", () => {
    const plugin = makePlugin({ id: "p", permissions: { readFiles: true } });
    const text = renderPermissionContract(plugin.manifest);
    expect(text).toContain("## Escalation");
    expect(text).toContain("redact secrets");
  });
});
