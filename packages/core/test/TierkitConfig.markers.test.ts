import { describe, it, expect } from "vitest";
import { TierkitConfigSchema } from "../src/config/TierkitConfig.js";

describe("TierkitConfig — migration & notice markers", () => {
  it("supplies migrations.defaultDisabledSeededProfileIds default = []", () => {
    const r = TierkitConfigSchema.parse({ version: "0.1", modelProfiles: {} });
    expect(r.migrations.defaultDisabledSeededProfileIds).toEqual([]);
  });

  it("supplies notices.* defaults = false", () => {
    const r = TierkitConfigSchema.parse({ version: "0.1", modelProfiles: {} });
    expect(r.notices.seenPinnedNoFallbackV013).toBe(false);
    expect(r.notices.seenModelTestExplained).toBe(false);
  });

  it("round-trips explicit markers", () => {
    const r = TierkitConfigSchema.parse({
      version: "0.1",
      modelProfiles: {},
      migrations: { defaultDisabledSeededProfileIds: ["claudeCode"] },
      notices: { seenPinnedNoFallbackV013: true, seenModelTestExplained: false },
    });
    expect(r.migrations.defaultDisabledSeededProfileIds).toEqual(["claudeCode"]);
    expect(r.notices.seenPinnedNoFallbackV013).toBe(true);
  });
});
