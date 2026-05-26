# Anthropic Gateway Phase 1 Implementation Plan (rev6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize the Phase 0 Anthropic-passthrough as a safe connection feature in Tierkit — config flag, scoped terminal launch, on-daemon status endpoint, local-only diagnostics, safe per-request log with value-constrained rotation, sidebar toggle, daemon auto-restart pre-flight, and explicit direct fallback.

**Architecture:** Layer config + UX + safe logging + local-only status/diagnostic endpoints on top of the validated Phase 0 passthrough. Pure helpers live in modules with NO `vscode` import so unit tests run without the VS Code runtime. Daemon control state is a discriminated union — `reachable` / `transport-failure` / `rejected` — so the extension never silently writes the config when the daemon rejected a request, and never auto-retries after an attempted-PATCH transport failure (which would risk double-toggling). The safe-log schema enforces semantic invariants (no fingerprint without channel presence). Streaming errors log the HTTP status the client actually observed, not the would-be 502.

**Tech Stack:**
- Backend: TypeScript, Node 20+, plain `http` (existing `Server.ts`), `fetch()` (already in spike)
- Config: zod (existing schema layer)
- CLI: `clipanion`
- VS Code extension: `vscode` API
- Tests: vitest

---

## Mandatory corrections before implementation

The following corrections override conflicting snippets elsewhere. Each task is already aligned; this section is the executive summary the executor verifies against.

1. **Safe log shape is value-constrained.** `path` enum, `authorizationScheme` enum `["Bearer", "Other"]`, fingerprints regex `^[0-9a-f]{12}$`, `ts` datetime. `apiKeyPresent` has NO default — missing must fail.

2. **Input is unknown.** `appendGatewayLog()` accepts `unknown` and projects allowlisted fields at runtime.

3. **Local-only enforcement (server).** `GET /v1/gateway/status`, `PATCH /v1/config/runtime`, `GET /v1/doctor/gateway` reject non-loopback callers with HTTP 403 via `isLoopbackRemoteAddress(addr)`.

4. **Canonical dataDir resolver.** A single helper `resolveRuntimeDataDir(dataDir, cwd)`. Status, log writer, doctor MUST use the same resolved directory.

5. **No real upstream in tests.** All `/v1/messages*` tests set `TIERKIT_ANTHROPIC_UPSTREAM` to a mock server URL.

6. **Deterministic logging contract.** Non-stream: `await logFinal(status)` BEFORE `res.end(body)`. Stream: log after `streamMessages()` resolves. Stronger pre-client-completion stream guarantees deferred to Phase 2.

7. **Transport-error status records match the emitted HTTP status.** Before response headers are sent, an upstream transport error returns and logs HTTP 502. After streaming headers have already been sent, the safe log records `res.statusCode` (the status the client actually observed) and the stream is destroyed. A dedicated stream-abort outcome field is deferred to Phase 2.

8. **PATCH validates the full result.** `PATCH /v1/config/runtime` parses through `TierkitConfigSchema.parse()` before atomic write.

9. **Ordinary `tierkit doctor` is NOT touched.**

10. **Public core export.** `doctorGateway` exported from `packages/core/src/index.ts`.

11. **Diff-based language audit.**

12. **No unconditional `acquireVsCodeApi()` in gui.ts.**

13. **Offline toggle reads the file before flipping** (so OFF transitions work when the daemon is down).

14. **Readiness distinguishes mode-off from unreachable.** Mode-off → guidance immediately, no daemon restart.

15. **Authorization scheme must not cause silent log loss.** Server.ts maps any non-Bearer raw scheme to `"Other"` before logging.

16. **Cover every modified proxy route in tests.** `/v1/messages` (off, on non-stream, on stream, 502 pre-headers), `/v1/messages/count_tokens` (off, on). Mock upstream parses request body and returns SSE when `stream: true`.

17. **Audit actual dialog and CLI strings** including `extension.ts`, `DoctorGatewayCommand.ts`, and the manual test plan markdown.

18. **Direct fallback honors `TIERKIT_CLAUDE_CODE_BIN`.**

19. **Offline file fallback is constrained.** Extension only mutates `runtime.gatewayMode` and rejects a pre-existing malformed value.

20. **Canonical loopback URL for SERVER-side endpoint registration / doctor.** `doctorGateway` probes `loopbackControlUrl(host, port)`.

21. **`appendGatewayLog()` is `async`.** Schema/byte-guard failures surface as rejected Promises; `await expect(...).rejects.toThrow()` works.

22. **VS Code control requests also use loopback** via `controlBaseUrlFromConfiguredBaseUrl(...)`.

23. **Offline fallback is allowed only before any mutation request is sent.** If the initial `GET /v1/gateway/status` fails due to transport failure, the extension may perform the atomic file fallback. Once a PATCH request has been attempted, any transport failure is ambiguous: the daemon may already have committed the write. In that case, show an indeterminate-state error and require the user to refresh/retry; NEVER perform a second file mutation automatically.

24. **Offline config mutation is pure-tested** via `gatewayModeConfig.ts` helpers.

25. **Doctor loopback test checks the displayed URL** (asserts on `label`, not `detail`).

26. **Streaming mock responds based on the request body.**

27. **Sensitive-logging audit is a review aid, not a guard.** Diff-based, advisory.

28. **Docs describe the auth record shape accurately** (classification, not separate "present" boolean).

29. **Control-URL helper exists before Task 8 consumes it.** `controlBaseUrlFromConfiguredBaseUrl()` is a shared control-plane helper, not a terminal-launch-only helper. It lives in its OWN file (`packages/vscode-tierkit/src/gatewayControlUrl.ts`) with its own pure test, created in Task 8 BEFORE the extension toggle code. Both Task 8 and Task 9 import from it. Task 8 must never `import` from a file created later in Task 9.

30. **HTTP rejection is not transport failure.** A reachable `/v1/gateway/status` with non-2xx status, or a malformed successful body, MUST surface an error and stop. The discriminated reachability type is `{kind:"reachable"} | {kind:"transport-failure"} | {kind:"rejected"}`. File fallback runs only on `transport-failure`.

31. **Never retry a possibly committed PATCH via file mutation.** Once `PATCH /v1/config/runtime` has been attempted, a thrown fetch error is ambiguous: the daemon may have already committed the write before the response was lost. Show an indeterminate-state error and ask the user to refresh and retry. Do NOT execute offline file fallback after an attempted PATCH.

32. **Streaming error status reflects what the client received.** When headers have already been sent (stream in progress), an upstream failure logs `res.statusCode` (the status the client observed). Logging `502` in that case would make the safe log diverge from what actually happened on the wire.

33. **Auth fields enforce semantic invariants.** `superRefine()` adds:
    - `authorizationScheme === null` iff `authorizationFingerprint === null`
    - `apiKeyPresent === false` iff `apiKeyFingerprint === null`

34. **Document supported control-plane bind modes.** Loopback canonicalization rescues daemons bound to `127.0.0.1`, `::1`, `0.0.0.0`, `::`. A daemon bound only to a specific LAN interface (e.g. `192.168.1.50`) is NOT reachable through Phase 1's local-control flow — explicitly documented as out of scope.

35. **Keep pure tests independent of the VS Code runtime.** Split the extension helpers:
    - `gatewayControlUrl.ts` — pure, no `vscode` import
    - `gatewayLaunchCore.ts` — pure (`buildGatewayEnv`, `gatewayLaunchCommand`, `classifyReadiness`, `nextGatewayMode`)
    - `gatewayModeConfig.ts` — pure (`readGatewayModeFromConfig`, `withGatewayMode`)
    - `gatewayTerminal.ts` — VS Code side effects only (`openGatewayTerminal`)
    The first three are unit-tested; pure tests never import `vscode`.

---

## Context — read these first

1. **Phase 0 spike code is already in this branch.** Verify with `git log --oneline main..HEAD`. Phase 1 PR base = spike branch until Phase 0 merges.

2. **Files this plan reuses:**
   - `packages/core/src/runtime/anthropicGateway.ts` — `forwardMessages`, `streamMessages`, `forwardCountTokens`, `pickForwardHeaders` (header allowlist does NOT include `accept`), `observeAuthHeaders` (returns raw scheme prefix), `upstreamUrl()` override via `TIERKIT_ANTHROPIC_UPSTREAM`.
   - `packages/core/src/runtime/Server.ts` — Phase 0 routes wired unconditionally.
   - `packages/core/src/runtime/usageLog.ts` — JSONL pattern.
   - `packages/core/src/config/TierkitConfig.ts` — zod schemas.
   - `packages/core/src/usecases/doctor.ts` — `DoctorCheck` type (re-used, not modified).
   - `packages/cli/src/commands/DoctorCommand.ts` — clipanion command pattern.
   - `packages/vscode-tierkit/src/extension.ts` — `maybeStartDaemon` (~line 399), `registerCommand` (~834+), sidebar webview's `onDidReceiveMessage` (~572-603), main-panel webview's equivalent (~279-299).

3. **Phase 0 RFC** (`docs/RFC-anthropic-gateway.md`): all four validations passed.

---

## What this plan does NOT do

| Excluded | Why |
|---|---|
| Body transformation / compression / dedupe / pagination | Phase 2. |
| Per-call efficiency claims | No measurement = no claim. |
| `~/.zshrc` / persistent shell profile mutation | Too invasive. |
| Forcing or removing the user's Anthropic credential | Auth choice preserved. |
| `POST /v1/models` discovery | Already gated by Claude Code. |
| Local-LLM routing | Phase 3. |
| OAuth admin endpoints | Hardcoded by Claude Code. |
| Strengthening stream pre-completion logging guarantee | Requires `anthropicGateway.ts` change → Phase 2. |
| Stream-abort outcome field | Phase 2 (correction 32 records `res.statusCode` instead). |
| Integrating gateway into ordinary `tierkit doctor` | Opt-in via `tierkit doctor gateway`. |
| Reaching a daemon bound only to a specific LAN interface | Out of scope (correction 34). |

