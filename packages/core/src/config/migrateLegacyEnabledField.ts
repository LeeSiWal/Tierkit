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
