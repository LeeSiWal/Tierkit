# Anthropic Gateway Phase 1 Implementation Plan (rev2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize the Phase 0 Anthropic-passthrough as a safe connection feature in Tierkit — config flag, scoped terminal launch, on-daemon status endpoint, local-only diagnostics, safe per-request log with rotation, sidebar toggle, daemon auto-restart pre-flight, and explicit direct fallback. The gateway routes Claude Code's Messages API traffic through the local daemon without modifying message content.

**Architecture:** Layer config + UX + safe logging + local status/diagnostic endpoints on top of the validated Phase 0 passthrough (`packages/core/src/runtime/anthropicGateway.ts` and two routes in `Server.ts`). All diagnostics and readiness checks use a new local-only `GET /v1/gateway/status` endpoint — they never invoke the upstream Anthropic API. Request log is an allowlist projection (caller mistakes can never leak secrets to disk).

**Tech Stack:**
- Backend: TypeScript, Node 20+, plain `http` (existing `Server.ts`), `fetch()` (already in spike)
- Config: zod (existing schema layer)
- CLI: `clipanion` (existing pattern in `packages/cli/src/commands/`)
- VS Code extension: `vscode` API, no new build deps
- Tests: vitest

---

## Context — read these first

1. **Phase 0 spike code is already in this branch.** Phase 1 branch is **stacked** on top of `worktree-anthropic-gateway-spike` (Draft PR #1). Verify with `git log --oneline main..HEAD` — you should see all spike commits plus this plan. Phase 1 PR base will be the spike branch, not main, until Phase 0 merges.

2. **Files this plan reuses:**
   - `packages/core/src/runtime/anthropicGateway.ts` — `forwardMessages`, `streamMessages`, `forwardCountTokens`, `pickForwardHeaders`, `observeAuthHeaders`. Phase 1 wraps; never modifies the proxy itself.
   - `packages/core/src/runtime/Server.ts` — `POST /v1/messages` / `POST /v1/messages/count_tokens` routes already wired (unconditionally). Phase 1 gates them on `runtime.gatewayMode` and adds the safe log.
   - `packages/core/src/runtime/usageLog.ts` — JSONL append + rotation pattern (not the size policy — Phase 1 uses 5 MB / 7 days).
   - `packages/core/src/config/TierkitConfig.ts` — zod schema layering. `RuntimeConfigSchema` is nested in `TierkitConfigSchema`.
   - `packages/core/src/usecases/doctor.ts` — `DoctorCheck` shape.
   - `packages/cli/src/commands/DoctorCommand.ts` — clipanion command structure.
   - `packages/vscode-tierkit/src/extension.ts` — `maybeStartDaemon` (line 399), `registerCommand` block (line 834+), sidebar webview's `onDidReceiveMessage` (line 572-603), main-panel webview's equivalent (line 279-299).

3. **Phase 0 RFC** (`docs/RFC-anthropic-gateway.md`): all four validations (A, B-1, B-2, C) passed. Phase 1's job is to wrap the validated passthrough in safe UX. It does not change the proxy's protocol behavior.

---

## What this plan does NOT do (and why)

| Excluded | Why deferred |
|---|---|
| Request / response body transformation | Phase 1 must not modify message content. Transformation lives in Phase 2 inside `anthropicGateway.ts`. |
| Compression / dedupe / cursor pagination | Schema design not finalized; effect must be measured before claimed. |
| Secret redaction at the body level | Same — body is untouched in Phase 1. |
| Per-call effectiveness numbers in the UI | No measurement = no claim. Phase 1 displays request count and status only. |
| `~/.zshrc` or any persistent shell profile mutation | Too invasive; impossible to reliably reverse. |
| Forcing or removing the user's Anthropic credential | The user's auth choice is preserved. Phase 1 only injects routing. |
| `POST /v1/models` discovery via gateway | Already gated by `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` in Claude Code. |
| Local-LLM provider routing | Phase 3. |
| OAuth admin endpoints | Hardcoded to api.anthropic.com by Claude Code. |

### User-facing language audit rule

Phase 1 user-facing strings (any string that lands in: `README.md`, `docs/ANTHROPIC_GATEWAY*.md`, sidebar HTML in `gui.ts`, `package.json::contributes`, `package.nls*.json`, VS Code dialog text, CLI command `description`/`details`) **must not contain any of**:

- `savings`, `save`, `saves`, `saved`
- `cost`, `cheaper`, `efficient`
- `절감`, `절약`, `비용`, `효율`
- numeric token-count claims or percentages

Internal docs (`docs/RFC-*.md`, plan files in `docs/superpowers/plans/`, code comments referencing Phase 2) MAY mention these terms when describing future work. This separation is enforced by the Task 12 grep audit.

**Preferred Phase 1 vocabulary**: route, connection, passthrough, diagnostic, status, 연결, 라우팅, 진단.

---

## File Structure

**New files:**
- `packages/core/src/runtime/gatewayLog.ts` — allowlist-projection safe writer + queue + rotation
- `packages/core/test/gatewayLog.test.ts` — unit tests (shape, rotation, queue)
- `packages/core/test/gatewayLog.redaction.test.ts` — proves no body / no raw credential lands in the log even when caller passes extra fields
- `packages/core/src/runtime/gatewayStatus.ts` — pure function building the local status response
- `packages/core/test/gatewayStatus.test.ts`
- `packages/core/src/usecases/doctorGateway.ts` — cross-platform local-only diagnostic
- `packages/core/test/doctorGateway.test.ts`
- `packages/cli/src/commands/DoctorGatewayCommand.ts`
- `packages/cli/test/doctorGatewayCommand.test.ts`
- `packages/vscode-tierkit/src/gatewayLaunch.ts` — env builder + terminal helpers (preserves auth env)
- `packages/vscode-tierkit/test/gatewayLaunch.test.ts`
- `packages/vscode-tierkit/src/webviewCommandAllowlist.ts` — pure allowlist for `tk:cmd`
- `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts`
- `packages/vscode-tierkit/test/MANUAL_gateway_flows.md` — checklist for dialog/terminal flows that can't be auto-tested
- `docs/ANTHROPIC_GATEWAY.md` + `docs/ANTHROPIC_GATEWAY.ko.md`

**Modified files:**
- `packages/core/src/config/TierkitConfig.ts` — add `gatewayMode: "off" | "on"` (default `"off"`)
- `packages/core/src/runtime/Server.ts` — gate spike routes on `gatewayMode`; await safe log; add `GET /v1/gateway/status`; add `PATCH /v1/config/runtime` for the gatewayMode toggle
- `packages/core/src/usecases/doctor.ts` — call `doctorGateway()` and merge its checks (under a gateway-specific id prefix)
- `packages/cli/src/cli.ts` — register `DoctorGatewayCommand`
- `packages/vscode-tierkit/src/extension.ts` — register `tierkit.toggleGatewayMode` + `tierkit.launchClaudeCodeWithGateway`; add `tk:cmd` allowlist handler at both `onDidReceiveMessage` sites
- `packages/vscode-tierkit/package.json` — add the two commands; **do NOT add a `tierkit.gatewayMode` configuration property** (single source of truth = `tierkit.config.json::runtime.gatewayMode`)
- `packages/vscode-tierkit/package.nls.json` + `package.nls.ko.json` — strings
- `packages/core/src/runtime/ui/gui.ts` — sidebar toggle row + diagnostics card
- `README.md` — one paragraph + link to `docs/ANTHROPIC_GATEWAY.md`

**Untouched:**
- `packages/core/src/runtime/anthropicGateway.ts` — Phase 0 code is API-stable for Phase 1. Phase 2 will add a transformation hook inside `forwardMessages`/`streamMessages`; Phase 1 does not.

---

## Task order

| Order | Task | Reason for placement |
|---|---|---|
| 0 | Branch verification | spike commits must be in this branch |
| 1 | `gatewayMode` schema | foundation — everyone reads this |
| 2 | `gatewayLog` writer (allowlist + queue + rotation) | safety primitive — used by Task 4 |
| 3 | `GET /v1/gateway/status` (local-only) | used by Task 5 diagnostic AND Task 8 launch readiness, so it must precede both |
| 4 | Route gate + deterministic safe-log wiring | uses Tasks 1 + 2 |
| 5 | `doctorGateway` usecase (no upstream calls) | uses Task 3 |
| 6 | `tierkit doctor gateway` CLI | wraps Task 5 |
| 7 | Sidebar toggle (single source of truth) | uses Task 1; `PATCH /v1/config/runtime` lives in Server.ts |
| 8 | Scoped terminal launch (preserves auth env) | uses Task 3 for readiness |
| 9 | Auto-restart pre-flight + explicit direct fallback | builds on Task 8 |
| 10 | Sidebar diagnostics card | uses Task 5 |
| 11 | Docs (EN + KR) — language audit applies | last so it reflects final UX |
| 12 | Full regression + Phase 2 entry-gate note | final pass |

---

## Task 0: Verify branch state

**Why:** This branch (`worktree-anthropic-gateway-phase1`) is rebased on top of `worktree-anthropic-gateway-spike`. All Phase 0 code is already present. If it isn't, stop and rebase before doing anything else.

- [ ] **Step 1: Confirm working tree clean and on the right branch**

```bash
git status
git branch --show-current
```
Expected: `nothing to commit, working tree clean` on `worktree-anthropic-gateway-phase1`.

- [ ] **Step 2: Confirm spike commits are reachable from HEAD**

```bash
git log --oneline main..HEAD | tail -20
```
Expected: at least 15 commits ending with `feat(core): anthropicGateway header picker for Anthropic proxy spike` near the bottom.

- [ ] **Step 3: Confirm spike files are present**

```bash
ls packages/core/src/runtime/anthropicGateway.ts \
   packages/core/test/anthropicGateway.test.ts \
   packages/core/test/Server.anthropicGateway.test.ts \
   docs/RFC-anthropic-gateway.md
```
Expected: all four present.

- [ ] **Step 4: Build + run the spike's tests as baseline**

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @tierkit/core test -- anthropicGateway Server.anthropicGateway
```
Expected: all packages build; 17 spike tests pass.

- [ ] **Step 5: No commit** — the branch is already at the right state.

---

## Task 1: Add `gatewayMode` to runtime config schema

**Files:**
- Modify: `packages/core/src/config/TierkitConfig.ts` — extend `RuntimeConfigSchema`
- Create: `packages/core/test/configGatewayMode.test.ts`

- [ ] **Step 1: Failing test**

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
    expect(TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "on" } }).runtime.gatewayMode).toBe("on");
    expect(TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "off" } }).runtime.gatewayMode).toBe("off");
  });

  it("rejects unknown values", () => {
    expect(() => TierkitConfigSchema.parse({ version: "0.1", runtime: { gatewayMode: "auto" } })).toThrow();
  });
});
```

- [ ] **Step 2: Verify it fails**

```bash
pnpm --filter @tierkit/core test -- configGatewayMode
```
Expected: 3 failures.

- [ ] **Step 3: Implement**

In `packages/core/src/config/TierkitConfig.ts`, inside `RuntimeConfigSchema.object({...})` (after `discoverOllamaModels`, around line 132), add:

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
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/TierkitConfig.ts packages/core/test/configGatewayMode.test.ts
git commit -m "feat(core): runtime.gatewayMode config field (off|on, default off)"
```

---

## Task 2: Safe gateway log writer (allowlist + queue + rotation)

**Why:** Phase 1's hard rule — only allowlisted fields land in `.tierkit/runtime/anthropic-gateway.jsonl`. Caller mistakes (passing `body` or `authorizationRaw`) must NOT crash the writer AND must NOT leak to disk. Concurrent requests must serialize so trim/append don't collide.

### Design

- **`sanitizeGatewayLogRecord(input)`** — pure projection. Reads only allowlisted properties off the input; everything else is ignored at the JS layer (never reaches zod). Then `GatewayLogRecordSchema.parse(projected)` validates the result.
- **Auth structure** — split into four fields so the diagnostic value of "which credential was sent" is preserved without leaking the raw token:
  - `authorizationScheme: string | null`
  - `authorizationFingerprint: string | null`
  - `apiKeyPresent: boolean`
  - `apiKeyFingerprint: string | null`
- **Queue** — module-level `Promise` chain serializes all writes in this process. Sufficient for Phase 1 (single daemon).
- **Rotation order** — `append → maybeTrim`. Trim AFTER append guarantees the post-condition that the file size ≤ cap on return.

### Files

- Create: `packages/core/src/runtime/gatewayLog.ts`
- Create: `packages/core/test/gatewayLog.test.ts`
- Create: `packages/core/test/gatewayLog.redaction.test.ts`

- [ ] **Step 1: Failing redaction tests**

Create `packages/core/test/gatewayLog.redaction.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendGatewayLog, type GatewayLogInput } from "../src/runtime/gatewayLog.js";