### User-facing language audit rule

Forbidden in user-facing strings (README, `docs/ANTHROPIC_GATEWAY*.md`, newly added sidebar HTML, `package.json::contributes`, `package.nls*.json`, `extension.ts` dialogs, `DoctorGatewayCommand.ts`, manual test markdown): `\bsavings\b`, `\bsave\b`, `\bsaves\b`, `\bsaved\b`, `\bcost\b`, `\bcheaper\b`, `\befficient\b`, `절감`, `절약`, `비용`, `효율`, numeric token-count claims.

Preferred vocabulary: route, connection, passthrough, diagnostic, status, 연결, 라우팅, 진단. Audit is diff-based (Task 13).

---

## File Structure

**New files:**
- `packages/core/src/runtime/gatewayLog.ts` — async writer with value-constrained schema + superRefine + queue + rotation
- `packages/core/test/gatewayLog.test.ts`
- `packages/core/test/gatewayLog.redaction.test.ts`
- `packages/core/src/runtime/gatewayStatus.ts`
- `packages/core/test/gatewayStatus.test.ts`
- `packages/core/src/runtime/loopback.ts` — `isLoopbackRemoteAddress`, `loopbackControlUrl` (server-side)
- `packages/core/test/loopback.test.ts`
- `packages/core/src/runtime/runtimePaths.ts`
- `packages/core/test/runtimePaths.test.ts`
- `packages/core/src/usecases/doctorGateway.ts`
- `packages/core/test/doctorGateway.test.ts`
- `packages/cli/src/commands/DoctorGatewayCommand.ts`
- `packages/cli/test/doctorGatewayCommand.test.ts`
- **`packages/vscode-tierkit/src/gatewayControlUrl.ts`** — pure: `controlBaseUrlFromConfiguredBaseUrl`. NO `vscode` import. (correction 29, 35)
- **`packages/vscode-tierkit/test/gatewayControlUrl.test.ts`**
- **`packages/vscode-tierkit/src/gatewayLaunchCore.ts`** — pure: `buildGatewayEnv`, `gatewayLaunchCommand`, `classifyReadiness`, `nextGatewayMode`. NO `vscode` import. (correction 35)
- **`packages/vscode-tierkit/test/gatewayLaunchCore.test.ts`**
- `packages/vscode-tierkit/src/gatewayModeConfig.ts` — pure: `readGatewayModeFromConfig`, `withGatewayMode`. NO `vscode` import.
- `packages/vscode-tierkit/test/gatewayModeConfig.test.ts`
- **`packages/vscode-tierkit/src/gatewayTerminal.ts`** — VS Code side effects: `openGatewayTerminal`. Imports `vscode` + `gatewayLaunchCore`. (correction 35)
- `packages/vscode-tierkit/src/webviewCommandAllowlist.ts`
- `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts`
- `packages/vscode-tierkit/test/MANUAL_gateway_flows.md`
- `docs/ANTHROPIC_GATEWAY.md` + `docs/ANTHROPIC_GATEWAY.ko.md`

**Modified files:**
- `packages/core/src/config/TierkitConfig.ts` — add `gatewayMode`
- `packages/core/src/runtime/Server.ts` — gate spike routes; non-stream log-before-end; **streaming error logs `res.statusCode`**; loopback-guarded status / doctor / PATCH; `resolveRuntimeDataDir` everywhere; scheme normalization
- `packages/core/src/index.ts` — export `doctorGateway` + types
- `packages/cli/src/cli.ts` — register `DoctorGatewayCommand`
- `packages/vscode-tierkit/src/extension.ts` — register two commands; `tk:cmd` allowlist; toggle uses discriminated reachability + transport-failure-only fallback + post-PATCH ambiguity stop; launch uses `gatewayLaunchCore` + `gatewayTerminal`
- `packages/vscode-tierkit/package.json` — add the two commands; no `tierkit.gatewayMode` config property
- `packages/vscode-tierkit/package.nls.json` + `package.nls.ko.json`
- `packages/core/src/runtime/ui/gui.ts` — toggle row + diagnostics card (existing bridge)
- `README.md`

**Removed from prior revisions:** `gatewayLaunch.ts` (its responsibilities split across `gatewayControlUrl.ts`, `gatewayLaunchCore.ts`, `gatewayTerminal.ts`).

**Untouched:**
- `packages/core/src/runtime/anthropicGateway.ts`
- `packages/core/src/usecases/doctor.ts`

---

## Task order

| Order | Task |
|---|---|
| 0 | Branch verification |
| 1 | `gatewayMode` schema |
| 2 | `gatewayLog` (async + value-constrained schema + superRefine + queue + rotation) |
| 3 | `loopback.ts` + `runtimePaths.ts` helpers (core-side) |
| 4 | `GET /v1/gateway/status` (loopback-guarded) |
| 5 | Route gate + deterministic safe-log wiring + streaming-aware error logging + scheme normalization (mock upstream parses body) |
| 6 | `doctorGateway` (uses `loopbackControlUrl`, label-asserted test) + core export |
| 7 | `tierkit doctor gateway` CLI |
| 8 | Sidebar toggle — pure VS Code helpers FIRST (control URL, config mutation, webview allowlist), then server PATCH, then extension toggle with discriminated reachability + no-fallback-after-PATCH, then sidebar HTML |
| 9 | Scoped terminal launch — pure `gatewayLaunchCore` + VS Code-side `gatewayTerminal` + extension launch command |
| 10 | Manual test plan |
| 11 | `GET /v1/doctor/gateway` + sidebar diagnostics card |
| 12 | Docs (EN + KR) — accurate auth shape + supported bind modes note |
| 13 | Full regression + diff-based language audit + sensitive-logging review aid + Phase 2 entry-gate |

---

## Task 0: Verify branch state

- [ ] **Step 1**: `git status` (clean) on `worktree-anthropic-gateway-phase1`.
- [ ] **Step 2**: spike commits reachable + 4 spike files present.
- [ ] **Step 3**: `pnpm install --frozen-lockfile && pnpm -r build && pnpm --filter @tierkit/core test -- anthropicGateway Server.anthropicGateway` green.
- [ ] **Step 4**: no commit.

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

- [ ] **Step 3: Implement** in `TierkitConfig.ts` inside `RuntimeConfigSchema.object({...})` after `discoverOllamaModels`:

```typescript
    /**
     * Anthropic Gateway flag. When "on", the daemon serves /v1/messages and
     * /v1/messages/count_tokens as a transparent passthrough so Claude Code
     * can be pointed at it via ANTHROPIC_BASE_URL. Default "off".
     *
     * This flag does NOT enable any request/response transformation.
     */
    gatewayMode: z.enum(["off", "on"]).default("off"),
```

- [ ] **Step 4: Tests pass**

```bash
pnpm --filter @tierkit/core test -- "configGatewayMode|config"
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/TierkitConfig.ts packages/core/test/configGatewayMode.test.ts
git commit -m "feat(core): runtime.gatewayMode (off|on, default off)"
```

---

## Task 2: Safe gateway log writer (async + value-constrained + superRefine + queue + rotation)

**Why:** Phase 1's hard rule. The function is `async` so all failures (including schema validation and the byte guard) surface as rejected Promises (correction 21). Value constraints prevent secret leakage and oversized records (corrections 1, 15). `superRefine()` enforces the documented invariant that fingerprint nullity matches channel presence (correction 33).

### Design

- `async appendGatewayLog(filePath, input: unknown, opts?): Promise<void>`
- Value-constrained schema: `path` enum, `authorizationScheme: ["Bearer", "Other"]`, fingerprints regex, `ts` datetime, `apiKeyPresent` boolean without default.
- `superRefine()` invariants:
  - `authorizationScheme === null` iff `authorizationFingerprint === null`
  - `apiKeyPresent === false` iff `apiKeyFingerprint === null`
- Module-level promise queue.
- `append → maybeTrim`; bounded line size; defensive byte guard.

**Files:**
- Create: `packages/core/src/runtime/gatewayLog.ts`
- Create: `packages/core/test/gatewayLog.test.ts`
- Create: `packages/core/test/gatewayLog.redaction.test.ts`

- [ ] **Step 1: Failing redaction + invariant tests**

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
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @tierkit/core test -- gatewayLog.redaction
```

- [ ] **Step 3: Failing shape/rotation/concurrency/oversized tests**

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

async function tmpDir() { return mkdtemp(path.join(tmpdir(), "gw-log-")); }

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
    } finally { await rm(dir, { recursive: true, force: true }); }
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

      expect((await stat(file)).size).toBeLessThanOrEqual(GATEWAY_LOG_MAX_BYTES);
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      expect(JSON.parse(lines.at(-1)!).status).toBe(201);
    } finally { await rm(dir, { recursive: true, force: true }); }
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
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("gatewayLog — concurrency", () => {
  it("serializes parallel calls deterministically", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "anthropic-gateway.jsonl");
      const N = 50;
      await Promise.all(Array.from({ length: N }, (_, i) => appendGatewayLog(file, record({ status: 200 + i }))));
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(N);
      for (const line of lines) JSON.parse(line);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("gatewayLog — oversized guard", () => {
  it("schema rejects an oversized path string (async rejection)", async () => {
    const dir = await tmpDir();
    try {
      const file = path.join(dir, "anthropic-gateway.jsonl");
      const evil = record({ path: "/v1/messages?" + "x".repeat(GATEWAY_LOG_MAX_BYTES) });
      await expect(appendGatewayLog(file, evil)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 4: Verify failure**

```bash
pnpm --filter @tierkit/core test -- "gatewayLog "
```

- [ ] **Step 5: Implement `gatewayLog.ts`** (async + superRefine):

```typescript
// packages/core/src/runtime/gatewayLog.ts
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const GATEWAY_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const GATEWAY_LOG_MAX_AGE_DAYS = 7;
const FINGERPRINT_RE = /^[0-9a-f]{12}$/;

