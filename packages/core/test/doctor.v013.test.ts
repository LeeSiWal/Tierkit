import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { doctor } from "../src/usecases/doctor.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-doctor-v013-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("doctor — v0.13 pinned-no-fallback notice", () => {
  it("warns when notice has not been acknowledged", async () => {
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({ version: "0.1", modelProfiles: {} }),
    );
    const r = await doctor({ cwd: root });
    const check = r.checks.find((c) => c.id === "v013-pinned-no-fallback");
    expect(check?.status).toBe("warn");
  });

  it("passes when notice has been acknowledged", async () => {
    await fs.writeFile(
      path.join(root, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {},
        notices: { seenPinnedNoFallbackV013: true, seenModelTestExplained: false },
      }),
    );
    const r = await doctor({ cwd: root });
    const check = r.checks.find((c) => c.id === "v013-pinned-no-fallback");
    expect(check?.status).toBe("ok");
  });
});
