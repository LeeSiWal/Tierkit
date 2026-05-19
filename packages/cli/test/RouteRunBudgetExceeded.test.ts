import { describe, expect, it, vi } from "vitest";
import { Cli } from "clipanion";
import { RouteRunCommand } from "../src/commands/route/RouteRunCommand.js";
import { PassThrough } from "node:stream";

// Mock the @tierkit/core runRoute to return a budget-exceeded Case A / Case B response.
vi.mock("@tierkit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tierkit/core")>();
  return {
    ...actual,
    runRoute: vi.fn(),
  };
});

import { runRoute } from "@tierkit/core";

function runCli(argv: string[]) {
  const cli = new Cli({ binaryName: "tierkit" });
  cli.register(RouteRunCommand);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "", err = "";
  stdout.on("data", (b) => (out += b.toString()));
  stderr.on("data", (b) => (err += b.toString()));
  return cli
    .run(argv, { cwd: process.cwd(), stdout, stderr, stdin: process.stdin } as any)
    .then((code) => ({ code, out, err }));
}

describe("RouteRunCommand budget-exceeded rendering", () => {
  it("Case A — renders per-candidate details list", async () => {
    (runRoute as any).mockResolvedValue({
      ok: false,
      code: "budget-exceeded",
      message: "All candidate profiles were skipped by per-profile budget policy.",
      details: [
        { profileId: "claudeSonnet", reason: "monthly USD cap reached ($20.00)" },
        { profileId: "claudeHaiku",  reason: "monthly input token cap reached (200,000)" },
      ],
    });
    const { code, err } = await runCli(["route", "run", "some task"]);
    expect(code).toBe(1);
    expect(err).toContain("budget-exceeded:");
    expect(err).toContain("All candidate profiles");
    expect(err).toContain("- claudeSonnet:");
    expect(err).toContain("- claudeHaiku:");
    expect(err).toMatch(/tierkit doctor/);
    expect(err).toMatch(/usage --by-profile/);
  });

  it("Case B — global budget single-line message, no details list", async () => {
    (runRoute as any).mockResolvedValue({
      ok: false,
      code: "budget-exceeded",
      message: "Global monthly USD budget exceeded ($30.00 / $30.00).",
      // no details
    });
    const { code, err } = await runCli(["route", "run", "some task"]);
    expect(code).toBe(1);
    expect(err).toContain("Global monthly USD budget exceeded");
    expect(err).not.toMatch(/^  - /m);  // no per-candidate list
  });
});