const GatewayAuthSchema = z
  .object({
    authorizationScheme: z.enum(["Bearer", "Other"]).nullable(),
    authorizationFingerprint: z.string().regex(FINGERPRINT_RE).nullable(),
    apiKeyPresent: z.boolean(),
    apiKeyFingerprint: z.string().regex(FINGERPRINT_RE).nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.authorizationScheme === null) !== (v.authorizationFingerprint === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizationFingerprint"],
        message: "authorizationFingerprint and authorizationScheme must both be null or both be non-null",
      });
    }
    if (v.apiKeyPresent === false && v.apiKeyFingerprint !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyFingerprint"],
        message: "apiKeyFingerprint must be null when apiKeyPresent is false",
      });
    }
    if (v.apiKeyPresent === true && v.apiKeyFingerprint === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyFingerprint"],
        message: "apiKeyFingerprint is required when apiKeyPresent is true",
      });
    }
  });

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

export interface AppendGatewayLogOptions { now?: Date; }

function projectAndValidate(input: unknown): GatewayLogRecord {
  if (!input || typeof input !== "object") throw new Error("gateway log input must be an object");
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

export async function appendGatewayLog(
  filePath: string,
  input: unknown,
  opts: AppendGatewayLogOptions = {},
): Promise<void> {
  const record = projectAndValidate(input);
  const line = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(line, "utf8") > GATEWAY_LOG_MAX_BYTES) {
    throw new Error("gateway log record exceeds maximum file size");
  }
  const work = writeQueue.then(() => appendImpl(filePath, line, opts));
  writeQueue = work.catch(() => undefined);
  await work;
}

async function appendImpl(filePath: string, line: string, opts: AppendGatewayLogOptions): Promise<void> {
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
          } catch { needsTrim = true; }
        }
      }
    } finally { await fd.close(); }
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
    } catch { /* drop malformed */ }
  }
  const kept: string[] = [];
  let keptBytes = 0;
  for (let i = ageKept.length - 1; i >= 0; i--) {
    const sz = Buffer.byteLength(ageKept[i]!, "utf8") + 1;
    if (keptBytes + sz > GATEWAY_LOG_MAX_BYTES) break;
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

- [ ] **Step 6: Tests pass + commit**

```bash
pnpm --filter @tierkit/core test -- gatewayLog
git add packages/core/src/runtime/gatewayLog.ts \
        packages/core/test/gatewayLog.test.ts \
        packages/core/test/gatewayLog.redaction.test.ts
git commit -m "feat(core): gatewayLog — async, value-constrained, superRefine invariants, queue"
```

---

## Task 3: `loopback.ts` + `runtimePaths.ts` helpers

**Files:**
- Create: `packages/core/src/runtime/loopback.ts`
- Create: `packages/core/test/loopback.test.ts`
- Create: `packages/core/src/runtime/runtimePaths.ts`
- Create: `packages/core/test/runtimePaths.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
// packages/core/test/loopback.test.ts
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

- [ ] **Step 2: Implement**

```typescript
// packages/core/src/runtime/loopback.ts
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackRemoteAddress(addr: string | undefined): boolean {
  return typeof addr === "string" && LOOPBACK.has(addr);
}

export function loopbackControlUrl(host: string, port: number): string {
  if (host.includes(":")) return `http://[::1]:${port}`;
  return `http://127.0.0.1:${port}`;
}
```

```typescript
// packages/core/src/runtime/runtimePaths.ts
import path from "node:path";
export function resolveRuntimeDataDir(dataDir: string, cwd: string): string {
  return path.isAbsolute(dataDir) ? dataDir : path.resolve(cwd, dataDir);
}
```

- [ ] **Step 3: Tests + commit**

```bash
pnpm --filter @tierkit/core test -- "loopback|runtimePaths"
git add packages/core/src/runtime/loopback.ts packages/core/src/runtime/runtimePaths.ts \
        packages/core/test/loopback.test.ts packages/core/test/runtimePaths.test.ts
git commit -m "feat(core): loopback + runtimePaths helpers"
```

---

## Task 4: `GET /v1/gateway/status` — loopback-guarded

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

- [ ] **Step 3: Failing endpoint test**

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
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("returns routesEnabled=false when off", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/gateway/status`);
      expect(((await res.json()) as { routesEnabled: boolean }).routesEnabled).toBe(false);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 4: Add the route** in `Server.ts`:

```typescript
import { isLoopbackRemoteAddress } from "./loopback.js";
import { resolveRuntimeDataDir } from "./runtimePaths.js";
import { buildGatewayStatus } from "./gatewayStatus.js";
```

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
git commit -m "feat(core): GET /v1/gateway/status — loopback, resolved dataDir"
```

---

## Task 5: Route gate + deterministic safe-log wiring + streaming-aware error logging + scheme normalization

**Why:** Phase 0 routes gate on `gatewayMode`. Safe log writes deterministically (non-stream before `res.end`, stream after `streamMessages` resolves). The catch block distinguishes pre-headers vs post-headers errors: pre-headers returns 502 and logs 502; post-headers logs `res.statusCode` because the client has already observed that status (correction 32). Authorization scheme is normalized to `"Bearer" | "Other"` so no header causes log loss (correction 15). Tests use mock upstream that responds to SSE based on body, not Accept header (correction 26).

**Files:**
- Modify: `packages/core/src/runtime/Server.ts`
- Create: `packages/core/test/Server.gatewayMode.test.ts`

- [ ] **Step 1: Failing tests (mock upstream decides on body, not headers)**

```typescript
// packages/core/test/Server.gatewayMode.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { startServer } from "../src/runtime/Server.js";
import { gatewayLogPath } from "../src/runtime/gatewayLog.js";
import { resolveRuntimeDataDir } from "../src/runtime/runtimePaths.js";

let upstream: HttpServer;
let upstreamUrl: string;
let upstreamRequests: Array<{ method: string; path: string }>;

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk.toString();
  return raw;
}

beforeAll(async () => {
  upstreamRequests = [];
  upstream = createServer(async (req, res) => {
    upstreamRequests.push({ method: req.method ?? "?", path: req.url ?? "?" });
    const raw = await readBody(req);
    let body: { stream?: boolean } = {};
    try { body = JSON.parse(raw); } catch { /* leave empty */ }

    if (req.url === "/v1/messages" && body.stream === true) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }
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

function logPathFor(dir: string): string {
  return gatewayLogPath(resolveRuntimeDataDir(".tierkit/runtime", dir));
}

describe("Server — gatewayMode gate", () => {
  it("returns 404 for /v1/messages when off", async () => {
    const { srv, dir, url } = await startWith("off");
    try {
      const r = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }) });
      expect(r.status).toBe(404);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("returns 404 for /v1/messages/count_tokens when off", async () => {
    const { srv, dir, url } = await startWith("off");
    try {
      const r = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) });
      expect(r.status).toBe(404);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("forwards /v1/messages to MOCK upstream when on", async () => {
    const before = upstreamRequests.length;
    const { srv, dir, url } = await startWith("on");
    try {
      const r = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }) });
      expect(r.status).toBe(200);
      expect(upstreamRequests.length).toBe(before + 1);
      expect(upstreamRequests.at(-1)!.path).toBe("/v1/messages");
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("forwards /v1/messages/count_tokens to MOCK upstream when on", async () => {
    const before = upstreamRequests.length;
    const { srv, dir, url } = await startWith("on");
    try {
      const r = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) });
      expect(r.status).toBe(200);
      expect(upstreamRequests.length).toBe(before + 1);
      expect(upstreamRequests.at(-1)!.path).toBe("/v1/messages/count_tokens");
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe("Server — safe log (deterministic, every route)", () => {
  it("non-stream /v1/messages: log present IMMEDIATELY when fetch resolves", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-test-NEVER-PERSISTED" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      const raw = await readFile(logPathFor(dir), "utf8");
      expect(raw.trim().split("\n")).toHaveLength(1);
      expect(raw).not.toContain("sk-test-NEVER-PERSISTED");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.path).toBe("/v1/messages");
      expect(parsed.stream).toBe(false);
      expect(parsed.status).toBe(200);
      expect(parsed.auth.apiKeyPresent).toBe(true);
      expect(parsed.auth.apiKeyFingerprint).toMatch(/^[0-9a-f]{12}$/);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("/v1/messages/count_tokens: writes path + stream:false to safe log", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) });
      const parsed = JSON.parse((await readFile(logPathFor(dir), "utf8")).trim());
      expect(parsed.path).toBe("/v1/messages/count_tokens");
      expect(parsed.stream).toBe(false);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("streaming /v1/messages: writes stream:true AFTER the stream completes (mock decides on body)", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, stream: true, messages: [] }),
      });
      await res.text(); // drain
      const parsed = JSON.parse((await readFile(logPathFor(dir), "utf8")).trim());
      expect(parsed.path).toBe("/v1/messages");
      expect(parsed.stream).toBe(true);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  it("pre-headers transport error → HTTP 502 AND log records status: 502", async () => {
    process.env.TIERKIT_ANTHROPIC_UPSTREAM = "http://127.0.0.1:1";
    const { srv, dir, url } = await startWith("on");
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      expect(r.status).toBe(502);
      const parsed = JSON.parse((await readFile(logPathFor(dir), "utf8")).trim());
      expect(parsed.status).toBe(502);
    } finally {
      process.env.TIERKIT_ANTHROPIC_UPSTREAM = upstreamUrl;
      await srv.stop(); await rm(dir, { recursive: true, force: true });
    }
  });

  it("non-Bearer Authorization scheme is recorded as 'Other'", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Basic abc123" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      const parsed = JSON.parse((await readFile(logPathFor(dir), "utf8")).trim());
      expect(parsed.auth.authorizationScheme).toBe("Other");
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });

  // Post-headers stream abort coverage is in Task 10 Test 11 (manual). The automated
  // version requires a mid-stream upstream socket close, which is timing-sensitive
  // in vitest. The implementation in Server.ts catch block logs res.statusCode
  // (not 502) when res.headersSent is true.
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @tierkit/core test -- Server.gatewayMode
```

- [ ] **Step 3: Gate + log in `Server.ts` — streaming-aware catch (correction 32)**

```typescript
import { appendGatewayLog, gatewayLogPath } from "./gatewayLog.js";
import { observeAuthHeaders } from "./anthropicGateway.js";
import { resolveRuntimeDataDir } from "./runtimePaths.js";
```

```typescript
function normalizeAuthorizationScheme(raw: string | null): "Bearer" | "Other" | null {
  if (raw === null) return null;
  return raw === "Bearer" ? "Bearer" : "Other";
}
```

`/v1/messages` block:

```typescript
      if (route === "POST /v1/messages") {
        if (opts.config.runtime.gatewayMode !== "on") return sendJson(res, 404, { error: "not_found" });

        const startedAt = Date.now();
        const auth = observeAuthHeaders(req.headers);
        const body = await readRawBody(req);
        const wantsStream = isStreamingMessagesBody(body);
        const logPath = gatewayLogPath(resolveRuntimeDataDir(opts.config.runtime.dataDir, opts.cwd));

        const logFinal = async (status: number): Promise<void> => {
          try {
            await appendGatewayLog(logPath, {
              ts: new Date(startedAt).toISOString(),
              path: "/v1/messages",
              stream: wantsStream,
              status,
              durationMs: Date.now() - startedAt,
              auth: {
                authorizationScheme: normalizeAuthorizationScheme(auth.authorizationScheme),
                authorizationFingerprint: auth.authorizationFingerprint,
                apiKeyPresent: auth.hasApiKey,
                apiKeyFingerprint: auth.apiKeyFingerprint,
              },
            });
          } catch (err) {
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
          await logFinal(r.status);
          for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
          res.statusCode = r.status;
          res.end(r.body);
          return;
        } catch (err) {
          // correction 32: if the stream has already sent headers, the client has
          // observed res.statusCode (usually 200). Logging 502 would diverge from
          // what actually happened on the wire. Record the observed status and
          // destroy the stream. Before headers, return + log 502.
          if (res.headersSent) {
            await logFinal(res.statusCode);
            res.destroy(err as Error);
            return;
          }
          await logFinal(502);
          return sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: (err as Error).message } });
        }
      }
