# Model Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users paste cloud API keys and delete model profiles directly from the Tierkit GUI without dropping to a shell.

**Architecture:** Add a `SecretsStore` (file: `<dataDir>/secrets.json`, mode `0600`) loaded into `process.env` at daemon boot. Three new HTTP endpoints (`GET/POST/DELETE /v1/secrets`) expose it. Extend the GUI Model profiles card with per-row delete, missing-key warnings, an "API Keys" subsection, and an optional API-key input in the add-profile form.

**Tech Stack:** TypeScript, Node.js built-in `http`/`fs`, vitest, no new runtime dependencies. Single-file inlined GUI HTML (no build step).

**Spec:** [docs/superpowers/specs/2026-05-18-model-management-ui-design.md](../specs/2026-05-18-model-management-ui-design.md)

---

## File Structure

**New files:**
- `packages/core/src/security/SecretsStore.ts` — store interface + factory; single responsibility = manage `secrets.json` + `process.env` sync
- `packages/core/test/secretsStore.test.ts` — unit tests for the store
- `packages/core/test/secretsEndpoints.test.ts` — integration tests for the 3 HTTP endpoints

**Modified files:**
- `packages/core/src/security/index.ts` (if exists; otherwise via direct import paths) — re-export
- `packages/core/src/index.ts` — export `createSecretsStore`, `SecretsStore` types so `runtimeLifecycle` can use them
- `packages/core/src/usecases/runtimeLifecycle.ts` — call `loadIntoEnv()` before `startServer(...)` and pass the store as `ServerOptions.secrets`
- `packages/core/src/runtime/Server.ts` — extend `ServerOptions`, add 3 routes
- `packages/core/src/runtime/ui/gui.ts` — Models card UI changes + i18n strings

---

## Task 1: SecretsStore unit — load + list (empty)

**Files:**
- Create: `packages/core/src/security/SecretsStore.ts`
- Test: `packages/core/test/secretsStore.test.ts`

- [ ] **Step 1: Write the failing tests for empty load + list**

Create `packages/core/test/secretsStore.test.ts`:

```typescript
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSecretsStore } from "../src/security/SecretsStore.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-secrets-"));
});

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("SecretsStore — load + list", () => {
  it("loadIntoEnv is a no-op when the file does not exist", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    expect(store.list().entries).toEqual([]);
  });

  it("list() returns one entry per key passed via knownKeys (even if not set)", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    const r = store.list({ knownKeys: ["ANTHROPIC_API_KEY"] });
    expect(r.entries).toEqual([
      { key: "ANTHROPIC_API_KEY", set: false, masked: "" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tierkit/core exec vitest run secretsStore`
Expected: FAIL with "Cannot find module './SecretsStore.js'".

- [ ] **Step 3: Create the minimal SecretsStore**

Create `packages/core/src/security/SecretsStore.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";

export interface SecretsStoreEntry {
  key: string;
  set: boolean;
  /** Masked preview, e.g. "sk-ant-…xyz9". Empty string when set === false. */
  masked: string;
}

export interface SecretsStoreListResult {
  entries: SecretsStoreEntry[];
}

export interface SecretsStoreListOptions {
  /**
   * Additional env-var names to include in the result even if not present in the store.
   * The Server passes the union of all `apiKeyEnv` values referenced by model profiles,
   * so the UI can show "ANTHROPIC_API_KEY: not set" rows.
   */
  knownKeys?: readonly string[];
}

export interface SecretsStore {
  list(opts?: SecretsStoreListOptions): SecretsStoreListResult;
  set(key: string, value: string): Promise<void>;
  /** Returns false if the key was set by the shell env (not by us) — caller should 4xx. */
  remove(key: string): Promise<boolean>;
  loadIntoEnv(): Promise<void>;
}

export interface CreateSecretsStoreOptions {
  /** Directory containing `secrets.json`. Usually `<projectRoot>/.tierkit`. */
  dataDir: string;
  /** Process env to read/write. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export function createSecretsStore(opts: CreateSecretsStoreOptions): SecretsStore {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const secretsPath = path.join(opts.dataDir, "secrets.json");
  const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

  // In-memory mirror of the on-disk file.
  let fileValues: Record<string, string> = {};
  // Keys we injected into env at loadIntoEnv() — only these may be removed from env on remove().
  const injectedKeys = new Set<string>();

  function mask(v: string): string {
    if (v.length < 12) return "…" + v.slice(-2);
    return v.slice(0, 7) + "…" + v.slice(-4);
  }

  async function readFile(): Promise<Record<string, string>> {
    try {
      const txt = await fs.readFile(secretsPath, "utf8");
      const parsed = JSON.parse(txt);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && ENV_KEY_PATTERN.test(k)) out[k] = v;
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async function writeFileAtomic(values: Record<string, string>): Promise<void> {
    await fs.mkdir(opts.dataDir, { recursive: true });
    const tmpPath = secretsPath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(values, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, secretsPath);
    await fs.chmod(secretsPath, 0o600);
  }

  async function ensureGitignore(): Promise<void> {
    const gi = path.join(opts.dataDir, ".gitignore");
    let body = "";
    try {
      body = await fs.readFile(gi, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const lines = body.split(/\r?\n/);
    if (!lines.includes("secrets.json")) {
      const next = (body && !body.endsWith("\n") ? body + "\n" : body) + "secrets.json\n";
      await fs.writeFile(gi, next);
    }
  }

  return {
    async loadIntoEnv() {
      fileValues = await readFile();
      for (const [k, v] of Object.entries(fileValues)) {
        const existing = env[k];
        if (existing === undefined || existing === "") {
          env[k] = v;
          injectedKeys.add(k);
        }
      }
    },

    list(opts2) {
      const known = new Set<string>([
        ...Object.keys(fileValues),
        ...(opts2?.knownKeys ?? []),
      ]);
      const entries: SecretsStoreEntry[] = [];
      for (const key of [...known].sort()) {
        const value = fileValues[key];
        const setInEnv = (env[key] ?? "") !== "";
        entries.push({
          key,
          set: setInEnv,
          masked: value ? mask(value) : "",
        });
      }
      return { entries };
    },

    async set(key, value) {
      if (!ENV_KEY_PATTERN.test(key)) {
        throw new Error("invalid env var name (must match /^[A-Z][A-Z0-9_]*$/)");
      }
      if (!value) throw new Error("value must be non-empty");
      fileValues = { ...fileValues, [key]: value };
      await writeFileAtomic(fileValues);
      await ensureGitignore();
      env[key] = value;
      injectedKeys.add(key);
    },

    async remove(key) {
      if (!(key in fileValues)) {
        // Not in our store. If env has it, it came from the shell — refuse.
        return false;
      }
      const next = { ...fileValues };
      delete next[key];
      fileValues = next;
      await writeFileAtomic(fileValues);
      if (injectedKeys.has(key)) {
        delete env[key];
        injectedKeys.delete(key);
      }
      return true;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tierkit/core exec vitest run secretsStore`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/security/SecretsStore.ts packages/core/test/secretsStore.test.ts
