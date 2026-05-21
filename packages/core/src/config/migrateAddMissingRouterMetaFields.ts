import fs from "node:fs/promises";
import path from "node:path";
import type { ModelProfileMap } from "../model/ModelProfile.js";

const CONFIG_FILE = "tierkit.config.json";

/**
 * Fields where the bundled default is the authoritative router-meta hint.
 * If the workspace has a profile with the same id as a bundled default and
 * doesn't set these fields explicitly, we backfill from the bundle. User-set
 * values (anything not `undefined`) are NEVER overwritten.
 *
 * Excluded: `kind`, `provider`, `model`, `baseUrl`, `apiKeyEnv`, `cost`,
 * `transport`, `paymentModel`, `requiresApproval`, `defaultMode`, `enabled`,
 * `roles`. These are user-facing identity / behavior settings — we don't want
 * to silently change them. Only routing-classification fields are backfilled.
 */
const BACKFILL_FIELDS = ["notGoodAt", "goodAt", "displayName"] as const;

export interface MigrateAddMissingRouterMetaInput {
  cwd: string;
  defaultProfiles: ModelProfileMap;
}

export async function migrateAddMissingRouterMetaFields(
  input: MigrateAddMissingRouterMetaInput,
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
  if (!raw.modelProfiles || typeof raw.modelProfiles !== "object") return;

  let changed = false;
  for (const [id, defaultProfile] of Object.entries(input.defaultProfiles)) {
    const wsProfile = raw.modelProfiles[id];
    if (!wsProfile || typeof wsProfile !== "object") continue;
    // Only backfill when both profiles refer to the same underlying model —
    // protects users who reused a bundled id for a different model/provider.
    if (wsProfile.provider !== defaultProfile.provider) continue;
    if (wsProfile.model !== defaultProfile.model) continue;

    for (const field of BACKFILL_FIELDS) {
      if (wsProfile[field] === undefined && (defaultProfile as any)[field] !== undefined) {
        wsProfile[field] = (defaultProfile as any)[field];
        changed = true;
      }
    }
  }
  if (!changed) return;

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(raw, null, 2), "utf8");
  await fs.rename(tmp, file);
}
