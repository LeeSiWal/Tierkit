# Model Management UI — Add/Delete Profiles + Paste API Keys

**Date:** 2026-05-18
**Status:** Approved (Phase 1 of 3)
**Scope:** Settings → Model profiles card in the Tierkit GUI

## Problem

Today the GUI's Model profiles card can list profiles and add new ones, but two gaps prevent users from actually using cloud models without dropping to a shell:

1. **No delete button.** The list ([gui.ts:1270-1315](../../../packages/core/src/runtime/ui/gui.ts)) only shows `[test]`. The backend already exposes `DELETE /v1/config/profile/:id` ([Server.ts:344](../../../packages/core/src/runtime/Server.ts)) — wiring is just missing.
2. **API key entry is hostile.** The add-profile form ([gui.ts:1317-1380](../../../packages/core/src/runtime/ui/gui.ts)) collects `apiKeyEnv` (an env var **name**, e.g. `ANTHROPIC_API_KEY`), not the key value. Users still have to `export` the secret in their shell before the daemon starts, otherwise the profile fails with `missing-api-key`.

This spec covers Phase 1 of a 3-phase roadmap. Phase 2 (auto fallback / upgrade) and Phase 3 (auto plugin selection) are out of scope here.

## Non-Goals

- Re-architecting `ModelRouter` or `RiskScorer`. Routing logic is untouched.
- Auto-discovery of local Ollama models (already works via `discoverOllamaModels: true`).
- Centralized secret rotation, sync across machines, or team sharing.
- Encrypting the secrets file at rest. File-mode `0600` + `.gitignore` is the chosen security boundary.

## Design

### 1. Backend — Secrets Store

**New module:** `packages/core/src/security/SecretsStore.ts`

```ts
export interface SecretsStore {
  /** All known env-var-style keys with whether they're set, plus a safe masked preview. */
  list(): { entries: Array<{ key: string; set: boolean; masked: string }> };
  /** Upsert a secret. Writes file atomically with mode 0600. Updates process.env. */
  set(key: string, value: string): Promise<void>;
  /** Remove from file and from process.env (only if it was injected by us). */
  remove(key: string): Promise<void>;
  /** Called once at daemon startup. Reads file, injects keys into process.env. */
  loadIntoEnv(): Promise<void>;
}

export function createSecretsStore(opts: { dataDir: string }): SecretsStore;
```

**File format** (`<dataDir>/secrets.json`, default `.tierkit/secrets.json`):

```json
{
  "ANTHROPIC_API_KEY": "sk-ant-…",
  "OPENAI_API_KEY": "sk-…"
}
```

**Rules:**

- File created lazily on first `set()`. Permissions `0600` enforced via `fs.chmod` after every write.
- Writes are atomic: write to `secrets.json.tmp` → `rename` to final.
- On `loadIntoEnv()`: if `process.env[key]` is already set (shell env), the shell value wins and we record the key as "external" so `remove()` won't touch it.
- On `remove(key)`: delete from file, then `delete process.env[key]` **only if** the key was originally injected by us (tracked in an in-memory `Set<string>`).
- Masking helper: `mask("sk-ant-abc123…xyz9")` → `"sk-ant-…xyz9"` (first 7 chars + `…` + last 4). Values shorter than 12 chars → `"…"+last2`.
- World/group-readable warning: on `loadIntoEnv()`, if `statSync(secretsPath).mode & 0o077 !== 0`, log a warning to stderr.

**`.gitignore` handling:** on first successful `set()`, ensure `<dataDir>/.gitignore` exists and contains the line `secrets.json`. Idempotent.

### 2. Backend — Boot-time injection

`packages/core/src/usecases/runtimeLifecycle.ts:startRuntime()` is the boot site. After `fs.mkdir(dataDir, { recursive: true })` and before `startServer(...)`, add:

```ts
const secrets = createSecretsStore({ dataDir });
await secrets.loadIntoEnv();
```

Pass `secrets` into `startServer({ ..., secrets })` so handlers can call it.

`startServer` (`ServerOptions`) gains an optional `secrets?: SecretsStore` field. When absent (tests), `/v1/secrets` endpoints return 501.

### 3. Backend — New endpoints

Three new routes in `Server.ts`:

| Route | Body | Response | Notes |
|-------|------|----------|-------|
| `GET /v1/secrets` | — | `{ entries: [{ key, set, masked }] }` | Never returns plaintext values. List = union of: known keys from `secrets.json` + every distinct `apiKeyEnv` referenced by any profile in config (so the UI can show "ANTHROPIC_API_KEY: not set" rows). |
| `POST /v1/secrets` | `{ key: string, value: string }` | `{ ok: true, masked }` | Validates `key` matches `/^[A-Z][A-Z0-9_]*$/` (env-var convention). Empty `value` → 400. |
| `DELETE /v1/secrets/:key` | — | `{ ok: true }` | 404 if key not in store. If key came from shell env, returns `{ ok: false, code: "external", message: "set by shell, not by Tierkit" }`. |

