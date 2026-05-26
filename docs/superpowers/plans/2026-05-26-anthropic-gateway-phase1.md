# Anthropic Gateway Phase 1 Implementation Plan (rev3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize the Phase 0 Anthropic-passthrough as a safe connection feature in Tierkit — config flag, scoped terminal launch, on-daemon status endpoint, local-only diagnostics, safe per-request log with value-constrained rotation, sidebar toggle, daemon auto-restart pre-flight, and explicit direct fallback. The gateway routes Claude Code's Messages API traffic through the local daemon without modifying message content.

**Architecture:** Layer config + UX + safe logging + local-only status/diagnostic endpoints on top of the validated Phase 0 passthrough (`packages/core/src/runtime/anthropicGateway.ts` and two routes in `Server.ts`). Diagnostics and readiness checks use a new local-only `GET /v1/gateway/status` endpoint — they never invoke the upstream Anthropic API. Request log is value-constrained by zod (regex / enum / datetime) so caller mistakes can neither leak secrets nor produce oversized records. All gateway control endpoints reject non-loopback callers.

**Tech Stack:**
- Backend: TypeScript, Node 20+, plain `http` (existing `Server.ts`), `fetch()` (already in spike)
- Config: zod (existing schema layer)
- CLI: `clipanion` (existing pattern in `packages/cli/src/commands/`)
- VS Code extension: `vscode` API, no new build deps
- Tests: vitest

---

## Mandatory corrections before implementation

The following corrections override conflicting snippets elsewhere in this plan. They are the result of rev2's code review. Each task below is already aligned with them; this section is the executive summary the executor verifies against.

1. **Safe log shape is value-constrained.** `GatewayLogRecordSchema` MUST constrain values, not just types:
   - `path` to `z.enum(["/v1/messages", "/v1/messages/count_tokens"])`
   - `authorizationScheme` to `z.enum(["Bearer"]).nullable()`
   - `authorizationFingerprint` and `apiKeyFingerprint` to `z.string().regex(/^[0-9a-f]{12}$/).nullable()`
   - `ts` to `z.string().datetime()`
   Missing auth fields MUST fail validation; do not silently default `apiKeyPresent` to `false`.

2. **Input is unknown.** `appendGatewayLog()` MUST accept `unknown` and perform runtime allowlist projection. The public type does not require callers to already satisfy `GatewayLogRecord`.

3. **Local-only enforcement.** `GET /v1/gateway/status`, `PATCH /v1/config/runtime`, and `GET /v1/doctor/gateway` MUST reject non-loopback requests with HTTP 403. A pure helper `isLoopbackRemoteAddress(addr)` covers `127.0.0.1`, `::1`, `::ffff:127.0.0.1` and is unit-tested.

4. **Canonical dataDir resolver.** A single helper `resolveRuntimeDataDir(dataDir, cwd)` returns an absolute path. Status, log writer, and doctor MUST use the same resolved directory.

5. **No real upstream in tests.** No Phase 1 automated test may call `api.anthropic.com` or depend on external network. All `/v1/messages*` tests set `TIERKIT_ANTHROPIC_UPSTREAM` to a mock server URL (Phase 0 already supports this via `anthropicGateway.upstreamUrl`).

6. **Deterministic logging contract.**
   - Non-stream: `await logFinal(status)` runs **before** `res.end(body)`.
   - Stream: log is awaited **after** `streamMessages()` resolves; no fire-and-forget writes.
   - Stronger pre-client-completion guarantees for streaming require modifying `anthropicGateway.ts` and are **out of Phase 1 scope** (preserves the Phase 0 untouched principle).

7. **Transport errors log as 502.** When the route returns HTTP 502 to the client, the log MUST record `status: 502` (not `-1`). The data shown to users and the data persisted match.

8. **PATCH validates the full result.** `PATCH /v1/config/runtime` parses the mutated full config through `TierkitConfigSchema.parse()` before atomically persisting. Atomic write = `writeFile(tmp)` then `rename(tmp, cfgPath)`.

9. **Ordinary `tierkit doctor` is NOT touched.** Gateway diagnostics are opt-in via `tierkit doctor gateway` and `GET /v1/doctor/gateway`. `packages/core/src/usecases/doctor.ts` is NOT modified.

10. **Public core export.** `doctorGateway` (and its public types) MUST be exported from `packages/core/src/index.ts` — the CLI imports it via `@tierkit/core`.

11. **Diff-based language audit.** Audit only NEW user-facing strings added in Phase 1. Whole-file grep is wrong because the existing Tierkit UI already mentions cost/savings for unrelated pre-Phase-1 features (`packages/core/src/runtime/tierkitSavings.ts`, etc.). Forbidden tokens: `\bsavings\b`, `\bsave\b`, `\bsaves\b`, `\bsaved\b`, `\bcost\b`, `\bcheaper\b`, `\befficient\b`, `절감`, `절약`, `비용`, `효율`.

12. **No unconditional `acquireVsCodeApi()` in gui.ts.** `gui.ts` is served at both `http://127.0.0.1:<port>/` (browser) and inside the VS Code webview. Before adding the toggle card, inspect the existing command-dispatch bridge and reuse it. Do not break the browser-served daemon page.

---

## Context — read these first

