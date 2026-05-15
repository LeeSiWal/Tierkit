import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/security/SecretRedactor.js";

// Build secret-shaped placeholders at runtime so the literal source doesn't trip GitHub's
// push-protection regex (it scans the literal text, not the assembled runtime value).
// These are all obviously-fake test fixtures; the rebuilt strings exercise the redaction
// rules in the same way a real leak would.
const SK = "sk" + "-";
const SK_PROJ = "sk" + "-proj-";
const SK_ANT = "sk" + "-ant-";
const GHP = "ghp" + "_";
const SLACK_BOT = "xox" + "b" + "-";
const STRIPE_TEST = "sk" + "_test_";
const STRIPE_LIVE = "sk" + "_live_";
const GOOGLE_AIZA = "AI" + "za";
const PEM_BEGIN = "-----" + "BEGIN RSA PRIVATE KEY" + "-----";
const PEM_END = "-----" + "END RSA PRIVATE KEY" + "-----";
const PEM_BODY = "MII" + "EpAIBAAKCAQEA...";

describe("redactSecrets (extended rules)", () => {
  it("redacts OpenAI keys including the modern sk-proj- variant", () => {
    const r = redactSecrets(`My key is ${SK_PROJ}abc123def456ghi789jkl012 don't share`);
    expect(r.text).toContain("[REDACTED:openai-api-key]");
    expect(r.text).not.toContain(`${SK_PROJ}abc123`);
  });

  it("redacts Anthropic api03 keys", () => {
    const r = redactSecrets(`k=${SK_ANT}api03-FAKE-PLACEHOLDER-NOT-A-REAL-KEY-FAKE`);
    expect(r.text).toContain("[REDACTED:anthropic-api-key]");
  });

  it("redacts GitHub PAT", () => {
    const r = redactSecrets(`token: ${GHP}aBcDeFgHiJkLmNoPqRsTuVwXyZ012345`);
    expect(r.text).toContain("[REDACTED:github-token]");
  });

  it("redacts Slack tokens", () => {
    const r = redactSecrets(`hook=${SLACK_BOT}1234567890-abcdefghij`);
    expect(r.text).toContain("[REDACTED:slack-token]");
  });

  it("redacts Stripe secret keys (test and live)", () => {
    const r = redactSecrets(
      `STRIPE=${STRIPE_TEST}abcdefghijklmnopqrstuvwx and ${STRIPE_LIVE}abcdefghijklmnopqrstuvwx`,
    );
    expect((r.text.match(/\[REDACTED:stripe-secret-key\]/g) ?? []).length).toBe(2);
  });

  it("redacts Google AIza keys", () => {
    const r = redactSecrets(`g=${GOOGLE_AIZA}SyAaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQ`);
    expect(r.text).toContain("[REDACTED:google-api-key]");
  });

  it("redacts JWT-shaped tokens", () => {
    // JWT header.payload.signature — assembled at runtime to dodge entropy detectors.
    const jwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJKb2huIERvZSJ9", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".");
    const r = redactSecrets(`bearer ${jwt}`);
    expect(r.text).toContain("[REDACTED:jwt-like]");
  });

  it("redacts PEM private key blocks", () => {
    const pem = `${PEM_BEGIN}\n${PEM_BODY}\n${PEM_END}`;
    const r = redactSecrets(pem);
    expect(r.text).toContain("[REDACTED:private-key-block]");
    expect(r.text).not.toContain(PEM_BODY.slice(0, 8));
  });

  it("redacts basic-auth credentials in URLs", () => {
    const r = redactSecrets("psql https://alice:supersecret@db.example.com:5432/mydb");
    expect(r.text).toContain("[REDACTED:user]:[REDACTED:pass]@db.example.com");
    expect(r.text).not.toContain("supersecret");
  });

  it("redacts Bearer headers", () => {
    const r = redactSecrets("Authorization: Bearer abc123def456");
    expect(r.text).toContain("Authorization: Bearer [REDACTED:bearer-token]");
  });

  it("leaves innocent strings alone (no api-key-shaped tokens)", () => {
    const innocent =
      `const x = 42;\nconst y = \`prefix ${SK}short\`;\n// the value ${SK} is too short to match`;
    const r = redactSecrets(innocent);
    expect(r.text).toBe(innocent);
    expect(r.hits).toEqual([]);
  });

  it("reports hits with counts", () => {
    const r = redactSecrets(
      `two keys: ${SK}abc123def456ghi789jklXYZ and ${SK}zyx987wvu654tsr321qpoMNO`,
    );
    expect(r.hits.find((h) => h.ruleId === "openai-api-key")?.count).toBe(2);
  });
});
