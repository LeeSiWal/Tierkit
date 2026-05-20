# Model Profile State Unification — Design Spec

**Date:** 2026-05-20
**Target version:** v0.12.3
**Status:** Approved (brainstorming → spec)

---

## 1. Problem statement

The model UI (Cost Control sidebar → Models card) has chronic bugs:

- **Toggle enable/disable is inconsistent** — clicking the toggle button sometimes appears to do nothing, or the toggle reverts after refresh.
- **Delete button doesn't work** — clicking Delete on a profile leaves it in the list (especially for Ollama auto-discovered profiles).
- **Duplicate entries in the list** — the same `(provider, baseUrl, model)` shows up twice with different ids (e.g. `localCoder` + `ollama-qwen2-5-coder-7b`, both mapping to `qwen2.5-coder:7b` on `127.0.0.1:11434`).

Two prior commits (`0e84006`, `89da934`) tried to fix the toggle/delete and shipped the same commit message twice — pattern of re-attempts that didn't stick. The root cause is structural, not surface-level.

## 2. Root cause

Three independent mechanisms currently express "profile is not active":

1. **`profile.enabled: boolean`** — inline field on each `ModelProfile`. Read by `sortProfilesForTier` ([packages/core/src/model/ModelRouter.ts:63](packages/core/src/model/ModelRouter.ts#L63)) via `p.enabled !== false`.
2. **`disabledProfileIds: string[]`** — separate array on `TierkitConfig`. Written by the `PATCH /v1/config/profile/:id` endpoint.
3. **`modelProfiles[id]: null`** — suppression marker that erases lower-priority layers. Written by the `DELETE /v1/config/profile/:id` endpoint.

The merge logic in [loadConfig.ts:196-203](packages/core/src/config/loadConfig.ts#L196-L203) syncs `disabledProfileIds` → `profile.enabled = false` ONLY for ids currently in the array. **It does not strip a stale `enabled: false` field when the id is removed from the array.**

Failure flow (toggle bug):
1. Profile config has `enabled: false` (from older code, sample default, or a prior delete attempt).
2. User clicks toggle ON → server removes id from `disabledProfileIds`.
3. Loader re-merges: id is no longer in the array, so the override at line 199 doesn't fire.
4. Raw `enabled: false` survives → effective state is still disabled → UI shows the profile as ON (because the toggle button derives state from `data-enabled`) but the router treats it as OFF.

Failure flow (duplicate bug):
1. Bundled sample `localCoder` covers `(ollama, 127.0.0.1:11434, qwen2.5-coder:7b)`.
2. Auto-discovery (`discoverOllamaProfiles`) walks `/api/tags`, sees the same model, synthesizes a new profile with id `ollama-qwen2-5-coder-7b`.
3. No `(provider, baseUrl, model)`-level dedup → both end up in the merged list.
4. User toggles/deletes one → the other remains active and the user can't tell why "the model is still on".

## 3. Goal

- **One** mechanism for "disabled" — `disabledProfileIds` array, since the PATCH endpoint already writes to it.
- **One** mechanism for "deleted" — `modelProfiles[id]: null` suppression marker, restricted to manually-added profiles.
- **Canonical identity** for profile dedup — `(provider, baseUrl, model)` is the natural key. The string id is a display label, not a uniqueness constraint.
- Delete button hidden for auto-discovered profiles (Ollama). User explicitly chose this in brainstorming: auto-discovered profiles can only be disabled, not deleted (since the underlying Ollama model still exists and would re-appear on next discovery).

## 4. Non-goals

- **Schema major version bump.** All changes are additive or migrated transparently. Existing `tierkit.config.json` files continue to work; on first load after the upgrade, they get cleaned up in place.
- **Cross-machine sync of disabled state.** Disabled state stays in the local config like today.
- **Touching the routing logic, budget, or task-classifier.** Those are out of scope.
- **`@tierkit/client` SDK changes.** Public types stay the same. The wire format is identical.
- **A new "deleted" runtime state.** Deleted profiles vanish from the merged view exactly like today.

## 5. Target design

### 5.1 Canonical-identity helper

New file `packages/core/src/model/profileIdentity.ts`:

```ts
import type { ModelProfile } from "./ModelProfile.js";

/**
 * Canonical identity of a profile — what makes two profile entries the SAME model on the
 * SAME endpoint, regardless of their string id. Used to dedup auto-discovered profiles
 * against manually-configured ones, and to dedup the GUI list as a defense in depth.
 *
 * Identity = (provider, baseUrl, model). Profiles missing baseUrl (e.g. cloud providers
 * that default to provider's own endpoint) use the empty string slot — different cloud
 * profiles for the same provider+model collide, which is the desired behavior (a duplicate
 * config entry for "claude-sonnet-4-6" via anthropic is a duplicate, full stop).
 */
export function canonicalIdentity(p: ModelProfile): string {
  return [p.provider ?? "", p.baseUrl ?? "", p.model ?? ""].join("|");
}
```

### 5.2 Single-source-of-truth helper for "disabled"

New helper in `packages/core/src/model/profileIdentity.ts`:

```ts
import type { TierkitConfig } from "../config/TierkitConfig.js";

/**
 * Returns true when this profile id is disabled. The ONLY mechanism going forward is
 * `disabledProfileIds`. The deprecated `profile.enabled === false` inline field is
 * IGNORED by readers — migrateLegacyEnabledField (see §5.4) folds it into the array on
 * load and rewrites the config file once, after which the field is gone.
 */
export function isProfileDisabled(cfg: TierkitConfig, id: string): boolean {
  return (cfg.disabledProfileIds ?? []).includes(id);
}
```

### 5.3 Discovery dedup (Ollama)

[packages/core/src/config/loadConfig.ts](packages/core/src/config/loadConfig.ts), around line 205 where `discoverOllamaProfiles()` is consumed:

```ts
if (acc.runtime.discoverOllamaModels !== false) {
  const discovered = await discoverOllamaProfiles();
  // Build a Set of canonical identities already covered by explicit configs
  // (bundled/user/workspace). Auto-discovery skips anything already covered.
  const coveredIdentities = new Set<string>();
  for (const p of Object.values(acc.modelProfiles)) {
    coveredIdentities.add(canonicalIdentity(p));
  }
  const merged: ModelProfileMap = { ...acc.modelProfiles };
  for (const [id, p] of Object.entries(discovered)) {
    if (suppressedIds.has(id)) continue;            // existing: explicit delete sticks
    if (coveredIdentities.has(canonicalIdentity(p))) continue;  // NEW: skip identity dups
    if (id in merged) continue;                      // existing: id collision (rare)
    merged[id] = p;
    profileSources[id] = "discovered";
  }
  acc = { ...acc, modelProfiles: merged };
}
```

### 5.4 Migration on load (one-time, in-place)

Inside `loadConfig`, BEFORE the existing `disabledProfileIds` sync block (around line 195):

```ts
// MIGRATION: fold any legacy `enabled: false` field into disabledProfileIds and remove
// the field from the raw config. Runs every load; idempotent. When something to migrate
// is found, we rewrite the SOURCE config file (workspace and/or user) so the next load
// sees a clean config. This makes the migration durable across daemon restarts.
const migrationTouched = await migrateLegacyEnabledField({ wsPath: workspacePath, userPath, wsRead, userRead });
if (migrationTouched.changed) {
  // Reload the changed files. Migration is cheap; the second read confirms persistence.
  // (Implementation note: we could splice the migrated values into `acc` directly, but
  //  a fresh read is simpler and avoids race conditions with concurrent writes.)
  // Force a re-merge from disk.
  return loadConfig(projectRoot, options);
}
```

`migrateLegacyEnabledField` lives in a new file `packages/core/src/config/migrateLegacyEnabledField.ts`:

```ts
/**
 * One-time-per-config migration: for each `modelProfiles[id]` with `enabled: false`,
 * add the id to `disabledProfileIds` and strip the field from the raw object. Writes
 * the updated JSON back to disk (atomic temp + rename) so the next load sees a clean
 * state. Idempotent: if no field is found, no write happens. Reports `changed: true`
 * when at least one file was rewritten.
 *
 * Also handles the case where `enabled: true` is set — strips the field too (it's the
 * default behavior, so the field is redundant noise).
 */
export async function migrateLegacyEnabledField(input: {
  wsPath: string;
  userPath: string;
  wsRead: { raw: Record<string, unknown> } | undefined;
  userRead: { raw: Record<string, unknown> } | undefined;
}): Promise<{ changed: boolean }>;
```

### 5.5 Migration on load (canonical-identity duplicates)

Same place as §5.4 (called from `loadConfig` before the existing dedup-disabled sync):

```ts
const dedupTouched = await migrateCanonicalDuplicates({ wsPath: workspacePath, userPath, wsRead, userRead });
if (dedupTouched.changed) return loadConfig(projectRoot, options);
```

`migrateCanonicalDuplicates` lives in `packages/core/src/config/migrateCanonicalDuplicates.ts`:

```ts
/**
 * For each (provider, baseUrl, model) canonical identity, if MORE THAN ONE profile id
 * in the workspace OR user config maps to it, keep the highest-priority one and write
 * `null` (suppression marker) for the lower-priority ones in their source file.
 *
 * Priority (high → low):
 *   1. Workspace `modelProfiles` entry with `roles.length > 0`
 *   2. User `modelProfiles` entry with `roles.length > 0`
 *   3. Workspace `modelProfiles` entry (any)
 *   4. User `modelProfiles` entry (any)
 *
 * Bundled (sample) and discovered profiles are NEVER overwritten by this migration —
 * they live in code or are recomputed on each load. The migration only touches workspace
 * + user config files.
 *
 * Returns `changed: true` when at least one file was rewritten.
 */
export async function migrateCanonicalDuplicates(input: {
  wsPath: string;
  userPath: string;
  wsRead: { raw: Record<string, unknown> } | undefined;
  userRead: { raw: Record<string, unknown> } | undefined;
}): Promise<{ changed: boolean }>;
```

### 5.6 Readers must consult the helper

Two callsites:

- [packages/core/src/model/ModelRouter.ts:63](packages/core/src/model/ModelRouter.ts#L63) `p.enabled !== false` → replace with `!isProfileDisabled(cfg, id)` (requires plumbing `cfg` through to `sortProfilesForTier`).
- [packages/core/src/runtime/ui/gui.ts:2378](packages/core/src/runtime/ui/gui.ts#L2378) `data-enabled="(p.enabled === false ? '0' : '1')"` → unchanged AT THIS SITE (the loader still sets `profile.enabled` for currently-disabled ids via the existing sync block), but the **render also dedups by canonical identity** before iterating (§5.7).

After migration is in place, `profile.enabled` on the IN-MEMORY merged config still exists as a derived/synthesized field set by the loader from `disabledProfileIds`. The schema's `enabled` field becomes deprecated for callers writing config; readers can keep reading it because the loader is the only writer.

**The schema definition itself** ([packages/core/src/model/ModelProfile.ts](packages/core/src/model/ModelProfile.ts)) keeps `enabled: z.boolean().optional()` to maintain backward compatibility with any external config files that still set it. The migration silently folds those values into `disabledProfileIds` on first load.

### 5.7 Display dedup (defense in depth)

[packages/core/src/runtime/ui/gui.ts](packages/core/src/runtime/ui/gui.ts), wherever the model list is rendered (~line 2300-2380, the `refreshModels()` flow). Before sorting/rendering entries:

```js
// Defense in depth: even if migration didn't run (older daemon, race condition, etc.),
// never show two rows with the same canonical identity. Priority: workspace > user >
// bundled > discovered; within a source, richer metadata wins (more roles / has cost).
const dedupedEntries = dedupeByCanonicalIdentity(entries);
```

Helper:

```js
function dedupeByCanonicalIdentity(entries) {
  const SOURCE_RANK = { workspace: 0, user: 1, bundled: 2, discovered: 3 };
  const byIdentity = new Map();
  for (const e of entries) {
    const key = (e.profile.provider || '') + '|' + (e.profile.baseUrl || '') + '|' + (e.profile.model || '');
    const existing = byIdentity.get(key);
    if (!existing) { byIdentity.set(key, e); continue; }
    // Tiebreak: lower source rank wins; within same rank, more roles wins.
    const eRank = SOURCE_RANK[e.source] ?? 99;
    const existingRank = SOURCE_RANK[existing.source] ?? 99;
    if (eRank < existingRank) { byIdentity.set(key, e); continue; }
    if (eRank === existingRank) {
      const eRoles = (e.profile.roles || []).length;
      const existingRoles = (existing.profile.roles || []).length;
      if (eRoles > existingRoles) byIdentity.set(key, e);
    }
  }
  return Array.from(byIdentity.values());
}
```

### 5.8 Delete button visibility

[packages/core/src/runtime/ui/gui.ts:2382](packages/core/src/runtime/ui/gui.ts#L2382) — the Delete button is currently rendered unconditionally. Change:

```js
// Only manually-added profiles (workspace/user) get a Delete button.
// Bundled samples can be disabled via toggle (effectively "remove from auto-routing").
// Auto-discovered profiles cannot be deleted because the underlying Ollama model still
// exists and would just be re-discovered on next load.
const canDelete = e.source === 'workspace' || e.source === 'user';
const deleteBtn = canDelete
  ? ' <button class="tiny" data-action="delete-profile" data-id="' + escapeHtml(e.id) + '" data-scope="' + escapeHtml(e.source) + '">' + escapeHtml(i18n.deleteBtn) + '</button>'
  : '';
```

For bundled samples (e.g. `localCoder` from `defaultProfiles.ts`), the user can toggle off, but Delete is hidden — the same as auto-discovered. Bundled samples come back automatically on next install if removed, so hiding Delete is the consistent behavior.

## 6. API contract

No breaking changes.

- `GET /v1/config` → returns merged config exactly as today; `disabledProfileIds` reflects unified state.
- `PATCH /v1/config/profile/:id` with `{ enabled }` → unchanged. Writes to `disabledProfileIds` array. Loader migration ensures any pre-existing `enabled` field is cleared on next load.
- `DELETE /v1/config/profile/:id` → unchanged. Writes `null` suppression marker. Server-side validation now rejects deletes for bundled or discovered profiles (returns `400 cannot-delete-non-editable`).

Server-side guard added to `DELETE /v1/config/profile/:id`:

```ts
// Reject delete for sources that re-create themselves (bundled samples, auto-discovered).
// User must use toggle (PATCH with enabled:false) instead. Returns 400 cannot-delete-non-editable.
const source = profileSources[id];
if (source === "bundled" || source === "discovered") {
  return sendJson(res, 400, {
    ok: false,
    code: "cannot-delete-non-editable",
    message: `cannot delete '${id}' (source: ${source}). Toggle it off instead — it will be re-created automatically otherwise.`,
  });
}
```

## 7. Migration safety

- **Migrations run on every `loadConfig` call** but are idempotent: if nothing to change, no write happens.
- **The recursive `return loadConfig(...)` after a touch** triggers exactly once per process startup, since the second load finds nothing to migrate. Worst case: 2 reads + 1-2 writes on first run.
- **Atomic writes**: existing `temp + rename` pattern from `profileCrud.ts` applies; if the daemon dies mid-write, the original config is intact.
- **Backups**: NOT included in this spec. Users can `git diff` their `tierkit.config.json` to see what the migration did. If we want backups later, they go in v0.13.

## 8. Testing

Unit tests:

- `canonicalIdentity` covers same-provider-same-model-same-url → same string; differing on any axis → different string; missing baseUrl → empty slot.
- `isProfileDisabled` returns true for ids in the array; false otherwise; handles missing array gracefully.
- `migrateLegacyEnabledField`:
  - `enabled: false` in workspace → folded into `disabledProfileIds`, field removed, file rewritten.
  - `enabled: true` → field removed, no change to array.
  - No field → no-op, `changed: false`.
  - Mix of workspace + user files → both updated independently.
- `migrateCanonicalDuplicates`:
  - Workspace `localCoder` + workspace `ollama-qwen2-5-coder-7b` → lower-priority gets `null`.
  - Workspace + user duplicate → workspace wins.
  - Within same scope, richer metadata wins.
  - No duplicates → no-op.

Integration tests:

- `contextHttpEndpoints.test.ts`-style: boot the daemon with a fixture config containing a legacy `enabled: false` profile + a canonical duplicate. After load, `GET /v1/config` shows: clean profile list, disabled state preserved via `disabledProfileIds`, duplicate removed.
- Toggle round-trip: `PATCH /v1/config/profile/X { enabled: false }` then GET → `disabledProfileIds` contains X and that profile's merged `enabled` is `false`. Toggle back ON → both clear.
- Delete guard: `DELETE /v1/config/profile/localCoder?scope=workspace` while `localCoder` is from bundled → 400 `cannot-delete-non-editable`.
- Delete success: `DELETE /v1/config/profile/myCustomProfile?scope=workspace` where the profile is in the workspace config → suppression marker written, subsequent GET hides it.

GUI smoke (manual): on the `tierkit-vscode-0.12.3.vsix`, the Models list shows no duplicates, every visible profile has a Test button, only workspace/user profiles show Delete, toggle round-trips correctly across reload.

## 9. Acceptance criteria

1. After upgrading to v0.12.3, an existing config with `enabled: false` fields + `disabledProfileIds` entries gets cleaned up: the field is stripped, the array remains canonical.
2. Toggling a profile OFF then ON in the GUI leaves no stale state — the next page reload shows the toggle in the correct position and the router treats the profile as enabled.
3. The Models list shows AT MOST ONE row per `(provider, baseUrl, model)` triple. Sample `localCoder` and auto-discovered `ollama-qwen2-5-coder-7b` pointing at the same model collapse to one row.
4. The Delete button does NOT appear on bundled or auto-discovered rows. On manually-added rows, clicking Delete makes the profile vanish, and subsequent loads (including auto-discovery) don't bring it back.
5. `pnpm -r test --run` is fully green. `pnpm -r typecheck` is clean. Existing 541 tests + at least 12 new unit + integration tests.
6. No `ConfigSchema` major-version bump. No `@tierkit/client` SDK API change. `tierkit.config.json` files that worked in v0.12.2 continue to work in v0.12.3.
7. Memory note `project_v18_3_profile_state_unification.md` added; MEMORY.md index updated.

## 10. Implementation order (preview, fleshed out in writing-plans)

Five phases:

1. **Helpers (new file)** — `canonicalIdentity` + `isProfileDisabled` + unit tests
2. **Migrations (new files)** — `migrateLegacyEnabledField` + `migrateCanonicalDuplicates` + unit tests
3. **loadConfig wiring** — call migrations + use canonical identity in discovery dedup
4. **Server-side delete guard** — `cannot-delete-non-editable` for bundled/discovered
5. **GUI fix** — display dedup + Delete button visibility + tests
6. **Release** — version bump 0.12.3, README/CHANGELOG, memory note

Each phase is TDD red→green→commit.
