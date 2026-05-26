import { describe, it, expect } from "vitest";
import { isLoopbackRemoteAddress, loopbackControlUrl } from "../src/runtime/loopback.js";

describe("isLoopbackRemoteAddress", () => {
  it("accepts canonical loopback forms", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
  });
  it("rejects LAN/public addresses", () => {
    expect(isLoopbackRemoteAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackRemoteAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackRemoteAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackRemoteAddress("::ffff:192.168.1.10")).toBe(false);
  });
  it("rejects undefined / empty", () => {
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
    expect(isLoopbackRemoteAddress("")).toBe(false);
  });
});

describe("loopbackControlUrl (server-side, host+port input)", () => {
  it("uses 127.0.0.1 by default", () => {
    expect(loopbackControlUrl("127.0.0.1", 4101)).toBe("http://127.0.0.1:4101");
    expect(loopbackControlUrl("0.0.0.0", 4101)).toBe("http://127.0.0.1:4101");
    expect(loopbackControlUrl("192.168.1.10", 4101)).toBe("http://127.0.0.1:4101");
  });
  it("uses [::1] when host is an IPv6 form", () => {
    expect(loopbackControlUrl("::", 4101)).toBe("http://[::1]:4101");
    expect(loopbackControlUrl("::1", 4101)).toBe("http://[::1]:4101");
  });
});
