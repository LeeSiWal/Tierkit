import { describe, expect, it } from "vitest";
import { canonicalIdentity, isProfileDisabled } from "@tierkit/core";
import type { ModelProfile } from "@tierkit/core";

const p = (over: Partial<ModelProfile> = {}): ModelProfile => ({
  kind: "local-device",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen2.5-coder:7b",
  roles: [],
  ...over,
});

describe("canonicalIdentity", () => {
  it("returns same string for same (provider, baseUrl, model)", () => {
    expect(canonicalIdentity(p())).toBe(canonicalIdentity(p()));
  });

  it("differs when provider differs", () => {
    expect(canonicalIdentity(p({ provider: "anthropic" }))).not.toBe(canonicalIdentity(p()));
  });

  it("differs when baseUrl differs", () => {
    expect(canonicalIdentity(p({ baseUrl: "http://10.0.0.1:11434" }))).not.toBe(canonicalIdentity(p()));
  });

  it("differs when model differs", () => {
    expect(canonicalIdentity(p({ model: "llama3.2:3b" }))).not.toBe(canonicalIdentity(p()));
  });

  it("treats missing baseUrl as empty slot (cloud providers)", () => {
    const anthropic1: ModelProfile = { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6", roles: [] };
    const anthropic2: ModelProfile = { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6", roles: [] };
    expect(canonicalIdentity(anthropic1)).toBe(canonicalIdentity(anthropic2));
  });
});

describe("isProfileDisabled", () => {
  it("returns true for an id in disabledProfileIds", () => {
    expect(isProfileDisabled({ disabledProfileIds: ["foo"] } as any, "foo")).toBe(true);
  });

  it("returns false for an id NOT in disabledProfileIds", () => {
    expect(isProfileDisabled({ disabledProfileIds: ["foo"] } as any, "bar")).toBe(false);
  });

  it("returns false when disabledProfileIds is missing", () => {
    expect(isProfileDisabled({} as any, "anything")).toBe(false);
  });

  it("returns false when disabledProfileIds is undefined", () => {
    expect(isProfileDisabled({ disabledProfileIds: undefined } as any, "x")).toBe(false);
  });
});