1. **Phase 0 spike code is already in this branch.** Phase 1 branch is **stacked** on top of `worktree-anthropic-gateway-spike` (Draft PR #1). Verify with `git log --oneline main..HEAD` — the Phase 0 commit series (`feat(core): anthropicGateway header picker for Anthropic proxy spike` through `docs(spike): fix Phase 1 framing`) is reachable from HEAD. Phase 1 PR base = spike branch until Phase 0 merges.

2. **Files this plan reuses:**
   - `packages/core/src/runtime/anthropicGateway.ts` — `forwardMessages`, `streamMessages`, `forwardCountTokens`, `pickForwardHeaders`, `observeAuthHeaders`, plus an `upstreamUrl()` override via `TIERKIT_ANTHROPIC_UPSTREAM` env (Phase 1 tests rely on this).
   - `packages/core/src/runtime/Server.ts` — `POST /v1/messages` / `POST /v1/messages/count_tokens` already wired unconditionally.
   - `packages/core/src/runtime/usageLog.ts` — JSONL pattern (not the size policy — Phase 1 uses 5 MB / 7 days).
   - `packages/core/src/config/TierkitConfig.ts` — zod schema layering.
   - `packages/core/src/usecases/doctor.ts` — `DoctorCheck` type (re-used, not modified — see correction 9).
   - `packages/cli/src/commands/DoctorCommand.ts` — clipanion command pattern.
   - `packages/vscode-tierkit/src/extension.ts` — `maybeStartDaemon` (line 399), `registerCommand` block (line 834+), sidebar webview's `onDidReceiveMessage` (line 572-603), main-panel webview's equivalent (line 279-299).

3. **Phase 0 RFC** (`docs/RFC-anthropic-gateway.md`): all four validations (A, B-1, B-2, C) passed.

---

## What this plan does NOT do (and why)

| Excluded | Why deferred |
|---|---|
| Request / response body transformation | Lives in Phase 2 inside `anthropicGateway.ts`. |
| Compression / dedupe / cursor pagination | Schema design not finalized; effect must be measured before claimed. |
| Secret redaction at the body level | Body is untouched in Phase 1. |
| Per-call effectiveness numbers in the UI | No measurement = no claim. |
| `~/.zshrc` or any persistent shell profile mutation | Too invasive; impossible to reliably reverse. |
| Forcing or removing the user's Anthropic credential | The user's auth choice is preserved. |
| `POST /v1/models` discovery via gateway | Already gated by `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. |
| Local-LLM provider routing | Phase 3. |
| OAuth admin endpoints | Hardcoded to api.anthropic.com by Claude Code. |
| Strengthening streaming logging completion guarantee | Requires changing `anthropicGateway.ts`; deferred (see correction 6). |
| Integrating gateway checks into ordinary `tierkit doctor` | Opt-in via `tierkit doctor gateway` only (see correction 9). |

### User-facing language audit rule

Phase 1 user-facing strings (any string that lands in: `README.md`, `docs/ANTHROPIC_GATEWAY*.md`, sidebar HTML in `gui.ts` (only the **newly added** card text), `package.json::contributes`, `package.nls*.json`, VS Code dialog text, CLI command `description`/`details`) **must not contain any of**:

- `\bsavings\b`, `\bsave\b`, `\bsaves\b`, `\bsaved\b`
- `\bcost\b`, `\bcheaper\b`, `\befficient\b`
- `절감`, `절약`, `비용`, `효율`
- numeric token-count claims or percentages

The audit is **diff-based** (see Task 12) — pre-existing UI strings for unrelated features (`tierkitSavings.ts`, `savingsBroadcaster.ts`, the Cost Control sidebar) are not audited.

**Preferred Phase 1 vocabulary**: route, connection, passthrough, diagnostic, status, 연결, 라우팅, 진단.

---

## File Structure

**New files:**
- `packages/core/src/runtime/gatewayLog.ts` — allowlist-projection safe writer + queue + value-constrained schema + rotation
- `packages/core/test/gatewayLog.test.ts` — shape, rotation, queue, oversized rejection
- `packages/core/test/gatewayLog.redaction.test.ts` — proves no body / no raw credential / no malformed fingerprint reaches disk
- `packages/core/src/runtime/gatewayStatus.ts` — pure function building the local status response
- `packages/core/test/gatewayStatus.test.ts`
- `packages/core/src/runtime/loopback.ts` — `isLoopbackRemoteAddress` pure helper
- `packages/core/test/loopback.test.ts`
- `packages/core/src/runtime/runtimePaths.ts` — `resolveRuntimeDataDir` pure helper
- `packages/core/test/runtimePaths.test.ts`
- `packages/core/src/usecases/doctorGateway.ts` — cross-platform local-only diagnostic
- `packages/core/test/doctorGateway.test.ts`
- `packages/cli/src/commands/DoctorGatewayCommand.ts`
- `packages/cli/test/doctorGatewayCommand.test.ts`
- `packages/vscode-tierkit/src/gatewayLaunch.ts` — env builder + terminal helpers (preserves auth env)
- `packages/vscode-tierkit/test/gatewayLaunch.test.ts`
- `packages/vscode-tierkit/src/webviewCommandAllowlist.ts` — pure allowlist for `tk:cmd`
- `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts`
- `packages/vscode-tierkit/test/MANUAL_gateway_flows.md`
- `docs/ANTHROPIC_GATEWAY.md` + `docs/ANTHROPIC_GATEWAY.ko.md`

**Modified files:**
- `packages/core/src/config/TierkitConfig.ts` — add `gatewayMode: "off" | "on"` (default `"off"`)
- `packages/core/src/runtime/Server.ts` — gate spike routes on `gatewayMode`; non-stream `await logFinal` BEFORE `res.end`; add loopback-guarded `GET /v1/gateway/status`, `PATCH /v1/config/runtime`, `GET /v1/doctor/gateway`; all routes use `resolveRuntimeDataDir`
- `packages/core/src/index.ts` — public-export `doctorGateway` + related types
- `packages/cli/src/cli.ts` — register `DoctorGatewayCommand`
- `packages/vscode-tierkit/src/extension.ts` — register `tierkit.toggleGatewayMode` + `tierkit.launchClaudeCodeWithGateway`; add `tk:cmd` allowlist handler at both `onDidReceiveMessage` sites
- `packages/vscode-tierkit/package.json` — add the two commands; **no `tierkit.gatewayMode` configuration property**
- `packages/vscode-tierkit/package.nls.json` + `package.nls.ko.json` — strings
- `packages/core/src/runtime/ui/gui.ts` — sidebar toggle row + diagnostics card (uses the existing command-dispatch bridge — do not call `acquireVsCodeApi()` unconditionally)
- `README.md` — one paragraph + link

**Untouched:**
- `packages/core/src/runtime/anthropicGateway.ts` — Phase 0 code is API-stable for Phase 1 (see correction 6).
- `packages/core/src/usecases/doctor.ts` — gateway checks are opt-in (see correction 9).

---

## Task order

| Order | Task | Reason |
|---|---|---|
| 0 | Branch verification | spike commits must be present |
| 1 | `gatewayMode` schema | foundation |
| 2 | `gatewayLog` (value-constrained schema + unknown input + queue + rotation + oversized rejection) | safety primitive |
| 3 | `isLoopbackRemoteAddress` + `resolveRuntimeDataDir` helpers | both used by every endpoint and the writer |
| 4 | `GET /v1/gateway/status` (loopback-guarded) | used by Task 6 diagnostic AND Task 9 launch readiness |
| 5 | Route gate + deterministic safe-log wiring (mock upstream) | uses Tasks 1, 2, 3 |
| 6 | `doctorGateway` usecase (local-only, cross-platform) + core export | uses Task 4 |
| 7 | `tierkit doctor gateway` CLI | wraps Task 6 |
| 8 | Sidebar toggle — single SoT, loopback-guarded PATCH, schema-validated persist | uses Task 1; PATCH lives in Server.ts |
| 9 | Scoped terminal launch (preserves auth env, status-aware pre-flight) | uses Task 4 |
| 10 | Manual test plan for launch + fallback flows | wraps Task 9 |
| 11 | `GET /v1/doctor/gateway` (loopback-guarded) + sidebar diagnostics card | uses Task 6 |
| 12 | Docs (EN + KR) — accurate fingerprint description | last so it reflects final UX |
| 13 | Full regression + diff-based language audit + Phase 2 entry-gate note | final pass |

---

## Task 0: Verify branch state

- [ ] **Step 1: Confirm working tree clean and on the right branch**

```bash
git status
git branch --show-current
```
Expected: clean, on `worktree-anthropic-gateway-phase1`.

- [ ] **Step 2: Confirm spike commits are reachable + files present**

```bash
git log --oneline main..HEAD | grep -E "anthropicGateway|RFC|streamMessages|forwardMessages" | wc -l
ls packages/core/src/runtime/anthropicGateway.ts \
   packages/core/test/anthropicGateway.test.ts \
   packages/core/test/Server.anthropicGateway.test.ts \
   docs/RFC-anthropic-gateway.md
```
Expected: at least four matching commits; all four files present. Do not assert an exact commit count — the preserved Phase 0 series is the contract.

- [ ] **Step 3: Build + baseline tests**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @tierkit/core test -- anthropicGateway Server.anthropicGateway
```
Expected: all packages build; spike tests pass.

- [ ] **Step 4: No commit.**

---

## Task 1: Add `gatewayMode` to runtime config schema

**Files:**
- Modify: `packages/core/src/config/TierkitConfig.ts`
- Create: `packages/core/test/configGatewayMode.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// packages/core/test/configGatewayMode.test.ts
import { describe, it, expect } from "vitest";
import { TierkitConfigSchema } from "../src/config/TierkitConfig.js";

describe("RuntimeConfigSchema.gatewayMode", () => {
  it("defaults to 'off'", () => {
    expect(TierkitConfigSchema.parse({ version: "0.1" }).runtime.gatewayMode).toBe("off");
  });
  it("accepts 'on' and 'off'", () => {
    expect(TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "on" } }).runtime.gatewayMode).toBe("on");
    expect(TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "off" } }).runtime.gatewayMode).toBe("off");
  });
  it("rejects unknown values", () => {
    expect(() => TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "auto" } })).toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @tierkit/core test -- configGatewayMode
```

- [ ] **Step 3: Implement**

In `packages/core/src/config/TierkitConfig.ts`, inside `RuntimeConfigSchema.object({...})` (after `discoverOllamaModels`), add:

```typescript
    /**
     * Anthropic Gateway flag. When "on", the daemon serves /v1/messages and
     * /v1/messages/count_tokens as a transparent passthrough so Claude Code
     * can be pointed at it via ANTHROPIC_BASE_URL. Default "off".
     *
     * This flag does NOT enable any request/response transformation. The
     * proxy forwards bodies byte-faithfully.
     */
    gatewayMode: z.enum(["off", "on"]).default("off"),
```

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @tierkit/core test -- configGatewayMode
pnpm --filter @tierkit/core test -- config
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/TierkitConfig.ts packages/core/test/configGatewayMode.test.ts
git commit -m "feat(core): runtime.gatewayMode config field (off|on, default off)"
```

---

## Task 2: Safe gateway log writer (value-constrained schema + unknown input + queue + rotation + oversized rejection)

**Why:** Phase 1's hard rule — even within allowlisted fields, only well-shaped values are persisted. A regex on fingerprints means a secret accidentally placed there fails closed. An enum on `path` and `authorizationScheme` bounds the maximum line length so the rotation post-condition (`size ≤ cap`) is structurally guaranteed.

### Design

- **`appendGatewayLog(filePath, input: unknown, opts?)`** — public signature is `unknown`. The function performs runtime allowlist projection.
- **Value constraints (correction 1):**
  - `ts: z.string().datetime()`
  - `path: z.enum(["/v1/messages", "/v1/messages/count_tokens"])`
  - `stream: z.boolean()`
  - `status: z.number().int()` (integer, may be 4xx/5xx/etc.; bounded by HTTP semantics)
  - `durationMs: z.number().int().nonnegative()`
  - `auth.authorizationScheme: z.enum(["Bearer"]).nullable()`
  - `auth.authorizationFingerprint: z.string().regex(/^[0-9a-f]{12}$/).nullable()`
  - `auth.apiKeyPresent: z.boolean()` (**no default** — missing → throw)
  - `auth.apiKeyFingerprint: z.string().regex(/^[0-9a-f]{12}$/).nullable()`
- **Queue** — module-level `Promise` chain serializes all writes in this process.
- **Rotation order** — `append → maybeTrim`. Combined with bounded line size, the post-condition holds.
- **Byte guard** — defensive `Buffer.byteLength(line) > GATEWAY_LOG_MAX_BYTES` throws before write (belt-and-suspenders).

### Files

- Create: `packages/core/src/runtime/gatewayLog.ts`
- Create: `packages/core/test/gatewayLog.test.ts`
- Create: `packages/core/test/gatewayLog.redaction.test.ts`

- [ ] **Step 1: Failing redaction tests**

```typescript
// packages/core/test/gatewayLog.redaction.test.ts
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

describe("gatewayLog — redaction", () => {
  it("drops extra fields like authorizationRaw without throwing", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, { ...baseRecord(), authorizationRaw: SECRET_BEARER });
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain(SECRET_BEARER);
      expect(raw).not.toContain("authorizationRaw");
      expect(raw.trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a body field even when passed", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, { ...baseRecord(), body: { messages: [{ role: "user", content: "TOP_SECRET" }] } });
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain("TOP_SECRET");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects records missing required fields", async () => {
    const { file, dir } = await tmpFile();
    try {
      await expect(appendGatewayLog(file, { ts: "2026-05-26T12:00:00.000Z" })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a secret accidentally placed in authorizationScheme", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { ...baseRecord().auth, authorizationScheme: SECRET_BEARER } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed fingerprint (not 12 hex chars) instead of persisting it", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { ...baseRecord().auth, apiKeyFingerprint: SECRET_API_KEY } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a record where apiKeyPresent is missing (no silent defaulting)", async () => {
    const { file, dir } = await tmpFile();
    try {
      const evil = { ...baseRecord(), auth: { authorizationScheme: "Bearer", authorizationFingerprint: "abcdef123456", apiKeyFingerprint: null } };
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-object input", async () => {
    const { file, dir } = await tmpFile();
    try {
      await expect(appendGatewayLog(file, null)).rejects.toThrow();
      await expect(appendGatewayLog(file, "x")).rejects.toThrow();
      await expect(appendGatewayLog(file, 42)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify failures**

```bash
pnpm --filter @tierkit/core test -- gatewayLog.redaction
```

- [ ] **Step 3: Failing shape + rotation + concurrency + oversized tests**

```typescript
// packages/core/test/gatewayLog.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendGatewayLog,
  GATEWAY_LOG_MAX_BYTES,
  GATEWAY_LOG_MAX_AGE_DAYS,
} from "../src/runtime/gatewayLog.js";

function record(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-05-26T12:00:00.000Z",
    path: "/v1/messages",
    stream: false,
    status: 200,
    durationMs: 50,
    auth: {
      authorizationScheme: "Bearer",
      authorizationFingerprint: "abcdef123456",
      apiKeyPresent: false,
      apiKeyFingerprint: null,
    },
    ...overrides,
  };
}

async function tmpDir() {
  return mkdtemp(path.join(tmpdir(), "gw-log-"));
}

describe("gatewayLog — file shape", () => {
  it("creates the directory and appends one line per call", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "nested", "anthropic-gateway.jsonl");
      await appendGatewayLog(file, record());
      await appendGatewayLog(file, record({ status: 502 }));
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).status).toBe(200);
      expect(JSON.parse(lines[1]!).status).toBe(502);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gatewayLog — rotation", () => {
  it("trims to ≤ cap AFTER an append that pushes over the byte cap", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "anthropic-gateway.jsonl");
      const line = JSON.stringify(record({ durationMs: 1 })) + "\n";
      const linesToOverflow = Math.ceil((GATEWAY_LOG_MAX_BYTES + 100_000) / line.length);
      await writeFile(file, line.repeat(linesToOverflow));

      await appendGatewayLog(file, record({ status: 201 }));

      const s = await stat(file);
      expect(s.size).toBeLessThanOrEqual(GATEWAY_LOG_MAX_BYTES);

      const lines = (await readFile(file, "utf8")).trim().split("\n");
      expect(JSON.parse(lines.at(-1)!).status).toBe(201);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops entries older than the age cap", async () => {
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
      const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => l.ts)).toEqual([recentTs, now.toISOString()]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gatewayLog — concurrency", () => {
  it("serializes parallel appendGatewayLog calls deterministically", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "anthropic-gateway.jsonl");
      const N = 50;
      const calls = Array.from({ length: N }, (_, i) => appendGatewayLog(file, record({ status: 200 + i })));
      await Promise.all(calls);
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(N);
      for (const line of lines) JSON.parse(line);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gatewayLog — oversized guard", () => {
  it("schema rejects any structurally oversized record (path enum bounds length)", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "anthropic-gateway.jsonl");
      // The constrained schema makes a single record at most ~250 bytes; attempting
      // an arbitrary long string in `path` falls outside the enum.
      const evil = record({ path: "/v1/messages?" + "x".repeat(GATEWAY_LOG_MAX_BYTES) });
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 4: Verify failures**

```bash
pnpm --filter @tierkit/core test -- "gatewayLog "
```

- [ ] **Step 5: Implement `gatewayLog.ts`**

```typescript
// packages/core/src/runtime/gatewayLog.ts
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const GATEWAY_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const GATEWAY_LOG_MAX_AGE_DAYS = 7;

const FINGERPRINT_RE = /^[0-9a-f]{12}$/;

const GatewayAuthSchema = z
  .object({
    authorizationScheme: z.enum(["Bearer"]).nullable(),
    authorizationFingerprint: z.string().regex(FINGERPRINT_RE).nullable(),
    apiKeyPresent: z.boolean(),                                     // no default — missing must fail
    apiKeyFingerprint: z.string().regex(FINGERPRINT_RE).nullable(),
  })
  .strict();

const GatewayLogRecordSchema = z
  .object({
    ts: z.string().datetime(),
    path: z.enum(["/v1/messages", "/v1/messages/count_tokens"]),
    stream: z.boolean(),
    status: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    auth: GatewayAuthSchema,
  })
  .strict();

export type GatewayLogRecord = z.infer<typeof GatewayLogRecordSchema>;

export interface AppendGatewayLogOptions {
  /** Override clock for tests. */
  now?: Date;
}

function projectAndValidate(input: unknown): GatewayLogRecord {
  if (!input || typeof input !== "object") {
    throw new Error("gateway log input must be an object");
  }
  const r = input as Record<string, unknown>;
  const a = (r.auth && typeof r.auth === "object" ? r.auth : {}) as Record<string, unknown>;
  return GatewayLogRecordSchema.parse({
    ts: r.ts,
    path: r.path,
    stream: r.stream,
    status: r.status,
    durationMs: r.durationMs,
    auth: {
      authorizationScheme: a.authorizationScheme,
      authorizationFingerprint: a.authorizationFingerprint,
      apiKeyPresent: a.apiKeyPresent,
      apiKeyFingerprint: a.apiKeyFingerprint,
    },
  });
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Phase 1 safe per-request log. Public input type is `unknown` so callers
 * cannot "satisfy" the type by carrying extra fields — they would have to
 * run our sanitizer to type-check. The runtime allowlist projection drops
 * unknown keys; the value-constrained schema then rejects mis-shaped values
 * (e.g. a secret accidentally placed in `authorizationScheme`).
 */
export function appendGatewayLog(
  filePath: string,
  input: unknown,
  opts: AppendGatewayLogOptions = {},
): Promise<void> {
  // Validate synchronously so caller errors surface immediately.
  const record = projectAndValidate(input);

  const line = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(line, "utf8") > GATEWAY_LOG_MAX_BYTES) {
    // Defensive — schema constraints make this unreachable today, but a future
    // field expansion must not silently break the rotation post-condition.
    return Promise.reject(new Error("gateway log record exceeds maximum file size"));
  }

  const work = writeQueue.then(() => appendImpl(filePath, line, opts));
  writeQueue = work.catch(() => undefined);
  return work;
}

async function appendImpl(
  filePath: string,
  line: string,
  opts: AppendGatewayLogOptions,
): Promise<void> {
  const now = opts.now ?? new Date();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, "utf8");
  await maybeTrim(filePath, now);
}

function ageCutoffMs(now: Date): number {
  return now.getTime() - GATEWAY_LOG_MAX_AGE_DAYS * 86_400_000;
}

async function maybeTrim(filePath: string, now: Date): Promise<void> {
  let needsTrim = false;
  try {
    const s = await fs.stat(filePath);
    if (s.size > GATEWAY_LOG_MAX_BYTES) needsTrim = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!needsTrim) {
    const fd = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      if (bytesRead > 0) {
        const nl = buf.indexOf(0x0a);
        if (nl > 0) {
          try {
            const parsed = JSON.parse(buf.subarray(0, nl).toString("utf8")) as { ts?: string };
            if (parsed.ts && new Date(parsed.ts).getTime() < ageCutoffMs(now)) needsTrim = true;
          } catch {
            needsTrim = true;
          }
        }
      }
    } finally {
      await fd.close();
    }
  }
  if (!needsTrim) return;

  const raw = await fs.readFile(filePath, "utf8");
  const cutoff = ageCutoffMs(now);
  const ageKept: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: string };
      if (parsed.ts && new Date(parsed.ts).getTime() >= cutoff) ageKept.push(line);
    } catch {
      // drop malformed
    }
  }
  const kept: string[] = [];
  let keptBytes = 0;
  for (let i = ageKept.length - 1; i >= 0; i--) {
    const sz = Buffer.byteLength(ageKept[i]!, "utf8") + 1;
    if (keptBytes + sz > GATEWAY_LOG_MAX_BYTES) break;     // no oversized escape hatch (schema bounds line size)
    kept.unshift(ageKept[i]!);
    keptBytes += sz;
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "");
  await fs.rename(tmp, filePath);
}

export function gatewayLogPath(dataDir: string): string {
  return path.join(dataDir, "anthropic-gateway.jsonl");
}
```

- [ ] **Step 6: Tests pass**

```bash
pnpm --filter @tierkit/core test -- gatewayLog
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/gatewayLog.ts \
        packages/core/test/gatewayLog.test.ts \
        packages/core/test/gatewayLog.redaction.test.ts
git commit -m "feat(core): gatewayLog — value-constrained schema, unknown input, queue"
```

---

## Task 3: `isLoopbackRemoteAddress` + `resolveRuntimeDataDir` helpers

**Why:** Both are pure functions used by every endpoint in this plan. Extract first so each subsequent task references one canonical implementation.

**Files:**
- Create: `packages/core/src/runtime/loopback.ts`
- Create: `packages/core/test/loopback.test.ts`
- Create: `packages/core/src/runtime/runtimePaths.ts`
- Create: `packages/core/test/runtimePaths.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
// packages/core/test/loopback.test.ts
import { describe, it, expect } from "vitest";
import { isLoopbackRemoteAddress } from "../src/runtime/loopback.js";

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
```

```typescript
// packages/core/test/runtimePaths.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveRuntimeDataDir } from "../src/runtime/runtimePaths.js";

describe("resolveRuntimeDataDir", () => {
  it("returns absolute paths unchanged", () => {
    expect(resolveRuntimeDataDir("/var/lib/tierkit", "/anywhere")).toBe("/var/lib/tierkit");
  });
  it("resolves relative paths against cwd", () => {
    expect(resolveRuntimeDataDir(".tierkit/runtime", "/work/proj")).toBe(path.resolve("/work/proj", ".tierkit/runtime"));
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @tierkit/core test -- "loopback|runtimePaths"
```

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/runtime/loopback.ts
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export function isLoopbackRemoteAddress(addr: string | undefined): boolean {
  return typeof addr === "string" && LOOPBACK.has(addr);
}
```

```typescript
// packages/core/src/runtime/runtimePaths.ts
import path from "node:path";
export function resolveRuntimeDataDir(dataDir: string, cwd: string): string {
  return path.isAbsolute(dataDir) ? dataDir : path.resolve(cwd, dataDir);
}
```

- [ ] **Step 4: Tests pass + commit**

```bash
pnpm --filter @tierkit/core test -- "loopback|runtimePaths"
git add packages/core/src/runtime/loopback.ts packages/core/src/runtime/runtimePaths.ts \
        packages/core/test/loopback.test.ts packages/core/test/runtimePaths.test.ts
git commit -m "feat(core): isLoopbackRemoteAddress + resolveRuntimeDataDir helpers"
```

---

## Task 4: `GET /v1/gateway/status` — local-only status endpoint

**Why:** Both `doctorGateway` (Task 6) and the launch readiness check (Task 9) need to know "is the gateway armed?" without invoking upstream Anthropic. Loopback-guarded so a daemon bound to a non-loopback host cannot leak its status to the network.

**Response shape:**

```json
{
  "gatewayMode": "on" | "off",
  "routesEnabled": true | false,
  "messagesPath": "/v1/messages",
  "countTokensPath": "/v1/messages/count_tokens",
  "logPath": "<absolute path>"
}
```

- `routesEnabled === (gatewayMode === "on")`. Same value today; gives Phase 2 room to diverge (e.g. emergency disable).
- `logPath` uses `resolveRuntimeDataDir` so it matches what the safe-log writer actually uses.

**Files:**
- Create: `packages/core/src/runtime/gatewayStatus.ts`
- Create: `packages/core/test/gatewayStatus.test.ts`
- Modify: `packages/core/src/runtime/Server.ts`
- Create: `packages/core/test/Server.gatewayStatus.test.ts`

- [ ] **Step 1: Failing pure-function test**

```typescript
// packages/core/test/gatewayStatus.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildGatewayStatus } from "../src/runtime/gatewayStatus.js";

describe("buildGatewayStatus", () => {
  it("reports routesEnabled=true when gatewayMode is on", () => {
    expect(buildGatewayStatus({ gatewayMode: "on", resolvedDataDir: "/tmp/data" })).toEqual({
      gatewayMode: "on",
      routesEnabled: true,
      messagesPath: "/v1/messages",
      countTokensPath: "/v1/messages/count_tokens",
      logPath: path.join("/tmp/data", "anthropic-gateway.jsonl"),
    });
  });
  it("reports routesEnabled=false when off", () => {
    expect(buildGatewayStatus({ gatewayMode: "off", resolvedDataDir: "/tmp/data" }).routesEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/core/src/runtime/gatewayStatus.ts
import { gatewayLogPath } from "./gatewayLog.js";

export interface GatewayStatusInput {
  gatewayMode: "off" | "on";
  /** ALREADY RESOLVED to absolute via resolveRuntimeDataDir. */
  resolvedDataDir: string;
}

export interface GatewayStatus {
  gatewayMode: "off" | "on";
  routesEnabled: boolean;
  messagesPath: string;
  countTokensPath: string;
  logPath: string;
}

export function buildGatewayStatus(input: GatewayStatusInput): GatewayStatus {
  return {
    gatewayMode: input.gatewayMode,
    routesEnabled: input.gatewayMode === "on",
    messagesPath: "/v1/messages",
    countTokensPath: "/v1/messages/count_tokens",
    logPath: gatewayLogPath(input.resolvedDataDir),
  };
}
```

- [ ] **Step 3: Failing endpoint test (verifies loopback + same logPath as writer)**

```typescript
// packages/core/test/Server.gatewayStatus.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/runtime/Server.js";

async function startWith(initial: object) {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-gw-status-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify(initial));
  const srv = await startServer({ port: 0, cwd: dir });
  return { srv, dir, url: `http://127.0.0.1:${srv.port}` };
}

describe("GET /v1/gateway/status", () => {
  it("returns routesEnabled=true when on", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const res = await fetch(`${url}/v1/gateway/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { gatewayMode: string; routesEnabled: boolean; logPath: string };
      expect(body.gatewayMode).toBe("on");
      expect(body.routesEnabled).toBe(true);
      expect(path.isAbsolute(body.logPath)).toBe(true);
      expect(body.logPath).toContain(dir);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns routesEnabled=false when off", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/gateway/status`);
      expect(((await res.json()) as { routesEnabled: boolean }).routesEnabled).toBe(false);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

(Non-loopback rejection is unit-tested via the `isLoopbackRemoteAddress` test in Task 3. End-to-end non-loopback testing is impractical with default test harness.)

- [ ] **Step 4: Add the route**

In `Server.ts`, add at the top:

```typescript
import { isLoopbackRemoteAddress } from "./loopback.js";
import { resolveRuntimeDataDir } from "./runtimePaths.js";
import { buildGatewayStatus } from "./gatewayStatus.js";
```

Inside the request handler:

```typescript
      if (route === "GET /v1/gateway/status") {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return sendJson(res, 403, { error: "local_only" });
        return sendJson(res, 200, buildGatewayStatus({
          gatewayMode: opts.config.runtime.gatewayMode,
          resolvedDataDir: resolveRuntimeDataDir(opts.config.runtime.dataDir, opts.cwd),
        }));
      }
```

- [ ] **Step 5: Tests pass + commit**

```bash
pnpm --filter @tierkit/core test -- "gatewayStatus|Server.gatewayStatus"
git add packages/core/src/runtime/gatewayStatus.ts \
        packages/core/test/gatewayStatus.test.ts \
        packages/core/test/Server.gatewayStatus.test.ts \
        packages/core/src/runtime/Server.ts
git commit -m "feat(core): GET /v1/gateway/status — local-only, uses resolved dataDir"
```

---

## Task 5: Route gate + deterministic safe-log wiring (mock upstream)

**Why:** Phase 0 routes are unconditional. Phase 1 gates them on `runtime.gatewayMode === "on"`, emits a safe log per request with the deterministic contract (correction 6), logs HTTP 502 as `status: 502` (correction 7), and uses the same resolved `dataDir` the status endpoint reports (correction 4). Tests use the mock upstream from `TIERKIT_ANTHROPIC_UPSTREAM` (correction 5).

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` — gate + log + use resolved dataDir
- Create: `packages/core/test/Server.gatewayMode.test.ts`

- [ ] **Step 1: Failing gate + log test (mock upstream)**

```typescript
// packages/core/test/Server.gatewayMode.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { startServer } from "../src/runtime/Server.js";

// Mock upstream — captures requests, returns canned responses.
let upstream: HttpServer;
let upstreamUrl: string;
let upstreamRequests: Array<{ method: string; path: string }>;

beforeAll(async () => {
  upstreamRequests = [];
  upstream = createServer((req, res) => {
    upstreamRequests.push({ method: req.method ?? "?", path: req.url ?? "?" });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true,"mock":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const addr = upstream.address();
  if (!addr || typeof addr !== "object") throw new Error("no mock addr");
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
  process.env.TIERKIT_ANTHROPIC_UPSTREAM = upstreamUrl;
});

afterAll(async () => {
  delete process.env.TIERKIT_ANTHROPIC_UPSTREAM;
  await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
});

async function startWith(gatewayMode: "off" | "on") {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-gw-mode-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1", runtime: { gatewayMode } }));
  const srv = await startServer({ port: 0, cwd: dir });
  return { srv, dir, url: `http://127.0.0.1:${srv.port}` };
}

describe("Server — gatewayMode gate", () => {
  it("returns 404 for /v1/messages when off", async () => {
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

  it("forwards to MOCK upstream when on (no real Anthropic call)", async () => {
    const before = upstreamRequests.length;
    const { srv, dir, url } = await startWith("on");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(upstreamRequests.length).toBe(before + 1);
      expect(upstreamRequests.at(-1)!.path).toBe("/v1/messages");
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Server — gateway safe log (deterministic)", () => {
  it("safe log is present IMMEDIATELY when the non-stream fetch resolves", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-test-NEVER-PERSISTED" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      // NO sleep — log must be written before res.end() per correction 6.
      const { resolveRuntimeDataDir } = await import("../src/runtime/runtimePaths.js");
      const { gatewayLogPath } = await import("../src/runtime/gatewayLog.js");
      const logPath = gatewayLogPath(resolveRuntimeDataDir(".tierkit/runtime", dir));
      const raw = await readFile(logPath, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(1);
      expect(raw).not.toContain("sk-test-NEVER-PERSISTED");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.path).toBe("/v1/messages");
      expect(parsed.status).toBe(200);
      expect(parsed.auth.apiKeyPresent).toBe(true);
      expect(parsed.auth.apiKeyFingerprint).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("when upstream fetch throws, logs status 502 (matches the HTTP response)", async () => {
    // Stop the mock upstream to force a transport error.
    process.env.TIERKIT_ANTHROPIC_UPSTREAM = "http://127.0.0.1:1"; // refused
    const { srv, dir, url } = await startWith("on");
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      expect(r.status).toBe(502);
      const { resolveRuntimeDataDir } = await import("../src/runtime/runtimePaths.js");
      const { gatewayLogPath } = await import("../src/runtime/gatewayLog.js");
      const raw = await readFile(gatewayLogPath(resolveRuntimeDataDir(".tierkit/runtime", dir)), "utf8");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.status).toBe(502);
    } finally {
      process.env.TIERKIT_ANTHROPIC_UPSTREAM = upstreamUrl;
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify failures**

```bash
pnpm --filter @tierkit/core test -- Server.gatewayMode
```

- [ ] **Step 3: Gate + log in `Server.ts`**

Top imports (if missing):

```typescript
import { appendGatewayLog, gatewayLogPath } from "./gatewayLog.js";
import { observeAuthHeaders } from "./anthropicGateway.js";
import { resolveRuntimeDataDir } from "./runtimePaths.js";
```

Replace the `/v1/messages` block:

```typescript
      if (route === "POST /v1/messages") {
        if (opts.config.runtime.gatewayMode !== "on") return sendJson(res, 404, { error: "not_found" });

        const startedAt = Date.now();
        const auth = observeAuthHeaders(req.headers);
        const body = await readRawBody(req);
        const wantsStream = isStreamingMessagesBody(body);
        const logPath = gatewayLogPath(resolveRuntimeDataDir(opts.config.runtime.dataDir, opts.cwd));

        const logFinal = async (status: number): Promise<void> => {
          const rec = {
            ts: new Date(startedAt).toISOString(),
            path: "/v1/messages",
            stream: wantsStream,
            status,
            durationMs: Date.now() - startedAt,
            auth: {
              authorizationScheme: auth.authorizationScheme,
              authorizationFingerprint: auth.authorizationFingerprint,
              apiKeyPresent: auth.hasApiKey,
              apiKeyFingerprint: auth.apiKeyFingerprint,
            },
          };
          try {
            await appendGatewayLog(logPath, rec);
          } catch (err) {
            console.error("[anthropic-gateway] log write failed:", (err as Error).message);
          }
        };

        try {
          if (wantsStream) {
            // Streaming completion boundary (correction 6): log after streamMessages resolves.
            await streamMessages(req, body, res);
            await logFinal(res.statusCode);
            return;
          }
          // Non-stream: log BEFORE res.end (correction 6) so the test that reads
          // the log immediately after fetch resolves is deterministic.
          const r = await forwardMessages(req, body);
          await logFinal(r.status);
          for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
          res.statusCode = r.status;
          res.end(r.body);
          return;
        } catch (err) {
          // Transport / upstream failure → 502 to the client AND 502 in the log (correction 7).
          await logFinal(502);
          if (res.headersSent) {
            res.destroy(err as Error);
            return;
          }
          return sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: (err as Error).message } });
        }
      }
```

Apply the same shape to `/v1/messages/count_tokens` with `stream: false`, `path: "/v1/messages/count_tokens"`, and no streaming branch.

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @tierkit/core test
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/Server.ts packages/core/test/Server.gatewayMode.test.ts
git commit -m "feat(core): gate /v1/messages; non-stream log-before-end; 502 logged as 502; mock upstream tests"
```

---

## Task 6: `doctorGateway` usecase (local-only, cross-platform) + core export

**Why:** A focused diagnostic that NEVER calls upstream Anthropic. Cross-platform via `path.isAbsolute` and `claude --version` (`shell: true` on win32 for `.cmd` shims). Public-exported from `@tierkit/core` so the CLI can import it (correction 10).

**Files:**
- Create: `packages/core/src/usecases/doctorGateway.ts`
- Create: `packages/core/test/doctorGateway.test.ts`
- Modify: `packages/core/src/index.ts` — add the export

- [ ] **Step 1: Failing test**

```typescript
// packages/core/test/doctorGateway.test.ts
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
  it("flags gatewayMode=off as warn", async () => {
    const dir = await projectWith({ version: "0.1" });
    try {
      const m = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-mode");
      expect(m?.status).toBe("warn");
      expect(m?.detail).toMatch(/gatewayMode/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports ok for gateway-mode when set to on", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      expect((await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-mode")?.status).toBe("ok");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports daemon unreachable when no daemon is running", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", port: 1 } });
    try {
      const d = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-daemon");
      expect(d?.status).toBe("fail");
      expect(d?.detail).toMatch(/unreachable|connect|refused/i);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports log path writable AND matches resolveRuntimeDataDir", async () => {
    const dataDir = path.join(await mkdtemp(path.join(tmpdir(), "tk-gw-dd-")), ".tierkit/runtime");
    await mkdir(dataDir, { recursive: true });
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", dataDir } });
    try {
      const log = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-log-path");
      expect(log?.status).toBe("ok");
      expect(log?.detail).toContain(dataDir);
      expect(log?.detail).toContain("anthropic-gateway.jsonl");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports claude binary presence as ok or warn (never fail)", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      expect((await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-claude-code")?.status).toMatch(/ok|warn/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports credential mode without echoing the value", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const cm = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-credential-mode");
      expect(cm?.status).toBe("ok");
      expect(cm?.detail).toMatch(/api-key|subscription|unknown/);
      if (process.env.ANTHROPIC_API_KEY) {
        expect(cm?.detail).not.toContain(process.env.ANTHROPIC_API_KEY);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @tierkit/core test -- doctorGateway
```

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/usecases/doctorGateway.ts
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loadConfig.js";
import type { DoctorCheck } from "./doctor.js";
import { gatewayLogPath } from "../runtime/gatewayLog.js";
import { resolveRuntimeDataDir } from "../runtime/runtimePaths.js";

export interface DoctorGatewayInput {
  cwd?: string;
}

export async function doctorGateway(input: DoctorGatewayInput = {}): Promise<DoctorCheck[]> {
  const cwd = input.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  const cfgResult = await loadConfig(cwd);
  const runtime = cfgResult.config.runtime;
  const baseUrl = `http://${runtime.host}:${runtime.port}`;
  const resolvedDataDir = resolveRuntimeDataDir(runtime.dataDir, cwd);

  // 1) gateway-mode
  if (runtime.gatewayMode === "on") {
    checks.push({ id: "gateway-mode", label: "runtime.gatewayMode", status: "ok", detail: "on" });
  } else {
    checks.push({
      id: "gateway-mode",
      label: "runtime.gatewayMode",
      status: "warn",
      detail: `gatewayMode is "off" (default). Toggle "Route Claude Code through Tierkit" in the sidebar, or set runtime.gatewayMode: "on" in tierkit.config.json.`,
    });
  }

  // 2-3) daemon + status (only when on)
  if (runtime.gatewayMode === "on") {
    const reach = await probeDaemon(baseUrl);
    if (reach.ok) {
      checks.push({ id: "gateway-daemon", label: `daemon @ ${baseUrl}`, status: "ok" });
      checks.push(await probeStatusEndpoint(baseUrl));
    } else {
      checks.push({ id: "gateway-daemon", label: `daemon @ ${baseUrl}`, status: "fail", detail: reach.detail });
    }
  }

  // 4) log path (uses the SAME resolver the writer and status endpoint use)
  checks.push(await checkLogWritable(resolvedDataDir));

  // 5) claude binary (cross-platform)
  checks.push(checkClaudeBinary());

  // 6) credential mode (presence only)
  checks.push(checkCredentialMode());

  return checks;
}

async function probeDaemon(baseUrl: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, detail: `daemon responded ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message}` };
  }
}

async function probeStatusEndpoint(baseUrl: string): Promise<DoctorCheck> {
  try {
    const res = await fetch(`${baseUrl}/v1/gateway/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { id: "gateway-routes", label: "/v1/gateway/status", status: "fail", detail: `status ${res.status}` };
    const body = (await res.json()) as { routesEnabled?: boolean; messagesPath?: string };
    if (body.routesEnabled !== true) {
      return { id: "gateway-routes", label: "routes", status: "fail", detail: `routesEnabled=${body.routesEnabled}` };
    }
    return { id: "gateway-routes", label: "routes", status: "ok", detail: body.messagesPath ?? "/v1/messages" };
  } catch (err) {
    return { id: "gateway-routes", label: "/v1/gateway/status", status: "fail", detail: (err as Error).message };
  }
}

async function checkLogWritable(resolvedDataDir: string): Promise<DoctorCheck> {
  const logPath = gatewayLogPath(resolvedDataDir);
  try {
    await fs.mkdir(resolvedDataDir, { recursive: true });
    const probe = `${logPath}.probe-${process.pid}`;
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
    return { id: "gateway-log-path", label: "safe gateway log", status: "ok", detail: logPath };
  } catch (err) {
    return { id: "gateway-log-path", label: "safe gateway log", status: "fail", detail: `${logPath} — ${(err as Error).message}` };
  }
}

function checkClaudeBinary(): DoctorCheck {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status === 0 && (r.stdout?.trim()?.length ?? 0) > 0) {
    return { id: "gateway-claude-code", label: "claude (Claude Code CLI)", status: "ok", detail: r.stdout.trim() };
  }
  return {
    id: "gateway-claude-code",
    label: "claude (Claude Code CLI)",
    status: "warn",
    detail: "not detected on PATH — install Claude Code, then re-run.",
  };
}

function checkCredentialMode(): DoctorCheck {
  const hasApiKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
  return {
    id: "gateway-credential-mode",
    label: "credential mode",
    status: "ok",
    detail: hasApiKey ? "api-key (ANTHROPIC_API_KEY is set)" : "subscription / unknown (no ANTHROPIC_API_KEY)",
  };
}
```

- [ ] **Step 4: Export from core barrel** (correction 10)

In `packages/core/src/index.ts`, alongside the existing `doctor` export, add:

```typescript
export { doctorGateway } from "./usecases/doctorGateway.js";
export type { DoctorGatewayInput } from "./usecases/doctorGateway.js";
```

- [ ] **Step 5: Tests pass + build the package**

```bash
pnpm --filter @tierkit/core test -- doctorGateway
pnpm --filter @tierkit/core build
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/usecases/doctorGateway.ts \
        packages/core/test/doctorGateway.test.ts \
        packages/core/src/index.ts
git commit -m "feat(core): doctorGateway — local-only diagnostic; public-exported"
```

---

## Task 7: `tierkit doctor gateway` CLI

**Files:**
- Create: `packages/cli/src/commands/DoctorGatewayCommand.ts`
- Create: `packages/cli/test/doctorGatewayCommand.test.ts`
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Failing test**

```typescript
// packages/cli/test/doctorGatewayCommand.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLI = path.resolve(__dirname, "../dist/cli.js");

describe("tierkit doctor gateway", () => {
  it("exits 0 with check lines when gatewayMode is off", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tk-cli-doctor-gw-"));
    try {
      await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1" }));
      const out = execFileSync("node", [CLI, "doctor", "gateway"], { cwd: dir, encoding: "utf8" });
      expect(out).toContain("runtime.gatewayMode");
      expect(out).toContain("safe gateway log");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("exits 1 when a hard failure occurs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tk-cli-doctor-gw-fail-"));
    try {
      await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1", runtime: { gatewayMode: "on", port: 1 } }));
      expect(() => execFileSync("node", [CLI, "doctor", "gateway"], { cwd: dir, encoding: "utf8" })).toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/cli/src/commands/DoctorGatewayCommand.ts
import { Command } from "clipanion";
import { doctorGateway } from "@tierkit/core";
import type { CliContext } from "../context/CliContext.js";

export class DoctorGatewayCommand extends Command<CliContext> {
  static override paths = [["doctor", "gateway"]];
  static override usage = Command.Usage({
    category: "Diagnostics",
    description: "Diagnose the Anthropic Gateway connection.",
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
    return checks.some((c) => c.status === "fail") ? 1 : 0;
  }
}
```

In `packages/cli/src/cli.ts`, register the command next to `DoctorCommand`.

- [ ] **Step 3: Build + test + commit**

```bash
pnpm --filter @tierkit/cli build
pnpm --filter @tierkit/cli test -- doctorGatewayCommand
git add packages/cli/src/commands/DoctorGatewayCommand.ts packages/cli/src/cli.ts packages/cli/test/doctorGatewayCommand.test.ts
git commit -m "feat(cli): tierkit doctor gateway"
```

---

## Task 8: Sidebar toggle — single source of truth, loopback-guarded PATCH, schema-validated persist

**Why:** Only one persistent state for `gatewayMode`: `tierkit.config.json::runtime.gatewayMode`. PATCH endpoint is loopback-guarded (correction 3), allowlists the field, and re-validates the full config through `TierkitConfigSchema` before writing (correction 8). The webview reuses `gui.ts`'s existing command-dispatch bridge (correction 12).

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` — add loopback-guarded `PATCH /v1/config/runtime`
- Create: `packages/core/test/Server.patchRuntime.test.ts`
- Modify: `packages/vscode-tierkit/src/extension.ts` — register `tierkit.toggleGatewayMode`
- Modify: `packages/vscode-tierkit/package.json` — command only (no configuration property)
- Modify: `packages/vscode-tierkit/package.nls.json` + `package.nls.ko.json`
- Create: `packages/vscode-tierkit/src/webviewCommandAllowlist.ts`
- Create: `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts`
- Modify: `packages/core/src/runtime/ui/gui.ts` — toggle row using EXISTING bridge

- [ ] **Step 1: Failing PATCH test**

```typescript
// packages/core/test/Server.patchRuntime.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/runtime/Server.js";

async function startWith(initial: object) {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-patch-runtime-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify(initial));
  const srv = await startServer({ port: 0, cwd: dir });
  return { srv, dir, url: `http://127.0.0.1:${srv.port}` };
}

describe("PATCH /v1/config/runtime", () => {
  it("flips gatewayMode and persists to tierkit.config.json", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayMode: "on" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { runtime: { gatewayMode: string } }).runtime.gatewayMode).toBe("on");
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.gatewayMode).toBe("on");
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects unknown fields (allowlist)", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: 9999 }),
      });
      expect(res.status).toBe(400);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects invalid gatewayMode values", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayMode: "auto" }),
      });
      expect(res.status).toBe(400);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("preserves other valid runtime fields when flipping gatewayMode", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1", runtime: { port: 4101, dataDir: ".custom/dd", host: "127.0.0.1" } });
    try {
      await fetch(`${url}/v1/config/runtime`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayMode: "on" }),
      });
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.dataDir).toBe(".custom/dd");
      expect(disk.runtime.port).toBe(4101);
      expect(disk.runtime.gatewayMode).toBe("on");
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Implement the route (schema-validated atomic write, loopback-guarded)**

In `Server.ts`:

```typescript
      if (route === "PATCH /v1/config/runtime") {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return sendJson(res, 403, { error: "local_only" });

        const body = await readJsonBody<{ gatewayMode?: "off" | "on" }>(req);
        const incoming = body ?? {};
        const allowedKeys = new Set(["gatewayMode"]);
        for (const k of Object.keys(incoming)) {
          if (!allowedKeys.has(k)) return sendJson(res, 400, { error: "unknown_field", field: k });
        }
        if (incoming.gatewayMode !== "off" && incoming.gatewayMode !== "on") {
          return sendJson(res, 400, { error: "invalid_gatewayMode" });
        }

        const cfgPath = path.join(opts.cwd, "tierkit.config.json");
        let current: Record<string, unknown> = { version: "0.1" };
        try {
          current = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, unknown>;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        const runtime = (current.runtime as Record<string, unknown> | undefined) ?? {};

        // Re-validate FULL resulting config through the canonical schema
        // before writing, so this endpoint cannot persist a config the
        // daemon would itself reject on next load.
        let nextConfig: ReturnType<typeof TierkitConfigSchema.parse>;
        try {
          nextConfig = TierkitConfigSchema.parse({
            ...current,
            runtime: { ...runtime, gatewayMode: incoming.gatewayMode },
          });
        } catch (err) {
          return sendJson(res, 400, { error: "invalid_resulting_config", detail: (err as Error).message });
        }

        const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(nextConfig, null, 2) + "\n");
        await fs.rename(tmp, cfgPath);
        opts.config.runtime.gatewayMode = nextConfig.runtime.gatewayMode;
        return sendJson(res, 200, { runtime: { gatewayMode: nextConfig.runtime.gatewayMode } });
      }
```

(`TierkitConfigSchema` import must be added at the top of Server.ts if not already.)

- [ ] **Step 3: Tests pass**

```bash
pnpm --filter @tierkit/core test -- Server.patchRuntime
```

- [ ] **Step 4: Webview allowlist module + test**

```typescript
// packages/vscode-tierkit/src/webviewCommandAllowlist.ts
const ALLOWED = new Set<string>([
  "tierkit.toggleGatewayMode",
  "tierkit.launchClaudeCodeWithGateway",
]);
export function isAllowedWebviewCommand(command: unknown): command is string {
  return typeof command === "string" && ALLOWED.has(command);
}
```

```typescript
// packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts
import { describe, it, expect } from "vitest";
import { isAllowedWebviewCommand } from "../src/webviewCommandAllowlist.js";

describe("isAllowedWebviewCommand", () => {
  it("admits Phase 1 gateway commands", () => {
    expect(isAllowedWebviewCommand("tierkit.toggleGatewayMode")).toBe(true);
    expect(isAllowedWebviewCommand("tierkit.launchClaudeCodeWithGateway")).toBe(true);
  });
  it("rejects other tierkit commands", () => {
    expect(isAllowedWebviewCommand("tierkit.openInPanel")).toBe(false);
    expect(isAllowedWebviewCommand("tierkit.restartDaemon")).toBe(false);
  });
  it("rejects arbitrary VS Code commands", () => {
    expect(isAllowedWebviewCommand("workbench.action.terminal.kill")).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isAllowedWebviewCommand(undefined)).toBe(false);
    expect(isAllowedWebviewCommand(42)).toBe(false);
  });
});
```

```bash
pnpm --filter @tierkit/vscode-tierkit test -- webviewCommandAllowlist
```

- [ ] **Step 5: Register the toggle command in `extension.ts` (proper ESM imports, daemon endpoint first, atomic file fallback)**

At the top of `extension.ts`:

```typescript
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { isAllowedWebviewCommand } from "./webviewCommandAllowlist.js";
```

In the registerCommand block:

```typescript
    vscode.commands.registerCommand("tierkit.toggleGatewayMode", async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Open a folder first."));
        return;
      }
      const baseUrl = vscode.workspace.getConfiguration("tierkit").get<string>("baseUrl") ?? "http://127.0.0.1:4101";

      // Read current state from the daemon (authoritative when available).
      let current: "off" | "on" = "off";
      try {
        const r = await fetch(`${baseUrl}/v1/gateway/status`);
        if (r.ok) current = ((await r.json()) as { gatewayMode: "off" | "on" }).gatewayMode;
      } catch { /* fall through */ }
      const next: "off" | "on" = current === "on" ? "off" : "on";

      // Prefer daemon endpoint.
      let daemonOk = false;
      try {
        const r = await fetch(`${baseUrl}/v1/config/runtime`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gatewayMode: next }),
        });
        daemonOk = r.ok;
      } catch { /* fall through */ }

      if (!daemonOk) {
        // Atomic file fallback when daemon is down.
        const cfgPath = nodePath.join(workspace.uri.fsPath, "tierkit.config.json");
        let cfg: Record<string, unknown> = { version: "0.1" };
        try {
          cfg = JSON.parse(await fsp.readFile(cfgPath, "utf8")) as Record<string, unknown>;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            void vscode.window.showErrorMessage(`tierkit.config.json: ${(err as Error).message}`);
            return;
          }
        }
        const rt = (cfg.runtime as Record<string, unknown> | undefined) ?? {};
        rt.gatewayMode = next;
        cfg.runtime = rt;
        const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
        await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2) + "\n");
        await fsp.rename(tmp, cfgPath);
        void vscode.commands.executeCommand("tierkit.restartDaemon");
      }

      void vscode.window.showInformationMessage(
        next === "on"
          ? vscode.l10n.t("Gateway: on. Use 'Launch Claude Code through Tierkit' to start a routed session.")
          : vscode.l10n.t("Gateway: off."),
      );
      sidebarRef?.render();
    }),
```

- [ ] **Step 6: Wire `tk:cmd` in both `onDidReceiveMessage` sites**

In sidebar (around `extension.ts:572-603`) and main-panel (around `:279-299`) handlers, add **before** `if (msg.type.startsWith("tk:"))`:

```typescript
      if (msg.type === "tk:cmd" && isAllowedWebviewCommand(msg.command)) {
        void vscode.commands.executeCommand(msg.command);
        return;
      }
```

- [ ] **Step 7: Command + nls (NO configuration property)**

`packages/vscode-tierkit/package.json::contributes.commands`:

```json
        {
          "command": "tierkit.toggleGatewayMode",
          "title": "%command.toggleGatewayMode%",
          "category": "Tierkit"
        }
```

`package.nls.json`:

```json
  "command.toggleGatewayMode": "Route Claude Code through Tierkit (toggle)"
```

`package.nls.ko.json`:

```json
  "command.toggleGatewayMode": "Claude Code를 Tierkit 통해 연결 (토글)"
```

**Do NOT** add `tierkit.gatewayMode` under `contributes.configuration.properties`.

- [ ] **Step 8: Toggle row in `gui.ts` (REUSE existing bridge — see correction 12)**

Before editing `gui.ts`, inspect its existing command-dispatch pattern:

```bash
grep -n "acquireVsCodeApi\|postMessage\|window.parent\|fetch(.\\?/v1" packages/core/src/runtime/ui/gui.ts | head -30
```

Identify the existing helper the GUI uses to send commands. The Phase 1 toggle card MUST call that same helper. It must NOT call `acquireVsCodeApi()` unconditionally — the same HTML is served at `http://127.0.0.1:<port>/` (plain browser) AND inside the VS Code webview, and `acquireVsCodeApi` is undefined in the browser.

If the existing bridge does NOT yet support `{ type: "tk:cmd", command: "..." }` posts, extend it:

```javascript
// Inside gui.ts — example shape; align with the file's existing style.
function postTierkitCommand(commandName) {
  if (typeof acquireVsCodeApi === "function") {
    const api = (window.__tierkitVsApi ??= acquireVsCodeApi());
    api.postMessage({ type: "tk:cmd", command: commandName });
    return true;
  }
  return false; // Browser context — caller decides whether to disable or use HTTP fallback
}
```

Add a card titled **"Route Claude Code through Tierkit"** with sub-text **"Phase 1 passthrough connection. Requests are routed through the local Tierkit daemon without modifying message content."**. On render, fetch `/v1/gateway/status` for the current value. On change, call `postTierkitCommand("tierkit.toggleGatewayMode")`. In the browser context (no VS Code API), disable the control with a small note ("Use the VS Code sidebar to toggle"). No token/percentage/efficiency display.

- [ ] **Step 9: Build + test the extension**

```bash
pnpm --filter @tierkit/vscode-tierkit build
pnpm --filter @tierkit/vscode-tierkit test
```

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/runtime/Server.ts \
        packages/core/test/Server.patchRuntime.test.ts \
        packages/vscode-tierkit/src/extension.ts \
        packages/vscode-tierkit/src/webviewCommandAllowlist.ts \
        packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts \
        packages/vscode-tierkit/package.json \
        packages/vscode-tierkit/package.nls.json \
        packages/vscode-tierkit/package.nls.ko.json \
        packages/core/src/runtime/ui/gui.ts
git commit -m "feat: sidebar toggle — loopback PATCH, schema-validated persist, existing GUI bridge"
```

---

## Task 9: Scoped terminal launch — preserves auth env, status-aware pre-flight

**Why:** Open an integrated terminal with `ANTHROPIC_BASE_URL` set for that terminal only. The user's existing `ANTHROPIC_API_KEY` (and any other env) is preserved verbatim. Pre-flight checks `routesEnabled` (not just daemon health). The Direct fallback terminal explicitly removes `ANTHROPIC_BASE_URL` from its env.

**Files:**
- Create: `packages/vscode-tierkit/src/gatewayLaunch.ts`
- Create: `packages/vscode-tierkit/test/gatewayLaunch.test.ts`
- Modify: `packages/vscode-tierkit/src/extension.ts`
- Modify: `packages/vscode-tierkit/package.json` + nls

- [ ] **Step 1: Failing tests**

```typescript
// packages/vscode-tierkit/test/gatewayLaunch.test.ts
import { describe, it, expect } from "vitest";
import { buildGatewayEnv, gatewayLaunchCommand } from "../src/gatewayLaunch.js";

describe("buildGatewayEnv", () => {
  it("sets ANTHROPIC_BASE_URL to the daemon URL", () => {
    expect(buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: {} }).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101");
  });
  it("preserves an existing ANTHROPIC_API_KEY verbatim", () => {
    const env = buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: { ANTHROPIC_API_KEY: "sk-secret" } });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-secret");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101");
  });
  it("preserves PATH, HOME, and other parent env", () => {
    const env = buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: { PATH: "/usr/local/bin", HOME: "/u" } });
    expect(env.PATH).toBe("/usr/local/bin");
    expect(env.HOME).toBe("/u");
  });
});

describe("gatewayLaunchCommand", () => {
  it("defaults to 'claude'", () => { expect(gatewayLaunchCommand({})).toBe("claude"); });
  it("honors TIERKIT_CLAUDE_CODE_BIN override", () => { expect(gatewayLaunchCommand({ TIERKIT_CLAUDE_CODE_BIN: "/opt/claude" })).toBe("/opt/claude"); });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/vscode-tierkit/src/gatewayLaunch.ts
import * as vscode from "vscode";

export interface GatewayEnvInput {
  baseUrl: string;
  parentEnv: Record<string, string | undefined>;
}

/** Pure env builder. ANTHROPIC_API_KEY is preserved verbatim — Phase 1 changes routing only. */
export function buildGatewayEnv(input: GatewayEnvInput): Record<string, string | undefined> {
  return { ...input.parentEnv, ANTHROPIC_BASE_URL: input.baseUrl };
}

export function gatewayLaunchCommand(env: Record<string, string | undefined>): string {
  return env.TIERKIT_CLAUDE_CODE_BIN ?? "claude";
}

export async function openGatewayTerminal(baseUrl: string): Promise<vscode.Terminal> {
  const env = buildGatewayEnv({ baseUrl, parentEnv: process.env });
  const t = vscode.window.createTerminal({ name: "Claude Code (Tierkit)", env });
  t.show();
  t.sendText(gatewayLaunchCommand(process.env), true);
  return t;
}
```

- [ ] **Step 3: Register the launch command in `extension.ts` (status-aware pre-flight)**

```typescript
    vscode.commands.registerCommand("tierkit.launchClaudeCodeWithGateway", async () => {
      const cfg = vscode.workspace.getConfiguration("tierkit");
      const baseUrl = cfg.get<string>("baseUrl") ?? "http://127.0.0.1:4101";

      const checkReady = async (): Promise<boolean> => {
        try {
          const r = await fetch(`${baseUrl}/v1/gateway/status`);
          if (!r.ok) return false;
          return ((await r.json()) as { routesEnabled?: boolean }).routesEnabled === true;
        } catch { return false; }
      };

      let ready = await checkReady();
      if (!ready) {
        void vscode.window.setStatusBarMessage(vscode.l10n.t("Tierkit Gateway: starting daemon…"), 3000);
        await vscode.commands.executeCommand("tierkit.restartDaemon");
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !ready) {
          await new Promise((r) => setTimeout(r, 300));
          ready = await checkReady();
        }
      }

      if (!ready) {
        let modeOff = false;
        try {
          const r = await fetch(`${baseUrl}/v1/gateway/status`);
          if (r.ok) modeOff = ((await r.json()) as { gatewayMode?: string }).gatewayMode === "off";
        } catch { /* daemon down */ }

        if (modeOff) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t('Enable "Route Claude Code through Tierkit" before launching a routed session.'),
          );
          return;
        }

        const directLabel = vscode.l10n.t("Launch direct");
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("Tierkit Gateway unreachable. Launch Claude Code directly (no gateway)?"),
          { modal: false }, directLabel, vscode.l10n.t("Cancel"),
        );
        if (pick === directLabel) {
          // Explicitly remove ANTHROPIC_BASE_URL from the fallback terminal —
          // VS Code TerminalOptions.env treats undefined as "remove".
          const t = vscode.window.createTerminal({
            name: "Claude Code (direct)",
            env: { ANTHROPIC_BASE_URL: undefined as unknown as string },
          });
          t.show();
          t.sendText("claude", true);
        }
        return;
      }

      const { openGatewayTerminal } = await import("./gatewayLaunch.js");
      await openGatewayTerminal(baseUrl);
    }),
```

- [ ] **Step 4: Command + nls**

```json
        {
          "command": "tierkit.launchClaudeCodeWithGateway",
          "title": "%command.launchClaudeCodeWithGateway%",
          "category": "Tierkit"
        }
```

```json
  "command.launchClaudeCodeWithGateway": "Launch Claude Code through Tierkit"
```

```json
  "command.launchClaudeCodeWithGateway": "Tierkit 통해 Claude Code 실행"
```

- [ ] **Step 5: Tests + build + commit**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayLaunch
pnpm --filter @tierkit/vscode-tierkit build
git add packages/vscode-tierkit/src/gatewayLaunch.ts \
        packages/vscode-tierkit/test/gatewayLaunch.test.ts \
        packages/vscode-tierkit/src/extension.ts \
        packages/vscode-tierkit/package.json \
        packages/vscode-tierkit/package.nls.json \
        packages/vscode-tierkit/package.nls.ko.json
git commit -m "feat(vscode): launch through gateway — preserves auth env, status-aware pre-flight, env-stripping fallback"
```

---

## Task 10: Manual test plan for launch + fallback flows

**Files:**
- Create: `packages/vscode-tierkit/test/MANUAL_gateway_flows.md`

- [ ] **Step 1: Write the manual test plan**

```markdown
# Manual: gateway flows (Phase 1)

## Setup
1. Open a workspace folder. Confirm `tierkit doctor` is green.
2. Sidebar → toggle "Route Claude Code through Tierkit" ON.
3. `tierkit doctor gateway` reports OK for: gateway-mode, gateway-daemon, gateway-routes, gateway-log-path.

## Test 1 — Happy launch
- Click "Tierkit: Launch Claude Code through Tierkit".
- New terminal: `echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"` → `http://127.0.0.1:<port>`.
- Run `claude` and say hi → normal response.

## Test 2 — Auth preservation
- In your parent shell, `export ANTHROPIC_API_KEY=sk-test-DO-NOT-USE`. Launch VS Code from that shell.
- Click launch button. In the new terminal: `echo $ANTHROPIC_API_KEY` → `sk-test-DO-NOT-USE`. (Launch button MUST NOT strip auth.)

## Test 3 — Mode-off guidance
- Sidebar toggle OFF. Click launch button.
- Expected info message: `Enable "Route Claude Code through Tierkit" before launching a routed session.` No terminal opens.

## Test 4 — Auto-restart + fallback
- Mode ON. `pkill -f 'tierkit runtime'`. Click launch button.
- Status bar: `Tierkit Gateway: starting daemon…`. Daemon restarts → terminal opens with ANTHROPIC_BASE_URL set.

## Test 5 — Hard fallback (env stripping)
- `tierkit.autoStartDaemon: false`. Kill daemon. Click launch button.
- Dialog appears → click "Launch direct".
- In the new terminal: `echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"` → empty, EVEN IF the parent shell had it set.

## Test 6 — Safe log inspection
- After Tests 1 and 4: `cat .tierkit/runtime/anthropic-gateway.jsonl`.
- Each record has only `ts, path, stream, status, durationMs, auth {authorizationScheme, authorizationFingerprint, apiKeyPresent, apiKeyFingerprint}`.
- Negative: grep for `sk-`, API key prefix, message text → no hits.

## Test 7 — Local-only enforcement (manual, requires LAN access)
- Temporarily set `runtime.host: "0.0.0.0"` and restart daemon.
- From ANOTHER machine on the same LAN: `curl http://<machine-ip>:<port>/v1/gateway/status` → 403 `local_only`.
- `curl -X PATCH http://<machine-ip>:<port>/v1/config/runtime ...` → 403 `local_only`.
- Restore `runtime.host: "127.0.0.1"`.
```

- [ ] **Step 2: Walk Tests 1–7 on a real machine; record observations in the PR**

- [ ] **Step 3: Commit**

```bash
git add packages/vscode-tierkit/test/MANUAL_gateway_flows.md
git commit -m "docs(vscode): manual test plan for gateway launch + fallback + local-only flows"
```

---

## Task 11: `GET /v1/doctor/gateway` (loopback-guarded) + sidebar diagnostics card

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` — add loopback-guarded route
- Create: `packages/core/test/Server.doctorGateway.test.ts`
- Modify: `packages/core/src/runtime/ui/gui.ts` — render the card via the existing bridge

- [ ] **Step 1: Failing endpoint test**

```typescript
// packages/core/test/Server.doctorGateway.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/runtime/Server.js";

describe("GET /v1/doctor/gateway", () => {
  it("returns checks array", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tk-srv-doctor-gw-"));
    await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1" }));
    const srv = await startServer({ port: 0, cwd: dir });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1/doctor/gateway`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { checks: Array<{ id: string }> };
      expect(body.checks.some((c) => c.id === "gateway-mode")).toBe(true);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Add the route**

```typescript
      if (route === "GET /v1/doctor/gateway") {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return sendJson(res, 403, { error: "local_only" });
        const { doctorGateway } = await import("../usecases/doctorGateway.js");
        return sendJson(res, 200, { checks: await doctorGateway({ cwd: opts.cwd }) });
      }
```

- [ ] **Step 3: Tests pass**

```bash
pnpm --filter @tierkit/core test -- Server.doctorGateway
```

- [ ] **Step 4: Sidebar card in `gui.ts`**

Add a card titled **"Anthropic Gateway — diagnostics"** that fetches `/v1/doctor/gateway` on render + a refresh button. Render each check's `label`, colored `status`, `detail`. No token/percentage/efficiency display. Use the same browser/webview-compatible fetch helper the rest of `gui.ts` already uses.

- [ ] **Step 5: Build + eyeball + commit**

```bash
pnpm -r build
node packages/cli/dist/cli.js runtime start
# Open the sidebar in VS Code OR open http://127.0.0.1:4101/
git add packages/core/src/runtime/Server.ts \
        packages/core/test/Server.doctorGateway.test.ts \
        packages/core/src/runtime/ui/gui.ts
git commit -m "feat(server): GET /v1/doctor/gateway (loopback) + sidebar diagnostics card"
```

---

## Task 12: Docs — README + ANTHROPIC_GATEWAY.md (EN + KR) with accurate fingerprint description

- [ ] **Step 1: Write `docs/ANTHROPIC_GATEWAY.md`**

```markdown
# Anthropic Gateway

Tierkit can run as a transparent gateway in front of Anthropic's Messages API.
Point Claude Code at the Tierkit daemon and your requests flow through Tierkit
on their way to `api.anthropic.com`. The gateway routes traffic through the
local daemon without modifying message content.

## Enable

1. Open the Tierkit sidebar.
2. Toggle **Route Claude Code through Tierkit**. This sets
   `runtime.gatewayMode: "on"` in `tierkit.config.json`.
3. Click **Launch Claude Code through Tierkit**. A new integrated terminal opens
   with `ANTHROPIC_BASE_URL` pointing at the daemon for that terminal only —
   your shell profile is never modified and your `ANTHROPIC_API_KEY` (if set)
   is preserved verbatim.

## Verify

```bash
tierkit doctor gateway
```

You should see `OK` for `runtime.gatewayMode`, `daemon @ ...`, `routes`,
`safe gateway log`, and (if Claude Code is installed) `claude (Claude Code CLI)`.

## Per-request log

When the gateway is on, the daemon writes a per-request log to
`.tierkit/runtime/anthropic-gateway.jsonl`. Each record records: timestamp,
path, stream flag, upstream status, duration, and — for the credential
channel that was used — whether an `Authorization` header was present (and its
scheme), whether an `x-api-key` header was present, plus a 12-character
fingerprint for each channel that was used. The log never contains the request
body, the response body, the raw `Authorization` or `x-api-key` value, the
`system` prompt, the `messages[]` array, or `tool_result` content. The file
rotates at 5 MB or 7 days, whichever comes first.

## Local-only control surface

`GET /v1/gateway/status`, `GET /v1/doctor/gateway`, and `PATCH /v1/config/runtime`
reject any non-loopback caller with HTTP 403. They are not network APIs.

## Direct fallback

If the daemon is unreachable when you click **Launch Claude Code through Tierkit**,
the extension first tries to restart it. If that fails, a dialog offers a
one-click **Launch direct** terminal that bypasses the gateway entirely.
The direct terminal explicitly removes `ANTHROPIC_BASE_URL` so it is truly
direct even when the VS Code process inherited the variable.

Additional context-processing and policy features are planned for a later phase.
```

- [ ] **Step 2: Write `docs/ANTHROPIC_GATEWAY.ko.md`**

```markdown
# Anthropic Gateway

Tierkit는 Anthropic Messages API 앞에 투명한 게이트웨이로 동작할 수 있습니다.
Claude Code를 Tierkit 데몬으로 가리키면, 모든 요청이 `api.anthropic.com`에
도달하기 전에 Tierkit를 거칩니다. 게이트웨이는 메시지 내용을 변경하지 않고
요청을 로컬 데몬을 통해 전달합니다.

## 활성화

1. Tierkit 사이드바를 엽니다.
2. **Claude Code를 Tierkit 통해 연결** 토글을 켭니다. `tierkit.config.json`의
   `runtime.gatewayMode`가 `"on"`이 됩니다.
3. **Tierkit 통해 Claude Code 실행** 버튼을 누릅니다. 새 integrated terminal에
   해당 터미널 한정으로 `ANTHROPIC_BASE_URL`이 주입됩니다. shell profile은
   수정되지 않으며, `ANTHROPIC_API_KEY`가 설정되어 있다면 그대로 보존됩니다.

## 점검

```bash
tierkit doctor gateway
```

`runtime.gatewayMode`, `daemon @ ...`, `routes`, `safe gateway log`, 그리고
설치되어 있다면 `claude (Claude Code CLI)`까지 `OK`로 표시되어야 합니다.

## 요청 단위 로그

게이트웨이가 켜져 있을 때, 데몬은 `.tierkit/runtime/anthropic-gateway.jsonl`에
요청 단위 로그를 남깁니다. 기록 항목은 timestamp, path, stream 여부, 업스트림
상태 코드, 처리 시간, 그리고 사용된 인증 채널의 존재 여부(Authorization scheme,
x-api-key 존재 여부)와 해당 채널의 12자 fingerprint입니다. 요청·응답 본문,
`Authorization`·`x-api-key` 원문, `system` 프롬프트, `messages[]`,
`tool_result` 내용은 포함되지 않습니다. 5 MB 또는 7일 중 먼저 도달하는
조건으로 회전합니다.

## 로컬 전용 제어 surface

`GET /v1/gateway/status`, `GET /v1/doctor/gateway`, `PATCH /v1/config/runtime`는
loopback이 아닌 호출자를 HTTP 403으로 거부합니다. 네트워크 API가 아닙니다.

## Direct fallback

**Tierkit 통해 Claude Code 실행**을 눌렀을 때 데몬이 닿지 않으면 확장 프로그램
이 먼저 데몬 재시작을 시도합니다. 그래도 실패하면 게이트웨이를 우회하는
**Launch direct** 버튼을 제공합니다. Direct 터미널은 `ANTHROPIC_BASE_URL`을
명시적으로 제거하므로, VS Code 프로세스가 부모 shell에서 해당 변수를 상속했더
라도 실제로 direct 경로로 동작합니다.

추가적인 컨텍스트 처리 및 정책 기능은 후속 단계에서 제공될 예정입니다.
```

- [ ] **Step 3: Update README.md**

```markdown
- **Anthropic Gateway (Phase 1 — connection)** — route Claude Code Messages
  API traffic through the local Tierkit daemon with a sidebar toggle and a
  scoped integrated-terminal launcher. See [docs/ANTHROPIC_GATEWAY.md](docs/ANTHROPIC_GATEWAY.md).
```

- [ ] **Step 4: Commit**

```bash
git add docs/ANTHROPIC_GATEWAY.md docs/ANTHROPIC_GATEWAY.ko.md README.md
git commit -m "docs: Anthropic Gateway — connection-focused EN+KR with accurate log description"
```

---

## Task 13: Final regression + diff-based language audit + Phase 2 entry-gate

- [ ] **Step 1: Clean build + full tests**

```bash
pnpm -r clean || true
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
```

- [ ] **Step 2: Diff-based language audit (correction 11)**

Only audit Phase 1's NEW user-facing additions, not pre-existing UI that legitimately mentions cost/savings for unrelated features:

```bash
# Base = spike branch tip (Phase 1's actual baseline).
BASE="$(git merge-base HEAD worktree-anthropic-gateway-spike)"

# User-facing files that this PR may have touched.
USER_FACING=(
  README.md
  docs/ANTHROPIC_GATEWAY.md
  docs/ANTHROPIC_GATEWAY.ko.md
  packages/core/src/runtime/ui/gui.ts
  packages/vscode-tierkit/package.json
  packages/vscode-tierkit/package.nls.json
  packages/vscode-tierkit/package.nls.ko.json
)

# Word-boundary pattern (corrects rev2's omission of `save` and `cost`).
PATTERN='\bsavings\b|\bsave\b|\bsaves\b|\bsaved\b|\bcost\b|\bcheaper\b|\befficient\b|절감|절약|비용|효율'

# Only check NEW lines added in this branch.
git diff --unified=0 "$BASE"...HEAD -- "${USER_FACING[@]}" \
  | grep -E '^\+' \
  | grep -v '^\+\+\+' \
  | grep -niE "$PATTERN" \
  && { echo "LANGUAGE AUDIT FAILED — Phase 1 added forbidden user-facing tokens"; exit 1; } \
  || echo "language audit ok"
```

- [ ] **Step 3: Body-redaction audit**

```bash
grep -nE 'console\.(log|error|info)\(.*(messages|system|tool_result|authorization|x-api-key)' packages -r \
  && { echo "REDACTION AUDIT FAILED"; exit 1; } \
  || echo "redaction audit ok"
```

- [ ] **Step 4: Phase 2 entry-gate note**

Append to `docs/RFC-anthropic-gateway.md`:

```markdown
## Phase 2 entry gate (added during Phase 1)

Phase 2 work (request/response transformation, including any context-handling
or measurement features) MUST NOT begin until:

1. Phase 1 has dogfood for ≥ 1 week with `tierkit doctor gateway` reporting
   ok across all checks on a real workstation.
2. The per-request safe log shows zero 5xx in the trailing 7 days:
   `jq 'select(.status >= 500)' .tierkit/runtime/anthropic-gateway.jsonl | wc -l == 0`.
3. The Direct fallback flow has been triggered at least once and resolved cleanly.

Phase 2 design constraint inherited from Phase 1:
- Any body transformation hook lands inside `forwardMessages` / `streamMessages`
  in `anthropicGateway.ts`. Phase 1's `Server.ts` route plumbing does not change.
- Strengthening the streaming-completion logging contract (currently: log after
  streamMessages resolves) requires changes to `anthropicGateway.ts` and is
  therefore a Phase 2 candidate, not a Phase 1 patch.
```

- [ ] **Step 5: Push + draft PR (base = spike branch)**

```bash
git add docs/RFC-anthropic-gateway.md
git commit -m "docs(rfc): Phase 2 entry-gate criteria"
git push -u origin worktree-anthropic-gateway-phase1
gh pr create --draft \
  --base worktree-anthropic-gateway-spike \
  --head worktree-anthropic-gateway-phase1 \
  --title "feat: Anthropic Gateway Phase 1 — passthrough productization" \
  --body "$(cat <<'EOF'
## Summary

Phase 1 of the Anthropic Gateway: wrap the Phase 0 passthrough in a safe,
local-only connection feature.

- New: \`runtime.gatewayMode\` config (off | on, default off)
- New: \`GET /v1/gateway/status\` (loopback-guarded)
- New: \`PATCH /v1/config/runtime\` (loopback-guarded, allowlist-projected, schema-validated)
- New: \`GET /v1/doctor/gateway\` (loopback-guarded)
- New: safe per-request log at \`.tierkit/runtime/anthropic-gateway.jsonl\` (value-constrained schema, 5 MB / 7-day rotation, serialized writes, oversized rejection)
- New: \`tierkit doctor gateway\` CLI (local-only, cross-platform)
- New: sidebar **Route Claude Code through Tierkit** toggle (single source of truth = tierkit.config.json)
- New: **Launch Claude Code through Tierkit** integrated-terminal button (preserves auth env, status-aware pre-flight)
- New: explicit Direct fallback dialog (removes ANTHROPIC_BASE_URL from the fallback terminal)
- New: \`docs/ANTHROPIC_GATEWAY.md\` + Korean version

## Stacked on Phase 0

Base branch: \`worktree-anthropic-gateway-spike\` (Draft PR #1). After #1
merges to main, change this PR's base to main.

## NOT in this PR

Body transformation, compression, dedupe, pagination, redaction at the body
level, secret transformation, provider routing, any numeric efficiency claim.
Strengthening the streaming-completion logging contract is deferred to Phase 2
(requires changes to \`anthropicGateway.ts\`).

## Test plan

- [ ] \`pnpm -r build && pnpm -r test\` green
- [ ] Diff-based language audit green (Task 13 Step 2)
- [ ] Body-redaction audit green (Task 13 Step 3)
- [ ] Manual flows from \`packages/vscode-tierkit/test/MANUAL_gateway_flows.md\` 1–7 all pass
- [ ] \`tierkit doctor gateway\` returns OK on a configured workstation
- [ ] Safe log inspected — no raw token, no body

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

**Coverage:** every Phase 1 scope item from RFC §3 is implemented:

| RFC item | Tasks |
|---|---|
| 1. Setting + sidebar toggle | 1, 8 |
| 2. Scoped env injection only | 9 |
| 3. Per-request safe log + rotation | 2, 5 |
| 4. Auto-heal + Direct fallback | 9, 10 |
| 5. Onboarding card | 11, 12 |
| 6. \`tierkit doctor gateway\` | 6, 7, 11 |
| 7. README + UI language (EN + KR) | 12 |
| 8. Phase 2 entry gate | 13 |

**Hard rules verified (from Mandatory corrections):**

- [ ] gatewayLog schema uses enum/regex/datetime, not bare strings. No default for `apiKeyPresent`.
- [ ] `appendGatewayLog()` accepts `unknown`. Public type does not require callers to pre-satisfy the record shape.
- [ ] All three control endpoints reject non-loopback with 403. `isLoopbackRemoteAddress` covered by unit tests.
- [ ] `resolveRuntimeDataDir(dataDir, cwd)` used by status, log writer, and doctor — same absolute path everywhere.
- [ ] No Phase 1 automated test calls `api.anthropic.com` (mock upstream via `TIERKIT_ANTHROPIC_UPSTREAM`).
- [ ] Non-stream handlers `await logFinal()` BEFORE `res.end()`. Stream handlers log after `streamMessages` resolves; no fire-and-forget.
- [ ] Transport-error responses log `status: 502`, not `-1`.
- [ ] `PATCH /v1/config/runtime` runs result through `TierkitConfigSchema.parse()` before writing.
- [ ] Ordinary `tierkit doctor` is not modified.
- [ ] `doctorGateway` exported from `@tierkit/core` index.
- [ ] Language audit is diff-based against spike branch with the complete word-boundary pattern.
- [ ] `gui.ts` toggle card uses the existing browser/webview-compatible dispatch helper. No unconditional `acquireVsCodeApi()`.

---

## Execution handoff

1. **Subagent-driven (recommended)** — REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline** — REQUIRED SUB-SKILL: `superpowers:executing-plans`.
