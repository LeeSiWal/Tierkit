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
