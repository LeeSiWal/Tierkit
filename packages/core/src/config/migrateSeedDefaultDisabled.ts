import fs from "node:fs/promises";
import path from "node:path";
import type { ModelProfileMap } from "../model/ModelProfile.js";

const CONFIG_FILE = "tierkit.config.json";

export interface MigrateSeedDefaultDisabledInput {
  cwd: string;
  defaultProfiles: ModelProfileMap;
}

/**
 * Seeds bundled `defaultDisabled: true` profiles into the workspace's
 * `disabledProfileIds` exactly once per profile id. Records the seed in
 * `migrations.defaultDisabledSeededProfileIds` so a later user-driven enable
 * is never undone by a future load.
 *
 * Idempotent: profiles already recorded as seeded are skipped, regardless of
 * whether the user has since enabled or re-disabled them. Atomic write via
 * tmp + rename. No-op when the workspace tierkit.config.json is absent.
 */
export async function migrateSeedDefaultDisabled(
  input: MigrateSeedDefaultDisabledInput,
): Promise<void> {
  const file = path.join(input.cwd, CONFIG_FILE);
  let raw: any;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err: any) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  if (!raw || typeof raw !== "object") return;

  const disabled = new Set<string>(Array.isArray(raw.disabledProfileIds) ? raw.disabledProfileIds : []);
  const seeded = new Set<string>(
    Array.isArray(raw.migrations?.defaultDisabledSeededProfileIds)
      ? raw.migrations.defaultDisabledSeededProfileIds
      : [],
  );

  let changed = false;
  for (const [id, profile] of Object.entries(input.defaultProfiles)) {
    if (!profile || (profile as any).defaultDisabled !== true) continue;
    if (seeded.has(id)) continue;
    if (!disabled.has(id)) disabled.add(id);
    seeded.add(id);
    changed = true;
  }
  if (!changed) return;

  raw.disabledProfileIds = Array.from(disabled);
  raw.migrations = { ...(raw.migrations ?? {}), defaultDisabledSeededProfileIds: Array.from(seeded) };

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(raw, null, 2), "utf8");
  await fs.rename(tmp, file);
}
