import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendGatewayLog } from "../src/runtime/gatewayLog.js";

const SECRET_BEARER = "sk-ant-secret-bearer-abcdef12345";
const SECRET_API_KEY = "sk-ant-api03-VERYSECRET";

async function tmpFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "gw-log-redaction-"));
  return { file: path.join(dir, "anthropic-gateway.jsonl"), dir };
}

function baseRecord() {
  return {
    ts: "2026-05-26T12:00:00.000Z",
    path: "/v1/messages",
    stream: true,
    status: 200,
    durationMs: 1234,
    auth: {
      authorizationScheme: "Bearer",
      authorizationFingerprint: "abcdef123456",
      apiKeyPresent: false,
      apiKeyFingerprint: null,
    },
  };
}

describe("gatewayLog — redaction (value constraints + invariants)", () => {
  it("drops extra fields like authorizationRaw without throwing", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, { ...baseRecord(), authorizationRaw: SECRET_BEARER });
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain(SECRET_BEARER);
      expect(raw).not.toContain("authorizationRaw");
      expect(raw.trim().split("\n")).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("drops a body field even when passed", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, { ...baseRecord(), body: { messages: [{ role: "user", content: "TOP_SECRET" }] } });
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain("TOP_SECRET");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects records missing required fields (async rejection)", async () => {
    const { file, dir } = await tmpFile();
    try {
      await expect(appendGatewayLog(file, { ts: "2026-05-26T12:00:00.000Z" })).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects a secret placed in authorizationScheme (only Bearer|Other accepted)", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { ...baseRecord().auth, authorizationScheme: SECRET_BEARER } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("accepts 'Other' as authorizationScheme", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, { ...baseRecord(), auth: { ...baseRecord().auth, authorizationScheme: "Other" } });
      const parsed = JSON.parse((await readFile(file, "utf8")).trim());
      expect(parsed.auth.authorizationScheme).toBe("Other");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects a malformed fingerprint", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { ...baseRecord().auth, apiKeyFingerprint: SECRET_API_KEY } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects when apiKeyPresent is missing", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { authorizationScheme: "Bearer", authorizationFingerprint: "abcdef123456", apiKeyFingerprint: null } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects non-object inputs", async () => {
    const { file, dir } = await tmpFile();
    try {
      await expect(appendGatewayLog(file, null)).rejects.toThrow();
      await expect(appendGatewayLog(file, "x")).rejects.toThrow();
      await expect(appendGatewayLog(file, 42)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  // --- invariant (superRefine) tests ---

  it("rejects authorizationFingerprint set while scheme is null", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { ...baseRecord().auth, authorizationScheme: null, authorizationFingerprint: "abcdef123456" } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects authorizationScheme set while fingerprint is null", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { ...baseRecord().auth, authorizationScheme: "Bearer", authorizationFingerprint: null } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects apiKeyFingerprint set while apiKeyPresent is false", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { ...baseRecord().auth, apiKeyPresent: false, apiKeyFingerprint: "abcdef123456" } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects apiKeyPresent: true with apiKeyFingerprint: null", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { ...baseRecord().auth, apiKeyPresent: true, apiKeyFingerprint: null } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
