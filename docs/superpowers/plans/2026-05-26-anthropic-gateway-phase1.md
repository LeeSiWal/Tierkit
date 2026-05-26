# Anthropic Gateway Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize the Phase 0 Anthropic-passthrough as a safe, observable connection feature in Tierkit — settings, sidebar toggle, scoped terminal launch, safe per-request logging with rotation, daemon auto-heal, direct fallback, and `tierkit doctor gateway`. **Strictly NO** request/response transformation, NO compression, NO dedupe, NO redaction, NO savings claims.

**Architecture:** Layer UX + safe logging + diagnostics on top of the validated Phase 0 passthrough (`packages/core/src/runtime/anthropicGateway.ts` and two routes in `Server.ts`). Two new core modules (`gatewayLog.ts`, `usecases/doctorGateway.ts`), one config-schema extension (`gatewayMode`), one CLI sub-command, three VS Code extension surfaces (toggle, launch button, fallback dialog). Token-savings claims are out of scope — they belong in Phase 2 once `tool_result` envelope + cursor pagination + dedupe land.

**Tech Stack:**
- Backend: TypeScript, Node 20+, plain `http` (existing `Server.ts`), `undici`-style `fetch()` already in spike
- Config: zod (existing schema layer)
- CLI: `clipanion` (existing pattern in `packages/cli/src/commands/`)
- VS Code extension: `vscode` API, no new build deps; existing webview wiring through `messageRouter.ts`
- Tests: vitest

---

## Context — read these first

Before starting, understand what already exists:

1. **Phase 0 spike code (must be present in this branch — see Task 0)**:
   - `packages/core/src/runtime/anthropicGateway.ts` — `forwardMessages`, `streamMessages`, `forwardCountTokens`, `pickForwardHeaders`, `observeAuthHeaders`
   - `packages/core/src/runtime/Server.ts` — `POST /v1/messages` and `POST /v1/messages/count_tokens` routes
   - `packages/core/test/anthropicGateway.test.ts` (14 unit)
   - `packages/core/test/Server.anthropicGateway.test.ts` (3 integration)

2. **Phase 0 evidence**: `docs/RFC-anthropic-gateway.md` — all 4 validations (A, B-1, B-2, C) passed.

3. **Existing patterns this plan reuses**:
   - `packages/core/src/runtime/usageLog.ts` — JSONL append + rotation pattern (`appendUsage` + `trimUsageLog`). The Phase 1 safe gateway log copies this shape, not its size policy (we cap at 5 MB and 7 days, not 10/5 MB).
   - `packages/core/src/config/TierkitConfig.ts` — zod schema layering (`RuntimeConfigSchema` nested in `TierkitConfigSchema`).
   - `packages/core/src/usecases/doctor.ts` — `DoctorCheck` shape and check-composition pattern.
   - `packages/cli/src/commands/DoctorCommand.ts` — clipanion command structure.
   - `packages/vscode-tierkit/src/extension.ts` — `maybeStartDaemon` (line 399), `registerCommand` block (line 834+), `vscode.workspace.getConfiguration("tierkit")` (line 222), sidebar webview provider (line 538+).

4. **Phase 0 framing (RFC section "Phase 1 scope sketch") is binding**: this plan implements exactly the 8 items there; nothing more, nothing less.

---

## What this plan does NOT do (and why)

These are explicitly Phase 2 (or later):

| Excluded | Why deferred |
|---|---|
| Compress / summarize `tool_result` payloads | Requires envelope schema design; effect must be measured before claimed |
| Cursor pagination for truncated reads | Schema change spans Tierkit MCP server + tooling; design not finalized |
| Read dedupe per session | Needs session-store design; can break correctness if mis-scoped |
| Redact secrets from request body | Phase 1 must not modify the body — only Phase 2's transformation hook touches it |
| Display "saved tokens" in sidebar | No measurement = no claim. Phase 1 displays request count and status only |
| Modify `~/.zshrc` / persistent shell profile | Too invasive; impossible to reliably reverse |
| `POST /v1/models` discovery via gateway | Already gated behind `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` in Claude Code; out of scope for v1 |
| Local-LLM provider routing | Phase 3 |
| OAuth admin endpoints | Hardcoded to api.anthropic.com by Claude Code; not affected by base URL |

**Hard rule on language**: never use "savings", "saves tokens", "절감" in any user-facing string or doc added by this plan. Phase 1 copy uses "connect", "route", "passthrough", "diagnostic", "연결".

---

## File Structure

**New files:**
- `packages/core/src/runtime/gatewayLog.ts` — safe per-request JSONL writer + rotation
- `packages/core/test/gatewayLog.test.ts` — unit tests for the writer
- `packages/core/test/gatewayLog.redaction.test.ts` — asserts no body / no raw credential ever lands in the log
- `packages/core/src/usecases/doctorGateway.ts` — `doctorGateway()` returning `DoctorCheck[]`
- `packages/core/test/doctorGateway.test.ts` — unit tests
- `packages/cli/src/commands/DoctorGatewayCommand.ts` — `tierkit doctor gateway` clipanion command
- `packages/cli/test/doctorGatewayCommand.test.ts` — CLI smoke test
- `packages/vscode-tierkit/src/gatewayLaunch.ts` — terminal-creation helper (scoped env)
- `packages/vscode-tierkit/test/gatewayLaunch.test.ts` — unit test for the env-builder pure function
- `packages/vscode-tierkit/src/webviewCommandAllowlist.ts` — pure allowlist for `tk:cmd` messages
- `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts` — allowlist unit test
- `docs/ANTHROPIC_GATEWAY.md` — feature doc (English)
- `docs/ANTHROPIC_GATEWAY.ko.md` — Korean version

**Modified files:**
- `packages/core/src/runtime/Server.ts` — call `appendGatewayLog` from the two Phase 0 routes; wire `gatewayMode` gate
- `packages/core/src/config/TierkitConfig.ts` — add `gatewayMode: "off" | "on"` (default `"off"`)
- `packages/core/src/usecases/doctor.ts` — call `doctorGateway()` and merge its checks
- `packages/cli/src/cli.ts` — register `DoctorGatewayCommand`
- `packages/vscode-tierkit/src/extension.ts` — register `tierkit.launchClaudeCodeWithGateway` command, register `tierkit.toggleGatewayMode` command, hook fallback dialog
- `packages/vscode-tierkit/package.json` — `contributes.commands` + `contributes.configuration` entries
- `packages/vscode-tierkit/package.nls.json` + `package.nls.ko.json` — strings
- `README.md` — one paragraph + link to `docs/ANTHROPIC_GATEWAY.md`

**Untouched (Phase 0 code is API-stable for Phase 1):**
- `packages/core/src/runtime/anthropicGateway.ts` — no change. Phase 1 wraps it; does not modify the proxy itself.

---

## Task 0: Foundation — bring Phase 0 spike code into this branch

**Why:** This branch (`worktree-anthropic-gateway-phase1`) was cut from `main`. The spike code lives on `worktree-anthropic-gateway-spike` (Draft PR #1). Phase 1 builds on it. We either merge or cherry-pick; this plan uses merge because it preserves the spike commit history (which is the validation evidence) and avoids re-running the spike's TDD on top.

**Files:**
- All Phase 0 additions land verbatim:
  - `packages/core/src/runtime/anthropicGateway.ts`
  - `packages/core/src/runtime/Server.ts` (the two routes + `readRawBody` + `isStreamingMessagesBody`)
  - `packages/core/test/anthropicGateway.test.ts`
  - `packages/core/test/Server.anthropicGateway.test.ts`
  - `scripts/spike-anthropic-gateway.sh`
  - `docs/RFC-anthropic-gateway.md`
  - `docs/superpowers/plans/2026-05-26-anthropic-gateway-spike.md`

- [ ] **Step 1: Confirm clean working tree**

```bash
git status
```
Expected: `nothing to commit, working tree clean` on branch `worktree-anthropic-gateway-phase1`.

- [ ] **Step 2: Fetch and inspect spike branch tip**

```bash
git fetch origin worktree-anthropic-gateway-spike
git log --oneline origin/worktree-anthropic-gateway-spike ^HEAD | head -20
```
Expected: 15 commits from the Phase 0 spike (ending in `5f002bd docs(spike): fix Phase 1 framing …`).

- [ ] **Step 3: Merge the spike branch (no-ff so the history block is visible)**

```bash
git merge --no-ff origin/worktree-anthropic-gateway-spike \
  -m "merge: incorporate Phase 0 spike as foundation for Phase 1"
```

If conflicts occur (only `package.json` version bumps are likely):
- Take the spike's `0.23.0-spike.0` version bumps as-is. Phase 1 will re-bump cleanly when it ships.
- Resolve, then `git add` and `git merge --continue`.

- [ ] **Step 4: Verify the spike files are present**

```bash
ls packages/core/src/runtime/anthropicGateway.ts \
   packages/core/test/anthropicGateway.test.ts \
   packages/core/test/Server.anthropicGateway.test.ts \
   docs/RFC-anthropic-gateway.md
```
Expected: all four files listed without "No such file" errors.

- [ ] **Step 5: Install deps + build to confirm the spike still compiles on this branch**

```bash
pnpm install --frozen-lockfile
pnpm -r build
```
Expected: every package builds, no TypeScript errors.

- [ ] **Step 6: Run the spike's tests as baseline**

```bash
pnpm --filter @tierkit/core test -- anthropicGateway Server.anthropicGateway
```
Expected: all 17 tests pass.

- [ ] **Step 7: Commit nothing — merge commit already records this**

Confirm `git log -1 --oneline` shows the merge commit, then proceed to Task 1.

---

## Task 1: Add `gatewayMode` to runtime config schema

**Why:** Single source of truth for "is the gateway armed?" — read by the daemon (to decide whether to expose `/v1/messages`), by the VS Code extension (to decide whether to inject env), and by `tierkit doctor gateway`.

**Files:**
- Modify: `packages/core/src/config/TierkitConfig.ts:79-134` (extend `RuntimeConfigSchema`)
- Test: `packages/core/test/configRoutingEndpoint.test.ts` (existing — extend with two cases) OR a new file `packages/core/test/configGatewayMode.test.ts`. Use the new file to keep diffs surgical.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/configGatewayMode.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TierkitConfigSchema } from "../src/config/TierkitConfig.js";

