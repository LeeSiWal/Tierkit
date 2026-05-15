import { describe, it, expect } from "vitest";
import { isSensitivePath, matchSensitive } from "../src/security/sensitiveFiles.js";

describe("isSensitivePath", () => {
  it("matches plain .env at root", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.local")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
  });

  it("matches .env in any subdirectory via basename", () => {
    expect(isSensitivePath("config/.env")).toBe(true);
    expect(isSensitivePath("packages/api/.env")).toBe(true);
  });

  it("matches SSH key file names", () => {
    expect(isSensitivePath("id_rsa")).toBe(true);
    expect(isSensitivePath("id_ed25519")).toBe(true);
    expect(isSensitivePath("project_rsa")).toBe(true);
  });

  it("matches PEM/key/p12/jks by extension", () => {
    expect(isSensitivePath("cert.pem")).toBe(true);
    expect(isSensitivePath("key.key")).toBe(true);
    expect(isSensitivePath("trust.jks")).toBe(true);
    expect(isSensitivePath("client.p12")).toBe(true);
  });

  it("matches secrets/ and .ssh/ subtrees via **", () => {
    expect(isSensitivePath("infra/secrets/api-token.txt")).toBe(true);
    expect(isSensitivePath("home/user/.ssh/known_hosts")).toBe(true);
    expect(isSensitivePath("home/user/.aws/credentials")).toBe(true);
  });

  it("matches credentials.* and service-account*.json", () => {
    expect(isSensitivePath("credentials.json")).toBe(true);
    expect(isSensitivePath("credentials.yaml")).toBe(true);
    expect(isSensitivePath("service-account-prod.json")).toBe(true);
  });

  it("leaves innocent file paths alone", () => {
    expect(isSensitivePath("README.md")).toBe(false);
    expect(isSensitivePath("packages/core/src/index.ts")).toBe(false);
    expect(isSensitivePath("rules/local-first.md")).toBe(false);
    expect(isSensitivePath("commands/brainstorm.md")).toBe(false);
  });

  it("matchSensitive returns all matched patterns", () => {
    const matched = matchSensitive(".env");
    expect(matched).toContain(".env");
  });

  it("normalizes Windows-style backslash paths", () => {
    expect(isSensitivePath("home\\user\\.ssh\\id_rsa")).toBe(true);
  });
});
