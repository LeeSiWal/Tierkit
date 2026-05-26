import { describe, it, expect } from "vitest";
import {
  buildGatewayEnv,
  gatewayLaunchCommand,
  classifyReadiness,
  nextGatewayMode,
} from "../src/gatewayLaunchCore.js";

describe("buildGatewayEnv", () => {
  it("sets ANTHROPIC_BASE_URL", () => {
    expect(buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: {} }).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101");
  });
  it("preserves existing ANTHROPIC_API_KEY verbatim", () => {
    const env = buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: { ANTHROPIC_API_KEY: "sk-secret" } });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-secret");
  });
  it("preserves PATH and HOME", () => {
    const env = buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: { PATH: "/usr/local/bin", HOME: "/u" } });
    expect(env.PATH).toBe("/usr/local/bin");
    expect(env.HOME).toBe("/u");
  });
});

describe("gatewayLaunchCommand", () => {
  it("defaults to 'claude'", () => expect(gatewayLaunchCommand({})).toBe("claude"));
  it("honors TIERKIT_CLAUDE_CODE_BIN", () => expect(gatewayLaunchCommand({ TIERKIT_CLAUDE_CODE_BIN: "/opt/claude" })).toBe("/opt/claude"));
});

describe("classifyReadiness", () => {
  it("ready when routesEnabled true", () => {
    expect(classifyReadiness({ gatewayMode: "on", routesEnabled: true })).toEqual({ kind: "ready" });
  });
  it("mode-off when gatewayMode is off", () => {
    expect(classifyReadiness({ gatewayMode: "off", routesEnabled: false })).toEqual({ kind: "mode-off" });
  });
  it("unreachable when body is null/undefined or malformed", () => {
    expect(classifyReadiness(null).kind).toBe("unreachable");
    expect(classifyReadiness(undefined).kind).toBe("unreachable");
    expect(classifyReadiness({} as never).kind).toBe("unreachable");
  });
});

describe("nextGatewayMode", () => {
  it("flips on <-> off", () => {
    expect(nextGatewayMode("on")).toBe("off");
    expect(nextGatewayMode("off")).toBe("on");
  });
});