git commit -m "feat(core): SecretsStore skeleton — load + list with knownKeys"
```

---

## Task 2: SecretsStore — set + persistence + mode 0600

**Files:**
- Test: `packages/core/test/secretsStore.test.ts` (append)
- Modify: `packages/core/src/security/SecretsStore.ts` (no changes expected; tests should pass against the impl from Task 1)

- [ ] **Step 1: Add failing tests for set/persist/mode**

Append to `packages/core/test/secretsStore.test.ts`:

```typescript
describe("SecretsStore — set", () => {
  it("persists the value to disk with mode 0600", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await store.set("ANTHROPIC_API_KEY", "sk-ant-abc1234567890xyz");
    const stat = await fs.stat(path.join(tmp, "secrets.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    const body = JSON.parse(await fs.readFile(path.join(tmp, "secrets.json"), "utf8"));
    expect(body).toEqual({ ANTHROPIC_API_KEY: "sk-ant-abc1234567890xyz" });
  });

  it("masks long values with first 7 + … + last 4", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await store.set("ANTHROPIC_API_KEY", "sk-ant-abc1234567890xyz");
    const r = store.list();
    expect(r.entries[0]).toMatchObject({
      key: "ANTHROPIC_API_KEY",
      set: true,
      masked: "sk-ant-…0xyz",
    });
  });

  it("rejects invalid env var names", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await expect(store.set("not-an-env", "x")).rejects.toThrow(/invalid env var name/);
    await expect(store.set("lower_case", "x")).rejects.toThrow();
  });

  it("rejects empty values", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await expect(store.set("OPENAI_API_KEY", "")).rejects.toThrow(/non-empty/);
  });

  it("creates .gitignore with secrets.json on first set", async () => {
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await store.set("OPENAI_API_KEY", "sk-ohai-1234567890xyz");
    const gi = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    expect(gi).toContain("secrets.json");
  });

  it(".gitignore append is idempotent (no duplicate lines)", async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(path.join(tmp, ".gitignore"), "other-file\nsecrets.json\n");
    const store = createSecretsStore({ dataDir: tmp, env: {} });
    await store.loadIntoEnv();
    await store.set("OPENAI_API_KEY", "sk-ohai-1234567890xyz");
    const gi = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    const matches = gi.match(/^secrets\.json$/gm);
    expect(matches?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @tierkit/core exec vitest run secretsStore`
Expected: PASS, 7 tests total (2 from Task 1 + 5 here). If any fail, fix the implementation in `SecretsStore.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/secretsStore.test.ts
git commit -m "test(core): SecretsStore set + persistence + mode + gitignore"
```

---

## Task 3: SecretsStore — env injection + remove + shell-env precedence

**Files:**
- Test: `packages/core/test/secretsStore.test.ts` (append)

- [ ] **Step 1: Add failing tests**

Append to `packages/core/test/secretsStore.test.ts`:

```typescript
describe("SecretsStore — env injection + remove", () => {
  it("injects file values into env on loadIntoEnv (when env is empty)", async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(
      path.join(tmp, "secrets.json"),
      JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-fromdisk1234567" }),
      { mode: 0o600 },
    );
    const env: Record<string, string | undefined> = {};
    const store = createSecretsStore({ dataDir: tmp, env });
    await store.loadIntoEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fromdisk1234567");
  });

  it("shell env wins over file (file value not injected)", async () => {
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(
      path.join(tmp, "secrets.json"),
      JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-fromdisk1234567" }),
      { mode: 0o600 },
    );
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-fromshell" };
    const store = createSecretsStore({ dataDir: tmp, env });
    await store.loadIntoEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fromshell");
  });

  it("set() then remove() deletes from env (since we injected it)", async () => {
    const env: Record<string, string | undefined> = {};
    const store = createSecretsStore({ dataDir: tmp, env });
    await store.loadIntoEnv();
    await store.set("OPENAI_API_KEY", "sk-ohai-1234567890xyz");
    expect(env.OPENAI_API_KEY).toBe("sk-ohai-1234567890xyz");
    const ok = await store.remove("OPENAI_API_KEY");
    expect(ok).toBe(true);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("remove() returns false when key was never in our store", async () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-ohai-fromshell" };
    const store = createSecretsStore({ dataDir: tmp, env });
    await store.loadIntoEnv();
    const ok = await store.remove("OPENAI_API_KEY");
    expect(ok).toBe(false);
    expect(env.OPENAI_API_KEY).toBe("sk-ohai-fromshell"); // untouched
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @tierkit/core exec vitest run secretsStore`
Expected: PASS, 11 tests total.

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/secretsStore.test.ts
git commit -m "test(core): SecretsStore env injection + remove with shell-env precedence"
```

---

## Task 4: Export SecretsStore + wire into runtime boot

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/usecases/runtimeLifecycle.ts`
- Modify: `packages/core/src/runtime/Server.ts` (add `secrets?: SecretsStore` to `ServerOptions`)

- [ ] **Step 1: Re-export from core index**

Open `packages/core/src/index.ts`. Find the existing security exports (search for `redactSecrets` to anchor). Add to the same export block:

```typescript
export { createSecretsStore } from "./security/SecretsStore.js";
export type { SecretsStore, SecretsStoreEntry, SecretsStoreListOptions } from "./security/SecretsStore.js";
```

- [ ] **Step 2: Extend ServerOptions in Server.ts**

In `packages/core/src/runtime/Server.ts`, find the existing import block at the top. Add:

```typescript
import type { SecretsStore } from "../security/SecretsStore.js";
```

Then in `ServerOptions` (around line 39), add a new field BEFORE the closing `}`:

```typescript
  /**
   * Optional store for runtime-managed API keys (read/written via /v1/secrets).
   * The daemon caller is expected to call `secrets.loadIntoEnv()` BEFORE startServer,
   * so providers see the keys via process.env. Without this field, /v1/secrets returns 501.
   */
  secrets?: SecretsStore;
```

- [ ] **Step 3: Wire into runtimeLifecycle**

In `packages/core/src/usecases/runtimeLifecycle.ts`, modify `startRuntime()`. Replace the body block starting at the `await fs.mkdir(dataDir, ...)` line and ending at `const server = await startServer(...)` with:

```typescript
  await fs.mkdir(dataDir, { recursive: true });

  const pidPath = path.join(dataDir, PID_FILE);
  const portPath = path.join(dataDir, PORT_FILE);

  const existingPid = await readPidIfAlive(pidPath);
  if (existingPid !== undefined) {
    let existingPort: number | undefined;
    try {
      existingPort = Number.parseInt(await fs.readFile(portPath, "utf8"), 10);
    } catch {
      /* ignore */
    }
    throw new RuntimeError(
      "already-running",
      `tierkit runtime is already running with pid ${existingPid}${existingPort ? ` on port ${existingPort}` : ""}. ` +
        `Run \`tierkit runtime stop\` first.`,
    );
  }

  const host = input.host ?? rc.host;
  const port = input.port ?? rc.port;

  const { createSecretsStore } = await import("../security/SecretsStore.js");
  const secrets = createSecretsStore({ dataDir });
  await secrets.loadIntoEnv();

  const server = await startServer({ cwd: projectRoot, host, port, secrets });
```

(Keep the rest of `startRuntime` unchanged — the pid/port file writes and the `return` block stay.)

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @tierkit/core build`
Expected: succeeds with no TS errors. If it fails because `ServerOptions.secrets` isn't recognized somewhere, fix the missing import.

- [ ] **Step 5: Run the existing test suite to make sure nothing regressed**

Run: `pnpm --filter @tierkit/core test`
Expected: all existing tests still pass (plus the 11 secretsStore tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/usecases/runtimeLifecycle.ts packages/core/src/runtime/Server.ts
git commit -m "feat(runtime): inject SecretsStore into process.env at daemon boot"
```

---

## Task 5: Endpoint — GET /v1/secrets

**Files:**
- Create: `packages/core/test/secretsEndpoints.test.ts`
- Modify: `packages/core/src/runtime/Server.ts` (add route handler)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/secretsEndpoints.test.ts`:

```typescript
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";
import { createSecretsStore } from "../src/security/SecretsStore.js";

let tmp: string;
let server: RunningServer | undefined;

async function bootServer(env: Record<string, string | undefined> = {}): Promise<{
  baseUrl: string;
  cwd: string;
}> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-secretsep-"));
  const cwd = tmp;
  const dataDir = path.join(cwd, ".tierkit");
  await fs.mkdir(dataDir, { recursive: true });
  // Minimal config so loadConfig doesn't throw inside any handler.
  await fs.writeFile(
    path.join(cwd, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      activePlugins: [],
      defaultTarget: "generic",
      modelProfiles: {
        claudeSonnet: {
          kind: "private-remote",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          roles: ["code"],
          cost: { type: "free" },
        },
      },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
    }),
  );
  const secrets = createSecretsStore({ dataDir, env });
  await secrets.loadIntoEnv();
  server = await startServer({ cwd, host: "127.0.0.1", port: 0, secrets, env });
  return { baseUrl: `http://${server.address}:${server.port}`, cwd };
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("GET /v1/secrets", () => {
  it("lists keys referenced by profiles as unset when none stored", async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/v1/secrets`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: Array<{ key: string; set: boolean; masked: string }> };
    const ant = body.entries.find((e) => e.key === "ANTHROPIC_API_KEY");
    expect(ant).toEqual({ key: "ANTHROPIC_API_KEY", set: false, masked: "" });
  });

  it("never returns the plaintext value, only masked", async () => {
    const { baseUrl } = await bootServer({ ANTHROPIC_API_KEY: "sk-ant-supersecretvalue123" });
    const r = await fetch(`${baseUrl}/v1/secrets`);
    const text = await r.text();
    expect(text).not.toContain("supersecretvalue");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tierkit/core exec vitest run secretsEndpoints`
Expected: FAIL — `GET /v1/secrets` returns 404 (route not implemented).

- [ ] **Step 3: Implement GET /v1/secrets in Server.ts**

In `packages/core/src/runtime/Server.ts`, add a new route block. Insert it AFTER the existing `if (route === "GET /v1/config") { ... }` block (around line 383), BEFORE the next route. Add:

```typescript
      // ── Secrets management: GET/POST/DELETE /v1/secrets ──
      if (route === "GET /v1/secrets") {
        if (!opts.secrets) return sendJson(res, 501, { error: "secrets store not configured" });
        const cfg = await loadConfig(opts.cwd);
        const known = new Set<string>();
        const profiles = cfg.config.modelProfiles ?? {};
        for (const p of Object.values(profiles)) {
          const k = (p as { apiKeyEnv?: string }).apiKeyEnv;
          if (typeof k === "string" && k) known.add(k);
        }
        const r = opts.secrets.list({ knownKeys: [...known] });
        return sendJson(res, 200, r);
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tierkit/core exec vitest run secretsEndpoints`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/secretsEndpoints.test.ts packages/core/src/runtime/Server.ts
git commit -m "feat(runtime): GET /v1/secrets — list keys, never values"
```

---

## Task 6: Endpoint — POST /v1/secrets

**Files:**
- Test: `packages/core/test/secretsEndpoints.test.ts` (append)
- Modify: `packages/core/src/runtime/Server.ts`

- [ ] **Step 1: Add failing tests**

Append to `packages/core/test/secretsEndpoints.test.ts`:

```typescript
describe("POST /v1/secrets", () => {
  it("stores a key and reports it as set on the next GET", async () => {
    const { baseUrl } = await bootServer();
    const post = await fetch(`${baseUrl}/v1/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "ANTHROPIC_API_KEY", value: "sk-ant-newvalue1234567" }),
    });
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { ok: boolean; masked: string };
    expect(postBody.ok).toBe(true);
    expect(postBody.masked).toBe("sk-ant-…4567");

    const get = await fetch(`${baseUrl}/v1/secrets`);
    const body = (await get.json()) as { entries: Array<{ key: string; set: boolean; masked: string }> };
    const ant = body.entries.find((e) => e.key === "ANTHROPIC_API_KEY");
    expect(ant?.set).toBe(true);
    expect(ant?.masked).toBe("sk-ant-…4567");
  });

  it("rejects invalid env var names with 400", async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/v1/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "bad-name", value: "x" }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects empty values with 400", async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/v1/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "OPENAI_API_KEY", value: "" }),
    });
    expect(r.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tierkit/core exec vitest run secretsEndpoints`
Expected: FAIL (POST returns 404).

- [ ] **Step 3: Implement POST /v1/secrets**

In `Server.ts`, add this block directly after the GET /v1/secrets block from Task 5:

```typescript
      if (route === "POST /v1/secrets") {
        if (!opts.secrets) return sendJson(res, 501, { error: "secrets store not configured" });
        const body = await readJsonBody<{ key: string; value: string }>(req);
        if (!body || typeof body.key !== "string" || typeof body.value !== "string") {
          return sendJson(res, 400, { error: "request must be { key: string, value: string }" });
        }
        try {
          await opts.secrets.set(body.key, body.value);
          const listed = opts.secrets.list({ knownKeys: [body.key] });
          const entry = listed.entries.find((e) => e.key === body.key);
          return sendJson(res, 200, { ok: true, masked: entry?.masked ?? "" });
        } catch (err) {
          return sendJson(res, 400, { code: "invalid", message: (err as Error).message });
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tierkit/core exec vitest run secretsEndpoints`
Expected: PASS, 5 tests total.

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/secretsEndpoints.test.ts packages/core/src/runtime/Server.ts
git commit -m "feat(runtime): POST /v1/secrets — upsert key with masked response"
```

---

## Task 7: Endpoint — DELETE /v1/secrets/:key

**Files:**
- Test: `packages/core/test/secretsEndpoints.test.ts` (append)
- Modify: `packages/core/src/runtime/Server.ts`

- [ ] **Step 1: Add failing tests**

Append:

```typescript
describe("DELETE /v1/secrets/:key", () => {
  it("removes a key set via POST", async () => {
    const { baseUrl } = await bootServer();
    await fetch(`${baseUrl}/v1/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "OPENAI_API_KEY", value: "sk-ohai-1234567890xyz" }),
    });
    const del = await fetch(`${baseUrl}/v1/secrets/OPENAI_API_KEY`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const get = await fetch(`${baseUrl}/v1/secrets`);
    const listed = (await get.json()) as { entries: Array<{ key: string; set: boolean }> };
    const e = listed.entries.find((x) => x.key === "OPENAI_API_KEY");
    expect(e?.set ?? false).toBe(false);
  });

  it("returns 400 with code=external when key came from shell env (not our store)", async () => {
    const { baseUrl } = await bootServer({ ANTHROPIC_API_KEY: "sk-ant-fromshell12345" });
    const r = await fetch(`${baseUrl}/v1/secrets/ANTHROPIC_API_KEY`, { method: "DELETE" });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("external");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tierkit/core exec vitest run secretsEndpoints`
Expected: FAIL (DELETE returns 404).

- [ ] **Step 3: Implement DELETE /v1/secrets/:key**

In `Server.ts`, add this block directly after the POST /v1/secrets block:

```typescript
      if (method === "DELETE" && url.pathname.startsWith("/v1/secrets/")) {
        if (!opts.secrets) return sendJson(res, 501, { error: "secrets store not configured" });
        const key = decodeURIComponent(url.pathname.slice("/v1/secrets/".length));
        if (!key) return sendJson(res, 400, { error: "missing key in path" });
        const ok = await opts.secrets.remove(key);
        if (!ok) {
          return sendJson(res, 400, {
            ok: false,
            code: "external",
            message: "key was set by the shell env, not by Tierkit — cannot remove",
          });
        }
        return sendJson(res, 200, { ok: true });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tierkit/core exec vitest run secretsEndpoints`
Expected: PASS, 7 tests total.

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/secretsEndpoints.test.ts packages/core/src/runtime/Server.ts
git commit -m "feat(runtime): DELETE /v1/secrets/:key — refuse external/shell-env keys"
```

---

## Task 8: GUI — per-row delete button on model profiles

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Add i18n strings**

In `gui.ts`, add to the `RUNTIME.en` block (around line 762, before the closing `}` of `en`):

```javascript
      deleteBtn: 'Delete',
      confirmDeleteProfile: 'Delete profile "{id}"?',
      deletedOk: 'deleted',
      keyMissing: 'API key not set',
      setKeyBtn: 'Set key',
      keySaved: 'API key saved',
      apiKeyValueLabel: 'API key value',
      apiKeyValuePlaceholder: 'paste sk-… (optional)',
      sectionApiKeys: 'API Keys',
      keyExternal: 'set by shell env — cannot delete here',
```

And the matching `ko` block:

```javascript
      deleteBtn: '삭제',
      confirmDeleteProfile: '"{id}" 프로파일을 삭제할까요?',
      deletedOk: '삭제됨',
      keyMissing: 'API 키 미설정',
      setKeyBtn: '키 입력',
      keySaved: 'API 키 저장됨',
      apiKeyValueLabel: 'API 키 값',
      apiKeyValuePlaceholder: 'sk-… 붙여넣기 (선택)',
      sectionApiKeys: 'API 키',
      keyExternal: '셸 env에서 설정됨 — 여기서 삭제 불가',
```

- [ ] **Step 2: Modify refreshModels to add delete + missing-key indicator**

In `gui.ts`, replace the existing `refreshModels()` function (lines ~1271-1315) with this version. The diff is: (a) fetch /v1/secrets in parallel, (b) add delete button to each row, (c) show keyMissing pill for profiles whose apiKeyEnv is unset.

```javascript
  async function refreshModels() {
    try {
      const [r, secretsR] = await Promise.all([
        jget('/v1/models'),
        jget('/v1/secrets').catch(() => ({ entries: [] })),
      ]);
      const entries = r.entries || [];
      const secretMap = {};
      for (const s of (secretsR.entries || [])) secretMap[s.key] = s;
      const root = $('models-list');
      root.innerHTML = '';
      if (entries.length === 0) {
        root.innerHTML = '<div class="empty">no profiles</div>';
        renderApiKeysSection(secretMap);
        return;
      }
      const srcLabel = lang === 'ko'
        ? { bundled: '기본', user: '사용자', workspace: '워크스페이스' }
        : { bundled: 'bundled', user: 'user', workspace: 'workspace' };
      for (const e of entries) {
        const p = e.profile || {};
        const keyMissing = p.apiKeyEnv && !(secretMap[p.apiKeyEnv] && secretMap[p.apiKeyEnv].set);
        const row = document.createElement('div');
        row.className = 'row dense';
        row.innerHTML =
          '<div class="col-grow">' +
            '<div><span class="mono" style="color:var(--accent)">' + escapeHtml(e.id) + '</span>' +
              ' <span class="dim">(' + escapeHtml(p.kind || '?') + ')</span></div>' +
            '<div class="dim mono" style="margin-top:2px;font-size:10.5px">' +
              escapeHtml(p.provider || '') + ' · ' + escapeHtml(p.model || '') +
              ' · <span style="color:var(--fg-dim)">' + escapeHtml(srcLabel[e.source] || e.source) + '</span>' +
              (p.requiresApproval ? ' · <span style="color:var(--warn)">⚠</span>' : '') +
              (keyMissing
                ? ' · <span style="color:var(--warn)">⚠ ' + escapeHtml(i18n.keyMissing) + '</span>' +
                  ' <button class="tiny" data-action="setkey" data-key="' + escapeHtml(p.apiKeyEnv) + '">' + escapeHtml(i18n.setKeyBtn) + '</button>'
                : '') +
            '</div>' +
          '</div>' +
          '<button class="tiny" data-action="test" data-id="' + escapeHtml(e.id) + '">test</button>' +
          ' <button class="tiny" data-action="delete-profile" data-id="' + escapeHtml(e.id) + '" data-scope="' + escapeHtml(e.source) + '">' + escapeHtml(i18n.deleteBtn) + '</button>';
        root.appendChild(row);
      }
      root.querySelectorAll('button[data-action="test"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id'); b.disabled = true; b.textContent = '...';
          try {
            const resp = await jpost('/v1/models/test', { profileId: id });
            const d = resp.data || {};
            if (resp.ok) toast(id + ' ✓ ' + (d.modelAvailable === false ? 'reachable, model missing' : 'reachable'), d.modelAvailable === false ? 'err' : 'ok');
            else toast(id + ': ' + (d.code || 'err'), 'err');
          } finally { b.disabled = false; b.textContent = 'test'; }
        };
      });
      root.querySelectorAll('button[data-action="delete-profile"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id');
          const scope = b.getAttribute('data-scope') === 'user' ? 'user' : 'workspace';
          if (!confirm(i18n.confirmDeleteProfile.replace('{id}', id))) return;
          b.disabled = true;
          try {
            const resp = await transport.request('/v1/config/profile/' + encodeURIComponent(id) + '?scope=' + scope, { method: 'DELETE' });
            if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
            toast(id + ' ✓ ' + i18n.deletedOk, 'ok');
            await refreshModels();
          } finally { b.disabled = false; }
        };
      });
      root.querySelectorAll('button[data-action="setkey"]').forEach((b) => {
        b.onclick = () => openSetKeyDialog(b.getAttribute('data-key'));
      });
      renderApiKeysSection(secretMap);
    } catch (e) {
      $('models-list').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }
```

- [ ] **Step 3: Add placeholder stubs for the two helpers used above**

Right above `refreshModels` (before the `// ── Card: Models` comment, around line 1269), add stubs that we'll fill in in Task 9. This lets the file parse:

```javascript
  function openSetKeyDialog(_key) { /* implemented in Task 9 */ }
  function renderApiKeysSection(_secretMap) { /* implemented in Task 9 */ }
```

- [ ] **Step 4: Note — `transport.request` is what jget/jpost wrap**

The DELETE call uses `transport.request` directly because `jpost` only supports POST. Confirm this exists by checking [gui.ts:866](packages/core/src/runtime/ui/gui.ts#L866) — it does (`transport.request(p, { method: 'GET' })`).

- [ ] **Step 5: Build + smoke-test manually**

Run: `pnpm --filter @tierkit/core build`
Expected: build succeeds.

Then start the daemon in another shell:
```bash
cd /Users/siwal/code/Tierkit
pnpm --filter @tierkit/cli build
node packages/cli/dist/index.js runtime start
```
Open http://127.0.0.1:4101/ → Settings tab → Model profiles card. Each row should have a `[Delete]` button next to `[test]`. Cloud rows whose API key isn't set should show `⚠ API key not set [Set key]`.

Click `[Delete]` on a test profile (add a throwaway first via `+ Add` if needed) → confirm → row disappears.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git commit -m "feat(gui): per-row delete button + missing-key indicator on model profiles"
```

---

## Task 9: GUI — API Keys subsection + Set-key dialog

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Replace the stubs from Task 8 with real implementations**

In `gui.ts`, find the two stub functions (`openSetKeyDialog`, `renderApiKeysSection`) added in Task 8 and replace them with:

```javascript
  function openSetKeyDialog(presetKey) {
    const existing = document.getElementById('secret-dialog');
    if (existing) existing.remove();
    const dlg = document.createElement('div');
    dlg.id = 'secret-dialog';
    dlg.className = 'inline-form';
    dlg.style.marginTop = '8px';
    dlg.innerHTML =
      '<div class="form-grid">' +
        '<label>env name</label>' +
        '<input id="sk-key" value="' + escapeHtml(presetKey || '') + '" placeholder="ANTHROPIC_API_KEY" />' +
        '<label>' + escapeHtml(i18n.apiKeyValueLabel) + '</label>' +
        '<input id="sk-val" type="password" placeholder="sk-…" />' +
      '</div>' +
      '<div class="actions">' +
        '<button id="sk-cancel">' + escapeHtml(i18n.cancelBtn) + '</button>' +
        '<button id="sk-save" class="primary">' + escapeHtml(i18n.saveBtn) + '</button>' +
      '</div>';
    $('profile-add-form').style.display = 'block';
    $('profile-add-form').innerHTML = '';
    $('profile-add-form').appendChild(dlg);
    $('sk-cancel').onclick = () => { $('profile-add-form').innerHTML = ''; $('profile-add-form').style.display = 'none'; };
    $('sk-save').onclick = async () => {
      const key = ($('sk-key').value || '').trim();
      const value = ($('sk-val').value || '').trim();
      if (!key || !value) { toast('key + value required', 'err'); return; }
      const resp = await jpost('/v1/secrets', { key, value });
      if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
      toast(key + ' ✓ ' + i18n.keySaved, 'ok');
      $('profile-add-form').innerHTML = '';
      $('profile-add-form').style.display = 'none';
      await refreshModels();
    };
  }

  function renderApiKeysSection(secretMap) {
    const keys = Object.keys(secretMap).sort();
    let section = document.getElementById('api-keys-section');
    if (!section) {
      const card = $('models-list').parentElement;
      section = document.createElement('div');
      section.id = 'api-keys-section';
      section.className = 'card-divider';
      card.insertBefore(section, $('profile-add-form'));
    }
    if (keys.length === 0) { section.innerHTML = ''; return; }
    let html = '<div class="card-divider-label">' + escapeHtml(i18n.sectionApiKeys) + '</div>';
    for (const k of keys) {
      const e = secretMap[k];
      const status = e.set
        ? '<span class="mono dim">' + escapeHtml(e.masked || 'set') + '</span>'
        : '<span style="color:var(--warn)">⚠ ' + escapeHtml(i18n.keyMissing) + '</span>';
      html +=
        '<div class="row dense">' +
          '<div class="col-grow"><span class="mono">' + escapeHtml(k) + '</span> · ' + status + '</div>' +
          (e.set
            ? '<button class="tiny" data-action="delete-key" data-key="' + escapeHtml(k) + '">' + escapeHtml(i18n.deleteBtn) + '</button>'
            : '<button class="tiny" data-action="setkey" data-key="' + escapeHtml(k) + '">' + escapeHtml(i18n.setKeyBtn) + '</button>') +
        '</div>';
    }
    section.innerHTML = html;
    section.querySelectorAll('button[data-action="setkey"]').forEach((b) => {
      b.onclick = () => openSetKeyDialog(b.getAttribute('data-key'));
    });
    section.querySelectorAll('button[data-action="delete-key"]').forEach((b) => {
      b.onclick = async () => {
        const key = b.getAttribute('data-key');
        if (!confirm(i18n.confirmDeleteProfile.replace('{id}', key))) return;
        b.disabled = true;
        try {
          const resp = await transport.request('/v1/secrets/' + encodeURIComponent(key), { method: 'DELETE' });
          if (!resp.ok) {
            const msg = resp.data && resp.data.code === 'external' ? i18n.keyExternal : (resp.data && resp.data.message) || i18n.failed;
            toast(key + ': ' + msg, 'err');
            return;
          }
          toast(key + ' ✓ ' + i18n.deletedOk, 'ok');
          await refreshModels();
        } finally { b.disabled = false; }
      };
    });
  }
```

- [ ] **Step 2: Build + smoke-test manually**

Run: `pnpm --filter @tierkit/core build && pnpm --filter @tierkit/cli build`
Restart daemon, open the GUI Settings tab.

Expected:
- Below the Model profiles list, an **API Keys** subsection appears (only if any keys are referenced).
- Each row shows the env name + either `sk-…xyz9 [Delete]` or `⚠ API key not set [Set key]`.
- Click `[Set key]` on `ANTHROPIC_API_KEY` → dialog appears in the same area where `+ Add` opens. Paste a value, save → row updates to show masked value + `[Delete]`.
- Click `[Delete]` on a key you just set → confirm → row flips back to `⚠ not set`.
- If you have `export OPENAI_API_KEY=…` in your shell, the `[Delete]` button is NOT shown (only `[Set key]`, since we only show Delete for entries we own). Try forcing a delete via `curl -X DELETE http://127.0.0.1:4101/v1/secrets/OPENAI_API_KEY` → expect `{ ok: false, code: "external" }`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git commit -m "feat(gui): API Keys subsection + paste-key dialog (writes to /v1/secrets)"
```

---

## Task 10: GUI — optional API-key input in add-profile form

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Extend the add-profile form**

In `gui.ts`, find `$('btn-profile-add').onclick` (around line 1317). In the `render(provider)` function inside it (around line 1326), the `host.innerHTML` template currently shows the apiKeyEnv field for non-local providers. Modify the `(isLocal ? ... : ...)` ternary to ALSO add the value input. Replace:

```javascript
            (isLocal
              ? '<label>' + escapeHtml(i18n.baseUrlLabel) + '</label>' +
                '<input id="pa-baseUrl" value="' + escapeHtml(tpl.baseUrl) + '" />'
              : '<label>' + escapeHtml(i18n.apiKeyLabel) + '</label>' +
                '<input id="pa-apiKey" value="' + escapeHtml(tpl.apiKeyEnv) + '" />') +
```

with:

```javascript
            (isLocal
              ? '<label>' + escapeHtml(i18n.baseUrlLabel) + '</label>' +
                '<input id="pa-baseUrl" value="' + escapeHtml(tpl.baseUrl) + '" />'
              : '<label>' + escapeHtml(i18n.apiKeyLabel) + '</label>' +
                '<input id="pa-apiKey" value="' + escapeHtml(tpl.apiKeyEnv) + '" />' +
                '<label>' + escapeHtml(i18n.apiKeyValueLabel) + '</label>' +
                '<input id="pa-apiKeyValue" type="password" placeholder="' + escapeHtml(i18n.apiKeyValuePlaceholder) + '" />') +
```

- [ ] **Step 2: Save handler — POST /v1/secrets first if value is provided**

Still inside `render(provider)`, find `$('pa-save').onclick = async () => { ... }`. Replace the existing body with:

```javascript
      $('pa-save').onclick = async () => {
        const id = ($('pa-id').value || '').trim();
        const model = ($('pa-model').value || '').trim();
        const scope = $('pa-scope').value;
        const apiKeyEnv = $('pa-apiKey') ? $('pa-apiKey').value.trim() : '';
        const apiKeyValue = $('pa-apiKeyValue') ? $('pa-apiKeyValue').value.trim() : '';
        const baseUrl = $('pa-baseUrl') ? $('pa-baseUrl').value.trim() : '';
        if (!id || !model) { toast('id + model required', 'err'); return; }
        if (apiKeyValue) {
          if (!apiKeyEnv) { toast('API key env name required when value is set', 'err'); return; }
          const secResp = await jpost('/v1/secrets', { key: apiKeyEnv, value: apiKeyValue });
          if (!secResp.ok) { toast((secResp.data && secResp.data.message) || i18n.failed, 'err'); return; }
        }
        const profile = { kind: tpl.kind, provider, model, roles: [] };
        if (apiKeyEnv) profile.apiKeyEnv = apiKeyEnv;
        if (baseUrl) profile.baseUrl = baseUrl;
        if (tpl.kind === 'public-cloud') { profile.requiresApproval = true; profile.defaultMode = 'review-only'; }
        const resp = await jpost('/v1/config/profile', { id, profile, scope });
        if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
        toast(id + ' ✓ ' + i18n.added, 'ok');
        host.style.display = 'none'; host.innerHTML = '';
        await refreshModels();
      };
```

- [ ] **Step 3: Build + smoke-test manually**

Run: `pnpm --filter @tierkit/core build && pnpm --filter @tierkit/cli build`
Restart daemon. In the GUI, click `+ Add`, pick `anthropic`, fill `id=claudeTest`, `model=claude-sonnet-4-6`, `API key env=ANTHROPIC_API_KEY`, `API key value=sk-ant-…(real or fake)`. Save.

Expected:
- Profile appears in the list with NO `⚠ API key not set` indicator (because the value was just stored).
- API Keys subsection shows `ANTHROPIC_API_KEY · sk-ant-…xxxx [Delete]`.

Click `[test]` on the new profile — if the key is real, it should pass; if fake, the failure is from Anthropic, not from "missing-api-key".

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git commit -m "feat(gui): add-profile form accepts an optional API key value (stores via /v1/secrets)"
```

---

## Task 11: End-to-end verification + summary

**Files:** none

- [ ] **Step 1: Run the full core test suite**

Run: `pnpm --filter @tierkit/core test`
Expected: all green, including the 11 SecretsStore unit tests + 7 endpoint integration tests added in this plan.

- [ ] **Step 2: Visual confirmation checklist (browser at http://127.0.0.1:4101)**

Verify each of these in order:

- [ ] Settings tab → Model profiles card shows existing profiles, each with `[test]` and `[Delete]` buttons.
- [ ] Cloud profiles whose `apiKeyEnv` isn't set show `⚠ API key not set [Set key]` inline.
- [ ] An **API Keys** subsection lists every env name referenced by a profile.
- [ ] `[Set key]` opens a dialog with a password input. Saving stores the key and the row flips to masked + `[Delete]`.
- [ ] `[Delete]` on a stored key requires confirm, then removes it.
- [ ] `+ Add` → for anthropic/openai providers, the form has both `API key env` and `API key value` fields. Filling both stores the key automatically.
- [ ] `[Delete]` on a profile requires confirm, then removes the profile (re-running `tierkit doctor` from the CLI confirms it's gone from `tierkit.config.json`).

- [ ] **Step 3: Check `.tierkit/secrets.json` exists with mode 0600**

Run: `stat -f '%Sp %N' /Users/siwal/code/Tierkit/.tierkit/secrets.json` (macOS) or `stat -c '%a %n' .tierkit/secrets.json` (Linux).
Expected: shows `-rw-------` (i.e., mode `600`).

- [ ] **Step 4: Confirm `.tierkit/.gitignore` was created**

```bash
cat /Users/siwal/code/Tierkit/.tierkit/.gitignore
```
Expected: contains the line `secrets.json`.

- [ ] **Step 5: Final commit (only if any cleanups are needed; otherwise skip)**

If nothing to commit, just confirm:
```bash
git log --oneline -12
```
Expected: 10 new commits from this plan on top of `7701fd4`.

---

## Self-Review

Spec coverage check (against [the design doc](../specs/2026-05-18-model-management-ui-design.md)):

| Spec section | Plan task |
|---|---|
| 1. SecretsStore (file `<dataDir>/secrets.json`, mode 0600, atomic write, mask, .gitignore) | Tasks 1, 2 |
| 2. Boot-time injection in `runtimeLifecycle` | Task 4 |
| 3. `GET /v1/secrets` | Task 5 |
| 3. `POST /v1/secrets` | Task 6 |
| 3. `DELETE /v1/secrets/:key` (404 + external code) | Task 7 (note: spec says 404, plan uses 400 + `code: "external"` because endpoint succeeds in finding the key in env but refuses to act — this matches the spec's `{ ok: false, code: "external" }` wording) |
| 4a. Delete button per row | Task 8 |
| 4b. Missing-key warning + `[Set key]` inline | Task 8 + Task 9 (dialog) |
| 4c. Add-profile form: optional API key field | Task 10 |
| 4d. Mini "API Keys" subsection | Task 9 |
| 5. Safety (masking, never leak plaintext, confirm dialogs) | Tasks 1, 5, 8, 9 |
| 6. Tests | Tasks 1–3 (unit), 5–7 (integration), 8–11 (manual GUI) |
| 7. Backward compatibility (existing profiles unchanged, shell env wins) | Task 3 (`shell env wins over file`), Task 4 (no migration) |

No placeholders detected. Type/method names are consistent across tasks (`createSecretsStore`, `list`, `set`, `remove`, `loadIntoEnv`; route paths are stable; GUI helper IDs `pa-apiKey`/`pa-apiKeyValue`/`sk-key`/`sk-val` defined once and reused).

One spec ↔ plan delta to flag: spec section 3 says `404 if key not in store` for DELETE; plan returns `400 + code: "external"` when the key IS in `process.env` but not in our file (i.e., set by shell). For a key that's truly unknown (not in env, not in store), `remove()` returns `false` and the endpoint also returns 400 with `code: "external"`. This is intentional — distinguishing those two cases would require exposing more state about `process.env` than we want. Documented here so the implementer doesn't try to "fix" it.