```

Mirror for `/v1/messages/count_tokens` with `path: "/v1/messages/count_tokens"`, `stream: false`, no streaming branch (so the post-headers case is unreachable — non-stream `await logFinal(r.status)` runs before `res.end`, the catch always sees `headersSent: false`, and logs 502).

- [ ] **Step 4: Tests pass + commit**

```bash
pnpm --filter @tierkit/core test
git add packages/core/src/runtime/Server.ts packages/core/test/Server.gatewayMode.test.ts
git commit -m "feat(core): gate routes; log-before-end; streaming-aware error status; scheme normalization"
```

---

## Task 6: `doctorGateway` (uses `loopbackControlUrl`, label-asserted test) + core export

**Why:** Local-only diagnostic via `loopbackControlUrl` (correction 20). The "non-loopback host" test asserts on the displayed `label` (correction 25) so a regression to `runtime.host` URLs would be caught.

**Files:**
- Create: `packages/core/src/usecases/doctorGateway.ts`
- Create: `packages/core/test/doctorGateway.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Failing test (label assertion)**

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
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports daemon unreachable when no daemon is running", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", port: 1 } });
    try {
      const d = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-daemon");
      expect(d?.status).toBe("fail");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports log path writable AND matches resolved dataDir", async () => {
    const dataDir = path.join(await mkdtemp(path.join(tmpdir(), "tk-gw-dd-")), ".tierkit/runtime");
    await mkdir(dataDir, { recursive: true });
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", dataDir } });
    try {
      const log = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-log-path");
      expect(log?.status).toBe("ok");
      expect(log?.detail).toContain(dataDir);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("probes loopback URL even when runtime.host is non-loopback (asserts on label)", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", host: "0.0.0.0", port: 1 } });
    try {
      const d = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-daemon");
      // The check's label embeds the URL doctor actually probed.
      expect(d?.label).toContain("http://127.0.0.1:1");
      expect(d?.label).not.toContain("0.0.0.0");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("uses [::1] when host is IPv6", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on", host: "::", port: 1 } });
    try {
      const d = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-daemon");
      expect(d?.label).toContain("[::1]:1");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("reports credential mode without echoing the value", async () => {
    const dir = await projectWith({ version: "0.1", runtime: { gatewayMode: "on" } });
    try {
      const cm = (await doctorGateway({ cwd: dir })).find((c) => c.id === "gateway-credential-mode");
      expect(cm?.status).toBe("ok");
      if (process.env.ANTHROPIC_API_KEY) {
        expect(cm?.detail).not.toContain(process.env.ANTHROPIC_API_KEY);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Implement** (uses `loopbackControlUrl`)

```typescript
// packages/core/src/usecases/doctorGateway.ts
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loadConfig.js";
import type { DoctorCheck } from "./doctor.js";
import { gatewayLogPath } from "../runtime/gatewayLog.js";
import { resolveRuntimeDataDir } from "../runtime/runtimePaths.js";
import { loopbackControlUrl } from "../runtime/loopback.js";

export interface DoctorGatewayInput { cwd?: string; }

export async function doctorGateway(input: DoctorGatewayInput = {}): Promise<DoctorCheck[]> {
  const cwd = input.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  const cfgResult = await loadConfig(cwd);
  const runtime = cfgResult.config.runtime;
  const baseUrl = loopbackControlUrl(runtime.host, runtime.port);
  const resolvedDataDir = resolveRuntimeDataDir(runtime.dataDir, cwd);

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

  if (runtime.gatewayMode === "on") {
    const reach = await probeDaemon(baseUrl);
    if (reach.ok) {
      checks.push({ id: "gateway-daemon", label: `daemon @ ${baseUrl}`, status: "ok" });
      checks.push(await probeStatusEndpoint(baseUrl));
    } else {
      checks.push({ id: "gateway-daemon", label: `daemon @ ${baseUrl}`, status: "fail", detail: reach.detail });
    }
  }

  checks.push(await checkLogWritable(resolvedDataDir));
  checks.push(checkClaudeBinary());
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
    if (body.routesEnabled !== true) return { id: "gateway-routes", label: "routes", status: "fail", detail: `routesEnabled=${body.routesEnabled}` };
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
  return { id: "gateway-claude-code", label: "claude (Claude Code CLI)", status: "warn", detail: "not detected on PATH — install Claude Code, then re-run." };
}

function checkCredentialMode(): DoctorCheck {
  const hasApiKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
  return { id: "gateway-credential-mode", label: "credential mode", status: "ok", detail: hasApiKey ? "api-key (ANTHROPIC_API_KEY is set)" : "subscription / unknown (no ANTHROPIC_API_KEY)" };
}
```

- [ ] **Step 3: Export from core barrel**

In `packages/core/src/index.ts`:

```typescript
export { doctorGateway } from "./usecases/doctorGateway.js";
export type { DoctorGatewayInput } from "./usecases/doctorGateway.js";
```

- [ ] **Step 4: Tests + build + commit**

```bash
pnpm --filter @tierkit/core test -- doctorGateway
pnpm --filter @tierkit/core build
git add packages/core/src/usecases/doctorGateway.ts \
        packages/core/test/doctorGateway.test.ts \
        packages/core/src/index.ts
git commit -m "feat(core): doctorGateway — loopback probe, label-asserted, public-exported"
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

Register in `packages/cli/src/cli.ts` next to `DoctorCommand`:

```typescript
import { DoctorGatewayCommand } from "./commands/DoctorGatewayCommand.js";
// ...
cli.register(DoctorGatewayCommand);
```

- [ ] **Step 3: Build + test + commit**

```bash
pnpm --filter @tierkit/cli build
pnpm --filter @tierkit/cli test -- doctorGatewayCommand
git add packages/cli/src/commands/DoctorGatewayCommand.ts packages/cli/src/cli.ts packages/cli/test/doctorGatewayCommand.test.ts
git commit -m "feat(cli): tierkit doctor gateway"
```

---

## Task 8: Sidebar toggle — pure VS Code helpers FIRST, then server PATCH, then extension toggle

**Why:** Three corrections converge here (29, 30, 31). The pure helpers (`gatewayControlUrl.ts`, `gatewayModeConfig.ts`, `webviewCommandAllowlist.ts`) are created BEFORE the extension code that imports them so the build order is correct (correction 29). The toggle's reachability is a discriminated union — non-2xx status responses are rejections, not transport failures (correction 30). Once a PATCH has been attempted and the response is lost, the extension does NOT execute file fallback — the daemon may have already committed (correction 31).

**Files:**
- Create: `packages/vscode-tierkit/src/gatewayControlUrl.ts`
- Create: `packages/vscode-tierkit/test/gatewayControlUrl.test.ts`
- Create: `packages/vscode-tierkit/src/gatewayModeConfig.ts`
- Create: `packages/vscode-tierkit/test/gatewayModeConfig.test.ts`
- Create: `packages/vscode-tierkit/src/webviewCommandAllowlist.ts`
- Create: `packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts`
- Modify: `packages/core/src/runtime/Server.ts` — loopback-guarded, full-schema-validated `PATCH /v1/config/runtime`
- Create: `packages/core/test/Server.patchRuntime.test.ts`
- Modify: `packages/vscode-tierkit/src/extension.ts`
- Modify: `packages/vscode-tierkit/package.json` (command only, no config property)
- Modify: `packages/vscode-tierkit/package.nls.json` + `package.nls.ko.json`
- Modify: `packages/core/src/runtime/ui/gui.ts`

### 8a. Pure helpers (NO `vscode` import)

- [ ] **Step 1: `gatewayControlUrl.ts` failing test**

```typescript
// packages/vscode-tierkit/test/gatewayControlUrl.test.ts
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
```

- [ ] **Step 2: Implement**

```typescript
// packages/vscode-tierkit/src/gatewayControlUrl.ts
/**
 * Canonicalize the user-configured `tierkit.baseUrl` into a loopback control
 * URL. Phase 1's control endpoints reject non-loopback callers; the extension
 * must always use this canonical URL for control calls.
 *
 * Pure. NO `vscode` import. Unit-testable without the VS Code runtime.
 *
 * NOTE: This canonicalization rescues daemons bound to 127.0.0.1, ::1,
 * 0.0.0.0, or :: only. A daemon bound only to a specific LAN interface
 * (e.g. 192.168.1.50) is NOT reachable through this flow — see
 * docs/ANTHROPIC_GATEWAY.md.
 */
export function controlBaseUrlFromConfiguredBaseUrl(configuredBaseUrl: string): string {
  const url = new URL(configuredBaseUrl);
  if (configuredBaseUrl.includes("[")) {
    return `http://[::1]:${url.port}`;
  }
  return `http://127.0.0.1:${url.port}`;
}
```

- [ ] **Step 3: Test passes**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayControlUrl
```

- [ ] **Step 4: `gatewayModeConfig.ts` failing test**

```typescript
// packages/vscode-tierkit/test/gatewayModeConfig.test.ts
import { describe, it, expect } from "vitest";
import { readGatewayModeFromConfig, withGatewayMode } from "../src/gatewayModeConfig.js";

describe("readGatewayModeFromConfig", () => {
  it("defaults absent gatewayMode to off", () => {
    expect(readGatewayModeFromConfig({ version: "0.1" })).toBe("off");
    expect(readGatewayModeFromConfig({ version: "0.1", runtime: {} })).toBe("off");
  });
  it("reads existing on so offline toggle can flip to off", () => {
    expect(readGatewayModeFromConfig({ runtime: { gatewayMode: "on" } })).toBe("on");
  });
  it("reads existing off", () => {
    expect(readGatewayModeFromConfig({ runtime: { gatewayMode: "off" } })).toBe("off");
  });
  it("rejects malformed existing values rather than silently coercing", () => {
    expect(() => readGatewayModeFromConfig({ runtime: { gatewayMode: "auto" } })).toThrow();
    expect(() => readGatewayModeFromConfig({ runtime: { gatewayMode: 1 } })).toThrow();
  });
});

describe("withGatewayMode", () => {
  it("mutates only runtime.gatewayMode", () => {
    expect(
      withGatewayMode(
        { version: "0.1", runtime: { port: 4101, dataDir: ".tierkit/runtime" }, plugins: { enabled: true } },
        "on",
      ),
    ).toEqual({
      version: "0.1",
      runtime: { port: 4101, dataDir: ".tierkit/runtime", gatewayMode: "on" },
      plugins: { enabled: true },
    });
  });
  it("creates runtime block when absent", () => {
    expect(withGatewayMode({ version: "0.1" }, "off").runtime).toEqual({ gatewayMode: "off" });
  });
});
```

- [ ] **Step 5: Implement**

```typescript
// packages/vscode-tierkit/src/gatewayModeConfig.ts
export type GatewayMode = "off" | "on";

export function readGatewayModeFromConfig(config: Record<string, unknown>): GatewayMode {
  const runtime =
    config.runtime && typeof config.runtime === "object"
      ? (config.runtime as Record<string, unknown>)
      : {};
  const value = runtime.gatewayMode;
  if (value === undefined) return "off";
  if (value === "off" || value === "on") return value;
  throw new Error("runtime.gatewayMode has an invalid value");
}

export function withGatewayMode(config: Record<string, unknown>, next: GatewayMode): Record<string, unknown> {
  const runtime =
    config.runtime && typeof config.runtime === "object"
      ? { ...(config.runtime as Record<string, unknown>) }
      : {};
  runtime.gatewayMode = next;
  return { ...config, runtime };
}
```

- [ ] **Step 6: Test passes**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayModeConfig
```

- [ ] **Step 7: Webview allowlist module + test**

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

### 8b. Server PATCH route (correction 8)

- [ ] **Step 8: Failing PATCH tests**

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
  it("flips gatewayMode and persists", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ gatewayMode: "on" }) });
      expect(res.status).toBe(200);
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.gatewayMode).toBe("on");
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects unknown fields", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ port: 9999 }) });
      expect(res.status).toBe(400);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects invalid gatewayMode values", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1" });
    try {
      const res = await fetch(`${url}/v1/config/runtime`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ gatewayMode: "auto" }) });
      expect(res.status).toBe(400);
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });
  it("preserves other valid runtime fields", async () => {
    const { srv, dir, url } = await startWith({ version: "0.1", runtime: { port: 4101, dataDir: ".custom/dd", host: "127.0.0.1" } });
    try {
      await fetch(`${url}/v1/config/runtime`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ gatewayMode: "on" }) });
      const disk = JSON.parse(await readFile(path.join(dir, "tierkit.config.json"), "utf8"));
      expect(disk.runtime.dataDir).toBe(".custom/dd");
      expect(disk.runtime.port).toBe(4101);
      expect(disk.runtime.gatewayMode).toBe("on");
    } finally { await srv.stop(); await rm(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 9: Implement the route** in `Server.ts` (imports add `TierkitConfigSchema`, `fs`, `path` if missing):

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

- [ ] **Step 10: Tests pass**

```bash
pnpm --filter @tierkit/core test -- Server.patchRuntime
```

### 8c. Extension toggle command — discriminated reachability + no-fallback-after-PATCH

- [ ] **Step 11: Imports**

At the top of `extension.ts`:

```typescript
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { isAllowedWebviewCommand } from "./webviewCommandAllowlist.js";
import { readGatewayModeFromConfig, withGatewayMode } from "./gatewayModeConfig.js";
import { controlBaseUrlFromConfiguredBaseUrl } from "./gatewayControlUrl.js";
```

- [ ] **Step 12: Register the toggle command** (corrections 13, 19, 23, 30, 31)

```typescript
    vscode.commands.registerCommand("tierkit.toggleGatewayMode", async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Open a folder first."));
        return;
      }
      const configuredBaseUrl =
        vscode.workspace.getConfiguration("tierkit").get<string>("baseUrl") ?? "http://127.0.0.1:4101";
      const controlBaseUrl = controlBaseUrlFromConfiguredBaseUrl(configuredBaseUrl);
      const cfgPath = nodePath.join(workspace.uri.fsPath, "tierkit.config.json");

      // Discriminated reachability — corrections 30 & 23.
      type Reach =
        | { kind: "reachable"; gatewayMode: "off" | "on" }
        | { kind: "transport-failure" }
        | { kind: "rejected"; status: number; detail: string };

      const probeDaemon = async (): Promise<Reach> => {
        let res: Response;
        try {
          res = await fetch(`${controlBaseUrl}/v1/gateway/status`);
        } catch {
          return { kind: "transport-failure" };
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return { kind: "rejected", status: res.status, detail };
        }
        let body: { gatewayMode?: unknown };
        try { body = (await res.json()) as { gatewayMode?: unknown }; }
        catch (err) { return { kind: "rejected", status: res.status, detail: (err as Error).message }; }
        if (body.gatewayMode !== "on" && body.gatewayMode !== "off") {
          return { kind: "rejected", status: res.status, detail: "Gateway status response contained an invalid gatewayMode." };
        }
        return { kind: "reachable", gatewayMode: body.gatewayMode };
      };

      const reach = await probeDaemon();

      if (reach.kind === "rejected") {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Tierkit daemon rejected the gateway status request.") +
            (reach.detail ? ` ${reach.detail}` : ""),
        );
        return;
      }

      if (reach.kind === "transport-failure") {
        // Pre-mutation transport failure → offline file fallback is allowed (correction 23).
        let cfg: Record<string, unknown>;
        try {
          cfg = JSON.parse(await fsp.readFile(cfgPath, "utf8")) as Record<string, unknown>;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            cfg = { version: "0.1" };
          } else {
            void vscode.window.showErrorMessage(`tierkit.config.json: ${(err as Error).message}`);
            return;
          }
        }
        let current: "off" | "on";
        try {
          current = readGatewayModeFromConfig(cfg);
        } catch {
          void vscode.window.showErrorMessage(
            vscode.l10n.t("tierkit.config.json runtime.gatewayMode has an invalid value. Fix it manually and re-toggle."),
          );
          return;
        }
        const next: "off" | "on" = current === "on" ? "off" : "on";
        const updated = withGatewayMode(cfg, next);
        const tmp = `${cfgPath}.tmp-${process.pid}-${Date.now()}`;
        await fsp.writeFile(tmp, JSON.stringify(updated, null, 2) + "\n");
        await fsp.rename(tmp, cfgPath);
        void vscode.commands.executeCommand("tierkit.restartDaemon");
        void vscode.window.showInformationMessage(
          next === "on"
            ? vscode.l10n.t("Gateway: on (offline file fallback applied; daemon will pick this up on restart).")
            : vscode.l10n.t("Gateway: off (offline file fallback applied)."),
        );
        sidebarRef?.render();
        return;
      }

      // reach.kind === "reachable" — daemon owns the write from here on.
      const next: "off" | "on" = reach.gatewayMode === "on" ? "off" : "on";

      let patchRes: Response;
      try {
        patchRes = await fetch(`${controlBaseUrl}/v1/config/runtime`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gatewayMode: next }),
        });
      } catch {
        // correction 31: PATCH attempted, response lost. Daemon may have already
        // committed. NEVER auto-fallback — show indeterminate-state error.
        void vscode.window.showErrorMessage(
          vscode.l10n.t("The gateway update request did not complete cleanly. Check the current status (sidebar) before trying again."),
        );
        sidebarRef?.render();
        return;
      }

      if (!patchRes.ok) {
        const detail = await patchRes.text().catch(() => "");
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Tierkit daemon rejected the gateway mode update.") +
            (detail ? ` ${detail}` : ""),
        );
        return;
      }

      void vscode.window.showInformationMessage(
        next === "on"
          ? vscode.l10n.t("Gateway: on. Use 'Launch Claude Code through Tierkit' to start a routed session.")
          : vscode.l10n.t("Gateway: off."),
      );
      sidebarRef?.render();
    }),
```

- [ ] **Step 13: Wire `tk:cmd` in both `onDidReceiveMessage` sites** (unchanged):

```typescript
      if (msg.type === "tk:cmd" && isAllowedWebviewCommand(msg.command)) {
        void vscode.commands.executeCommand(msg.command);
        return;
      }
```

- [ ] **Step 14: package.json command + nls** (unchanged): add `tierkit.toggleGatewayMode` command, NO configuration property.

### 8d. Sidebar HTML

- [ ] **Step 15: `gui.ts` toggle row** — inspect existing bridge before editing:

```bash
grep -n "acquireVsCodeApi\|postMessage\|window.parent" packages/core/src/runtime/ui/gui.ts | head -30
```

Reuse the existing dispatch helper. If a `tk:cmd` post is not yet supported, extend the existing helper rather than calling `acquireVsCodeApi()` directly. Suggested helper shape if you need to add one:

```javascript
// Inside gui.ts — align with the file's existing style.
function postTierkitCommand(commandName) {
  if (typeof acquireVsCodeApi === "function") {
    const api = (window.__tierkitVsApi ??= acquireVsCodeApi());
    api.postMessage({ type: "tk:cmd", command: commandName });
    return true;
  }
  return false;  // Browser context — caller disables the control with a small note.
}
```

Add a card titled **"Route Claude Code through Tierkit"** with sub-text **"Phase 1 passthrough connection. Requests are routed through the local Tierkit daemon without modifying message content."**. On render, fetch `/v1/gateway/status` for the current value. On change, call `postTierkitCommand("tierkit.toggleGatewayMode")`. In the browser context (no VS Code API), disable the control with `"Use the VS Code sidebar to toggle"`. No token/percentage/efficiency display.

- [ ] **Step 16: Build + test + commit**

```bash
pnpm --filter @tierkit/vscode-tierkit build
pnpm --filter @tierkit/vscode-tierkit test
git add packages/core/src/runtime/Server.ts \
        packages/core/test/Server.patchRuntime.test.ts \
        packages/vscode-tierkit/src/gatewayControlUrl.ts \
        packages/vscode-tierkit/test/gatewayControlUrl.test.ts \
        packages/vscode-tierkit/src/gatewayModeConfig.ts \
        packages/vscode-tierkit/test/gatewayModeConfig.test.ts \
        packages/vscode-tierkit/src/webviewCommandAllowlist.ts \
        packages/vscode-tierkit/test/webviewCommandAllowlist.test.ts \
        packages/vscode-tierkit/src/extension.ts \
        packages/vscode-tierkit/package.json \
        packages/vscode-tierkit/package.nls.json \
        packages/vscode-tierkit/package.nls.ko.json \
        packages/core/src/runtime/ui/gui.ts
git commit -m "feat: sidebar toggle — pure helpers, discriminated reachability, no-fallback-after-PATCH"
```

---

## Task 9: Scoped terminal launch — pure `gatewayLaunchCore` + VS Code-side `gatewayTerminal` + extension launch

**Why:** Pure helpers live in `gatewayLaunchCore.ts` (NO `vscode` import) so unit tests run regardless of the test harness's VS Code mock (correction 35). The VS Code-specific terminal helper lives in `gatewayTerminal.ts`. The launch command reuses `controlBaseUrlFromConfiguredBaseUrl` (already created in Task 8a) and `classifyReadiness` to drive readiness states (correction 14). Direct fallback honors `TIERKIT_CLAUDE_CODE_BIN` (correction 18).

**Files:**
- Create: `packages/vscode-tierkit/src/gatewayLaunchCore.ts`
- Create: `packages/vscode-tierkit/test/gatewayLaunchCore.test.ts`
- Create: `packages/vscode-tierkit/src/gatewayTerminal.ts`
- Modify: `packages/vscode-tierkit/src/extension.ts` — register launch command
- Modify: `packages/vscode-tierkit/package.json` + nls

- [ ] **Step 1: Failing pure tests**

```typescript
// packages/vscode-tierkit/test/gatewayLaunchCore.test.ts
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
```

- [ ] **Step 2: Implement pure module** (NO `vscode` import)

```typescript
// packages/vscode-tierkit/src/gatewayLaunchCore.ts
export interface GatewayEnvInput {
  baseUrl: string;
  parentEnv: Record<string, string | undefined>;
}

export function buildGatewayEnv(input: GatewayEnvInput): Record<string, string | undefined> {
  return { ...input.parentEnv, ANTHROPIC_BASE_URL: input.baseUrl };
}

export function gatewayLaunchCommand(env: Record<string, string | undefined>): string {
  return env.TIERKIT_CLAUDE_CODE_BIN ?? "claude";
}

export type Readiness =
  | { kind: "ready" }
  | { kind: "mode-off" }
  | { kind: "unreachable" };

export function classifyReadiness(body: { gatewayMode?: "off" | "on"; routesEnabled?: boolean } | null | undefined): Readiness {
  if (!body) return { kind: "unreachable" };
  if (body.gatewayMode === "off") return { kind: "mode-off" };
  if (body.routesEnabled === true) return { kind: "ready" };
  return { kind: "unreachable" };
}

export function nextGatewayMode(current: "off" | "on"): "off" | "on" {
  return current === "on" ? "off" : "on";
}
```

- [ ] **Step 3: Tests pass**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayLaunchCore
```

- [ ] **Step 4: VS Code-side terminal helper**

```typescript
// packages/vscode-tierkit/src/gatewayTerminal.ts
import * as vscode from "vscode";
import { buildGatewayEnv, gatewayLaunchCommand } from "./gatewayLaunchCore.js";

export async function openGatewayTerminal(baseUrl: string): Promise<vscode.Terminal> {
  const env = buildGatewayEnv({ baseUrl, parentEnv: process.env });
  const t = vscode.window.createTerminal({ name: "Claude Code (Tierkit)", env });
  t.show();
  t.sendText(gatewayLaunchCommand(process.env), true);
  return t;
}
```

- [ ] **Step 5: Register the launch command** (corrections 14, 18, 22, 35)

```typescript
    vscode.commands.registerCommand("tierkit.launchClaudeCodeWithGateway", async () => {
      const cfg = vscode.workspace.getConfiguration("tierkit");
      const configuredBaseUrl = cfg.get<string>("baseUrl") ?? "http://127.0.0.1:4101";
      const { classifyReadiness, gatewayLaunchCommand } = await import("./gatewayLaunchCore.js");
      const { openGatewayTerminal } = await import("./gatewayTerminal.js");
      const controlBaseUrl = controlBaseUrlFromConfiguredBaseUrl(configuredBaseUrl);

      const readReadiness = async () => {
        try {
          const r = await fetch(`${controlBaseUrl}/v1/gateway/status`);
          if (!r.ok) return classifyReadiness(null);
          return classifyReadiness((await r.json()) as { gatewayMode?: "off" | "on"; routesEnabled?: boolean });
        } catch {
          return classifyReadiness(null);
        }
      };

      let state = await readReadiness();

      if (state.kind === "mode-off") {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Enable "Route Claude Code through Tierkit" before launching a routed session.'),
        );
        return;
      }

      if (state.kind === "unreachable") {
        void vscode.window.setStatusBarMessage(vscode.l10n.t("Tierkit Gateway: starting daemon…"), 3000);
        await vscode.commands.executeCommand("tierkit.restartDaemon");
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && state.kind !== "ready") {
          await new Promise((r) => setTimeout(r, 300));
          state = await readReadiness();
          if (state.kind === "mode-off") {
            void vscode.window.showInformationMessage(
              vscode.l10n.t('Enable "Route Claude Code through Tierkit" before launching a routed session.'),
            );
            return;
          }
        }
      }

      if (state.kind !== "ready") {
        const directLabel = vscode.l10n.t("Launch direct");
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t("Tierkit Gateway unreachable. Launch Claude Code directly (no gateway)?"),
          { modal: false }, directLabel, vscode.l10n.t("Cancel"),
        );
        if (pick === directLabel) {
          const t = vscode.window.createTerminal({
            name: "Claude Code (direct)",
            env: { ANTHROPIC_BASE_URL: undefined as unknown as string },
          });
          t.show();
          t.sendText(gatewayLaunchCommand(process.env), true);
        }
        return;
      }

      await openGatewayTerminal(controlBaseUrl);
    }),
```

- [ ] **Step 6: Command + nls**

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

- [ ] **Step 7: Tests + build + commit**

```bash
pnpm --filter @tierkit/vscode-tierkit test -- gatewayLaunchCore
pnpm --filter @tierkit/vscode-tierkit build
git add packages/vscode-tierkit/src/gatewayLaunchCore.ts \
        packages/vscode-tierkit/test/gatewayLaunchCore.test.ts \
        packages/vscode-tierkit/src/gatewayTerminal.ts \
        packages/vscode-tierkit/src/extension.ts \
        packages/vscode-tierkit/package.json \
        packages/vscode-tierkit/package.nls.json \
        packages/vscode-tierkit/package.nls.ko.json
git commit -m "feat(vscode): launch — pure core + terminal side effects, readiness, env-stripping fallback"
```

---

## Task 10: Manual test plan

**Files:**
- Create: `packages/vscode-tierkit/test/MANUAL_gateway_flows.md`

- [ ] **Step 1: Write the plan**

```markdown
# Manual: gateway flows (Phase 1)

## Setup
1. Open a workspace folder. Confirm `tierkit doctor` is green.
2. Sidebar → toggle "Route Claude Code through Tierkit" ON.
3. `tierkit doctor gateway` reports OK.

## Test 1 — Happy launch
- Click "Tierkit: Launch Claude Code through Tierkit".
- New terminal: `echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"` → `http://127.0.0.1:<port>`.

## Test 2 — Auth preservation
- Parent shell: `export ANTHROPIC_API_KEY=sk-test-DO-NOT-USE`. Launch VS Code from that shell.
- Click launch. `echo $ANTHROPIC_API_KEY` → prints the test value.

## Test 3 — Mode-off guidance (NO daemon restart)
- Sidebar toggle OFF. Click launch.
- Expected info message: `Enable "Route Claude Code through Tierkit" before launching a routed session.`
- Expected: NO "starting daemon…" message and NO daemon restart attempt.

## Test 4 — Auto-restart + fallback
- Mode ON. `pkill -f 'tierkit runtime'`. Click launch.
- Status bar: `Tierkit Gateway: starting daemon…`. Daemon restarts → terminal opens.

## Test 5 — Hard fallback (env stripping + custom binary)
- `tierkit.autoStartDaemon: false`. Kill daemon. Click launch.
- Dialog appears → click "Launch direct".
- `echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"` → empty.
- With `TIERKIT_CLAUDE_CODE_BIN=/opt/custom/claude`, confirm BOTH routed AND direct terminals launch `/opt/custom/claude`.

## Test 6 — Safe log inspection
- After Tests 1 and 4: `cat .tierkit/runtime/anthropic-gateway.jsonl`.
- Each record has only `ts, path, stream, status, durationMs, auth {authorizationScheme, authorizationFingerprint, apiKeyPresent, apiKeyFingerprint}`.
- `authorizationScheme` is `null`, `"Bearer"`, or `"Other"`.
- The invariant holds in every record: scheme null iff fingerprint null; apiKeyPresent false iff fingerprint null.
- Negative: grep for `sk-`, API key prefix, message text → no hits.

## Test 7 — Local-only enforcement (LAN)
- Temporarily set `runtime.host: "0.0.0.0"` and restart daemon.
- From ANOTHER machine on the same LAN: `curl http://<machine-ip>:<port>/v1/gateway/status` → 403 `local_only`.
- `curl -X PATCH http://<machine-ip>:<port>/v1/config/runtime ...` → 403.
- From the same machine: `curl http://127.0.0.1:<port>/v1/gateway/status` → 200.
- Restore.

## Test 8 — Offline toggle works in both directions
- With daemon running: sidebar toggle to ON.
- Stop daemon. Sidebar toggle → file should flip ON → OFF.

## Test 9 — Daemon rejection does NOT trigger offline fallback
- With daemon running, send a request that the daemon will reject (the sidebar
  toggle's PATCH should succeed under normal conditions; this test exercises
  the rejection path by temporarily exporting a value the daemon rejects).
- Expected: error message containing daemon's rejection detail.
- tierkit.config.json on disk is NOT silently overwritten by the extension.

## Test 10 — Extension uses loopback even with LAN configured baseUrl
- Set `tierkit.baseUrl` in VS Code settings to `http://192.168.1.50:4101`.
- Sidebar toggle and launch button still work (extension canonicalizes to `127.0.0.1:4101`).
- Restore.

## Test 11 — Streaming abort logs the observed HTTP status (correction 32)
- Mode ON. From `claude` running in the gateway terminal, start a long streaming completion.
- Kill the daemon mid-stream (`pkill -f 'tierkit runtime'`).
- The Claude Code session may show a disconnect.
- After restart, `cat .tierkit/runtime/anthropic-gateway.jsonl | tail -1`.
- Expected: the aborted record's `status` is `200` (the status the client actually observed at the start of the stream), NOT `502`. `stream: true` is present.

## Test 12 — Bind-mode constraints (LAN-only bind is NOT supported)
- Set `runtime.host: "192.168.1.50"` (a specific LAN interface, NOT 0.0.0.0). Restart daemon.
- `tierkit doctor gateway` reports `gateway-daemon: fail` because the extension's loopback probe cannot reach the LAN-only bind. This is expected behavior (docs/ANTHROPIC_GATEWAY.md lists the supported bind modes).
- Restore to `127.0.0.1` or `0.0.0.0`.

## Test 13 — PATCH-then-transport-failure indeterminate state (correction 31)
- Mode ON. Set up a flaky network condition between extension and daemon (or kill the daemon between the status probe and the PATCH request).
- Click sidebar toggle.
- Expected: indeterminate-state error like "The gateway update request did not complete cleanly. Check the current status before trying again."
- Expected: `tierkit.config.json` was NOT silently overwritten by the extension.
```

- [ ] **Step 2: Walk Tests 1–13.**

- [ ] **Step 3: Commit**

```bash
git add packages/vscode-tierkit/test/MANUAL_gateway_flows.md
git commit -m "docs(vscode): manual test plan — adds streaming-abort + bind-mode + PATCH-ambiguity tests"
```

---

## Task 11: `GET /v1/doctor/gateway` + sidebar diagnostics card

**Files:**
- Modify: `packages/core/src/runtime/Server.ts`
- Create: `packages/core/test/Server.doctorGateway.test.ts`
- Modify: `packages/core/src/runtime/ui/gui.ts`

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

- [ ] **Step 2: Add the route (loopback-guarded)**

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

Add a card titled **"Anthropic Gateway — diagnostics"** that fetches `/v1/doctor/gateway` on render + a refresh button. Render each check's `label`, colored `status`, and `detail`. Use the browser/webview-compatible helper already in `gui.ts`. No token/percentage/efficiency display.

- [ ] **Step 5: Build + commit**

```bash
pnpm -r build
git add packages/core/src/runtime/Server.ts \
        packages/core/test/Server.doctorGateway.test.ts \
        packages/core/src/runtime/ui/gui.ts
git commit -m "feat(server): GET /v1/doctor/gateway (loopback) + sidebar diagnostics card"
```

---

## Task 12: Docs — README + ANTHROPIC_GATEWAY.md (EN + KR), accurate auth shape + bind modes

- [ ] **Step 1: Write `docs/ANTHROPIC_GATEWAY.md`** (rev5 content + bind-mode paragraph from correction 34)

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
`.tierkit/runtime/anthropic-gateway.jsonl`. Each record contains: timestamp,
path, stream flag, upstream status, duration, and an `auth` block with the
Authorization classification (`Bearer`, `Other`, or `null` when no
Authorization header was present), an `apiKeyPresent` boolean for the
`x-api-key` channel, and a 12-character fingerprint for each credential
channel that was present. The schema enforces that a fingerprint is present
exactly when its channel is present — there are no records with a fingerprint
for an absent channel. The log never contains the request body, the response
body, the raw `Authorization` or `x-api-key` value, the `system` prompt, the
`messages[]` array, or `tool_result` content. The file rotates at 5 MB or
7 days, whichever comes first.

For streaming requests, the recorded `status` is the HTTP status the client
actually observed (typically 200), even when the upstream stream aborts
mid-flight. A separate stream-abort outcome field is planned for a later phase.

## Local-only control surface

`GET /v1/gateway/status`, `GET /v1/doctor/gateway`, and
`PATCH /v1/config/runtime` reject any non-loopback caller with HTTP 403.

For these control endpoints to be reachable, run the daemon on a loopback or
wildcard bind address: `127.0.0.1`, `::1`, `0.0.0.0`, or `::`. A daemon bound
only to a specific LAN interface (for example `192.168.1.50`) is not supported
by the Phase 1 local-control flow.

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
요청 단위 로그를 남깁니다. 각 레코드는 timestamp, path, stream 여부, 업스트림
상태 코드, 처리 시간과, `auth` 블록을 포함합니다. `auth`는 Authorization 분류
값(`Bearer`, `Other`, 또는 Authorization 헤더가 없을 때 `null`), `x-api-key`
존재 여부를 나타내는 `apiKeyPresent` boolean, 그리고 존재했던 각 인증 채널의
12자 fingerprint로 구성됩니다. 스키마는 채널이 존재할 때에만 해당 채널의
fingerprint가 기록되도록 보장합니다 — 없는 채널의 fingerprint가 기록되는
레코드는 발생하지 않습니다. 요청·응답 본문, `Authorization`·`x-api-key`
원문, `system` 프롬프트, `messages[]`, `tool_result` 내용은 포함되지 않습니다.
5 MB 또는 7일 중 먼저 도달하는 조건으로 회전합니다.

스트리밍 요청의 경우, 기록되는 `status`는 클라이언트가 실제로 관측한 HTTP
상태 코드(보통 200)이며, 업스트림 스트림이 중간에 끊긴 경우에도 그렇습니다.
별도의 stream-abort outcome 필드는 후속 단계에서 제공할 예정입니다.

## 로컬 전용 제어 surface

`GET /v1/gateway/status`, `GET /v1/doctor/gateway`, `PATCH /v1/config/runtime`는
loopback이 아닌 호출자를 HTTP 403으로 거부합니다.

이 제어 endpoint를 사용하려면 데몬은 `127.0.0.1`, `::1`, `0.0.0.0`, `::`처럼
loopback 또는 wildcard 주소에 바인딩되어야 합니다. 특정 LAN 인터페이스 주소
(예: `192.168.1.50`)에만 바인딩된 데몬은 Phase 1 제어 흐름의 지원 대상이
아닙니다.

## Direct fallback

**Tierkit 통해 Claude Code 실행**을 눌렀을 때 데몬이 닿지 않으면 확장 프로그램
이 먼저 데몬 재시작을 시도합니다. 그래도 실패하면 게이트웨이를 우회하는
**Launch direct** 버튼을 제공합니다. Direct 터미널은 `ANTHROPIC_BASE_URL`을
명시적으로 제거하므로, VS Code 프로세스가 부모 shell에서 해당 변수를 상속했더
라도 실제로 direct 경로로 동작합니다.

추가적인 컨텍스트 처리 및 정책 기능은 후속 단계에서 제공될 예정입니다.
```

- [ ] **Step 3: README.md**

```markdown
- **Anthropic Gateway (Phase 1 — connection)** — route Claude Code Messages
  API traffic through the local Tierkit daemon with a sidebar toggle and a
  scoped integrated-terminal launcher. See [docs/ANTHROPIC_GATEWAY.md](docs/ANTHROPIC_GATEWAY.md).
```

- [ ] **Step 4: Commit**

```bash
git add docs/ANTHROPIC_GATEWAY.md docs/ANTHROPIC_GATEWAY.ko.md README.md
git commit -m "docs: Anthropic Gateway — accurate auth shape + supported bind modes (EN+KR)"
```

---

## Task 13: Full regression + diff-based language audit + sensitive-logging review aid + Phase 2 entry-gate

- [ ] **Step 1: Clean build + full tests**

```bash
pnpm -r clean || true
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
```

- [ ] **Step 2: Diff-based language audit (correction 11, 17)**

```bash
BASE="$(git merge-base HEAD worktree-anthropic-gateway-spike)"

USER_FACING=(
  README.md
  docs/ANTHROPIC_GATEWAY.md
  docs/ANTHROPIC_GATEWAY.ko.md
  packages/core/src/runtime/ui/gui.ts
  packages/cli/src/commands/DoctorGatewayCommand.ts
  packages/vscode-tierkit/src/extension.ts
  packages/vscode-tierkit/package.json
  packages/vscode-tierkit/package.nls.json
  packages/vscode-tierkit/package.nls.ko.json
  packages/vscode-tierkit/test/MANUAL_gateway_flows.md
)

PATTERN='\bsavings\b|\bsave\b|\bsaves\b|\bsaved\b|\bcost\b|\bcheaper\b|\befficient\b|절감|절약|비용|효율'

git diff --unified=0 "$BASE"...HEAD -- "${USER_FACING[@]}" \
  | grep -E '^\+' \
  | grep -v '^\+\+\+' \
  | grep -niE "$PATTERN" \
  && { echo "LANGUAGE AUDIT FAILED"; exit 1; } \
  || echo "language audit ok"
```

- [ ] **Step 3: Sensitive-logging review aid (advisory, correction 27)**

The hard redaction guarantees are the value-constrained schema and `gatewayLog.redaction.test.ts`. This step surfaces sensitive-sounding console calls that Phase 1 ADDED, for reviewer eyeballing. It does NOT fail CI.

```bash
BASE="$(git merge-base HEAD worktree-anthropic-gateway-spike)"
SENSITIVE='messages|system|tool_result|authorization|x-api-key'

echo "Sensitive-logging review aid (advisory) — Phase 1 added lines containing console.* AND sensitive terms:"
git diff --unified=0 "$BASE"...HEAD -- packages \
  | grep -E '^\+' \
  | grep -v '^\+\+\+' \
  | grep -E 'console\.(log|error|info)' \
  | grep -iE "$SENSITIVE" \
  || echo "  (none)"
```

- [ ] **Step 4: Phase 2 entry-gate** — append to `docs/RFC-anthropic-gateway.md`:

```markdown
## Phase 2 entry gate (added during Phase 1)

Phase 2 work (request/response transformation, including any context-handling
or measurement features) MUST NOT begin until:

1. Phase 1 has dogfood for ≥ 1 week with `tierkit doctor gateway` reporting
   ok across all checks on a real workstation.
2. The per-request safe log shows zero 5xx in the trailing 7 days:
   `jq 'select(.status >= 500)' .tierkit/runtime/anthropic-gateway.jsonl | wc -l == 0`.
3. The Direct fallback flow has been triggered at least once and resolved cleanly.

Phase 2 design constraints inherited from Phase 1:
- Body transformation hooks land inside `forwardMessages` / `streamMessages`
  in `anthropicGateway.ts`. Phase 1's `Server.ts` route plumbing does not change.
- Strengthening the streaming-completion logging contract requires changes to
  `anthropicGateway.ts`; Phase 2 candidate.
- The safe log `authorizationScheme` enum stays `["Bearer", "Other"]` unless
  Phase 2 deliberately extends it (and updates the redaction tests).
```

- [ ] **Step 5: Push + draft PR (base = spike branch)**

```bash
git add docs/RFC-anthropic-gateway.md
git commit -m "docs(rfc): Phase 2 entry-gate"
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
- New: \`PATCH /v1/config/runtime\` (loopback-guarded, allowlist, full-schema-validated)
- New: \`GET /v1/doctor/gateway\` (loopback-guarded)
- New: async safe per-request log (value-constrained schema with Bearer|Other scheme + superRefine invariants, 5 MB / 7-day rotation, queue, oversized rejection)
- New: \`tierkit doctor gateway\` CLI (local-only, cross-platform, loopback control probe)
- New: sidebar **Route Claude Code through Tierkit** toggle (single SoT; discriminated reachability — daemon rejection stops, post-PATCH transport failure shows indeterminate-state; offline write only on pre-mutation transport failure)
- New: **Launch Claude Code through Tierkit** terminal button (preserves auth env; readiness discrimination; canonicalizes configured baseUrl to loopback control URL via pure helper; honors \`TIERKIT_CLAUDE_CODE_BIN\` in routed AND direct terminals)
- New: explicit Direct fallback dialog (removes ANTHROPIC_BASE_URL)
- New: \`docs/ANTHROPIC_GATEWAY.md\` + Korean version (with supported bind-mode constraints)

## Stacked on Phase 0

Base branch: \`worktree-anthropic-gateway-spike\` (Draft PR #1). After #1
merges to main, change this PR's base to main.

## NOT in this PR

Body transformation, compression, dedupe, pagination, body-level redaction,
provider routing, any numeric efficiency claim. Strengthening the
streaming-completion logging contract is deferred to Phase 2 (requires
changes to \`anthropicGateway.ts\`). LAN-only bind support is out of scope.

## Test plan

- [ ] \`pnpm -r build && pnpm -r test\` green
- [ ] Diff-based language audit green (Task 13 Step 2)
- [ ] Sensitive-logging review aid reviewed (Task 13 Step 3 — advisory)
- [ ] Manual flows from \`packages/vscode-tierkit/test/MANUAL_gateway_flows.md\` 1–13 all pass
- [ ] \`tierkit doctor gateway\` returns OK on a configured workstation
- [ ] Safe log inspected — no raw token, no body, \`authorizationScheme\` ∈ {null, "Bearer", "Other"}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

**Coverage:** every Phase 1 scope item from RFC §3 implemented:

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

**Hard rules verified (all 35 corrections):**

- [ ] gatewayLog: value-constrained schema, `Bearer|Other` scheme enum, no default for `apiKeyPresent`, superRefine invariants on auth shape.
- [ ] `appendGatewayLog()` is `async`; tests use `await expect(...).rejects.toThrow()`.
- [ ] All three control endpoints reject non-loopback with 403.
- [ ] `resolveRuntimeDataDir(dataDir, cwd)` used by status, log writer, doctor.
- [ ] No Phase 1 automated test calls `api.anthropic.com`.
- [ ] Non-stream: `await logFinal()` BEFORE `res.end()`. Stream: log after `streamMessages` resolves.
- [ ] Pre-headers transport error returns AND logs 502. Post-headers (stream in progress) error logs `res.statusCode`.
- [ ] `PATCH /v1/config/runtime` runs through `TierkitConfigSchema.parse()`.
- [ ] Ordinary `tierkit doctor` not modified.
- [ ] `doctorGateway` exported from `@tierkit/core`.
- [ ] Language audit is diff-based and includes `extension.ts` + `DoctorGatewayCommand.ts` + manual test plan.
- [ ] `gui.ts` toggle uses the existing dispatch bridge.
- [ ] Offline toggle reads the file for current state so OFF transitions work.
- [ ] Launch classifies ready / mode-off / unreachable; mode-off skips daemon restart.
- [ ] Non-Bearer Authorization scheme persists as `"Other"`.
- [ ] Tests cover `/v1/messages` (off/on/non-stream/stream/502 pre-headers) AND `/v1/messages/count_tokens`.
- [ ] Direct fallback honors `TIERKIT_CLAUDE_CODE_BIN` via `gatewayLaunchCommand(process.env)`.
- [ ] Doctor probes `loopbackControlUrl`; test asserts on `label`.
- [ ] Mock upstream parses request body to decide SSE.
- [ ] Pure helpers (`gatewayControlUrl.ts`, `gatewayModeConfig.ts`, `gatewayLaunchCore.ts`) — NO `vscode` import; testable standalone.
- [ ] Extension toggle: discriminated reachability (`reachable | transport-failure | rejected`); only `transport-failure` permits file fallback.
- [ ] Extension toggle: after PATCH was attempted and threw, show indeterminate-state error — do NOT write the file.
- [ ] Extension control requests use `controlBaseUrlFromConfiguredBaseUrl`.
- [ ] Task 8 imports `controlBaseUrlFromConfiguredBaseUrl` from `./gatewayControlUrl.js` (created in Task 8a), NOT from a Task 9 file.
- [ ] Docs describe auth as `Bearer`/`Other`/`null` classification and list supported bind modes.
- [ ] Manual Test 11 covers streaming-abort logging; Test 12 covers LAN-only-bind non-support; Test 13 covers PATCH-then-transport-failure indeterminate state.

---

## Execution handoff

1. **Subagent-driven (recommended)** — REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline** — REQUIRED SUB-SKILL: `superpowers:executing-plans`.