const SECRET_BEARER = "sk-ant-secret-bearer-abcdef12345";
const SECRET_API_KEY = "sk-ant-api03-VERYSECRET";

async function tmpFile(): Promise<{ file: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "gw-log-redaction-"));
  return { file: path.join(dir, "anthropic-gateway.jsonl"), dir };
}

function baseRecord(): GatewayLogInput {
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

describe("gatewayLog — redaction (allowlist projection)", () => {
  it("drops extra fields like authorizationRaw without throwing", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, { ...baseRecord(), authorizationRaw: SECRET_BEARER } as never);
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain(SECRET_BEARER);
      expect(raw).not.toContain("authorizationRaw");
      expect(raw.trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops apiKeyRaw without throwing", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, { ...baseRecord(), apiKeyRaw: SECRET_API_KEY } as never);
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain(SECRET_API_KEY);
      expect(raw).not.toContain("apiKeyRaw");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a body field even when passed", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, { ...baseRecord(), body: { messages: [{ role: "user", content: "TOP_SECRET" }] } } as never);
      const raw = await readFile(file, "utf8");
      expect(raw).not.toContain("TOP_SECRET");
      expect(raw).not.toContain('"body"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects records missing required allowlist fields", async () => {
    const { file, dir } = await tmpFile();
    try {
      await expect(appendGatewayLog(file, { ts: "2026-05-26T12:00:00.000Z" } as never)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves the four-part auth shape", async () => {
    const { file, dir } = await tmpFile();
    try {
      await appendGatewayLog(file, baseRecord());
      const parsed = JSON.parse((await readFile(file, "utf8")).trim());
      expect(parsed.auth).toEqual({
        authorizationScheme: "Bearer",
        authorizationFingerprint: "abcdef123456",
        apiKeyPresent: false,
        apiKeyFingerprint: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @tierkit/core test -- gatewayLog.redaction
```
Expected: 5 failures (module missing).

- [ ] **Step 3: Failing shape + rotation + concurrency tests**

Create `packages/core/test/gatewayLog.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendGatewayLog,
  type GatewayLogInput,
  GATEWAY_LOG_MAX_BYTES,
  GATEWAY_LOG_MAX_AGE_DAYS,
} from "../src/runtime/gatewayLog.js";

function record(overrides: Partial<GatewayLogInput> = {}): GatewayLogInput {
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

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "gw-log-"));
}

describe("gatewayLog — file shape", () => {
  it("creates the directory and appends one line per call", async () => {
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
      // No interleaved partial JSON.
      for (const line of lines) JSON.parse(line);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 4: Verify failure**

```bash
pnpm --filter @tierkit/core test -- "gatewayLog "
```
Expected: 4 failures (module missing).

- [ ] **Step 5: Implement `gatewayLog.ts`**

Create `packages/core/src/runtime/gatewayLog.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Phase 1 safe per-request log for the Anthropic Gateway.
 *
 * Design:
 *   - **Allowlist projection**: only the named safe fields are read off the
 *     input. Callers passing `body`, `authorizationRaw`, `apiKeyRaw`, etc.
 *     by mistake have those fields ignored at the JS layer — they never
 *     reach zod.
 *   - **Schema validation** then enforces required-field presence and type.
 *   - **Process-wide queue** serializes writes so concurrent requests cannot
 *     interleave a trim with an append.
 *   - **Trim after append** guarantees the post-condition `size ≤ cap` on
 *     return.
 *
 * Hard rule the schema enforces:
 *   No body, no response body, no raw Authorization, no raw x-api-key, no
 *   `system` prompt, no `messages[]`, no `tool_result` content.
 */

export const GATEWAY_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const GATEWAY_LOG_MAX_AGE_DAYS = 7;

const GatewayAuthSchema = z
  .object({
    authorizationScheme: z.string().nullable(),
    authorizationFingerprint: z.string().nullable(),
    apiKeyPresent: z.boolean(),
    apiKeyFingerprint: z.string().nullable(),
  })
  .strict();

const GatewayLogRecordSchema = z
  .object({
    ts: z.string().min(1),
    path: z.string().min(1),
    stream: z.boolean(),
    status: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    auth: GatewayAuthSchema,
  })
  .strict();

export type GatewayLogRecord = z.infer<typeof GatewayLogRecordSchema>;
/** Any object shape — sanitizer projects safe fields and ignores the rest. */
export type GatewayLogInput = GatewayLogRecord & Record<string, unknown>;

export interface AppendGatewayLogOptions {
  /** Override clock for tests. Defaults to `new Date()`. */
  now?: Date;
}

function sanitize(input: GatewayLogInput): GatewayLogRecord {
  const a = (input.auth ?? {}) as Partial<GatewayLogRecord["auth"]>;
  return GatewayLogRecordSchema.parse({
    ts: input.ts,
    path: input.path,
    stream: input.stream,
    status: input.status,
    durationMs: input.durationMs,
    auth: {
      authorizationScheme: a.authorizationScheme ?? null,
      authorizationFingerprint: a.authorizationFingerprint ?? null,
      apiKeyPresent: a.apiKeyPresent ?? false,
      apiKeyFingerprint: a.apiKeyFingerprint ?? null,
    },
  });
}

let writeQueue: Promise<unknown> = Promise.resolve();

export function appendGatewayLog(
  filePath: string,
  input: GatewayLogInput,
  opts: AppendGatewayLogOptions = {},
): Promise<void> {
  // Validate synchronously (outside the queue) so callers see schema errors
  // immediately and the queue never holds a rejected entry.
  const validated = sanitize(input);
  const work = writeQueue.then(() => appendImpl(filePath, validated, opts));
  writeQueue = work.catch(() => undefined);
  return work;
}

async function appendImpl(
  filePath: string,
  record: GatewayLogRecord,
  opts: AppendGatewayLogOptions,
): Promise<void> {
  const now = opts.now ?? new Date();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
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
  // Age check: cheap peek at first line.
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
      // Drop malformed.
    }
  }
  const kept: string[] = [];
  let keptBytes = 0;
  for (let i = ageKept.length - 1; i >= 0; i--) {
    const sz = Buffer.byteLength(ageKept[i]!, "utf8") + 1;
    if (keptBytes + sz > GATEWAY_LOG_MAX_BYTES && kept.length > 0) break;
    kept.unshift(ageKept[i]!);
    keptBytes += sz;
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "");
  await fs.rename(tmp, filePath);
}

/** Canonical log path under runtime.dataDir. */
export function gatewayLogPath(dataDir: string): string {
  return path.join(dataDir, "anthropic-gateway.jsonl");
}
```

- [ ] **Step 6: Tests pass**

```bash
pnpm --filter @tierkit/core test -- gatewayLog
```
Expected: 9 pass (5 redaction + 1 shape + 2 rotation + 1 concurrency).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/gatewayLog.ts \
        packages/core/test/gatewayLog.test.ts \
        packages/core/test/gatewayLog.redaction.test.ts
git commit -m "feat(core): gatewayLog — allowlist projection, queue, age+byte rotation"
```

---

## Task 3: `GET /v1/gateway/status` — local-only status endpoint

**Why:** Both `doctorGateway` (Task 5) and the launch readiness check (Task 8) need to know "is the gateway armed?" without invoking upstream Anthropic. A dedicated local endpoint also lets the sidebar diagnose without authenticated requests.

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

- `routesEnabled === (gatewayMode === "on")`. The redundancy is intentional — `gatewayMode` is the user-set config; `routesEnabled` is what the daemon actually serves. Same value today; gives Phase 2 room to diverge (e.g. emergency disable).

**Files:**
- Create: `packages/core/src/runtime/gatewayStatus.ts` (pure function)
- Create: `packages/core/test/gatewayStatus.test.ts`
- Modify: `packages/core/src/runtime/Server.ts` — add the route
- Create: `packages/core/test/Server.gatewayStatus.test.ts`

- [ ] **Step 1: Failing pure-function test**

Create `packages/core/test/gatewayStatus.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildGatewayStatus } from "../src/runtime/gatewayStatus.js";

describe("buildGatewayStatus", () => {
  it("reports routesEnabled=true when gatewayMode is on", () => {
    const s = buildGatewayStatus({ gatewayMode: "on", dataDir: "/tmp/data" });
    expect(s).toEqual({
      gatewayMode: "on",
      routesEnabled: true,
      messagesPath: "/v1/messages",
      countTokensPath: "/v1/messages/count_tokens",
      logPath: path.join("/tmp/data", "anthropic-gateway.jsonl"),
    });
  });

  it("reports routesEnabled=false when gatewayMode is off", () => {
    expect(buildGatewayStatus({ gatewayMode: "off", dataDir: "/tmp/data" }).routesEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Create `packages/core/src/runtime/gatewayStatus.ts`:

```typescript
import { gatewayLogPath } from "./gatewayLog.js";

export interface GatewayStatusInput {
  gatewayMode: "off" | "on";
  dataDir: string;
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
    logPath: gatewayLogPath(input.dataDir),
  };
}
```

- [ ] **Step 3: Tests pass**

```bash
pnpm --filter @tierkit/core test -- gatewayStatus
```

- [ ] **Step 4: Failing endpoint test**

Create `packages/core/test/Server.gatewayStatus.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/runtime/Server.js";

async function startWith(gatewayMode: "off" | "on") {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-gw-status-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1", runtime: { gatewayMode } }));
  const srv = await startServer({ port: 0, cwd: dir });
  return { srv, dir, url: `http://127.0.0.1:${srv.port}` };
}

describe("GET /v1/gateway/status", () => {
  it("returns routesEnabled=true when gatewayMode is on", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      const res = await fetch(`${url}/v1/gateway/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { gatewayMode: string; routesEnabled: boolean };
      expect(body.gatewayMode).toBe("on");
      expect(body.routesEnabled).toBe(true);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns routesEnabled=false when gatewayMode is off", async () => {
    const { srv, dir, url } = await startWith("off");
    try {
      const res = await fetch(`${url}/v1/gateway/status`);
      const body = (await res.json()) as { routesEnabled: boolean };
      expect(body.routesEnabled).toBe(false);
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 5: Verify failure**

```bash
pnpm --filter @tierkit/core test -- Server.gatewayStatus
```
Expected: 404.

- [ ] **Step 6: Add the route in Server.ts**

Near the existing health/config routes:

```typescript
      if (route === "GET /v1/gateway/status") {
        const { buildGatewayStatus } = await import("./gatewayStatus.js");
        return sendJson(res, 200, buildGatewayStatus({
          gatewayMode: opts.config.runtime.gatewayMode,
          dataDir: opts.config.runtime.dataDir,
        }));
      }
```

- [ ] **Step 7: Tests pass**

```bash
pnpm --filter @tierkit/core test -- Server.gatewayStatus
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/runtime/gatewayStatus.ts \
        packages/core/test/gatewayStatus.test.ts \
        packages/core/test/Server.gatewayStatus.test.ts \
        packages/core/src/runtime/Server.ts
git commit -m "feat(core): GET /v1/gateway/status — local-only status endpoint"
```

---

## Task 4: Route gate + deterministic safe-log wiring

**Why:** Phase 0 routes are unconditional. Phase 1 must (a) only serve `/v1/messages*` when `runtime.gatewayMode === "on"`, and (b) emit a safe log record per request **deterministically** (await — no fire-and-forget).

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` — gate + await `appendGatewayLog`
- Create: `packages/core/test/Server.gatewayMode.test.ts`

- [ ] **Step 1: Failing gate test**

Create `packages/core/test/Server.gatewayMode.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/runtime/Server.js";
import { gatewayLogPath } from "../src/runtime/gatewayLog.js";

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

  it("returns 404 for /v1/messages/count_tokens when off", async () => {
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

  it("routes are wired when on (any non-404 status confirms registration)", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
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

describe("Server — gateway safe log (deterministic)", () => {
  it("writes the safe log BEFORE the handler returns (no fire-and-forget)", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      // Upstream may fail in CI. Log MUST still be present immediately when fetch resolves.
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-test-NEVER-PERSISTED" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      // No sleep — the log must be written synchronously w.r.t. handler completion.
      const logPath = gatewayLogPath(path.join(dir, ".tierkit/runtime"));
      const raw = await readFile(logPath, "utf8");
      expect(raw.trim().split("\n")).toHaveLength(1);
      expect(raw).not.toContain("sk-test-NEVER-PERSISTED");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.path).toBe("/v1/messages");
      expect(parsed.auth.apiKeyPresent).toBe(true);
      expect(parsed.auth.apiKeyFingerprint).toMatch(/^[0-9a-f]{12}$/);
    } finally {
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
Expected: 4 failures.

- [ ] **Step 3: Gate + log in Server.ts**

At the top of `Server.ts`:

```typescript
import { appendGatewayLog, gatewayLogPath, type GatewayLogInput } from "./gatewayLog.js";
import { observeAuthHeaders } from "./anthropicGateway.js";
```

Replace each of the two Phase 0 route blocks. For `/v1/messages`:

```typescript
      if (route === "POST /v1/messages") {
        if (opts.config.runtime.gatewayMode !== "on") return sendJson(res, 404, { error: "not_found" });

        const startedAt = Date.now();
        const auth = observeAuthHeaders(req.headers);
        const body = await readRawBody(req);
        const wantsStream = isStreamingMessagesBody(body);

        const logFinal = async (status: number): Promise<void> => {
          const rec: GatewayLogInput = {
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
            await appendGatewayLog(gatewayLogPath(opts.config.runtime.dataDir), rec);
          } catch (err) {
            // Logging must never alter user-visible behavior.
            console.error("[anthropic-gateway] log write failed:", (err as Error).message);
          }
        };

        try {
          if (wantsStream) {
            await streamMessages(req, body, res);
            await logFinal(res.statusCode);
            return;
          }
          const r = await forwardMessages(req, body);
          for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
          res.statusCode = r.status;
          res.end(r.body);
          await logFinal(r.status);
          return;
        } catch (err) {
          await logFinal(-1);
          if (res.headersSent) {
            res.destroy(err as Error);
            return;
          }
          return sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: (err as Error).message } });
        }
      }
```

Apply the same shape to `/v1/messages/count_tokens` with `stream: false` and its own `path` value.

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @tierkit/core test
```
Expected: all green (gate + log + the spike's original 17).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/Server.ts packages/core/test/Server.gatewayMode.test.ts
git commit -m "feat(core): gate /v1/messages on gatewayMode; deterministic safe log"
```

---

## Task 5: `doctorGateway` usecase (local-only, cross-platform)

**Why:** A focused diagnostic that NEVER calls upstream Anthropic. Composed of: config has `gatewayMode: on`, daemon health, `GET /v1/gateway/status` reports `routesEnabled: true`, safe log path writable, Claude Code on PATH (cross-platform), credential mode (subscription vs api-key — by env presence only, never the value).

**Files:**
- Create: `packages/core/src/usecases/doctorGateway.ts`
- Create: `packages/core/test/doctorGateway.test.ts`

- [ ] **Step 1: Failing test**

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
  it("flags gatewayMode=off as warn", async () => {
    const dir = await projectWith({ version: "0.1" });
    try {
      const checks = await doctorGateway({ cwd: dir });
      const m = checks.find((c) => c.id === "gateway-mode");
      expect(m?.status).toBe("warn");
      expect(m?.detail).toMatch(/gatewayMode/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports ok for gateway-mode when set to on", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const checks = await doctorGateway({ cwd: dir });
      expect(checks.find((c) => c.id === "gateway-mode")?.status).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports daemon unreachable when no daemon is running", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", port: 1 } });
    try {
      const checks = await doctorGateway({ cwd: dir });
      const d = checks.find((c) => c.id === "gateway-daemon");
      expect(d?.status).toBe("fail");
      expect(d?.detail).toMatch(/unreachable|connect|refused/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports log path writable", async () => {
    const dataDir = path.join(await mkdtemp(path.join(tmpdir(), "tk-gw-dd-")), ".tierkit/runtime");
    await mkdir(dataDir, { recursive: true });
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", dataDir } });
    try {
      const checks = await doctorGateway({ cwd: dir });
      const log = checks.find((c) => c.id === "gateway-log-path");
      expect(log?.status).toBe("ok");
      expect(log?.detail).toContain("anthropic-gateway.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports claude binary presence as ok or warn (never fail)", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const cc = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-claude-code");
      expect(cc?.status).toMatch(/ok|warn/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports credential mode without reading the value", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const cm = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-credential-mode");
      expect(cm?.status).toBe("ok");
      expect(cm?.detail).toMatch(/api-key|subscription|unknown/);
      if (process.env.ANTHROPIC_API_KEY) {
        expect(cm?.detail).not.toContain(process.env.ANTHROPIC_API_KEY);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify failures**

```bash
pnpm --filter @tierkit/core test -- doctorGateway
```

- [ ] **Step 3: Implement**

Create `packages/core/src/usecases/doctorGateway.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loadConfig.js";
import type { DoctorCheck } from "./doctor.js";
import { gatewayLogPath } from "../runtime/gatewayLog.js";

export interface DoctorGatewayInput {
  cwd?: string;
}

/**
 * Phase 1 local-only diagnostic. NEVER calls upstream Anthropic. NEVER reads
 * or echoes a credential value — only its presence/absence.
 *
 * Cross-platform: uses path.isAbsolute for dataDir; uses `claude --version`
 * (via shell on win32 for .cmd shims) as a more portable presence probe than
 * `which`/`where`.
 */
export async function doctorGateway(input: DoctorGatewayInput = {}): Promise<DoctorCheck[]> {
  const cwd = input.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  const cfgResult = await loadConfig(cwd);
  const runtime = cfgResult.config.runtime;
  const baseUrl = `http://${runtime.host}:${runtime.port}`;

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

  // 4) log path
  checks.push(await checkLogWritable(runtime.dataDir, cwd));

  // 5) claude binary
  checks.push(checkClaudeBinary());

  // 6) credential mode (presence only, never value)
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

async function checkLogWritable(dataDir: string, cwd: string): Promise<DoctorCheck> {
  const absDataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(cwd, dataDir);
  const logPath = gatewayLogPath(absDataDir);
  try {
    await fs.mkdir(absDataDir, { recursive: true });
    const probe = `${logPath}.probe-${process.pid}`;
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
    return { id: "gateway-log-path", label: "safe gateway log", status: "ok", detail: logPath };
  } catch (err) {
    return { id: "gateway-log-path", label: "safe gateway log", status: "fail", detail: `${logPath} — ${(err as Error).message}` };
  }
}

function checkClaudeBinary(): DoctorCheck {
  // `claude --version` is the most portable presence probe. `shell: true` on
  // win32 handles the .cmd shim.
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

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @tierkit/core test -- doctorGateway
```
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/usecases/doctorGateway.ts packages/core/test/doctorGateway.test.ts
git commit -m "feat(core): doctorGateway — local-only diagnostic, no upstream calls"
```

---

## Task 6: `tierkit doctor gateway` CLI

**Files:**
- Create: `packages/cli/src/commands/DoctorGatewayCommand.ts`
- Create: `packages/cli/test/doctorGatewayCommand.test.ts`
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Failing test**

Create `packages/cli/test/doctorGatewayCommand.test.ts`:

```typescript
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when a hard failure occurs (unreachable daemon, mode on)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tk-cli-doctor-gw-fail-"));
    try {
      await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1", runtime: { gatewayMode: "on", port: 1 } }));
      expect(() => execFileSync("node", [CLI, "doctor", "gateway"], { cwd: dir, encoding: "utf8" })).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @tierkit/cli build && pnpm --filter @tierkit/cli test -- doctorGatewayCommand
```

- [ ] **Step 3: Implement**

Create `packages/cli/src/commands/DoctorGatewayCommand.ts`:

```typescript
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

In `packages/cli/src/cli.ts`, add the import and `cli.register(DoctorGatewayCommand)` next to `DoctorCommand`.

- [ ] **Step 4: Build + test**

```bash
pnpm --filter @tierkit/cli build && pnpm --filter @tierkit/cli test -- doctorGatewayCommand
```
Expected: pass.

- [ ] **Step 5: Manual probe**

```bash
node packages/cli/dist/cli.js doctor gateway
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/DoctorGatewayCommand.ts packages/cli/src/cli.ts packages/cli/test/doctorGatewayCommand.test.ts
git commit -m "feat(cli): tierkit doctor gateway"
```

---

## Task 7: Sidebar toggle — single source of truth

**Why:** Only one persistent state for `gatewayMode`: `tierkit.config.json::runtime.gatewayMode`. The VS Code extension registers a **command** (no VS Code setting) and the webview displays the current value by calling `GET /v1/gateway/status`.

**Toggle write path:**
1. Prefer daemon endpoint `PATCH /v1/config/runtime` — keeps config writes inside the daemon's schema-aware path and avoids race with other writers.
2. Fall back to atomic file write (tmp + rename) only when the daemon is unreachable.

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` — add `PATCH /v1/config/runtime` that mutates `runtime.gatewayMode` only (allowlisted)
- Create: `packages/core/test/Server.patchRuntime.test.ts`
- Modify: `packages/vscode-tierkit/src/extension.ts` — register `tierkit.toggleGatewayMode` command (uses daemon endpoint, atomic fallback)
- Modify: `packages/vscode-tierkit/package.json` — add **command only**, no configuration property
- Modify: `packages/vscode-tierkit/package.nls.json` + `package.nls.ko.json` — strings
- Create: `packages/vscode-tierkit/src/webviewCommandAllowlist.ts`
- Create: `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts`
- Modify: `packages/core/src/runtime/ui/gui.ts` — add toggle row that reads `/v1/gateway/status` and posts `tk:cmd` to flip

- [ ] **Step 1: Failing PATCH test**

Create `packages/core/test/Server.patchRuntime.test.ts`:

```typescript
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
      const body = (await res.json()) as { runtime: { gatewayMode: string } };
      expect(body.runtime.gatewayMode).toBe("on");
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.gatewayMode).toBe("on");
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
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
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Implement the route**

In `Server.ts` (add `import fs from "node:fs/promises"` and `import path from "node:path"` at the top if not present):

```typescript
      if (route === "PATCH /v1/config/runtime") {
        const body = await readJsonBody<{ gatewayMode?: "off" | "on" }>(req);
        const allowedKeys = new Set(["gatewayMode"]);
        const incoming = body ?? {};
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
        runtime.gatewayMode = incoming.gatewayMode;
        current.runtime = runtime;
        const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(current, null, 2) + "\n");
        await fs.rename(tmp, cfgPath);
        // Mutate in-memory config so subsequent requests in this process see the new value without restart.
        opts.config.runtime.gatewayMode = incoming.gatewayMode;
        return sendJson(res, 200, { runtime: { gatewayMode: opts.config.runtime.gatewayMode } });
      }
```

- [ ] **Step 3: Tests pass**

```bash
pnpm --filter @tierkit/core test -- Server.patchRuntime
```

- [ ] **Step 4: Failing webview allowlist test**

Create `packages/vscode-tierkit/src/webviewCommandAllowlist.ts`:

```typescript
const ALLOWED = new Set<string>([
  "tierkit.toggleGatewayMode",
  "tierkit.launchClaudeCodeWithGateway",
]);

export function isAllowedWebviewCommand(command: unknown): command is string {
  return typeof command === "string" && ALLOWED.has(command);
}
```

Create `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts`:

```typescript
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

- [ ] **Step 5: Register the toggle command in extension.ts (proper ESM imports)**

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

      // Current value.
      let current: "off" | "on" = "off";
      try {
        const r = await fetch(`${baseUrl}/v1/gateway/status`);
        if (r.ok) current = ((await r.json()) as { gatewayMode: "off" | "on" }).gatewayMode;
      } catch { /* fall through to file read */ }
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
      } catch { /* fall through to file */ }

      if (!daemonOk) {
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

In **both** sidebar (around `extension.ts:572-603`) and main-panel (around `:279-299`) handlers, add **before** the generic `if (msg.type.startsWith("tk:"))` branch:

```typescript
      if (msg.type === "tk:cmd" && isAllowedWebviewCommand(msg.command)) {
        void vscode.commands.executeCommand(msg.command);
        return;
      }
```

- [ ] **Step 7: Add the command + nls entries (NO configuration property)**

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

**Do NOT** add `tierkit.gatewayMode` under `contributes.configuration.properties` — that creates a phantom setting users will edit fruitlessly.

- [ ] **Step 8: Add the toggle row to `gui.ts`**

In `packages/core/src/runtime/ui/gui.ts`, add a card. It MUST:
1. On render, call `GET /v1/gateway/status` to read current state.
2. Display a checkbox/switch bound to that state.
3. On change, post `{ type: "tk:cmd", command: "tierkit.toggleGatewayMode" }` to the parent (via `acquireVsCodeApi().postMessage(...)` — match existing call sites).
4. Row label: **"Route Claude Code through Tierkit"**. Sub-text: **"Phase 1 passthrough connection. Requests are routed through the local Tierkit daemon without modifying message content."**
5. **No** token count, percentage, or efficiency display.

Mirror the structure of any existing card that displays a daemon-sourced value and posts a command (search `gui.ts` for `restartDaemon`).

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
git commit -m "feat: sidebar toggle — single source of truth, daemon endpoint + atomic fallback"
```

---

## Task 8: Scoped terminal launch — preserves auth env

**Why:** Open an integrated terminal with `ANTHROPIC_BASE_URL` set for that terminal only. The user's existing `ANTHROPIC_API_KEY` (and any other env) is preserved verbatim — the launch button changes routing, never authentication. Pre-flight checks `routesEnabled`, not just daemon health.

**Files:**
- Create: `packages/vscode-tierkit/src/gatewayLaunch.ts`
- Create: `packages/vscode-tierkit/test/gatewayLaunch.test.ts`
- Modify: `packages/vscode-tierkit/src/extension.ts` — register `tierkit.launchClaudeCodeWithGateway`
- Modify: `packages/vscode-tierkit/package.json` + nls — add the command

- [ ] **Step 1: Failing tests**

Create `packages/vscode-tierkit/test/gatewayLaunch.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildGatewayEnv, gatewayLaunchCommand } from "../src/gatewayLaunch.js";

describe("buildGatewayEnv", () => {
  it("sets ANTHROPIC_BASE_URL to the daemon URL", () => {
    const env = buildGatewayEnv({ baseUrl: "http://127.0.0.1:4101", parentEnv: {} });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101");
  });

  it("preserves an existing ANTHROPIC_API_KEY verbatim (does not strip auth)", () => {
    const env = buildGatewayEnv({
      baseUrl: "http://127.0.0.1:4101",
      parentEnv: { ANTHROPIC_API_KEY: "sk-secret" },
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-secret");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4101");
  });

  it("preserves PATH, HOME, and other parent env", () => {
    const env = buildGatewayEnv({
      baseUrl: "http://127.0.0.1:4101",
      parentEnv: { PATH: "/usr/local/bin", HOME: "/Users/x" },
    });
    expect(env.PATH).toBe("/usr/local/bin");
    expect(env.HOME).toBe("/Users/x");
  });
});

describe("gatewayLaunchCommand", () => {
  it("defaults to 'claude'", () => {
    expect(gatewayLaunchCommand({})).toBe("claude");
  });
  it("honors TIERKIT_CLAUDE_CODE_BIN override", () => {
    expect(gatewayLaunchCommand({ TIERKIT_CLAUDE_CODE_BIN: "/opt/claude" })).toBe("/opt/claude");
  });
});
```

- [ ] **Step 2: Verify failures**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayLaunch
```

- [ ] **Step 3: Implement**

Create `packages/vscode-tierkit/src/gatewayLaunch.ts`:

```typescript
import * as vscode from "vscode";

export interface GatewayEnvInput {
  baseUrl: string;
  parentEnv: Record<string, string | undefined>;
}

/**
 * Pure env builder. Sets ANTHROPIC_BASE_URL to the daemon; preserves every
 * other parent env variable verbatim — in particular, ANTHROPIC_API_KEY is
 * NEVER stripped. The launch button changes routing, not authentication.
 */
export function buildGatewayEnv(input: GatewayEnvInput): Record<string, string | undefined> {
  return {
    ...input.parentEnv,
    ANTHROPIC_BASE_URL: input.baseUrl,
  };
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

- [ ] **Step 4: Register the command in extension.ts (with proper readiness check)**

```typescript
    vscode.commands.registerCommand("tierkit.launchClaudeCodeWithGateway", async () => {
      const cfg = vscode.workspace.getConfiguration("tierkit");
      const baseUrl = cfg.get<string>("baseUrl") ?? "http://127.0.0.1:4101";

      const checkReady = async (): Promise<boolean> => {
        try {
          const r = await fetch(`${baseUrl}/v1/gateway/status`);
          if (!r.ok) return false;
          const body = (await r.json()) as { routesEnabled?: boolean };
          return body.routesEnabled === true;
        } catch {
          return false;
        }
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
        // Distinguish "mode off" from "daemon down" for honest guidance.
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
          { modal: false },
          directLabel,
          vscode.l10n.t("Cancel"),
        );
        if (pick === directLabel) {
          // Explicitly remove ANTHROPIC_BASE_URL so the fallback terminal is truly direct
          // even if the VS Code process inherited the var from its parent shell.
          // VS Code TerminalOptions.env treats `undefined` value as "remove".
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

- [ ] **Step 5: Command + nls**

`package.json::contributes.commands`:

```json
        {
          "command": "tierkit.launchClaudeCodeWithGateway",
          "title": "%command.launchClaudeCodeWithGateway%",
          "category": "Tierkit"
        }
```

`package.nls.json`:

```json
  "command.launchClaudeCodeWithGateway": "Launch Claude Code through Tierkit"
```

`package.nls.ko.json`:

```json
  "command.launchClaudeCodeWithGateway": "Tierkit 통해 Claude Code 실행"
```

- [ ] **Step 6: Tests + build**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayLaunch
pnpm --filter @tierkit/vscode-tierkit build
```

- [ ] **Step 7: Commit**

```bash
git add packages/vscode-tierkit/src/gatewayLaunch.ts \
        packages/vscode-tierkit/test/gatewayLaunch.test.ts \
        packages/vscode-tierkit/src/extension.ts \
        packages/vscode-tierkit/package.json \
        packages/vscode-tierkit/package.nls.json \
        packages/vscode-tierkit/package.nls.ko.json
git commit -m "feat(vscode): launch through gateway — preserves auth env, status-aware pre-flight"
```

---

## Task 9: Manual test plan for launch + fallback flows

**Why:** Task 8 already implements the pre-flight and fallback. This task is the **manual test plan** — VS Code modals + terminal env propagation can't be auto-tested cleanly.

**Files:**
- Create: `packages/vscode-tierkit/test/MANUAL_gateway_flows.md`

- [ ] **Step 1: Write the manual test plan**

Create `packages/vscode-tierkit/test/MANUAL_gateway_flows.md`:

```markdown
# Manual: gateway flows (Phase 1)

Run all checks on a real workstation with VS Code + Tierkit extension installed.

## Setup
1. Open a workspace folder.
2. Confirm `tierkit doctor` is green.
3. From the sidebar, toggle "Route Claude Code through Tierkit" ON.
4. Confirm `tierkit doctor gateway` reports OK for: runtime.gatewayMode, daemon, routes, safe gateway log.

## Test 1 — Happy launch
- Click "Tierkit: Launch Claude Code through Tierkit".
- In the new terminal, run `echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"`.
- Expected: prints `http://127.0.0.1:<port>`.
- Run `claude` and ask "say hi". Expected: normal response.

## Test 2 — Auth preservation
- In your parent shell (outside VS Code), set `export ANTHROPIC_API_KEY=sk-test-DO-NOT-USE`.
- Launch VS Code from that shell.
- Click "Launch Claude Code through Tierkit".
- In the new terminal: `echo $ANTHROPIC_API_KEY`.
- Expected: prints `sk-test-DO-NOT-USE`. **The launch button must not strip auth.**

## Test 3 — Mode-off guidance
- Sidebar toggle: OFF.
- Click "Launch Claude Code through Tierkit".
- Expected: info message: `Enable "Route Claude Code through Tierkit" before launching a routed session.` No terminal opens.

## Test 4 — Auto-restart + fallback
- Mode ON. Kill the daemon: `pkill -f 'tierkit runtime'`.
- Click "Launch Claude Code through Tierkit".
- Expected: status-bar message `Tierkit Gateway: starting daemon…`.
- Daemon restarts → terminal opens with ANTHROPIC_BASE_URL set.

## Test 5 — Hard fallback
- Disable daemon auto-start: `tierkit.autoStartDaemon: false` in VS Code settings.
- Kill the daemon.
- Click "Launch Claude Code through Tierkit".
- Expected: dialog "Tierkit Gateway unreachable. Launch Claude Code directly (no gateway)?"
- Click "Launch direct".
- In the new terminal: `echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"`.
- Expected: prints empty value, EVEN IF the parent shell had ANTHROPIC_BASE_URL set.

## Test 6 — Safe log
- After Tests 1 and 4, `cat .tierkit/runtime/anthropic-gateway.jsonl`.
- Expected: one JSONL record per request. Each record has only:
  `ts, path, stream, status, durationMs, auth {authorizationScheme, authorizationFingerprint, apiKeyPresent, apiKeyFingerprint}`.
- Negative: grep the file for `sk-`, your real API key prefix, message text, etc. Expected: no hits.
```

- [ ] **Step 2: Walk through Tests 1–6 on a real machine; record observations in the PR**

- [ ] **Step 3: Commit**

```bash
git add packages/vscode-tierkit/test/MANUAL_gateway_flows.md
git commit -m "docs(vscode): manual test plan for gateway launch + fallback flows"
```

---

## Task 10: Sidebar diagnostics card

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` — add `GET /v1/doctor/gateway`
- Create: `packages/core/test/Server.doctorGateway.test.ts`
- Modify: `packages/core/src/runtime/ui/gui.ts` — render the card

- [ ] **Step 1: Failing endpoint test**

Create `packages/core/test/Server.doctorGateway.test.ts`:

```typescript
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
    } finally {
      await srv.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Add the route in Server.ts**

```typescript
      if (route === "GET /v1/doctor/gateway") {
        const { doctorGateway } = await import("../usecases/doctorGateway.js");
        return sendJson(res, 200, { checks: await doctorGateway({ cwd: opts.cwd }) });
      }
```

- [ ] **Step 3: Tests pass**

```bash
pnpm --filter @tierkit/core test -- Server.doctorGateway
```

- [ ] **Step 4: Sidebar card in gui.ts**

Add a card titled **"Anthropic Gateway — diagnostics"** that fetches `/v1/doctor/gateway` on render + a refresh button. Render each check's `label`, colored `status`, and `detail`. No token/percentage/efficiency display.

- [ ] **Step 5: Build + eyeball**

```bash
pnpm -r build
node packages/cli/dist/cli.js runtime start
# Open the sidebar in VS Code OR open http://127.0.0.1:4101/
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/Server.ts \
        packages/core/test/Server.doctorGateway.test.ts \
        packages/core/src/runtime/ui/gui.ts
git commit -m "feat(server): GET /v1/doctor/gateway + sidebar diagnostics card"
```

---

## Task 11: Docs — README + ANTHROPIC_GATEWAY.md (EN + KR)

**Files:**
- Create: `docs/ANTHROPIC_GATEWAY.md`
- Create: `docs/ANTHROPIC_GATEWAY.ko.md`
- Modify: `README.md`

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
`.tierkit/runtime/anthropic-gateway.jsonl`. The log contains only: timestamp,
path, stream flag, upstream status, duration, and a 12-character fingerprint
of the auth header. It never contains the request body, the response body,
the raw `Authorization` or `x-api-key` header, the `system` prompt, the
`messages[]` array, or `tool_result` content. The file rotates at 5 MB or
7 days, whichever comes first.

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
요청 단위 로그를 남깁니다. 기록되는 항목은 timestamp, path, stream 여부,
업스트림 상태 코드, 처리 시간, auth 헤더의 12자 fingerprint뿐입니다. 요청·응답
본문, `Authorization`·`x-api-key` 원문, `system` 프롬프트, `messages[]`,
`tool_result` 내용은 포함되지 않습니다. 5 MB 또는 7일 중 먼저 도달하는
조건으로 회전합니다.

## Direct fallback

**Tierkit 통해 Claude Code 실행**을 눌렀을 때 데몬이 닿지 않으면 확장 프로그램
이 먼저 데몬 재시작을 시도합니다. 그래도 실패하면 게이트웨이를 우회하는
**Launch direct** 버튼을 제공합니다. Direct 터미널은 `ANTHROPIC_BASE_URL`을
명시적으로 제거하므로, VS Code 프로세스가 부모 shell에서 해당 변수를 상속했더
라도 실제로 direct 경로로 동작합니다.

추가적인 컨텍스트 처리 및 정책 기능은 후속 단계에서 제공될 예정입니다.
```

- [ ] **Step 3: Update README.md**

Add a single bullet near the existing Features section:

```markdown
- **Anthropic Gateway (Phase 1 — connection)** — route Claude Code Messages
  API traffic through the local Tierkit daemon with a sidebar toggle and a
  scoped integrated-terminal launcher. See [docs/ANTHROPIC_GATEWAY.md](docs/ANTHROPIC_GATEWAY.md).
```

- [ ] **Step 4: Commit**

```bash
git add docs/ANTHROPIC_GATEWAY.md docs/ANTHROPIC_GATEWAY.ko.md README.md
git commit -m "docs: Anthropic Gateway — connection-focused EN+KR"
```

---

## Task 12: Final regression + language audit + Phase 2 entry-gate note

- [ ] **Step 1: Clean build**

```bash
pnpm -r clean || true
pnpm install --frozen-lockfile
pnpm -r build
```

- [ ] **Step 2: Full test run**

```bash
pnpm -r test
```

- [ ] **Step 3: User-facing language audit**

```bash
USER_FACING=(
  README.md
  docs/ANTHROPIC_GATEWAY.md
  docs/ANTHROPIC_GATEWAY.ko.md
  packages/core/src/runtime/ui/gui.ts
  packages/vscode-tierkit/package.json
  packages/vscode-tierkit/package.nls.json
  packages/vscode-tierkit/package.nls.ko.json
)
PATTERN='savings|saves|saved|cheaper|efficient|절감|절약|비용|효율'
grep -nE "$PATTERN" "${USER_FACING[@]}" && { echo "LANGUAGE AUDIT FAILED"; exit 1; } || echo "language audit ok"
```

If `save` legitimately appears as a verb in an unrelated UI label, narrow with `\bsave\b` and re-run.

- [ ] **Step 4: Body-redaction audit**

```bash
grep -nE 'console\.(log|error|info)\(.*(messages|system|tool_result|authorization|x-api-key)' packages -r && { echo "REDACTION AUDIT FAILED"; exit 1; } || echo "redaction audit ok"
```

- [ ] **Step 5: Phase 2 entry-gate note in the RFC**

Append to `docs/RFC-anthropic-gateway.md`:

```markdown
## Phase 2 entry gate (added during Phase 1)

Phase 2 work (request/response transformation, including any context-handling
or measurement features) MUST NOT begin until:

1. Phase 1 has dogfood for ≥ 1 week with `tierkit doctor gateway` reporting
   ok across all checks on a real workstation.
2. The per-request safe log shows zero crashes / unexpected 5xx in the trailing
   7 days: `jq 'select(.status >= 500)' .tierkit/runtime/anthropic-gateway.jsonl | wc -l == 0`.
3. The Direct fallback flow has been triggered at least once and resolved cleanly.

Phase 2 design constraint inherited from Phase 1:
- Any body transformation hook lands inside `forwardMessages` / `streamMessages`
  in `anthropicGateway.ts`. Phase 1's `Server.ts` route plumbing does not
  change.
```

- [ ] **Step 6: Push + open the Phase 1 PR (base = spike branch)**

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
- New: \`GET /v1/gateway/status\` (local-only)
- New: \`PATCH /v1/config/runtime\` (allowlisted to gatewayMode)
- New: \`GET /v1/doctor/gateway\`
- New: safe per-request log at \`.tierkit/runtime/anthropic-gateway.jsonl\` (5 MB / 7-day rotation, allowlist projection, serialized writes)
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
Those are tracked behind the Phase 2 entry gate in the RFC.

## Test plan

- [ ] \`pnpm -r build && pnpm -r test\` green
- [ ] User-facing language audit green (Task 12 Step 3)
- [ ] Manual flows from \`packages/vscode-tierkit/test/MANUAL_gateway_flows.md\` 1–6 all pass
- [ ] \`tierkit doctor gateway\` returns OK on a configured workstation
- [ ] Safe log inspected — no raw token, no body

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist (run before declaring "done")

**Coverage:** every Phase 1 scope item from RFC §3 is implemented:

| RFC item | Tasks |
|---|---|
| 1. Setting + sidebar toggle | 1, 7 |
| 2. Scoped env injection only (no shell profile mutation) | 8 |
| 3. Per-request safe log + rotation | 2, 4 |
| 4. Auto-heal + Direct fallback | 8, 9 |
| 5. Onboarding card | 10, 11 |
| 6. \`tierkit doctor gateway\` | 5, 6, 10 |
| 7. README + UI language (EN + KR) | 11 |
| 8. Phase 2 entry gate | 12 |

**Hard rules verified:**

- [ ] User-facing language audit (Task 12 Step 3) prints `language audit ok`.
- [ ] Body-redaction audit (Task 12 Step 4) prints `redaction audit ok`.
- [ ] `buildGatewayEnv` test asserts `ANTHROPIC_API_KEY` is preserved verbatim.
- [ ] `gatewayLog.redaction.test.ts` asserts no `body`, no `authorizationRaw`, no `apiKeyRaw` reaches disk even when callers pass them.
- [ ] `doctorGateway` makes zero requests to `api.anthropic.com`.
- [ ] Only one `gatewayMode` storage location: `tierkit.config.json::runtime.gatewayMode`. No VS Code configuration property.
- [ ] Direct fallback terminal explicitly removes `ANTHROPIC_BASE_URL` (Test 5).

---

## Execution handoff

Two options:

1. **Subagent-driven (recommended)** — REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline** — REQUIRED SUB-SKILL: `superpowers:executing-plans`.