Loopback-only — same constraint as the rest of `/v1/*`, no extra auth needed.

### 4. GUI — Models card changes

File: `packages/core/src/runtime/ui/gui.ts` (single-file inlined GUI, no build step).

**4a. Delete button per row** (modify `refreshModels()` at ~line 1284):

Each row gains a `[×]` button to the left of `[test]`. Click → `confirm()` → `DELETE /v1/config/profile/:id` → `refreshModels()`. Toast on success/error.

**4b. Missing-key warning + inline "Set key" button:**

For profiles where `p.apiKeyEnv` is set, fetch `/v1/secrets` once per `refreshModels()` and cross-reference. If `entries[apiKeyEnv].set === false`, render a `⚠ key missing [Set key]` indicator below the model line. Clicking `[Set key]` opens a small inline form (key name pre-filled, value input, Save/Cancel) that POSTs to `/v1/secrets` then refreshes.

**4c. Add-profile form: optional API key field** (modify `render()` at ~line 1326):

For `anthropic` and `openai` providers, the form already shows the env-var-name field. Add **below** it a second input:

```
API key  [_______________]  (optional — paste sk-… to save it now)
```

On Save:
1. If the API key field is non-empty, POST `/v1/secrets { key: <apiKeyEnv-value>, value: <pasted> }` first. On 4xx, abort with toast.
2. POST `/v1/config/profile` as today.
3. `refreshModels()`.

For `ollama`, no API key field (unchanged).

**4d. Mini "Secrets" subsection** (new, below Models list):

```
API Keys
  ANTHROPIC_API_KEY   sk-ant-…xyz9   [×]
  OPENAI_API_KEY      ⚠ not set      [Set]
```

Reuses `/v1/secrets` data already fetched in 4b. `[×]` calls DELETE; `[Set]` opens the same inline form as 4b.

### 5. Safety

- Plaintext values **never** appear in any GET response, log line, or toast. Internal log lines that mention a key reference it as `<key=ANTHROPIC_API_KEY>` only.
- `process.memoryUsage` / heap dumps still leak — accepted (out of scope; same trust model as today's env vars).
- `confirm()` dialog before profile delete and before secret delete.
- POST `/v1/secrets` ignores any header attempting to set `X-Forwarded-For` — already enforced by loopback bind.

### 6. Tests

New unit tests under `packages/core/src/security/SecretsStore.test.ts`:

- `loadIntoEnv` with no file → no-op, returns empty list.
- `set` then `list` → key present, value masked correctly.
- `set` writes file with mode 0600 (check `statSync.mode & 0o777 === 0o600`).
- `remove` deletes from file AND from `process.env`.
- `remove` does NOT delete from `process.env` when value came from shell env at load time.
- Atomic write: simulate crash mid-write (write to tmp, throw before rename) → original file intact.
- `.gitignore` is created with `secrets.json` line on first `set`.

New integration tests under `packages/core/src/runtime/Server.test.ts` (or new file):

- `GET /v1/secrets` returns entries with `set: false` for `apiKeyEnv`s referenced by profiles but not stored.
- `POST /v1/secrets` then `GET /v1/secrets` shows `set: true` and masked value. Plaintext never appears in response.
- `POST /v1/secrets { key: "bad-name" }` → 400.
- `DELETE /v1/secrets/UNKNOWN` → 404.

GUI: manual verification only (matches existing GUI test policy — same as 0.9.x changes).

### 7. Backward compatibility

- Profiles unchanged. Existing `apiKeyEnv: "ANTHROPIC_API_KEY"` continues to work.
- Users who already export `ANTHROPIC_API_KEY` in their shell see no behavior change — shell env wins.
- No config migration needed.

## File Changes Summary

**New:**
- `packages/core/src/security/SecretsStore.ts`
- `packages/core/src/security/SecretsStore.test.ts`

**Modified:**
- `packages/core/src/usecases/runtimeLifecycle.ts` (boot-time inject)
- `packages/core/src/runtime/Server.ts` (3 endpoints + plumb `secrets` through `ServerOptions`)
- `packages/core/src/runtime/Server.test.ts` (or new `Server.secrets.test.ts`)
- `packages/core/src/runtime/ui/gui.ts` (delete button, key warnings, optional key input in add form, API Keys subsection, i18n strings ko/en)

**Estimated diff size:** ~350 lines added, ~30 modified.
