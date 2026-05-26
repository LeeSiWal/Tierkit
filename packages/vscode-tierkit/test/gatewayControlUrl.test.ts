import { describe, it, expect } from "vitest";
import { controlBaseUrlFromConfiguredBaseUrl } from "../src/gatewayControlUrl.js";

describe("controlBaseUrlFromConfiguredBaseUrl", () => {
  it("rewrites LAN bind addresses to loopback while preserving the port", () => {
    expect(controlBaseUrlFromConfiguredBaseUrl("http://192.168.1.10:4101")).toBe("http://127.0.0.1:4101");
    expect(controlBaseUrlFromConfiguredBaseUrl("http://0.0.0.0:9876")).toBe("http://127.0.0.1:9876");
    expect(controlBaseUrlFromConfiguredBaseUrl("http://localhost:9876")).toBe("http://127.0.0.1:9876");
  });
  it("uses IPv6 loopback for IPv6 hosts", () => {
    expect(controlBaseUrlFromConfiguredBaseUrl("http://[::1]:4101")).toBe("http://[::1]:4101");
    expect(controlBaseUrlFromConfiguredBaseUrl("http://[::]:4101")).toBe("http://[::1]:4101");
  });
  it("leaves loopback IPv4 unchanged", () => {
    expect(controlBaseUrlFromConfiguredBaseUrl("http://127.0.0.1:4101")).toBe("http://127.0.0.1:4101");
    expect(controlBaseUrlFromConfiguredBaseUrl("http://127.0.0.1:4101/")).toBe("http://127.0.0.1:4101");
  });
});
