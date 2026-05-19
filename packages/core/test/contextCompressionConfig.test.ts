import { describe, expect, it } from "vitest";
import { TierkitConfigSchema } from "../src/config/TierkitConfig.js";

describe("TierkitConfig with contextCompression", () => {
  it("accepts config without contextCompression (backward compatible)", () => {
    const parsed = TierkitConfigSchema.parse({ version: "0.1" });
    expect(parsed.contextCompression).toBeUndefined();
  });

  it("accepts contextCompression with valid minimal fields", () => {
    const parsed = TierkitConfigSchema.parse({
      version: "0.1",
      contextCompression: {
        defaultMaxFiles: 12,
        defaultCloudTokenBudget: 8000,
        ignoreGlobs: ["vendor/**"],
      },
    });
    expect(parsed.contextCompression?.defaultMaxFiles).toBe(12);
  });

  it("rejects unknown fields under contextCompression", () => {
    expect(() =>
      TierkitConfigSchema.parse({
        version: "0.1",
        contextCompression: { defaultMaxFiles: 8, somethingElse: true },
      }),
    ).toThrow();
  });
});