describe("RuntimeConfigSchema.gatewayMode", () => {
  it("defaults to 'off' when no field is supplied", () => {
    const cfg = TierkitConfigSchema.parse({ version: "0.1" });
    expect(cfg.runtime.gatewayMode).toBe("off");
  });

  it("accepts 'on' and 'off'", () => {
    const on = TierkitConfigSchema.parse({
      version: "0.1",
      runtime: { gatewayMode: "on" },
    });
    expect(on.runtime.gatewayMode).toBe("on");

    const off = TierkitConfigSchema.parse({
      version: "0.1",
      runtime: { gatewayMode: "off" },
    });
    expect(off.runtime.gatewayMode).toBe("off");
  });

  it("rejects unknown values", () => {
    expect(() =>
      TierkitConfigSchema.parse({
        version: "0.1",
        runtime: { gatewayMode: "auto" },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tierkit/core test -- configGatewayMode
```
Expected: 3 failures — `gatewayMode` is `undefined` on the parsed object.

- [ ] **Step 3: Extend the schema**

In `packages/core/src/config/TierkitConfig.ts`, inside `RuntimeConfigSchema`'s `.object({ … })` (around line 132, after `discoverOllamaModels`), add:

```typescript
    /**
     * Phase 1 of the Anthropic Gateway: when "on", the daemon advertises
     * /v1/messages and /v1/messages/count_tokens as a transparent passthrough
     * for Claude Code (point ANTHROPIC_BASE_URL at the daemon). Default "off"
     * — Phase 1 ships as opt-in. NOTE: this flag does NOT enable any
     * request/response transformation, compression, redaction, or savings
     * measurement. Those land in Phase 2.
     */
    gatewayMode: z.enum(["off", "on"]).default("off"),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tierkit/core test -- configGatewayMode
```
Expected: 3 pass.

- [ ] **Step 5: Run the full schema test suite to confirm nothing else broke**

```bash
pnpm --filter @tierkit/core test -- config
```
Expected: all config-related tests still green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/TierkitConfig.ts \
        packages/core/test/configGatewayMode.test.ts
git commit -m "feat(core): runtime.gatewayMode config field (off|on, default off)"
```

---

## Task 2: Build the safe gateway log writer

**Why:** Phase 1's hard rule (from RFC §3 of Phase 1 scope sketch): only allowlisted fields land in `.tierkit/runtime/anthropic-gateway.jsonl`. NO request body, NO `Authorization` raw, NO `x-api-key` raw, NO response body. Rotation: 7 days OR 5 MB cap, whichever comes first.

**Files:**
- Create: `packages/core/src/runtime/gatewayLog.ts`
- Create: `packages/core/test/gatewayLog.test.ts`
- Create: `packages/core/test/gatewayLog.redaction.test.ts`

- [ ] **Step 1: Write the failing redaction test FIRST**

Create `packages/core/test/gatewayLog.redaction.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendGatewayLog, type GatewayLogRecord } from "../src/runtime/gatewayLog.js";

describe("gatewayLog — redaction rules", () => {
  const SECRET_BEARER = "sk-ant-secret-token-abcdef12345";
  const SECRET_API_KEY = "sk-ant-api03-VERYSECRET";

  async function tmpFile(): Promise<{ file: string; dir: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), "gw-log-"));
    return { file: path.join(dir, "anthropic-gateway.jsonl"), dir };
  }

  function record(): GatewayLogRecord {
    return {
      ts: "2026-05-26T12:00:00.000Z",
      path: "/v1/messages",
      stream: true,
      status: 200,
      durationMs: 1234,
      auth: { scheme: "Bearer", fingerprint: "abcdef123456" },
    };
  }

  it("never writes the verbatim Authorization token", async () => {
    const { file, dir } = await tmpFile();
    try {
      // Even if caller mistakenly stuffs secrets into a record, the writer's
      // schema-enforced allowlist must drop them. We pass an extended record
      // and expect the file to never contain SECRET_BEARER.
      const evil = { ...record(), authorizationRaw: SECRET_BEARER } as never;
      await appendGatewayLog(file, evil);
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain(SECRET_BEARER);
      expect(raw).not.toContain("authorizationRaw");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never writes the verbatim x-api-key token", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...record(), apiKeyRaw: SECRET_API_KEY } as never;
      await appendGatewayLog(file, evil);
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain(SECRET_API_KEY);
      expect(raw).not.toContain("apiKeyRaw");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never writes a request body field even when passed", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...record(), body: { messages: [{ role: "user", content: "secret data" }] } } as never;
      await appendGatewayLog(file, evil);
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain("secret data");
      expect(raw).not.toContain('"body"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects records missing required allowlist fields", async () => {
    const { file, dir } = await tmpFile();
    try {
      const bad = { ts: "2026-05-26T12:00:00.000Z" } as never;
      await expect(appendGatewayLog(file, bad)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the redaction test to verify it fails**

```bash
pnpm --filter @tierkit/core test -- gatewayLog.redaction
```
Expected: 4 failures — file does not exist yet.

- [ ] **Step 3: Write the rotation test**

Create `packages/core/test/gatewayLog.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendGatewayLog,
  type GatewayLogRecord,
  GATEWAY_LOG_MAX_BYTES,
  GATEWAY_LOG_MAX_AGE_DAYS,
} from "../src/runtime/gatewayLog.js";

function record(overrides: Partial<GatewayLogRecord> = {}): GatewayLogRecord {
  return {
    ts: "2026-05-26T12:00:00.000Z",
    path: "/v1/messages",
    stream: false,
    status: 200,
    durationMs: 50,
    auth: { scheme: "Bearer", fingerprint: "abcdef123456" },
    ...overrides,
  };
}

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "gw-log-"));
}

describe("gatewayLog — file shape", () => {
  it("creates the directory and appends one JSON line per call", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "nested", "anthropic-gateway.jsonl");
      await appendGatewayLog(file, record());
      await appendGatewayLog(file, record({ status: 502 }));
      const raw = await readFile(file, "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).status).toBe(200);
      expect(JSON.parse(lines[1]!).status).toBe(502);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gatewayLog — rotation", () => {
  it("trims the file when it exceeds the 5 MB cap", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "anthropic-gateway.jsonl");
      // Pre-seed a file that is over the cap.
      const oneKbLine = JSON.stringify(record({ durationMs: 1 })) + "\n";
      const linesToOverflow = Math.ceil((GATEWAY_LOG_MAX_BYTES + 100_000) / oneKbLine.length);
      await writeFile(file, oneKbLine.repeat(linesToOverflow));

      // One append should trigger rotation.
      await appendGatewayLog(file, record({ status: 201 }));

      const s = await stat(file);
      expect(s.size).toBeLessThanOrEqual(GATEWAY_LOG_MAX_BYTES);

      const raw = await readFile(file, "utf8");
      const lines = raw.trim().split("\n");
      // The most recent record (status: 201) must still be present.
      expect(JSON.parse(lines.at(-1)!).status).toBe(201);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops entries older than 7 days when appending", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "anthropic-gateway.jsonl");
      const now = new Date("2026-05-26T12:00:00.000Z");
      const oldTs = new Date(now.getTime() - (GATEWAY_LOG_MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
      const recentTs = new Date(now.getTime() - 60_000).toISOString();
      await writeFile(
        file,
        JSON.stringify(record({ ts: oldTs })) + "\n" +
          JSON.stringify(record({ ts: recentTs })) + "\n",
      );

      await appendGatewayLog(file, record({ ts: now.toISOString() }), { now });
      const raw = await readFile(file, "utf8");
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      // Old line was dropped; recent + new survived.
      expect(lines.map((l) => l.ts)).toEqual([recentTs, now.toISOString()]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 4: Run the rotation test to verify it fails**

```bash
pnpm --filter @tierkit/core test -- "gatewayLog "
```
Expected: 3 failures, missing module.

- [ ] **Step 5: Implement `gatewayLog.ts`**

Create `packages/core/src/runtime/gatewayLog.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Phase 1 safe per-request log for the Anthropic Gateway.
 *
 * Hard rules (enforced by the zod schema below):
 *   - No request body
 *   - No response body
 *   - No raw Authorization or x-api-key value (only `scheme` + 12-char fingerprint)
 *   - No `system` prompt, no `messages[]`, no `tool_result` content
 *
 * The writer DROPS any field outside the allowlist via `z.object().strict()`.
 * If a caller mistakenly stuffs `body`, `authorizationRaw`, etc. into a record,
 * the parse fails — the log file is never written.
 *
 * Rotation: whichever fires first.
 *   - File-size cap: 5 MB. When exceeded on the next append, trim to keep the
 *     most-recent ~5 MB of complete lines.
 *   - Age cap: 7 days. Same trim pass also drops lines whose ts is older than
 *     7 days relative to the current append's clock.
 */

export const GATEWAY_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const GATEWAY_LOG_MAX_AGE_DAYS = 7;

const GatewayAuthSchema = z
  .object({
    /** Bearer | Basic | … — never the full token. Null when no Authorization header was present. */
    scheme: z.string().nullable(),
    /** First 12 hex chars of sha256(headerValue). Null when no Authorization or x-api-key was present. */
    fingerprint: z.string().nullable(),
  })
  .strict();

export const GatewayLogRecordSchema = z
  .object({
    /** ISO-8601 timestamp of the inbound request arrival. */
    ts: z.string().min(1),
    /** Always one of "/v1/messages" or "/v1/messages/count_tokens" in Phase 1. */
    path: z.string().min(1),
    /** Whether the response was streamed (SSE). */
    stream: z.boolean(),
    /** Upstream status code. -1 when the upstream call never returned (network error / abort). */
    status: z.number().int(),
    /** Wall-clock duration in milliseconds. */
    durationMs: z.number().int().nonnegative(),
    /** Auth header fingerprint only — never the raw token. */
    auth: GatewayAuthSchema,
  })
  .strict();

export type GatewayLogRecord = z.infer<typeof GatewayLogRecordSchema>;

export interface AppendGatewayLogOptions {
  /** Override clock for tests. Defaults to `new Date()`. */
  now?: Date;
}

export async function appendGatewayLog(
  filePath: string,
  record: GatewayLogRecord,
  opts: AppendGatewayLogOptions = {},
): Promise<void> {
  // Strict parse rejects unknown fields (e.g. body, authorizationRaw) AND
  // missing required fields. Any caller mistake → throw, no write.
  const validated = GatewayLogRecordSchema.parse(record);
  const now = opts.now ?? new Date();

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Maybe rotate before we append.
  try {
    const s = await fs.stat(filePath);
    if (s.size > GATEWAY_LOG_MAX_BYTES) {
      await trimByBytesAndAge(filePath, now);
    } else {
      // Even under the byte cap, age-based trim runs cheaply when the file exists
      // and contains entries older than the cap. Skip work if first byte is
      // newer than the age cap (common case).
      await maybeAgeTrim(filePath, now);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await fs.appendFile(filePath, JSON.stringify(validated) + "\n", "utf8");
}

function ageCutoffMs(now: Date): number {
  return now.getTime() - GATEWAY_LOG_MAX_AGE_DAYS * 86_400_000;
}

async function maybeAgeTrim(filePath: string, now: Date): Promise<void> {
  // Read the first ~2 KB and peek at the first line's ts; if it is newer than
  // the cutoff, no age trim is needed and we can skip a full read.
  const fd = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return;
    const newlineIdx = buf.indexOf(0x0a, 0);
    if (newlineIdx < 0) return; // single huge line; nothing to do
    const firstLine = buf.subarray(0, newlineIdx).toString("utf8");
    try {
      const parsed = JSON.parse(firstLine) as { ts?: string };
      if (parsed.ts && new Date(parsed.ts).getTime() >= ageCutoffMs(now)) return;
    } catch {
      // malformed first line → fall through and do a full age trim
    }
  } finally {
    await fd.close();
  }
  await trimByBytesAndAge(filePath, now);
}

async function trimByBytesAndAge(filePath: string, now: Date): Promise<void> {
  const raw = await fs.readFile(filePath, "utf8");
  const cutoff = ageCutoffMs(now);
  const allLines = raw.split("\n").filter((l) => l.length > 0);

  // First pass: drop age-expired entries.
  const ageKept: string[] = [];
  for (const line of allLines) {
    try {
      const parsed = JSON.parse(line) as { ts?: string };
      if (parsed.ts && new Date(parsed.ts).getTime() >= cutoff) ageKept.push(line);
    } catch {
      // Malformed line: drop (telemetry, not source of truth).
    }
  }

  // Second pass: keep most-recent lines up to the byte cap.
  const kept: string[] = [];
  let keptBytes = 0;
  for (let i = ageKept.length - 1; i >= 0; i--) {
    const lineSize = Buffer.byteLength(ageKept[i]!, "utf8") + 1;
    if (keptBytes + lineSize > GATEWAY_LOG_MAX_BYTES && kept.length > 0) break;
    kept.unshift(ageKept[i]!);
    keptBytes += lineSize;
  }

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "");
  await fs.rename(tmp, filePath);
}

/** Convenience for the daemon — builds the canonical path under runtime.dataDir. */
export function gatewayLogPath(dataDir: string): string {
  return path.join(dataDir, "anthropic-gateway.jsonl");
}
```

- [ ] **Step 6: Run both test files to verify they pass**

```bash
pnpm --filter @tierkit/core test -- gatewayLog
```
Expected: 7 pass (3 redaction + 1 shape + 2 rotation + 1 trimmer fixture).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/gatewayLog.ts \
        packages/core/test/gatewayLog.test.ts \
        packages/core/test/gatewayLog.redaction.test.ts
git commit -m "feat(core): gatewayLog — safe per-request log with age+byte rotation"
```

---

## Task 3: Wire safe log + gatewayMode gate into the two Phase 0 routes

**Why:** The spike routes were registered unconditionally. Phase 1 must (a) only serve `/v1/messages*` when `runtime.gatewayMode === "on"`, and (b) emit a `GatewayLogRecord` after every call.

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` — guard both routes and add `appendGatewayLog` calls (the spike's two `if (route === ...)` blocks, originally added near line 1792 — the merge from Task 0 placed them in this file)
- Create: `packages/core/test/Server.gatewayMode.test.ts`

- [ ] **Step 1: Write the failing gate test**

Create `packages/core/test/Server.gatewayMode.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

async function startWith(gatewayMode: "off" | "on"): Promise<{ srv: RunningServer; dir: string; url: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-gw-mode-"));
  const srv = await startServer({
    port: 0,
    cwd: dir,
    config: {
      version: "0.1",
      runtime: { port: 0, dataDir: path.join(dir, ".tierkit/runtime"), host: "127.0.0.1", gatewayMode },
    } as never,
  });
  return { srv, dir, url: `http://127.0.0.1:${srv.port}` };
}

describe("Server — gatewayMode gate", () => {
  it("returns 404 for POST /v1/messages when gatewayMode is off", async () => {
    const { srv, dir, url } = await startWith("off");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      expect(res.status).toBe(404);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 404 for POST /v1/messages/count_tokens when gatewayMode is off", async () => {
    const { srv, dir, url } = await startWith("off");
    try {
      const res = await fetch(`${url}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Note: positive case (gatewayMode "on" returns 200/502/etc) is already
  // covered by the spike's Server.anthropicGateway.test.ts. We don't duplicate
  // — but we DO add a regression that the spike's tests pass with mode "on".
  it("the spike's integration test still passes with explicit gatewayMode: on", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      // The route exists; without an upstream the call may 502, but it must not 404.
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      expect(res.status).not.toBe(404);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tierkit/core test -- Server.gatewayMode
```
Expected: first two cases fail with status 200/502 (route unconditionally responds); third may pass already.

- [ ] **Step 3: Add the gate at the top of each route in `Server.ts`**

Edit the spike's two route blocks (inside the `if (route === "POST /v1/messages")` and `if (route === "POST /v1/messages/count_tokens")` blocks). Replace each block's opening with:

```typescript
      if (route === "POST /v1/messages") {
        if (opts.config.runtime.gatewayMode !== "on") return sendJson(res, 404, { error: "not_found" });
        // ... existing spike body unchanged ...
      }

      if (route === "POST /v1/messages/count_tokens") {
        if (opts.config.runtime.gatewayMode !== "on") return sendJson(res, 404, { error: "not_found" });
        // ... existing spike body unchanged ...
      }
```

Use `Edit` against the existing strings inside Server.ts.

- [ ] **Step 4: Run the gate test to verify it passes**

```bash
pnpm --filter @tierkit/core test -- Server.gatewayMode
```
Expected: 3 pass.

- [ ] **Step 5: Write the failing logging test**

Append to `packages/core/test/Server.gatewayMode.test.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { gatewayLogPath } from "../src/runtime/gatewayLog.js";

describe("Server — gateway safe log", () => {
  it("writes one record per /v1/messages call when gatewayMode is on", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      // We don't have a real Anthropic endpoint, so the call will 502 against
      // the default upstream. The log MUST still be written.
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-test-NEVER-PERSISTED" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      // Tiny wait for the post-response log write to flush.
      await new Promise((r) => setTimeout(r, 50));
      const logPath = gatewayLogPath(path.join(dir, ".tierkit/runtime"));
      const raw = await readFile(logPath, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(1);
      expect(raw).not.toContain("sk-test-NEVER-PERSISTED");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.path).toBe("/v1/messages");
      expect(parsed.auth.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
pnpm --filter @tierkit/core test -- Server.gatewayMode
```
Expected: new test fails — no log file written.

- [ ] **Step 7: Wire `appendGatewayLog` into both routes**

In `Server.ts`, import at the top:

```typescript
import { appendGatewayLog, gatewayLogPath } from "./gatewayLog.js";
import { observeAuthHeaders } from "./anthropicGateway.js";
```

Wrap each route body to capture start time and emit a record in both success and error paths. Example for `/v1/messages` (apply the same shape to `/v1/messages/count_tokens` with `stream: false`):

```typescript
      if (route === "POST /v1/messages") {
        if (opts.config.runtime.gatewayMode !== "on") return sendJson(res, 404, { error: "not_found" });

        const startedAt = Date.now();
        const auth = observeAuthHeaders(req.headers);
        const body = await readRawBody(req);
        const wantsStream = isStreamingMessagesBody(body);

        const logRecord = (status: number) =>
          appendGatewayLog(
            gatewayLogPath(opts.config.runtime.dataDir),
            {
              ts: new Date(startedAt).toISOString(),
              path: "/v1/messages",
              stream: wantsStream,
              status,
              durationMs: Date.now() - startedAt,
              auth: {
                scheme: auth.authorizationScheme,
                fingerprint: auth.authorizationFingerprint ?? auth.apiKeyFingerprint,
              },
            },
          ).catch((err) => {
            // Logging must never break the request. Surface to stderr but swallow.
            console.error("[anthropic-gateway] log write failed:", (err as Error).message);
          });

        try {
          if (wantsStream) {
            await streamMessages(req, body, res);
            void logRecord(res.statusCode);
            return;
          }
          const r = await forwardMessages(req, body);
          for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
          res.statusCode = r.status;
          res.end(r.body);
          void logRecord(r.status);
          return;
        } catch (err) {
          void logRecord(-1);
          if (res.headersSent) {
            res.destroy(err as Error);
            return;
          }
          return sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: (err as Error).message } });
        }
      }
```

- [ ] **Step 8: Run the full suite**

```bash
pnpm --filter @tierkit/core test
```
Expected: all green, including the gate + log tests and the spike's original 17.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runtime/Server.ts \
        packages/core/test/Server.gatewayMode.test.ts
git commit -m "feat(core): gate /v1/messages routes on runtime.gatewayMode + safe log"
```

---

## Task 4: `doctorGateway` usecase

**Why:** A focused diagnostic surface for "is the connection wired correctly?" that the CLI and the sidebar share. Composed of checks: config has `gatewayMode: on`, daemon is reachable, route responds, the safe log path is writable, and Claude Code is detected on PATH.

**Files:**
- Create: `packages/core/src/usecases/doctorGateway.ts`
- Create: `packages/core/test/doctorGateway.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/doctorGateway.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctorGateway } from "../src/usecases/doctorGateway.js";

async function projectWith(config: object): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-doctor-gw-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify(config));
  return dir;
}

describe("doctorGateway", () => {
  it("flags gatewayMode=off as a 'warn' with how-to-fix hint", async () => {
    const dir = await projectWith({ version: "0.1" });
    try {
      const r = await doctorGateway({ cwd: dir });
      const mode = r.find((c) => c.id === "gateway-mode");
      expect(mode?.status).toBe("warn");
      expect(mode?.detail).toMatch(/gatewayMode/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports 'ok' for gateway-mode when set to on", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const r = await doctorGateway({ cwd: dir });
      expect(r.find((c) => c.id === "gateway-mode")?.status).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports daemon as unreachable when no daemon is running on the configured port", async () => {
    const dir = await projectWith({
      version: "0.1",
      runtime: { gatewayMode: "on", port: 1 }, // port 1 is reserved; will refuse
    });
    try {
      const r = await doctorGateway({ cwd: dir });
      const daemon = r.find((c) => c.id === "gateway-daemon");
      expect(daemon?.status).toBe("fail");
      expect(daemon?.detail).toMatch(/unreachable|connect|refused/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the safe log path and whether it is writable", async () => {
    const dataDir = path.join(await mkdtemp(path.join(tmpdir(), "tk-gw-dd-")), ".tierkit/runtime");
    await mkdir(dataDir, { recursive: true });
    const dir = await projectWith({
      version: "0.1",
      runtime: { gatewayMode: "on", dataDir },
    });
    try {
      const r = await doctorGateway({ cwd: dir });
      const log = r.find((c) => c.id === "gateway-log-path");
      expect(log?.status).toBe("ok");
      expect(log?.detail).toContain("anthropic-gateway.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports Claude Code presence on PATH (ok | warn — never fail; user may not have installed it)", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const r = await doctorGateway({ cwd: dir });
      const cc = r.find((c) => c.id === "gateway-claude-code");
      expect(cc?.status).toMatch(/ok|warn/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tierkit/core test -- doctorGateway
```
Expected: 5 failures — module missing.

- [ ] **Step 3: Implement `doctorGateway.ts`**

Create `packages/core/src/usecases/doctorGateway.ts`:

```typescript
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loadConfig.js";
import type { DoctorCheck } from "./doctor.js";
import { gatewayLogPath } from "../runtime/gatewayLog.js";

export interface DoctorGatewayInput {
  cwd?: string;
}

/**
 * Phase 1 connectivity diagnostic for the Anthropic Gateway.
 *
 * NEVER reads or echoes a credential value. The `gateway-credential-mode` check
 * reports the *mode* (subscription | api-key | unknown) by inspecting only
 * `process.env.ANTHROPIC_API_KEY` presence — never its value.
 *
 * Failure semantics:
 *   - `gateway-mode: warn` when off — it's the default; not an error.
 *   - `gateway-daemon: fail` when the daemon is unreachable AND mode is on
 *     (mode-off skips this check entirely; nothing to connect to).
 *   - `gateway-routes: fail` when daemon is reachable but /v1/messages returns
 *     anything other than 200/400/401/502 to a tiny shape-only probe.
 *   - `gateway-log-path: ok` when writable, `fail` when not.
 *   - `gateway-claude-code: warn` when not on PATH (user may not have it).
 */
export async function doctorGateway(input: DoctorGatewayInput = {}): Promise<DoctorCheck[]> {
  const cwd = input.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  const cfgResult = await loadConfig(cwd);
  const runtime = cfgResult.config.runtime;

  // 1) gateway-mode
  if (runtime.gatewayMode === "on") {
    checks.push({ id: "gateway-mode", label: "runtime.gatewayMode", status: "ok", detail: "on" });
  } else {
    checks.push({
      id: "gateway-mode",
      label: "runtime.gatewayMode",
      status: "warn",
      detail:
        `gatewayMode is "off" (default). Set "runtime.gatewayMode": "on" in tierkit.config.json ` +
        `OR toggle "Route Claude Code through Tierkit" in the sidebar to expose /v1/messages.`,
    });
  }

  const baseUrl = `http://${runtime.host}:${runtime.port}`;

  // 2) gateway-daemon (only when mode is on — otherwise nothing to test)
  if (runtime.gatewayMode === "on") {
    const reach = await probeDaemon(baseUrl);
    if (reach.ok) {
      checks.push({ id: "gateway-daemon", label: `daemon @ ${baseUrl}`, status: "ok" });
      // 3) gateway-routes
      checks.push(await probeRoute(baseUrl));
    } else {
      checks.push({
        id: "gateway-daemon",
        label: `daemon @ ${baseUrl}`,
        status: "fail",
        detail: reach.detail,
      });
    }
  }

  // 4) gateway-log-path
  checks.push(await checkLogWritable(runtime.dataDir, cwd));

  // 5) gateway-claude-code
  checks.push(checkClaudeCodeOnPath());

  // 6) gateway-credential-mode — never reads the value
  checks.push(checkCredentialMode());

  return checks;
}

async function probeDaemon(baseUrl: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, detail: `daemon responded with status ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message}` };
  }
}

async function probeRoute(baseUrl: string): Promise<DoctorCheck> {
  try {
    // Tiny shape-only probe — empty messages with max_tokens 1. Upstream will
    // 4xx but the route MUST respond (i.e. not 404). We never log the upstream
    // body; we only care about the status code.
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 404) {
      return { id: "gateway-routes", label: "/v1/messages", status: "fail", detail: "404 — gatewayMode is off or routes not registered" };
    }
    return { id: "gateway-routes", label: "/v1/messages", status: "ok", detail: `responded ${res.status} to probe (any non-404 = route is wired)` };
  } catch (err) {
    return { id: "gateway-routes", label: "/v1/messages", status: "fail", detail: `probe failed: ${(err as Error).message}` };
  }
}

async function checkLogWritable(dataDir: string, cwd: string): Promise<DoctorCheck> {
  const absDataDir = dataDir.startsWith("/") ? dataDir : `${cwd}/${dataDir}`;
  const logPath = gatewayLogPath(absDataDir);
  try {
    await fs.mkdir(absDataDir, { recursive: true });
    const probe = `${logPath}.probe-${process.pid}`;
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
    return { id: "gateway-log-path", label: "safe gateway log", status: "ok", detail: logPath };
  } catch (err) {
    return {
      id: "gateway-log-path",
      label: "safe gateway log",
      status: "fail",
      detail: `${logPath} — ${(err as Error).message}`,
    };
  }
}

function checkClaudeCodeOnPath(): DoctorCheck {
  const r = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim().length > 0) {
    return { id: "gateway-claude-code", label: "claude (Claude Code CLI)", status: "ok", detail: r.stdout.trim() };
  }
  return {
    id: "gateway-claude-code",
    label: "claude (Claude Code CLI)",
    status: "warn",
    detail: `not found on PATH — install Claude Code, then re-run this check`,
  };
}

function checkCredentialMode(): DoctorCheck {
  const hasApiKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
  return {
    id: "gateway-credential-mode",
    label: "credential mode",
    status: "ok",
    detail: hasApiKey ? "api-key (ANTHROPIC_API_KEY is set in this environment)" : "subscription / unknown (no ANTHROPIC_API_KEY)",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tierkit/core test -- doctorGateway
```
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/usecases/doctorGateway.ts \
        packages/core/test/doctorGateway.test.ts
git commit -m "feat(core): doctorGateway usecase — connection diagnostics, no credentials"
```

---

## Task 5: `tierkit doctor gateway` CLI

**Why:** Surface the diagnostic from the terminal as a top-level command so users (and CI) can verify the connection without opening the IDE.

**Files:**
- Create: `packages/cli/src/commands/DoctorGatewayCommand.ts`
- Create: `packages/cli/test/doctorGatewayCommand.test.ts`
- Modify: `packages/cli/src/cli.ts` — register the new command

- [ ] **Step 1: Write the failing CLI test**

Create `packages/cli/test/doctorGatewayCommand.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLI = path.resolve(__dirname, "../dist/cli.js");

describe("tierkit doctor gateway", () => {
  it("exits 0 and prints check lines when gatewayMode is off", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tk-cli-doctor-gw-"));
    try {
      await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1" }));
      const out = execFileSync("node", [CLI, "doctor", "gateway"], { cwd: dir, encoding: "utf8" });
      expect(out).toContain("runtime.gatewayMode");
      expect(out).toContain("safe gateway log");
      // Off is a warn, not a fail — must exit 0.
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when a hard failure (e.g. unreachable daemon with mode on)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tk-cli-doctor-gw-fail-"));
    try {
      await writeFile(
        path.join(dir, "tierkit.config.json"),
        JSON.stringify({ version: "0.1", runtime: { gatewayMode: "on", port: 1 } }),
      );
      expect(() => execFileSync("node", [CLI, "doctor", "gateway"], { cwd: dir, encoding: "utf8" })).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tierkit/cli build && pnpm --filter @tierkit/cli test -- doctorGatewayCommand
```
Expected: fail — command not registered.

- [ ] **Step 3: Implement `DoctorGatewayCommand`**

Create `packages/cli/src/commands/DoctorGatewayCommand.ts`:

```typescript
import { Command } from "clipanion";
import { doctorGateway } from "@tierkit/core";
import type { CliContext } from "../context/CliContext.js";

export class DoctorGatewayCommand extends Command<CliContext> {
  static override paths = [["doctor", "gateway"]];

  static override usage = Command.Usage({
    category: "Diagnostics",
    description: "Diagnose the Anthropic Gateway connection (Phase 1).",
    details: `
      Phase 1 is a passthrough connection feature — context-savings measurement
      and compression arrive in Phase 2. This command reports whether the
      connection is wired correctly and never reads or echoes credentials.
    `,
    examples: [["Run gateway diagnostics", "tierkit doctor gateway"]],
  });

  override async execute(): Promise<number> {
    const checks = await doctorGateway({ cwd: this.context.cwd });
    this.context.stdout.write(`Tierkit doctor gateway — ${this.context.cwd}\n`);
    for (const c of checks) {
      const tag = c.status === "ok" ? "OK  " : c.status === "warn" ? "WARN" : "FAIL";
      const detail = c.detail ? ` — ${c.detail}` : "";
      this.context.stdout.write(`  [${tag}] ${c.label}${detail}\n`);
    }
    const hasFail = checks.some((c) => c.status === "fail");
    return hasFail ? 1 : 0;
  }
}
```

- [ ] **Step 4: Register the command**

In `packages/cli/src/cli.ts`, add the import and `cli.register(DoctorGatewayCommand)` next to the existing `DoctorCommand` registration. Use `Edit` to add the line.

- [ ] **Step 5: Build and run the CLI test**

```bash
pnpm --filter @tierkit/cli build
pnpm --filter @tierkit/cli test -- doctorGatewayCommand
```
Expected: 2 pass.

- [ ] **Step 6: Manually verify**

```bash
node packages/cli/dist/cli.js doctor gateway
```
Expected: prints check lines, exits 0 in the repo root (gatewayMode off → warn, not fail).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/DoctorGatewayCommand.ts \
        packages/cli/src/cli.ts \
        packages/cli/test/doctorGatewayCommand.test.ts
git commit -m "feat(cli): tierkit doctor gateway — Phase 1 connection diagnostic"
```

---

## Task 6: VS Code config + sidebar toggle "Route Claude Code through Tierkit"

**Why:** The UI surface that flips `tierkit.config.json::runtime.gatewayMode`. Lives in the sidebar webview (`GUI_HTML`); the extension exposes a command that the webview can invoke.

**Files:**
- Modify: `packages/vscode-tierkit/package.json` — add `tierkit.gatewayMode` configuration property (mirror) AND `tierkit.toggleGatewayMode` command
- Modify: `packages/vscode-tierkit/src/extension.ts` — register the toggle command (writes through the daemon's `PATCH /v1/config` if available; otherwise edits `tierkit.config.json` directly)
- Modify: `packages/core/src/runtime/ui/gui.ts` — add the toggle row to the sidebar UI

The webview communicates with the extension via the existing `messageRouter` pattern.

- [ ] **Step 1: Add command + configuration entries to package.json**

In `packages/vscode-tierkit/package.json::contributes.commands`, append:

```json
        {
          "command": "tierkit.toggleGatewayMode",
          "title": "%command.toggleGatewayMode%",
          "category": "Tierkit"
        }
```

In `contributes.configuration.properties`, append:

```json
        "tierkit.gatewayMode": {
          "type": "string",
          "enum": ["off", "on"],
          "default": "off",
          "description": "%configuration.gatewayMode%"
        }
```

In `packages/vscode-tierkit/package.nls.json` append:

```json
  "command.toggleGatewayMode": "Route Claude Code through Tierkit (toggle)",
  "configuration.gatewayMode": "Phase 1 passthrough connection — when 'on', the Tierkit daemon exposes /v1/messages so Claude Code can be pointed at it via ANTHROPIC_BASE_URL. This is a CONNECTION feature only — it does not compress, redact, or save tokens. Default off."
```

In `packages/vscode-tierkit/package.nls.ko.json` append:

```json
  "command.toggleGatewayMode": "Claude Code를 Tierkit 통해 연결 (토글)",
  "configuration.gatewayMode": "Phase 1 패스스루 연결 기능. 'on'으로 두면 Tierkit 데몬이 /v1/messages를 노출하므로 ANTHROPIC_BASE_URL로 Claude Code를 가리킬 수 있습니다. 연결 기능일 뿐, 토큰 압축이나 절감은 제공하지 않습니다. 기본값 off."
```

- [ ] **Step 2: Register the toggle command in `extension.ts`**

In the `registerCommand` block (around line 834-851 from the merge baseline), add a new registration. Write through `tierkit.config.json` directly to avoid a daemon round-trip:

```typescript
    vscode.commands.registerCommand("tierkit.toggleGatewayMode", async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Open a folder first — Tierkit needs a workspace."));
        return;
      }
      const cfgPath = require("node:path").join(workspace.uri.fsPath, "tierkit.config.json");
      const fs = require("node:fs/promises");
      let cfg: { version: string; runtime?: { gatewayMode?: string } } = { version: "0.1" };
      try {
        cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          void vscode.window.showErrorMessage(`tierkit.config.json: ${(err as Error).message}`);
          return;
        }
      }
      const current = cfg.runtime?.gatewayMode ?? "off";
      const next = current === "on" ? "off" : "on";
      cfg.runtime = { ...(cfg.runtime ?? {}), gatewayMode: next };
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
      void vscode.commands.executeCommand("tierkit.restartDaemon");
      void vscode.window.showInformationMessage(
        next === "on"
          ? vscode.l10n.t("Gateway mode ON. Use 'Launch Claude Code through Tierkit' to start a session.")
          : vscode.l10n.t("Gateway mode OFF. /v1/messages is no longer served."),
      );
      sidebarRef?.render();
    }),
```

- [ ] **Step 3: Create the pure webview-command allowlist helper**

`packages/vscode-tierkit/src/messageRouter.ts` is a pure module that does not import `vscode`, so the webview→command bridge cannot live there. Instead it lives at the `onDidReceiveMessage` site in `extension.ts` (mirrors the existing `tk:open-panel` pattern around `extension.ts:595`). To keep the allowlist itself unit-testable, extract it as a pure helper.

Create `packages/vscode-tierkit/src/webviewCommandAllowlist.ts`:

```typescript
/**
 * Allowlist of VS Code commands the sidebar webview may invoke via a `tk:cmd`
 * message. Anything not in this set is dropped silently. Phase 1 only exposes
 * gateway-related commands — keep this list tight.
 */
const ALLOWED = new Set<string>([
  "tierkit.toggleGatewayMode",
  "tierkit.launchClaudeCodeWithGateway",
]);

export function isAllowedWebviewCommand(command: unknown): command is string {
  return typeof command === "string" && ALLOWED.has(command);
}
```

- [ ] **Step 4: Write a failing unit test for the allowlist**

Create `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isAllowedWebviewCommand } from "../src/webviewCommandAllowlist.js";

describe("isAllowedWebviewCommand", () => {
  it("admits Phase 1 gateway commands", () => {
    expect(isAllowedWebviewCommand("tierkit.toggleGatewayMode")).toBe(true);
    expect(isAllowedWebviewCommand("tierkit.launchClaudeCodeWithGateway")).toBe(true);
  });

  it("rejects unrelated tierkit commands", () => {
    expect(isAllowedWebviewCommand("tierkit.openInPanel")).toBe(false);
    expect(isAllowedWebviewCommand("tierkit.restartDaemon")).toBe(false);
  });

  it("rejects arbitrary VS Code commands", () => {
    expect(isAllowedWebviewCommand("workbench.action.terminal.kill")).toBe(false);
    expect(isAllowedWebviewCommand("workbench.action.reloadWindow")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isAllowedWebviewCommand(undefined)).toBe(false);
    expect(isAllowedWebviewCommand(42)).toBe(false);
    expect(isAllowedWebviewCommand({})).toBe(false);
  });
});
```

Run:

```bash
pnpm --filter @tierkit/vscode-tierkit test -- webviewCommandAllowlist
```
Expected: fail (module missing) → pass after Step 3 file exists.

- [ ] **Step 4b: Wire the `tk:cmd` handler in extension.ts**

In **both** webview `onDidReceiveMessage` handlers (the sidebar one around `extension.ts:572-603` and the main-panel one around `extension.ts:279-299`), add a new branch just BEFORE the `if (msg.type.startsWith("tk:"))` line:

```typescript
      // Phase 1: webview-triggered VS Code command (gateway toggle / launch).
      // Allowlisted in webviewCommandAllowlist.ts.
      if (msg.type === "tk:cmd" && isAllowedWebviewCommand(msg.command)) {
        void vscode.commands.executeCommand(msg.command);
        return;
      }
```

Add the import at the top of `extension.ts`:

```typescript
import { isAllowedWebviewCommand } from "./webviewCommandAllowlist.js";
```

- [ ] **Step 4c: Add the toggle row to the sidebar HTML**

In `packages/core/src/runtime/ui/gui.ts` (the inlined HTML), add a small card. It MUST:
1. Read current `runtime.gatewayMode` from `GET /v1/config` (already exposed by the daemon).
2. Render a checkbox wired to post `{ type: "tk:cmd", command: "tierkit.toggleGatewayMode" }` to the parent (`window.parent.postMessage` or `acquireVsCodeApi().postMessage`, matching the existing call sites in `gui.ts`).
3. Use the row label **"Route Claude Code through Tierkit (Phase 1 passthrough — connection only)"**. Do NOT use "savings" / "saves" / "절감".

Mirror the structure of any existing card that displays a config value + has a "Restart daemon" button (search `gui.ts` for `restartDaemon` to find that pattern).

- [ ] **Step 5: Run tests + build the extension**

```bash
pnpm --filter @tierkit/vscode-tierkit build
pnpm --filter @tierkit/vscode-tierkit test
```
Expected: pass.

- [ ] **Step 6: Manual smoke (developer-machine)**

Build the vsix and install. In the sidebar, the new row should appear with the toggle off. Flipping it edits `tierkit.config.json`, restarts the daemon, and shows the success info-message.

```bash
pnpm bump   # syncs versions across the monorepo
pnpm --filter @tierkit/vscode-tierkit package
ls packages/vscode-tierkit/*.vsix
```

- [ ] **Step 7: Commit**

```bash
git add packages/vscode-tierkit/package.json \
        packages/vscode-tierkit/package.nls.json \
        packages/vscode-tierkit/package.nls.ko.json \
        packages/vscode-tierkit/src/extension.ts \
        packages/vscode-tierkit/src/webviewCommandAllowlist.ts \
        packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts \
        packages/core/src/runtime/ui/gui.ts
git commit -m "feat(vscode): sidebar toggle 'Route Claude Code through Tierkit'"
```

---

## Task 7: "Launch Claude Code through Tierkit" terminal button (scoped env)

**Why:** Phase 1 must NOT modify `~/.zshrc`. The cleanest, most reversible approach is to spawn an integrated terminal with `ANTHROPIC_BASE_URL` set for THAT terminal only.

**Files:**
- Create: `packages/vscode-tierkit/src/gatewayLaunch.ts` — pure env-builder (testable) + the VS Code terminal creator
- Create: `packages/vscode-tierkit/test/gatewayLaunch.test.ts`
- Modify: `packages/vscode-tierkit/src/extension.ts` — register `tierkit.launchClaudeCodeWithGateway`
- Modify: `packages/vscode-tierkit/package.json` — add the command + a webview-triggerable command entry

- [ ] **Step 1: Write the failing env-builder test**

Create `packages/vscode-tierkit/test/gatewayLaunch.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildGatewayEnv, gatewayLaunchCommand } from "../src/gatewayLaunch.js";

describe("gatewayLaunch — buildGatewayEnv", () => {
  it("sets ANTHROPIC_BASE_URL to the daemon URL", () => {
    const env = buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: {} });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101");
  });

  it("explicitly UNSETS ANTHROPIC_API_KEY in the spawned terminal to force subscription mode when present", () => {
    // Phase 1 rationale: if the parent shell has ANTHROPIC_API_KEY set, Claude Code
    // will prefer it. We want the gateway-launched terminal to behave deterministically
    // (use whatever the user's subscription / OAuth gives — Phase 0 A proved this works).
    // The spike RFC §A explicitly tested this with "unset ANTHROPIC_API_KEY".
    const env = buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: { ANTHROPIC_API_KEY: "sk-secret" } });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("preserves an unrelated parent env var", () => {
    const env = buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: { PATH: "/usr/local/bin", HOME: "/Users/x" } });
    expect(env.PATH).toBe("/usr/local/bin");
    expect(env.HOME).toBe("/Users/x");
  });
});

describe("gatewayLaunch — gatewayLaunchCommand", () => {
  it("returns the literal 'claude' string by default", () => {
    expect(gatewayLaunchCommand()).toBe("claude");
  });

  it("allows override via TIERKIT_CLAUDE_CODE_BIN env", () => {
    expect(gatewayLaunchCommand({ TIERKIT_CLAUDE_CODE_BIN: "/usr/local/bin/claude" })).toBe("/usr/local/bin/claude");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayLaunch
```
Expected: 5 failures — module missing.

- [ ] **Step 3: Implement `gatewayLaunch.ts`**

Create `packages/vscode-tierkit/src/gatewayLaunch.ts`:

```typescript
import * as vscode from "vscode";

export interface GatewayEnvInput {
  baseUrl: string;
  parentEnv: Record<string, string | undefined>;
}

/**
 * Pure: build the env map for the gateway-routed Claude Code terminal.
 *
 * Hard rules:
 *   - Set ANTHROPIC_BASE_URL to the running daemon.
 *   - DELETE ANTHROPIC_API_KEY so Claude Code uses its subscription / OAuth
 *     credential, the path Phase 0 validation A actually proved works.
 *     If the user wants api-key mode, they can launch Claude Code without the
 *     gateway button (their plain terminal still has the env var).
 *   - Preserve every other parent env var verbatim (PATH, HOME, locale, etc.).
 */
export function buildGatewayEnv(input: GatewayEnvInput): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...input.parentEnv };
  out.ANTHROPIC_BASE_URL = input.baseUrl;
  delete out.ANTHROPIC_API_KEY;
  return out;
}

export function gatewayLaunchCommand(env: Record<string, string | undefined> = process.env): string {
  return env.TIERKIT_CLAUDE_CODE_BIN ?? "claude";
}

/**
 * Open a VS Code integrated terminal with `ANTHROPIC_BASE_URL` scoped to that
 * terminal only. Does NOT modify the user's shell profile.
 *
 * If the daemon is not reachable, surfaces a fallback dialog ("Run in Direct
 * mode?") — see Task 9 for the dialog implementation.
 */
export async function launchClaudeCodeWithGateway(baseUrl: string): Promise<vscode.Terminal | undefined> {
  const env = buildGatewayEnv({ baseUrl, parentEnv: process.env });
  const terminal = vscode.window.createTerminal({
    name: "Claude Code (Tierkit)",
    env,
  });
  terminal.show();
  terminal.sendText(gatewayLaunchCommand(), true);
  return terminal;
}
```

- [ ] **Step 4: Register the command**

In `packages/vscode-tierkit/src/extension.ts` (registerCommand block), add:

```typescript
    vscode.commands.registerCommand("tierkit.launchClaudeCodeWithGateway", async () => {
      // Pre-flight: gateway must be reachable. Otherwise direct-fallback dialog (Task 9).
      const health = await withClient((c) => c.health());
      if (!health) {
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("Tierkit Gateway unreachable. Launch Claude Code directly (no gateway)?"),
          { modal: false },
          vscode.l10n.t("Launch direct"),
          vscode.l10n.t("Cancel"),
        );
        if (pick === vscode.l10n.t("Launch direct")) {
          const t = vscode.window.createTerminal({ name: "Claude Code (direct)" });
          t.show();
          t.sendText("claude", true);
        }
        return;
      }
      const cfg = vscode.workspace.getConfiguration("tierkit");
      const baseUrl = cfg.get<string>("baseUrl") ?? "http://127.0.0.1:4101";
      const { launchClaudeCodeWithGateway } = await import("./gatewayLaunch.js");
      await launchClaudeCodeWithGateway(baseUrl);
    }),
```

- [ ] **Step 5: Add command + nls entries**

In `packages/vscode-tierkit/package.json::contributes.commands`:

```json
        {
          "command": "tierkit.launchClaudeCodeWithGateway",
          "title": "%command.launchClaudeCodeWithGateway%",
          "category": "Tierkit"
        }
```

In `package.nls.json`:

```json
  "command.launchClaudeCodeWithGateway": "Launch Claude Code through Tierkit"
```

In `package.nls.ko.json`:

```json
  "command.launchClaudeCodeWithGateway": "Tierkit 통해 Claude Code 실행"
```

- [ ] **Step 6: Run tests and build**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayLaunch
pnpm --filter @tierkit/vscode-tierkit build
```
Expected: 5 unit tests pass; build clean.

- [ ] **Step 7: Manual smoke**

Build vsix, install, toggle gateway on, click "Tierkit: Launch Claude Code through Tierkit" from the command palette.
- Verify the new terminal shows `ANTHROPIC_BASE_URL` set: `echo $ANTHROPIC_BASE_URL` should print `http://127.0.0.1:4101`.
- Verify `echo $ANTHROPIC_API_KEY` prints nothing in that terminal even if it was set in the parent shell.

- [ ] **Step 8: Commit**

```bash
git add packages/vscode-tierkit/src/gatewayLaunch.ts \
        packages/vscode-tierkit/test/gatewayLaunch.test.ts \
        packages/vscode-tierkit/src/extension.ts \
        packages/vscode-tierkit/package.json \
        packages/vscode-tierkit/package.nls.json \
        packages/vscode-tierkit/package.nls.ko.json
git commit -m "feat(vscode): launch Claude Code through Tierkit — scoped env, no shell profile mutation"
```

---

## Task 8: Direct fallback dialog when gateway unreachable

**Why:** When `gatewayMode === "on"` but the daemon is offline (crashed, port collision, ENOSPC, etc.), Claude Code launched with the gateway env will hang or error. The user must have a one-click escape hatch.

Note: a basic fallback dialog was wired in Task 7's launch command. This task hardens it to **also** auto-attempt a daemon restart before giving up.

**Files:**
- Modify: `packages/vscode-tierkit/src/extension.ts` — extend the launch command's pre-flight

- [ ] **Step 1: Write a manual test plan (no good way to unit-test VS Code dialogs)**

Create `packages/vscode-tierkit/test/MANUAL_gateway_fallback.md`:

```markdown
# Manual: gateway fallback flow

1. Toggle gateway mode ON.
2. Kill the daemon: `pkill -f 'tierkit runtime'` OR stop it from the command palette.
3. Open the command palette → "Tierkit: Launch Claude Code through Tierkit".

Expected:
- Pre-flight shows a transient "Starting daemon…" message.
- After ~3s, if the daemon comes back up, terminal opens with ANTHROPIC_BASE_URL set.
- If the daemon does NOT come back up, the dialog appears: "Tierkit Gateway unreachable. Launch Claude Code directly (no gateway)?"
- Clicking "Launch direct" opens a terminal WITHOUT ANTHROPIC_BASE_URL.
- Clicking "Cancel" does nothing.

Negative path:
- Click "Launch direct" → `echo $ANTHROPIC_BASE_URL` should print empty.
```

- [ ] **Step 2: Extend the launch command with auto-restart pre-flight**

Edit the `tierkit.launchClaudeCodeWithGateway` command body added in Task 7. Replace the health check + early dialog with:

```typescript
    vscode.commands.registerCommand("tierkit.launchClaudeCodeWithGateway", async () => {
      let health = await withClient((c) => c.health());
      if (!health) {
        // Try one auto-restart before surfacing the fallback dialog.
        void vscode.window.setStatusBarMessage(vscode.l10n.t("Tierkit Gateway: starting daemon…"), 3000);
        await vscode.commands.executeCommand("tierkit.restartDaemon");
        // Poll for up to 3 seconds.
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !health) {
          await new Promise((r) => setTimeout(r, 300));
          health = await withClient((c) => c.health());
        }
      }
      if (!health) {
        const launchDirectLabel = vscode.l10n.t("Launch direct");
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("Tierkit Gateway unreachable. Launch Claude Code directly (no gateway)?"),
          { modal: false },
          launchDirectLabel,
          vscode.l10n.t("Cancel"),
        );
        if (pick === launchDirectLabel) {
          const t = vscode.window.createTerminal({ name: "Claude Code (direct)" });
          t.show();
          t.sendText("claude", true);
        }
        return;
      }
      const cfg = vscode.workspace.getConfiguration("tierkit");
      const baseUrl = cfg.get<string>("baseUrl") ?? "http://127.0.0.1:4101";
      const { launchClaudeCodeWithGateway } = await import("./gatewayLaunch.js");
      await launchClaudeCodeWithGateway(baseUrl);
    }),
```

- [ ] **Step 3: Build the extension**

```bash
pnpm --filter @tierkit/vscode-tierkit build
```
Expected: clean.

- [ ] **Step 4: Run the manual test plan**

Walk through `packages/vscode-tierkit/test/MANUAL_gateway_fallback.md` and confirm each expected behavior. Record observations in the PR description.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode-tierkit/src/extension.ts \
        packages/vscode-tierkit/test/MANUAL_gateway_fallback.md
git commit -m "feat(vscode): gateway launch — auto-restart pre-flight + direct fallback dialog"
```

---

## Task 9: Sidebar gateway diagnostics card

**Why:** Mirror `tierkit doctor gateway` in the sidebar so users get the same diagnostic without dropping to a terminal.

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` — add `GET /v1/doctor/gateway` endpoint that calls `doctorGateway()`
- Modify: `packages/core/src/runtime/ui/gui.ts` — render the card
- Modify: `packages/client/src/Client.ts` (or wherever the typed SDK lives) — add `doctorGateway()` method

- [ ] **Step 1: Write a failing endpoint test**

Create `packages/core/test/Server.doctorGateway.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/runtime/Server.js";

describe("GET /v1/doctor/gateway", () => {
  it("returns checks array as JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tk-srv-doctor-gw-"));
    await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1" }));
    const srv = await startServer({ port: 0, cwd: dir });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1/doctor/gateway`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { checks: Array<{ id: string; status: string }> };
      expect(Array.isArray(body.checks)).toBe(true);
      expect(body.checks.some((c) => c.id === "gateway-mode")).toBe(true);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (404)**

```bash
pnpm --filter @tierkit/core test -- Server.doctorGateway
```
Expected: status 404.

- [ ] **Step 3: Add the route**

In `Server.ts`, near the existing health/config routes:

```typescript
      if (route === "GET /v1/doctor/gateway") {
        const { doctorGateway } = await import("../usecases/doctorGateway.js");
        const checks = await doctorGateway({ cwd: opts.cwd });
        return sendJson(res, 200, { checks });
      }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tierkit/core test -- Server.doctorGateway
```
Expected: pass.

- [ ] **Step 5: Add the client SDK method**

Find the existing client SDK (`packages/client/src/Client.ts` — locate via `grep -rn "class.*Client" packages/client/src`). Add:

```typescript
  async doctorGateway(): Promise<{ checks: Array<{ id: string; label: string; status: "ok"|"warn"|"fail"; detail?: string }> }> {
    const res = await this.fetch("/v1/doctor/gateway");
    if (!res.ok) throw new Error(`doctorGateway: ${res.status}`);
    return res.json();
  }
```

Write a tiny unit test next to the existing client tests asserting it calls the right URL.

- [ ] **Step 6: Render the sidebar card**

In `packages/core/src/runtime/ui/gui.ts`, add a "Gateway diagnostics" card that fetches `/v1/doctor/gateway` on render + a refresh button. Use the existing pattern (any `fetch('/v1/...')` call site in `gui.ts` is fine to mirror).

The card MUST display each check's `label`, `status` (with a colored dot), and `detail`. Heading: **"Anthropic Gateway — connection diagnostics"**. Subheading: **"Phase 1 passthrough — connection only, no token savings."**

- [ ] **Step 7: Build, run the daemon, eyeball**

```bash
pnpm -r build
node packages/cli/dist/cli.js runtime start
open http://127.0.0.1:4101/
```
Expected: card visible with checks.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/runtime/Server.ts \
        packages/core/test/Server.doctorGateway.test.ts \
        packages/core/src/runtime/ui/gui.ts \
        packages/client/src/Client.ts \
        packages/client/test/clientGateway.test.ts
git commit -m "feat(server): GET /v1/doctor/gateway + sidebar diagnostics card"
```

---

## Task 10: Onboarding + docs — README, ANTHROPIC_GATEWAY.md (EN + KR)

**Why:** Phase 1's framing-correctness is enforced by language. The docs must call this a *connection feature*, not a *savings feature*, and must point readers at Phase 2 for savings.

**Files:**
- Create: `docs/ANTHROPIC_GATEWAY.md`
- Create: `docs/ANTHROPIC_GATEWAY.ko.md`
- Modify: `README.md` — one paragraph + link to the new doc

- [ ] **Step 1: Write `docs/ANTHROPIC_GATEWAY.md`**

Create with the following content (substitute repository-specific paths if needed):

```markdown
# Anthropic Gateway (Phase 1 — connection)

Tierkit can run as a transparent gateway in front of Anthropic's Messages API.
Point Claude Code at the Tierkit daemon and your requests flow through Tierkit
before reaching `api.anthropic.com`.

**Phase 1 is a connection feature.** It does NOT compress payloads, deduplicate
reads, redact secrets, or measure savings. Those land in Phase 2 along with the
`tool_result` envelope, cursor pagination for truncated reads, and dedupe.

## Enable

1. Open the Tierkit sidebar.
2. Toggle **Route Claude Code through Tierkit**. This sets
   `runtime.gatewayMode: "on"` in `tierkit.config.json` and restarts the daemon.
3. Click **Launch Claude Code through Tierkit**. A new integrated terminal opens
   with `ANTHROPIC_BASE_URL` set to the daemon for that terminal only — your
   shell profile is never modified.

## Verify

From a terminal in your project:

```bash
tierkit doctor gateway
```

You should see `OK` rows for `runtime.gatewayMode`, `daemon @ http://127.0.0.1:4101`,
`/v1/messages`, `safe gateway log`, and (if installed) `claude (Claude Code CLI)`.

## Safe log

When the gateway is on, the daemon writes a per-request log to
`.tierkit/runtime/anthropic-gateway.jsonl`. The log NEVER contains:
- request body or response body
- raw `Authorization` or `x-api-key` headers
- `system` prompt or `messages[]`
- `tool_result` content

It contains only: timestamp, path, stream flag, upstream status, duration,
and a 12-char fingerprint of the auth header. The file rotates at 5 MB OR
7 days, whichever comes first.

## Direct fallback

If the daemon is unreachable when you click **Launch Claude Code through Tierkit**,
the extension first tries to restart it. If that fails too, it offers a one-click
**Launch direct** terminal that bypasses the gateway entirely. Direct mode never
mutates your shell profile either.

## Out of scope for Phase 1

- Request/response transformation
- Token-savings measurement
- Compression / dedupe / redaction
- Local-LLM routing

Phase 2 will introduce these on top of this connection substrate.
```

- [ ] **Step 2: Write `docs/ANTHROPIC_GATEWAY.ko.md`**

Korean translation following the same structure:

```markdown
# Anthropic Gateway (Phase 1 — 연결)

Tierkit는 Anthropic Messages API 앞에 투명한 게이트웨이로 동작할 수 있습니다.
Claude Code를 Tierkit 데몬으로 가리키면, 모든 요청이 `api.anthropic.com`에 도달
하기 전에 Tierkit를 거칩니다.

**Phase 1은 연결 기능입니다.** 페이로드를 압축하거나, 중복 read를 제거하거나,
시크릿을 마스킹하거나, 절감량을 측정하지 않습니다. 그 기능들은 `tool_result`
envelope, 잘림 read를 위한 cursor pagination, dedupe와 함께 Phase 2에서 제공
됩니다.

## 활성화

1. Tierkit 사이드바를 엽니다.
2. **Route Claude Code through Tierkit** 토글을 켭니다. `tierkit.config.json`의
   `runtime.gatewayMode`가 `"on"`으로 바뀌고 데몬이 재시작됩니다.
3. **Launch Claude Code through Tierkit** 버튼을 누릅니다. 새 integrated terminal
   에서 `ANTHROPIC_BASE_URL`이 해당 터미널에만 주입되어 Claude Code가 실행됩니다.
   사용자의 shell profile은 절대 수정되지 않습니다.

## 점검

프로젝트 터미널에서:

```bash
tierkit doctor gateway
```

`runtime.gatewayMode`, `daemon @ http://127.0.0.1:4101`, `/v1/messages`,
`safe gateway log`, 그리고 설치되어 있다면 `claude (Claude Code CLI)`까지 `OK`
로 표시되어야 합니다.

## 안전 로그

게이트웨이가 켜져 있을 때, 데몬은 `.tierkit/runtime/anthropic-gateway.jsonl`에
요청 단위 로그를 남깁니다. 로그에는 **절대** 포함되지 않습니다:
- 요청·응답 본문
- `Authorization`·`x-api-key` 원문
- `system` 프롬프트, `messages[]`
- `tool_result` 내용

기록되는 것은 timestamp, path, stream 여부, 업스트림 상태 코드, 처리 시간, auth
헤더의 12자 fingerprint뿐입니다. 5 MB 또는 7일 중 먼저 도달하는 조건으로 회전
합니다.

## Direct fallback

**Launch Claude Code through Tierkit**를 눌렀을 때 데몬이 닿지 않으면 확장 프로
그램이 먼저 데몬 재시작을 시도합니다. 그래도 실패하면 게이트웨이를 우회하는
**Launch direct** 버튼을 제공합니다. Direct 모드 역시 shell profile을 수정하지
않습니다.

## Phase 1에서 제공하지 않는 것

- 요청·응답 변환
- 토큰 절감량 측정
- 압축 / dedupe / redaction
- 로컬 LLM 라우팅

이 기능들은 이 연결 기반 위에서 Phase 2에 도입됩니다.
```

- [ ] **Step 3: Update README.md**

Find the existing Features section (look for `## Features` or similar) and add one bullet:

```markdown
- **Anthropic Gateway (Phase 1 — connection)** — route Claude Code's
  `/v1/messages` traffic through the Tierkit daemon with a one-click sidebar
  toggle and a scoped integrated-terminal launcher. See
  [docs/ANTHROPIC_GATEWAY.md](docs/ANTHROPIC_GATEWAY.md). Phase 1 is a
  connection feature; compression and savings arrive in Phase 2.
```

- [ ] **Step 4: Commit**

```bash
git add docs/ANTHROPIC_GATEWAY.md docs/ANTHROPIC_GATEWAY.ko.md README.md
git commit -m "docs: Anthropic Gateway Phase 1 — EN+KR, framing-correct"
```

---

## Task 11: Final integration pass + Phase 2 entry-gate note

**Why:** After every individual task is green, run the full repo build/test to catch cross-package fallout, then leave a single source-of-truth note for Phase 2's gate.

- [ ] **Step 1: Full clean build**

```bash
pnpm -r clean || true
pnpm install --frozen-lockfile
pnpm -r build
```
Expected: all packages compile.

- [ ] **Step 2: Full test run**

```bash
pnpm -r test
```
Expected: all tests pass.

- [ ] **Step 3: Run the public smoke flow end-to-end**

Walk through `docs/ANTHROPIC_GATEWAY.md` from a fresh checkout (or `git stash` + clean shell). Confirm:
- Sidebar toggle flips config and restarts daemon.
- Launch button opens a terminal with `ANTHROPIC_BASE_URL` set, `ANTHROPIC_API_KEY` unset.
- `claude` runs and returns an answer.
- `tierkit doctor gateway` reports all `OK`.
- `.tierkit/runtime/anthropic-gateway.jsonl` exists; `cat` it and confirm NO raw token, NO body.
- Kill daemon mid-session, click launch button — fallback dialog appears.

- [ ] **Step 4: Add the Phase 2 entry-gate note**

Append to `docs/RFC-anthropic-gateway.md` (the Phase 0 RFC), in a new section at the bottom:

```markdown
## Phase 2 entry gate (added during Phase 1)

Phase 2 (compression, savings, transformation) MUST NOT begin until:

1. Phase 1 has dogfood for ≥ 1 week with `tierkit doctor gateway` reporting `ok`
   across all checks on a real workstation.
2. The per-request safe log shows zero crashes / unexpected statuses in the
   trailing 7 days (`jq 'select(.status >= 500)' .tierkit/runtime/anthropic-gateway.jsonl | wc -l == 0`).
3. The Direct fallback flow has been triggered at least once and resolved cleanly.

Phase 2 design constraint inherited from Phase 1:
- The body-transformation hook lands inside `forwardMessages` / `streamMessages`
  in `anthropicGateway.ts`. Any compression / dedupe / redaction work happens
  there — Phase 1's `Server.ts` route plumbing does not change. This keeps the
  transformation testable in isolation from the route layer.
```

- [ ] **Step 5: Commit + open the Phase 1 PR**

```bash
git add docs/RFC-anthropic-gateway.md
git commit -m "docs(rfc): add Phase 2 entry-gate criteria"
git push -u origin worktree-anthropic-gateway-phase1
gh pr create --title "feat: Anthropic Gateway Phase 1 — passthrough productization" --body "$(cat <<'EOF'
## Summary

Phase 1 of the Anthropic Gateway: productize the Phase 0 passthrough as a
safe, observable connection feature.

- New: `runtime.gatewayMode` config (off | on, default off)
- New: safe per-request log at \`.tierkit/runtime/anthropic-gateway.jsonl\` with 5 MB / 7-day rotation
- New: \`tierkit doctor gateway\` CLI
- New: sidebar **Route Claude Code through Tierkit** toggle
- New: **Launch Claude Code through Tierkit** integrated-terminal button (scoped env, no shell-profile mutation)
- New: Direct fallback dialog when daemon unreachable
- New: \`docs/ANTHROPIC_GATEWAY.md\` + Korean version

## NOT in this PR

Compression, dedupe, redaction, tool_result envelope, cursor pagination, and
all token-savings measurement / claims. Those are Phase 2 (see updated RFC).

## Builds on

Draft PR #1 (Phase 0 spike). This branch merged it as Task 0.

## Test plan

- [ ] \`pnpm -r build && pnpm -r test\` green
- [ ] \`tierkit doctor gateway\` reports OK on a configured workstation
- [ ] Sidebar toggle flips config and restarts daemon
- [ ] Launch button opens terminal with correct env
- [ ] Safe log written; no raw token visible
- [ ] Direct fallback triggers when daemon is down

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist (run by the human or executor before declaring "done")

**Spec coverage:** Every item in the RFC Phase 1 scope sketch (§3 of `docs/RFC-anthropic-gateway.md`) is implemented:

| RFC item | Task |
|---|---|
| 1. Setting + sidebar toggle | Task 1 + Task 6 |
| 2. Scoped env injection only | Task 7 |
| 3. Per-request safe log + rotation | Tasks 2 + 3 |
| 4. Auto-heal + Direct fallback | Task 8 |
| 5. Onboarding card | Task 10 (README + docs) + Task 9 (sidebar card) |
| 6. \`tierkit doctor gateway\` | Tasks 4 + 5 + 9 |
| 7. README + UI language (EN + KR) | Task 10 |
| 8. Phase 2 entry gate | Task 11 |

**Language audit:** grep the whole diff for the words "savings", "saves", "절감". Expected: zero hits in any user-facing string. (Allowed in code comments only when referring to Phase 2.)

**Body-redaction audit:** grep the whole diff for any code path that writes `body`, `messages`, `system`, `tool_result`, `Authorization` raw, or `x-api-key` raw to disk or to a log. Expected: zero hits (the safe log writer's `z.strict()` schema enforces this at runtime too).

**Phase boundary:** confirm no compression / transformation / dedupe / cursor pagination / savings code landed. If any did, move it to a Phase 2 branch.

---

## Execution handoff

This plan is complete and ready to execute. Two options:

1. **Subagent-Driven (recommended)** — REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Fresh subagent per task, two-stage review between tasks, fast iteration.

2. **Inline Execution** — REQUIRED SUB-SKILL: `superpowers:executing-plans`. Batch execution in this session with review checkpoints.
