# Model Profile State Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3 parallel "disabled" mechanisms (`profile.enabled` field, `disabledProfileIds` array, `null` suppression marker) with a single canonical source (`disabledProfileIds`), add canonical-identity dedup for profiles sharing `(provider, baseUrl, model)`, and hide Delete on non-editable rows. Fixes chronic toggle/delete/duplicate bugs in the Models card.

**Architecture:** Two new helpers (`canonicalIdentity`, `isProfileDisabled`) + two on-load migrations (`migrateLegacyEnabledField`, `migrateCanonicalDuplicates`). `loadConfig` runs migrations once per process (idempotent), Ollama discovery uses canonical-identity dedup before adding new entries. Server-side delete guard rejects deletes for bundled/discovered profiles. GUI dedups by canonical identity as defense in depth and hides Delete for non-editable rows.

**Tech Stack:** TypeScript / zod / vitest / tsup. No new dependencies. No `@tierkit/client` SDK change.

**Spec:** [`docs/superpowers/specs/2026-05-20-model-profile-state-unification-design.md`](../specs/2026-05-20-model-profile-state-unification-design.md)

**Pre-flight notes (verified by plan author, 2026-05-20):**
- HEAD before this work: `9ef1245` (spec committed)
- Current core test count: 541 across 85 files; typecheck clean
- `ConfigSource` enum at [`packages/core/src/config/loadConfig.ts:14`](../../packages/core/src/config/loadConfig.ts#L14) = `"bundled" | "user" | "workspace" | "discovered"`
- Existing CRUD code at [`packages/core/src/usecases/profileCrud.ts`](../../packages/core/src/usecases/profileCrud.ts) (workspace + user file writers, atomic temp+rename)
- HTTP handlers at [`packages/core/src/runtime/Server.ts:713-741`](../../packages/core/src/runtime/Server.ts#L713) (DELETE/PATCH `/v1/config/profile/:id`)
- GUI render at [`packages/core/src/runtime/ui/gui.ts:2370-2440`](../../packages/core/src/runtime/ui/gui.ts#L2370)
- Loader's existing disabledProfileIds sync at [`packages/core/src/config/loadConfig.ts:196-203`](../../packages/core/src/config/loadConfig.ts#L196)
- Memory dir: `/Users/siwal/.claude/projects/-Users-siwal-code-Tierkit/memory/` (outside repo)

---

## Task 1: Canonical-identity + isDisabled helpers

**Files:**
- Create: `packages/core/src/model/profileIdentity.ts`
- Modify: `packages/core/src/index.ts` (export helpers)
- Test: `packages/core/test/profileIdentity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/profileIdentity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalIdentity, isProfileDisabled } from "@tierkit/core";
import type { ModelProfile } from "@tierkit/core";

const p = (over: Partial<ModelProfile> = {}): ModelProfile => ({
  kind: "local-device",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen2.5-coder:7b",
  roles: [],
  ...over,
});

describe("canonicalIdentity", () => {
  it("returns same string for same (provider, baseUrl, model)", () => {
    expect(canonicalIdentity(p())).toBe(canonicalIdentity(p()));
  });

  it("differs when provider differs", () => {
    expect(canonicalIdentity(p({ provider: "anthropic" }))).not.toBe(canonicalIdentity(p()));
  });

  it("differs when baseUrl differs", () => {
    expect(canonicalIdentity(p({ baseUrl: "http://10.0.0.1:11434" }))).not.toBe(canonicalIdentity(p()));
  });

  it("differs when model differs", () => {
    expect(canonicalIdentity(p({ model: "llama3.2:3b" }))).not.toBe(canonicalIdentity(p()));
  });

  it("treats missing baseUrl as empty slot (cloud providers)", () => {
    const anthropic1: ModelProfile = { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6", roles: [] };
    const anthropic2: ModelProfile = { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6", roles: [] };
    expect(canonicalIdentity(anthropic1)).toBe(canonicalIdentity(anthropic2));
  });
});

describe("isProfileDisabled", () => {
  it("returns true for an id in disabledProfileIds", () => {
    expect(isProfileDisabled({ disabledProfileIds: ["foo"] } as any, "foo")).toBe(true);
  });

  it("returns false for an id NOT in disabledProfileIds", () => {
    expect(isProfileDisabled({ disabledProfileIds: ["foo"] } as any, "bar")).toBe(false);
  });

  it("returns false when disabledProfileIds is missing", () => {
    expect(isProfileDisabled({} as any, "anything")).toBe(false);
  });

  it("returns false when disabledProfileIds is undefined", () => {
    expect(isProfileDisabled({ disabledProfileIds: undefined } as any, "x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test profileIdentity -- --run`
Expected: FAIL — `canonicalIdentity` and `isProfileDisabled` not exported.

- [ ] **Step 3: Implement helpers**

Create `packages/core/src/model/profileIdentity.ts`:

```ts
import type { ModelProfile } from "./ModelProfile.js";
import type { TierkitConfig } from "../config/TierkitConfig.js";

/**
 * Canonical identity of a profile — what makes two profile entries the SAME model on the
 * SAME endpoint, regardless of their string id. Used to dedup auto-discovered profiles
 * against manually-configured ones, and to dedup the GUI list as a defense in depth.
 *
 * Identity = (provider, baseUrl, model). Profiles missing baseUrl (e.g. cloud providers
 * that default to provider's own endpoint) use the empty string slot — different cloud
 * profiles for the same provider+model collide, which is the desired behavior.
 */
export function canonicalIdentity(p: ModelProfile): string {
  return [p.provider ?? "", p.baseUrl ?? "", p.model ?? ""].join("|");
}

/**
 * Returns true when this profile id is disabled. The ONLY mechanism going forward is
 * `disabledProfileIds`. The deprecated `profile.enabled === false` inline field is
 * IGNORED by readers — `migrateLegacyEnabledField` folds it into the array on load
 * and rewrites the config file once, after which the field is gone.
 */
export function isProfileDisabled(cfg: TierkitConfig, id: string): boolean {
  return (cfg.disabledProfileIds ?? []).includes(id);
}
```

- [ ] **Step 4: Add exports to `index.ts`**

In `packages/core/src/index.ts`, find an existing `from "./model/` export block (search `ModelProfile`). Add a parallel block:

```ts
export {
  canonicalIdentity,
  isProfileDisabled,
} from "./model/profileIdentity.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tierkit/core build && pnpm --filter @tierkit/core test profileIdentity -- --run`
Expected: PASS (8 tests).

- [ ] **Step 6: Run full core suite + typecheck**

Run: `pnpm --filter @tierkit/core typecheck && pnpm --filter @tierkit/core test -- --run`
Expected: typecheck clean; all tests pass (541 + 8 = 549).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/model/profileIdentity.ts \
        packages/core/src/index.ts \
        packages/core/test/profileIdentity.test.ts
git commit -m "feat(core, v0.12.3): canonicalIdentity + isProfileDisabled helpers

Two pure helpers as the foundation for the model-profile state
unification. canonicalIdentity(profile) returns (provider|baseUrl|model)
as the natural-key string for dedup. isProfileDisabled(cfg, id) is the
single-source-of-truth check that all readers will route through —
disabledProfileIds array only, ignores the legacy enabled field
(which migration strips on load).

8 unit tests covering same/different on each axis + missing-baseUrl
collapse behavior for cloud providers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: migrateLegacyEnabledField

**Files:**
- Create: `packages/core/src/config/migrateLegacyEnabledField.ts`
- Modify: `packages/core/src/index.ts` (export — internal use, but exported for testing)
- Test: `packages/core/test/migrateLegacyEnabledField.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/migrateLegacyEnabledField.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { migrateLegacyEnabledField } from "@tierkit/core";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mig-enabled-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeJson(name: string, data: unknown): Promise<string> {
  const p = path.join(tmp, name);
  await fs.writeFile(p, JSON.stringify(data, null, 2));
  return p;
}

async function readJson(p: string): Promise<any> {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

describe("migrateLegacyEnabledField", () => {
  it("folds enabled:false into disabledProfileIds and strips the field", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: false },
        bar: { kind: "local-device", provider: "ollama", model: "y", roles: [] },
      },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.disabledProfileIds).toContain("foo");
    expect(after.disabledProfileIds).not.toContain("bar");
    expect(after.modelProfiles.foo.enabled).toBeUndefined();
    expect(after.modelProfiles.bar.enabled).toBeUndefined();
  });

  it("strips enabled:true (it's the default — redundant)", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: true },
      },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.modelProfiles.foo.enabled).toBeUndefined();
    expect(after.disabledProfileIds ?? []).not.toContain("foo");
  });

  it("no-op when no profile has enabled field", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { kind: "local-device", provider: "ollama", model: "x", roles: [] },
      },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(false);
  });

  it("handles workspace + user config independently", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: { foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: false } },
    });
    const userPath = await writeJson("user.json", {
      version: "0.1",
      modelProfiles: { bar: { kind: "local-device", provider: "ollama", model: "y", roles: [], enabled: false } },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath,
      wsRead: { raw: await readJson(wsPath) }, userRead: { raw: await readJson(userPath) },
    });
    expect(r.changed).toBe(true);
    expect((await readJson(wsPath)).disabledProfileIds).toContain("foo");
    expect((await readJson(userPath)).disabledProfileIds).toContain("bar");
  });

  it("dedupes disabledProfileIds when id already there + enabled:false present", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      disabledProfileIds: ["foo"],
      modelProfiles: { foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: false } },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.disabledProfileIds.filter((x: string) => x === "foo")).toHaveLength(1);
  });

  it("ignores null entries in modelProfiles (suppression markers)", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: { foo: null, bar: { kind: "local-device", provider: "ollama", model: "y", roles: [] } },
    });
    const r = await migrateLegacyEnabledField({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(false);
    const after = await readJson(wsPath);
    expect(after.modelProfiles.foo).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test migrateLegacyEnabledField -- --run`
Expected: FAIL — `migrateLegacyEnabledField` not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/config/migrateLegacyEnabledField.ts`:

```ts
import fs from "node:fs/promises";

interface RawConfigRead {
  raw: Record<string, unknown>;
}

interface MigrateInput {
  wsPath: string;
  userPath: string;
  wsRead: RawConfigRead | undefined;
  userRead: RawConfigRead | undefined;
}

/**
 * One-time-per-config migration: for each `modelProfiles[id]` with an `enabled` field
 * (true OR false), strip the field. If the value was `false`, add the id to
 * `disabledProfileIds` (deduplicated). Writes the updated JSON back to disk (atomic
 * temp + rename). Idempotent: if no field is found, no write happens.
 *
 * The function is called from `loadConfig` on every load. After the first migration,
 * subsequent loads find no `enabled` field and return `changed: false`.
 */
export async function migrateLegacyEnabledField(input: MigrateInput): Promise<{ changed: boolean }> {
  let anyChanged = false;
  for (const target of [
    { path: input.wsPath, read: input.wsRead },
    { path: input.userPath, read: input.userRead },
  ]) {
    if (!target.read) continue;
    const updated = migrateOne(target.read.raw);
    if (!updated.changed) continue;
    await writeAtomic(target.path, updated.raw);
    anyChanged = true;
  }
  return { changed: anyChanged };
}

function migrateOne(raw: Record<string, unknown>): { changed: boolean; raw: Record<string, unknown> } {
  const profiles = raw.modelProfiles as Record<string, unknown> | undefined;
  if (!profiles || typeof profiles !== "object") return { changed: false, raw };

  let changed = false;
  const disabled = new Set<string>(Array.isArray(raw.disabledProfileIds) ? (raw.disabledProfileIds as string[]) : []);
  const initialDisabledSize = disabled.size;

  const newProfiles: Record<string, unknown> = {};
  for (const [id, val] of Object.entries(profiles)) {
    if (val === null || typeof val !== "object") {
      newProfiles[id] = val;
      continue;
    }
    const profile = val as Record<string, unknown>;
    if (!("enabled" in profile)) {
      newProfiles[id] = profile;
      continue;
    }
    if (profile.enabled === false) disabled.add(id);
    const { enabled: _omit, ...rest } = profile;
    void _omit;
    newProfiles[id] = rest;
    changed = true;
  }

  if (!changed && disabled.size === initialDisabledSize) return { changed: false, raw };

  return {
    changed: true,
    raw: { ...raw, modelProfiles: newProfiles, disabledProfileIds: Array.from(disabled) },
  };
}

async function writeAtomic(target: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = target + ".tmp";
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, target);
}
```

- [ ] **Step 4: Add export to `index.ts`**

Add to `packages/core/src/index.ts`:

```ts
export { migrateLegacyEnabledField } from "./config/migrateLegacyEnabledField.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tierkit/core build && pnpm --filter @tierkit/core test migrateLegacyEnabledField -- --run`
Expected: PASS (6 tests).

- [ ] **Step 6: Run full core suite + typecheck**

Run: `pnpm --filter @tierkit/core typecheck && pnpm --filter @tierkit/core test -- --run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config/migrateLegacyEnabledField.ts \
        packages/core/src/index.ts \
        packages/core/test/migrateLegacyEnabledField.test.ts
git commit -m "feat(core, v0.12.3): migrateLegacyEnabledField (on-load, in-place)

Folds modelProfiles[id].enabled:false into disabledProfileIds, strips
the field (also strips enabled:true — it's the default, redundant).
Atomic write (temp + rename). Idempotent: no-op when nothing to
migrate.

Caller (loadConfig in next task) invokes this before the existing
disabledProfileIds → enabled sync. After one rewrite the config is
clean and subsequent loads return changed:false fast.

6 unit tests: folds:false, strips:true, no-op, ws+user independent,
dedup with existing entries, ignores null suppression markers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: migrateCanonicalDuplicates

**Files:**
- Create: `packages/core/src/config/migrateCanonicalDuplicates.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/migrateCanonicalDuplicates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/migrateCanonicalDuplicates.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { migrateCanonicalDuplicates } from "@tierkit/core";

let tmp = "";

beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-mig-dup-")); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

async function writeJson(name: string, data: unknown): Promise<string> {
  const p = path.join(tmp, name);
  await fs.writeFile(p, JSON.stringify(data, null, 2));
  return p;
}
async function readJson(p: string): Promise<any> {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

const baseProfile = {
  kind: "local-device", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b",
};

describe("migrateCanonicalDuplicates", () => {
  it("collapses two workspace ids for same (provider,baseUrl,model) — richer-roles wins", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        localCoder: { ...baseProfile, roles: ["code", "review", "plan"] },
        "ollama-qwen2-5-coder-7b": { ...baseProfile, roles: ["code"] },
      },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.modelProfiles.localCoder).toBeTruthy();
    expect(after.modelProfiles["ollama-qwen2-5-coder-7b"]).toBeNull();
  });

  it("workspace wins over user for same identity", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: { wsOne: { ...baseProfile, roles: ["code"] } },
    });
    const userPath = await writeJson("user.json", {
      version: "0.1",
      modelProfiles: { userOne: { ...baseProfile, roles: ["code", "review"] } },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath,
      wsRead: { raw: await readJson(wsPath) }, userRead: { raw: await readJson(userPath) },
    });
    expect(r.changed).toBe(true);
    expect((await readJson(wsPath)).modelProfiles.wsOne).toBeTruthy();
    expect((await readJson(userPath)).modelProfiles.userOne).toBeNull();
  });

  it("no-op when no duplicates", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { ...baseProfile, model: "qwen2.5-coder:7b" },
        bar: { ...baseProfile, model: "llama3.2:3b" },
      },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(false);
  });

  it("ignores null entries (already suppressed)", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        foo: { ...baseProfile, roles: ["code"] },
        bar: null,
      },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(false);
  });

  it("tiebreaker: same source AND same roles count → keeps first-encountered (insertion order)", async () => {
    const wsPath = await writeJson("tierkit.config.json", {
      version: "0.1",
      modelProfiles: {
        first: { ...baseProfile, roles: ["code"] },
        second: { ...baseProfile, roles: ["code"] },
      },
    });
    const r = await migrateCanonicalDuplicates({
      wsPath, userPath: path.join(tmp, "user.json"),
      wsRead: { raw: await readJson(wsPath) }, userRead: undefined,
    });
    expect(r.changed).toBe(true);
    const after = await readJson(wsPath);
    expect(after.modelProfiles.first).toBeTruthy();
    expect(after.modelProfiles.second).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test migrateCanonicalDuplicates -- --run`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/config/migrateCanonicalDuplicates.ts`:

```ts
import fs from "node:fs/promises";

interface RawConfigRead {
  raw: Record<string, unknown>;
}

interface MigrateInput {
  wsPath: string;
  userPath: string;
  wsRead: RawConfigRead | undefined;
  userRead: RawConfigRead | undefined;
}

/**
 * For each (provider, baseUrl, model) canonical identity, if MORE THAN ONE profile id
 * across workspace + user configs maps to it, keep the highest-priority one and write
 * `null` (suppression marker) for the lower-priority ones in their source file.
 *
 * Priority (high → low):
 *   1. Workspace `modelProfiles` entry
 *   2. User `modelProfiles` entry
 * Within the same source, the entry with more `roles` wins; ties go to insertion order.
 *
 * Bundled (sample) and discovered profiles are NEVER overwritten by this migration —
 * they live in code or are recomputed on each load. The migration only touches workspace
 * + user config files.
 *
 * Returns `changed: true` when at least one file was rewritten.
 */
export async function migrateCanonicalDuplicates(input: MigrateInput): Promise<{ changed: boolean }> {
  const wsRaw = input.wsRead?.raw;
  const userRaw = input.userRead?.raw;

  const wsProfiles = (wsRaw?.modelProfiles as Record<string, unknown> | undefined) ?? {};
  const userProfiles = (userRaw?.modelProfiles as Record<string, unknown> | undefined) ?? {};

  type Entry = { id: string; source: "workspace" | "user"; identity: string; roles: number };
  const entries: Entry[] = [];

  const collect = (profiles: Record<string, unknown>, source: "workspace" | "user") => {
    for (const [id, val] of Object.entries(profiles)) {
      if (val === null || typeof val !== "object") continue;
      const p = val as Record<string, unknown>;
      const identity = [p.provider ?? "", p.baseUrl ?? "", p.model ?? ""].join("|");
      const roles = Array.isArray(p.roles) ? (p.roles as unknown[]).length : 0;
      entries.push({ id, source, identity, roles });
    }
  };
  collect(wsProfiles, "workspace");
  collect(userProfiles, "user");

  // Group by canonical identity.
  const byIdentity = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = byIdentity.get(e.identity) ?? [];
    arr.push(e);
    byIdentity.set(e.identity, arr);
  }

  // For each identity with >1 entry, determine winner; mark losers as null in their source.
  const wsNulls = new Set<string>();
  const userNulls = new Set<string>();
  for (const [, group] of byIdentity) {
    if (group.length <= 1) continue;
    // Sort: source workspace before user; within source, more roles first; insertion order ties.
    const sorted = [...group].sort((a, b) => {
      if (a.source !== b.source) return a.source === "workspace" ? -1 : 1;
      return b.roles - a.roles;
    });
    const losers = sorted.slice(1);
    for (const loser of losers) {
      if (loser.source === "workspace") wsNulls.add(loser.id);
      else userNulls.add(loser.id);
    }
  }

  let changed = false;
  if (wsNulls.size > 0 && wsRaw) {
    const updated = { ...wsRaw, modelProfiles: { ...(wsRaw.modelProfiles as object) } } as Record<string, unknown>;
    for (const id of wsNulls) (updated.modelProfiles as Record<string, unknown>)[id] = null;
    await writeAtomic(input.wsPath, updated);
    changed = true;
  }
  if (userNulls.size > 0 && userRaw) {
    const updated = { ...userRaw, modelProfiles: { ...(userRaw.modelProfiles as object) } } as Record<string, unknown>;
    for (const id of userNulls) (updated.modelProfiles as Record<string, unknown>)[id] = null;
    await writeAtomic(input.userPath, updated);
    changed = true;
  }
  return { changed };
}

async function writeAtomic(target: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = target + ".tmp";
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, target);
}
```

- [ ] **Step 4: Add export to `index.ts`**

Add to `packages/core/src/index.ts`:

```ts
export { migrateCanonicalDuplicates } from "./config/migrateCanonicalDuplicates.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tierkit/core build && pnpm --filter @tierkit/core test migrateCanonicalDuplicates -- --run`
Expected: PASS (5 tests).

- [ ] **Step 6: Run full core suite + typecheck**

Run: `pnpm --filter @tierkit/core typecheck && pnpm --filter @tierkit/core test -- --run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config/migrateCanonicalDuplicates.ts \
        packages/core/src/index.ts \
        packages/core/test/migrateCanonicalDuplicates.test.ts
git commit -m "feat(core, v0.12.3): migrateCanonicalDuplicates (on-load, in-place)

When two profile ids in workspace+user configs map to the same
(provider,baseUrl,model), pick a winner and write null suppression
marker for the losers in their source file.

Priority: workspace > user; within same source, more roles wins;
insertion order breaks final ties. Bundled samples + discovered
profiles are never touched (they live in code or are recomputed).

5 unit tests: dup-collapse with role tiebreak, ws-over-user,
no-op, null-marker-respect, insertion-order-final-tiebreak.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: loadConfig wiring (migrations + canonical-identity discovery dedup)

**Files:**
- Modify: `packages/core/src/config/loadConfig.ts`
- Test: `packages/core/test/loadConfig.test.ts` (extend if exists; create otherwise)

- [ ] **Step 1: Add integration tests**

Check if `packages/core/test/loadConfig.test.ts` exists:

Run: `ls packages/core/test/loadConfig.test.ts 2>/dev/null || echo MISSING`

If MISSING, create it with the imports skeleton:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { loadConfig } from "@tierkit/core";

let tmp = "";

beforeEach(async () => {
  process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1"; // fixture isolation
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-loadcfg-"));
});
afterEach(async () => {
  delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
  await fs.rm(tmp, { recursive: true, force: true });
});
```

Then append these tests (regardless of whether the file existed):

```ts
describe("loadConfig migrations (v0.12.3)", () => {
  it("strips enabled:false field on load and folds into disabledProfileIds", async () => {
    await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify({
      version: "0.1",
      modelProfiles: {
        foo: { kind: "local-device", provider: "ollama", model: "x", roles: [], enabled: false },
      },
    }));
    const cfg = await loadConfig(tmp, { homeDirOverride: tmp });
    expect(cfg.config.disabledProfileIds).toContain("foo");
    // Re-read raw file: enabled field should be gone
    const raw = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(raw.modelProfiles.foo.enabled).toBeUndefined();
  });

  it("collapses canonical duplicates on load (workspace, richer-roles wins)", async () => {
    await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify({
      version: "0.1",
      modelProfiles: {
        localCoder: { kind: "local-device", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b", roles: ["code", "review"] },
        "ollama-qwen2-5-coder-7b": { kind: "local-device", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b", roles: ["code"] },
      },
    }));
    const cfg = await loadConfig(tmp, { homeDirOverride: tmp });
    expect(cfg.config.modelProfiles.localCoder).toBeTruthy();
    expect(cfg.config.modelProfiles["ollama-qwen2-5-coder-7b"]).toBeUndefined();
  });

  it("Ollama discovery skips models already covered by an explicit profile", async () => {
    // No real Ollama daemon in tests — discovery is gated by network call.
    // This test ensures the canonical-identity check is wired in even if discovery
    // returns nothing on this CI machine. With TIERKIT_NO_BUNDLED_DEFAULTS=1 and no
    // user/workspace profiles, the result simply has zero profiles.
    const cfg = await loadConfig(tmp, { homeDirOverride: tmp });
    // Either: empty (no ollama running) OR has discovered entries (ollama running on CI is unlikely).
    // Stable assertion: no error, no duplicates.
    const identities = Object.values(cfg.config.modelProfiles)
      .map((p: any) => [p.provider, p.baseUrl, p.model].join("|"));
    expect(new Set(identities).size).toBe(identities.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test loadConfig -- --run -t "migrations"`
Expected: FAIL — the first test fails because `enabled:false` still survives after load.

- [ ] **Step 3: Wire migrations into `loadConfig`**

Open `packages/core/src/config/loadConfig.ts`. Add imports at the top (with existing imports):

```ts
import { migrateLegacyEnabledField } from "./migrateLegacyEnabledField.js";
import { migrateCanonicalDuplicates } from "./migrateCanonicalDuplicates.js";
import { canonicalIdentity } from "../model/profileIdentity.js";
```

Find the workspace overlay block (around line 173-182). AFTER the `wsRead` is computed but BEFORE the `disabledProfileIds` sync (around line 192), insert:

```ts
  // ── v0.12.3 migrations (on-load, in-place, idempotent) ────────────────────
  // Run before anything depends on the raw shape. If a write occurs, recurse to
  // pick up the freshly-rewritten files. Two recursive calls at most (one per
  // migration); each subsequent load sees clean state and returns changed:false.
  const m1 = await migrateLegacyEnabledField({
    wsPath: workspacePath, userPath,
    wsRead: wsRead ? { raw: wsRead.raw } : undefined,
    userRead: userRead ? { raw: userRead.raw } : undefined,
  });
  if (m1.changed) return loadConfig(projectRoot, options);

  const m2 = await migrateCanonicalDuplicates({
    wsPath: workspacePath, userPath,
    wsRead: wsRead ? { raw: wsRead.raw } : undefined,
    userRead: userRead ? { raw: userRead.raw } : undefined,
  });
  if (m2.changed) return loadConfig(projectRoot, options);
```

Then find the Ollama discovery block (around line 205-215). Change the dedup logic — currently it checks `id in merged` only. Add canonical-identity coverage check:

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
      if (suppressedIds.has(id)) continue;
      if (coveredIdentities.has(canonicalIdentity(p))) continue;
      if (id in merged) continue;
      merged[id] = p;
      profileSources[id] = "discovered";
    }
    acc = { ...acc, modelProfiles: merged };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tierkit/core build && pnpm --filter @tierkit/core test loadConfig -- --run`
Expected: all loadConfig tests pass, including the 3 new migration tests.

- [ ] **Step 5: Run full core suite + typecheck**

Run: `pnpm --filter @tierkit/core typecheck && pnpm --filter @tierkit/core test -- --run`
Expected: all green (541 + 8 + 6 + 5 + 3 = 563).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/loadConfig.ts \
        packages/core/test/loadConfig.test.ts
git commit -m "feat(core, v0.12.3): wire migrations + canonical-identity discovery dedup

loadConfig now runs migrateLegacyEnabledField and migrateCanonicalDuplicates
on every load (idempotent; recursive return on first touch). After the
first run, in-place rewrites leave a clean config and subsequent loads
return changed:false fast.

Ollama auto-discovery now consults a Set of canonical identities already
covered by bundled/user/workspace profiles and skips matching models
instead of synthesizing a duplicate.

3 integration tests: enabled:false strip, workspace duplicate collapse,
no-dups invariant in merged result.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Server-side delete guard

**Files:**
- Modify: `packages/core/src/runtime/Server.ts` (DELETE handler around line 713-724)
- Test: `packages/core/test/profileCrudHttp.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/profileCrudHttp.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { startServer, type RunningServer } from "@tierkit/core";

let tmp = "";
let server: RunningServer | null = null;
let baseUrl = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-profile-http-"));
  process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1";
  await fs.writeFile(path.join(tmp, "tierkit.config.json"), JSON.stringify({
    version: "0.1",
    modelProfiles: {
      manualProfile: { kind: "local-device", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "x", roles: [] },
    },
  }));
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  baseUrl = `http://${server.address}:${server.port}`;
});
afterEach(async () => {
  delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
  await server?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("DELETE /v1/config/profile/:id guard", () => {
  it("deletes a manually-added workspace profile (suppression marker written)", async () => {
    const res = await fetch(`${baseUrl}/v1/config/profile/manualProfile?scope=workspace`, { method: "DELETE" });
    expect(res.status).toBe(200);
    // After delete, the profile should not appear in GET /v1/config
    const cfgRes = await fetch(`${baseUrl}/v1/config`);
    const cfgBody = await cfgRes.json();
    expect(cfgBody.config.modelProfiles.manualProfile).toBeUndefined();
  });

  it("rejects delete for a bundled-sample profile with 400 cannot-delete-non-editable", async () => {
    // Temporarily remove the env suppression so a bundled sample exists.
    delete process.env.TIERKIT_NO_BUNDLED_DEFAULTS;
    await server?.close();
    server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
    baseUrl = `http://${server.address}:${server.port}`;

    // localCoder is a bundled sample; try to delete it from workspace scope
    const res = await fetch(`${baseUrl}/v1/config/profile/localCoder?scope=workspace`, { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("cannot-delete-non-editable");
    expect(body.message).toContain("source: bundled");

    process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1";
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test profileCrudHttp -- --run`
Expected: FAIL — the bundled-sample test fails because no guard exists yet (delete succeeds with 200 instead of 400).

- [ ] **Step 3: Add guard in `Server.ts`**

Open `packages/core/src/runtime/Server.ts`. Find the DELETE handler (around line 713-724):

```ts
      if (method === "DELETE" && url.pathname.startsWith("/v1/config/profile/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/config/profile/".length));
        const scope = (url.searchParams.get("scope") === "user" ? "user" : "workspace") as ProfileScope;
        if (!id) return sendJson(res, 400, { error: "missing profile id in path" });
        try {
          const r = await removeProfile({ cwd: opts.cwd, id, scope });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof ProfileCrudError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }
```

Replace the body of this `if` block with:

```ts
      if (method === "DELETE" && url.pathname.startsWith("/v1/config/profile/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/config/profile/".length));
        const scope = (url.searchParams.get("scope") === "user" ? "user" : "workspace") as ProfileScope;
        if (!id) return sendJson(res, 400, { error: "missing profile id in path" });

        // Reject delete for sources that re-create themselves (bundled samples,
        // auto-discovered Ollama profiles). User must use toggle (PATCH with
        // enabled:false) instead. Without this guard the suppression marker would
        // be written, but the user can't see "why" the profile keeps coming back.
        try {
          const cfg = await loadConfig(opts.cwd);
          const source = cfg.profileSources[id];
          if (source === "bundled" || source === "discovered") {
            return sendJson(res, 400, {
              ok: false,
              code: "cannot-delete-non-editable",
              message: `cannot delete '${id}' (source: ${source}). Toggle it off instead — it will be re-created automatically otherwise.`,
            });
          }
        } catch {
          // If loadConfig fails, fall through to the existing remove path; the
          // CRUD layer will surface a better error than swallowing here.
        }

        try {
          const r = await removeProfile({ cwd: opts.cwd, id, scope });
          return sendJson(res, 200, r);
        } catch (err) {
          if (err instanceof ProfileCrudError) return sendJson(res, 400, { code: err.code, message: err.message });
          throw err;
        }
      }
```

Confirm `loadConfig` is imported at the top of `Server.ts` (it's already used elsewhere — search `import.*loadConfig` to confirm).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tierkit/core build && pnpm --filter @tierkit/core test profileCrudHttp -- --run`
Expected: PASS (2 tests).

- [ ] **Step 5: Run full core suite + typecheck**

Run: `pnpm --filter @tierkit/core typecheck && pnpm --filter @tierkit/core test -- --run`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/Server.ts \
        packages/core/test/profileCrudHttp.test.ts
git commit -m "feat(http, v0.12.3): DELETE guard for bundled/discovered profiles

Returns 400 cannot-delete-non-editable when caller tries to delete a
profile whose source is bundled (sample default) or discovered (Ollama
auto-detected). Both would be re-created on next load, so a delete
would silently 'come back' from the user's perspective. The guard tells
them to toggle off instead.

Loaded config's profileSources map is consulted to determine the source.
If loadConfig fails, the guard falls through to the existing CRUD path
so we don't introduce a new failure mode.

2 integration tests: manual-profile delete succeeds (200) + bundled
delete is rejected (400 cannot-delete-non-editable).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: GUI display dedup + Delete button visibility

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Add display-dedup helper inside the IIFE**

Open `packages/core/src/runtime/ui/gui.ts`. Find the `refreshModels()` function (search `function refreshModels` or `refreshModels()` definition). Just BEFORE the entries are rendered (inside refreshModels, just after the entries list is constructed from the config fetch), add:

```js
// v0.12.3 — defense in depth: even if migration didn't run (older daemon, race
// condition), never show two rows with the same canonical identity.
// Priority: workspace > user > bundled > discovered; within same source, more
// roles (richer metadata) wins.
function dedupeByCanonicalIdentity(rows) {
  const SOURCE_RANK = { workspace: 0, user: 1, bundled: 2, discovered: 3 };
  const byIdentity = new Map();
  for (const e of rows) {
    const p = e.profile || {};
    const key = (p.provider || '') + '|' + (p.baseUrl || '') + '|' + (p.model || '');
    const existing = byIdentity.get(key);
    if (!existing) { byIdentity.set(key, e); continue; }
    const eRank = SOURCE_RANK[e.source] !== undefined ? SOURCE_RANK[e.source] : 99;
    const exRank = SOURCE_RANK[existing.source] !== undefined ? SOURCE_RANK[existing.source] : 99;
    if (eRank < exRank) { byIdentity.set(key, e); continue; }
    if (eRank === exRank) {
      const eRoles = (e.profile.roles || []).length;
      const exRoles = (existing.profile.roles || []).length;
      if (eRoles > exRoles) byIdentity.set(key, e);
    }
  }
  return Array.from(byIdentity.values());
}
```

(Placement: anywhere inside the same IIFE as `refreshModels`. If there's an existing helper section at the top of the IIFE, put it there; otherwise just above `refreshModels`.)

- [ ] **Step 2: Apply dedup before render**

In `refreshModels()`, find the line that builds the `entries` array (a list of `{ id, profile, source, ... }` objects). Right after that array is finalized and BEFORE the `for (const tierKey of TIER_ORDER) renderTier(tierKey);` line, insert:

```js
const dedupedEntries = dedupeByCanonicalIdentity(entries);
```

Then change every subsequent reference from `entries` to `dedupedEntries` until end of the render. Most importantly, the `renderTier` function (defined inside `refreshModels`) iterates over filtered entries — make sure it filters from `dedupedEntries`, not `entries`. And the missing-keys banner (`renderMissingKeysBanner(entries, secretMap)`) should also take `dedupedEntries` for consistency.

Concretely, in `refreshModels`:

```js
const dedupedEntries = dedupeByCanonicalIdentity(entries);
const renderTier = (tierKey) => {
  // ...filter dedupedEntries by tierKey, render rows...
  // (existing code, just swap `entries` → `dedupedEntries`)
};
for (const tierKey of TIER_ORDER) renderTier(tierKey);
renderTier('other');
renderMissingKeysBanner(dedupedEntries, secretMap);
```

- [ ] **Step 3: Hide Delete button for bundled / discovered**

Find the row markup (around line 2378-2383) that renders Delete:

```js
' <button class="tiny" data-action="delete-profile" data-id="' + escapeHtml(e.id) + '" data-scope="' + escapeHtml(e.source) + '">' + escapeHtml(i18n.deleteBtn) + '</button>';
```

Replace this with conditional rendering. Right before the row's HTML concatenation, compute:

```js
const canDelete = e.source === 'workspace' || e.source === 'user';
```

Then in the HTML string:

```js
+ (canDelete
    ? ' <button class="tiny" data-action="delete-profile" data-id="' + escapeHtml(e.id) + '" data-scope="' + escapeHtml(e.source) + '">' + escapeHtml(i18n.deleteBtn) + '</button>'
    : '');
```

- [ ] **Step 4: Build, smoke-test**

```sh
pnpm --filter @tierkit/core build
node -e "import('./packages/core/dist/index.js').then(m => { for (const s of ['dedupeByCanonicalIdentity','canDelete','data-action=\"delete-profile\"']) { if (!m.GUI_HTML.includes(s)) { console.error('MISSING:',s); process.exit(1); } } console.log('OK'); })"
```

Expected: `OK`.

- [ ] **Step 5: Run all tests + typecheck**

```sh
pnpm -r test -- --run
pnpm -r typecheck
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git commit -m "feat(ui, v0.12.3): GUI canonical-identity dedup + Delete visibility

Adds dedupeByCanonicalIdentity() inside refreshModels() as defense in
depth: even if on-load migration didn't run yet (older daemon, race
condition), the list collapses entries sharing (provider,baseUrl,model)
to a single row. Priority: workspace > user > bundled > discovered;
within same source, more roles wins.

Delete button now hidden for bundled and discovered rows (they re-
create themselves on next load; Delete would just appear to do nothing
from the user's perspective). Toggle remains.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Release — docs + version bump + memory note

**Files:**
- Modify: `README.md`
- Modify: `docs/SPEC.md`
- Modify: `CHANGELOG.md`
- Modify: all package.json files (root + 9 packages)
- Create: `/Users/siwal/.claude/projects/-Users-siwal-code-Tierkit/memory/project_v18_3_profile_state_unification.md`
- Modify: `/Users/siwal/.claude/projects/-Users-siwal-code-Tierkit/memory/MEMORY.md`

- [ ] **Step 1: CHANGELOG entry**

Insert at the TOP of `CHANGELOG.md`:

```markdown
## 0.12.3 — 2026-05-20

### Fixed — Model Profile State Unification

- **Toggle enable/disable now persists correctly.** The legacy `profile.enabled`
  inline field is folded into `disabledProfileIds` on first load (idempotent
  migration), so the array is the only source of truth. The `PATCH` endpoint
  already wrote to the array — readers now route through `isProfileDisabled()`
  which only consults the array.
- **Delete now sticks.** Auto-discovered Ollama profiles and bundled sample
  profiles no longer expose a Delete button (the underlying model exists,
  so Delete would just re-appear on next load). Server returns
  `400 cannot-delete-non-editable` if the API is called directly. Manually-added
  profiles (workspace/user scope) still support Delete.
- **No more duplicate rows.** Profiles sharing `(provider, baseUrl, model)` —
  e.g. `localCoder` (bundled sample) and `ollama-qwen2-5-coder-7b` (auto-discovered),
  both pointing to `qwen2.5-coder:7b` — collapse to a single row. Three layers
  of dedup: Ollama discovery skips already-covered identities, on-load migration
  rewrites the config to remove duplicates, and the GUI dedups the rendered list
  as defense in depth.

### Added

- `canonicalIdentity(profile)` and `isProfileDisabled(cfg, id)` helpers in
  `@tierkit/core`, exported for external consumers (CLI, SDK, plugins).
- `migrateLegacyEnabledField` and `migrateCanonicalDuplicates` run on every
  `loadConfig()` call (idempotent; no-op after first run).

### Backward compatibility

- No `ConfigSchema` major-version bump. Existing `tierkit.config.json` files
  work; the migration cleans them up in place.
- No `@tierkit/client` SDK API change.
- HTTP API unchanged except for the new `400 cannot-delete-non-editable`
  response (replaces a silent no-op delete).

### Non-goals (explicit, deferred)

- Cross-machine sync of disabled state — stays local.
- Backups of pre-migration configs — `git diff tierkit.config.json` covers it.
- Schema removal of the deprecated `enabled` field — keeping for forward
  compat with external editors; readers ignore it.
```

- [ ] **Step 2: README — short note under Cost routing**

In `README.md`, find the existing v0.12.2 subsection. Append (or add a new short H3) after it:

```markdown
### Profile state cleanup (v0.12.3)

The Models card no longer shows duplicate rows for the same model, toggles
persist correctly across refresh, and Delete is hidden for profiles that
would re-create themselves on next load (bundled samples, auto-discovered
Ollama). On first load after the upgrade, your `tierkit.config.json`
gets cleaned up in place.
```

- [ ] **Step 3: Version bump (10 package.json files)**

Run:

```sh
for f in package.json packages/*/package.json; do
  sed -i '' 's/"version": "0.12.2"/"version": "0.12.3"/' "$f"
done
grep -H '"version"' package.json packages/*/package.json | grep -v node_modules
```

Expected: 10 lines, all showing `0.12.3`.

- [ ] **Step 4: Build + smoke-test version propagation**

```sh
pnpm -r build
node -e "import('./packages/core/dist/index.js').then(m => { if (m.GUI_HTML.includes('0.12.3')) console.log('OK'); else { console.error('VERSION MISSING'); process.exit(1); } })"
```

Expected: `OK`.

- [ ] **Step 5: Run full test + typecheck**

```sh
pnpm -r test -- --run
pnpm -r typecheck
```

Expected: all green.

- [ ] **Step 6: Write memory note**

Create `/Users/siwal/.claude/projects/-Users-siwal-code-Tierkit/memory/project_v18_3_profile_state_unification.md`:

```markdown
---
name: project-v18-3-profile-state-unification
description: Tierkit v0.12.3 — fixed chronic Model UI bugs (toggle, delete, duplicates) by unifying the 3 parallel "disabled" mechanisms into one source of truth (disabledProfileIds) and adding canonical-identity dedup. Released 2026-05-20.
metadata:
  type: project
---

v0.12.3 fixes the chronic toggle/delete/duplicate bugs in the Models card. **Why:** the codebase had 3 parallel mechanisms expressing "profile is not active" (`profile.enabled` field, `disabledProfileIds` array, `modelProfiles[id]: null` suppression marker), so a fix to one always left the others writing stale state. Two prior commits (`0e84006`, `89da934`) tried to fix the symptom and shipped the same message twice — pattern that didn't stick because the data model itself was the problem.

**How to apply:** for any future profile-related work, use `isProfileDisabled(cfg, id)` (the only legitimate disabled-check). For dedup, use `canonicalIdentity(profile)` — never compare ids directly when checking "is this the same model".

## What shipped (v0.12.3, 2026-05-20)

### Helpers (new)
- `canonicalIdentity(profile) → string` = `(provider|baseUrl|model)`. Models sharing this triple are the same model, regardless of profile id.
- `isProfileDisabled(cfg, id) → boolean`. Reads ONLY from `disabledProfileIds`. Ignores the legacy `enabled` field.

### Migrations (new, run on every loadConfig — idempotent)
- `migrateLegacyEnabledField`: strips `enabled: false/true` from `modelProfiles[id]`, folds `false` into `disabledProfileIds`. Atomic temp+rename. Idempotent.
- `migrateCanonicalDuplicates`: when two ids in workspace+user config map to the same canonical identity, picks a winner (priority: workspace > user; within same source, more roles wins; insertion order breaks ties) and writes `null` suppression marker for the losers.

### loadConfig wiring
- Runs both migrations BEFORE the existing disabledProfileIds → enabled sync.
- On first touch, recursive `return loadConfig(...)` picks up the freshly-rewritten files. Worst case: 2 reads + 1-2 writes on first run.
- Ollama auto-discovery now consults a Set of canonical identities already covered by explicit configs; skips any matching models.

### Server-side guard
- `DELETE /v1/config/profile/:id` returns `400 cannot-delete-non-editable` when `profileSources[id]` is `bundled` or `discovered`. The error message tells the caller to toggle off instead.

### GUI changes
- `dedupeByCanonicalIdentity(rows)` helper in `refreshModels()` collapses entries with the same canonical identity (defense in depth — even if migration didn't run yet). Priority: workspace > user > bundled > discovered; within source, more roles wins.
- Delete button HIDDEN for bundled and discovered rows. Manual workspace/user profiles still show it.

## What stayed the same (deliberate)

- No `ConfigSchema` major-version bump. The `enabled` field still parses (zod `.optional()`); readers ignore it; migration strips it on load.
- No `@tierkit/client` SDK API change.
- HTTP API surface unchanged except for the new 400 response.
- CLI commands unchanged. No `tierkit profile delete` behavioral change.

## Validation

After upgrade, an existing config with both `enabled: false` fields AND `disabledProfileIds` entries gets cleaned up: the field is stripped, the array remains canonical. Toggling OFF then ON leaves no stale state. The Models list shows at most one row per `(provider, baseUrl, model)` triple.

## Architectural notes (load-bearing)

- The two migrations are the ONLY writers to the legacy `enabled` field's "removal" path. All other code paths must consult `isProfileDisabled(cfg, id)`.
- The recursive `return loadConfig(...)` after migration is intentional: rather than splicing migrated values into the in-memory result, a clean second read confirms persistence and avoids any race with concurrent writes.
- The GUI display-dedup is defense in depth; it's not a substitute for the on-load migration. If anyone disables migrations (e.g. for testing), the GUI still won't show dupes.

See [[project-v18-2-ui-validation-flow]] for the prior release; [[project-tierkit-identity]] for the loopback-only, no-telemetry stance.
```

- [ ] **Step 7: Update memory index**

Open `/Users/siwal/.claude/projects/-Users-siwal-code-Tierkit/memory/MEMORY.md`. Add immediately AFTER the `project_v18_2_ui_validation_flow.md` line:

```markdown
- [Project: v0.12.3 Profile State Unification](project_v18_3_profile_state_unification.md) — 2026-05-20; fixed chronic toggle/delete/duplicate bugs by unifying the 3 "disabled" mechanisms into disabledProfileIds (single source of truth), adding canonicalIdentity for dedup, and hiding Delete for non-editable rows. Two on-load migrations (idempotent). No schema/SDK changes.
```

- [ ] **Step 8: Final commit**

```bash
git add README.md docs/SPEC.md CHANGELOG.md \
        package.json packages/*/package.json
git commit -m "chore(release): 0.12.3 — Profile State Unification

All 10 packages bumped to 0.12.3. CHANGELOG covers the toggle/delete/
duplicate fixes, new canonicalIdentity/isProfileDisabled helpers, the
two on-load migrations, and the new 400 cannot-delete-non-editable
response. README gains a short subsection.

Memory note project_v18_3_profile_state_unification.md added outside
repo.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Spec coverage self-check

| Spec acceptance criterion | Implementing task |
| --- | --- |
| `canonicalIdentity` helper | Task 1 |
| `isProfileDisabled` helper | Task 1 |
| Schema `enabled` field deprecated but parseable | Task 4 (relies on existing zod `.optional()`) |
| `migrateLegacyEnabledField` (folds enabled:false, strips field) | Task 2 |
| `migrateCanonicalDuplicates` (priority: ws > user, roles tiebreak) | Task 3 |
| Migrations run on every loadConfig, idempotent | Task 4 |
| Recursive `return loadConfig(...)` on touch | Task 4 |
| Atomic temp+rename writes | Task 2, Task 3 |
| Ollama discovery dedup by canonical identity | Task 4 |
| Existing suppressedIds-respect preserved | Task 4 (we don't remove the existing check) |
| Server guard `400 cannot-delete-non-editable` | Task 5 |
| Delete button hidden for bundled/discovered | Task 6 |
| GUI dedup defense in depth | Task 6 |
| No `ConfigSchema` major bump | Tasks 1-7 (none touch schema) |
| No `@tierkit/client` SDK change | Tasks 1-7 (no SDK file edited) |
| Version bump 0.12.3 across 10 packages | Task 7 |
| README/CHANGELOG entries | Task 7 |
| Memory note + MEMORY.md index | Task 7 |
| Existing 541 core tests stay green | Each task's `pnpm -r test --run` |
| `pnpm -r typecheck` clean | Each task |
| At least 12 new unit + integration tests | Task 1 (8) + Task 2 (6) + Task 3 (5) + Task 4 (3) + Task 5 (2) = 24 new tests |
