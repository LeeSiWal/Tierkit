import { describe, it, expect } from "vitest";
import { readGatewayModeFromConfig, withGatewayMode } from "../src/gatewayModeConfig.js";

describe("readGatewayModeFromConfig", () => {
  it("defaults absent gatewayMode to off", () => {
    expect(readGatewayModeFromConfig({ version: "0.1" })).toBe("off");
    expect(readGatewayModeFromConfig({ version: "0.1", runtime: {} })).toBe("off");
  });
  it("reads existing on so offline toggle can flip to off", () => {
    expect(readGatewayModeFromConfig({ runtime: { gatewayMode: "on" } })).toBe("on");
  });
  it("reads existing off", () => {
    expect(readGatewayModeFromConfig({ runtime: { gatewayMode: "off" } })).toBe("off");
  });
  it("rejects malformed existing values rather than silently coercing", () => {
    expect(() => readGatewayModeFromConfig({ runtime: { gatewayMode: "auto" } })).toThrow();
    expect(() => readGatewayModeFromConfig({ runtime: { gatewayMode: 1 } })).toThrow();
  });
});

describe("withGatewayMode", () => {
  it("mutates only runtime.gatewayMode", () => {
    expect(
      withGatewayMode(
        { version: "0.1", runtime: { port: 4101, dataDir: ".tierkit/runtime" }, plugins: { enabled: true } },
        "on",
      ),
    ).toEqual({
      version: "0.1",
      runtime: { port: 4101, dataDir: ".tierkit/runtime", gatewayMode: "on" },
      plugins: { enabled: true },
    });
  });
  it("creates runtime block when absent", () => {
    expect(withGatewayMode({ version: "0.1" }, "off").runtime).toEqual({ gatewayMode: "off" });
  });
});
