import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TierkitConfigSchema,
  CONFIG_FILENAME,
  type TierkitConfig,
} from "./TierkitConfig.js";
import { DEFAULT_MODEL_PROFILES } from "./defaultProfiles.js";
import { discoverOllamaProfiles } from "../model/discoverOllamaProfiles.js";
import type { ModelProfile, ModelProfileMap } from "../model/ModelProfile.js";
import { migrateLegacyEnabledField } from "./migrateLegacyEnabledField.js";
import { migrateCanonicalDuplicates } from "./migrateCanonicalDuplicates.js";
import { migrateSeedDefaultDisabled } from "./migrateSeedDefaultDisabled.js";
import { migrateAddMissingRouterMetaFields } from "./migrateAddMissingRouterMetaFields.js";
import { canonicalIdentity } from "../model/profileIdentity.js";

/** Where a given config value originated. Surfaced via `/v1/models` so users can see why a profile is visible. */
export type ConfigSource = "bundled" | "user" | "workspace" | "discovered";

export interface ConfigLoadResult {
  /** The merged effective config. */
  config: TierkitConfig;
  /** Path to the workspace-level config (./tierkit.config.json). Null if the file does not exist. */
  configPath: string | null;
  /** Path to the user-level config (~/.tierkit/config.json). Null if it does not exist. */
  userConfigPath: string | null;
  /** True if the workspace-level config was found. */
  found: boolean;
  /** Per-profile origin map. Tells the UI whether a profile came from bundled defaults, user config, or workspace config. */
  profileSources: Record<string, ConfigSource>;
}

const BASE_DEFAULT: TierkitConfig = TierkitConfigSchema.parse({ version: "0.1" });

/** Bundled default config = base default + bundled model profiles. */
function bundledDefault(): TierkitConfig {
  return {
    ...BASE_DEFAULT,
    modelProfiles: { ...DEFAULT_MODEL_PROFILES },
  };
}

/** User-level config path: `~/.tierkit/config.json`. */
export function userConfigPath(homeDirOverride?: string): string {
  const home = homeDirOverride ?? os.homedir();
  return path.join(home, ".tierkit", "config.json");
}

/** Read + parse a TierkitConfig from disk. Returns null when the file does not exist. */
async function readConfigFile(filePath: string): Promise<TierkitConfig | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return TierkitConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Merge a higher-priority config (`override`) over a lower-priority one (`base`).
 * Special semantics for modelProfiles: setting a profile to `null` in the override removes
 * an entry inherited from the base. (Used so a user can suppress a bundled default in
 * `~/.tierkit/config.json` without disabling everything.)
 */
function mergeConfigs(
  base: TierkitConfig,
  override: { config: TierkitConfig; rawProfiles?: Record<string, unknown> },
): TierkitConfig {
  const o = override.config;
  const mergedProfiles: ModelProfileMap = { ...base.modelProfiles };

  // Walk the raw profile entries so we can distinguish "profile not present" (inherit base)
  // from "profile explicitly set to null" (delete from inheritance).
  const rawProfileEntries = override.rawProfiles ?? {};
  for (const [id, rawValue] of Object.entries(rawProfileEntries)) {
    if (rawValue === null) {
      delete mergedProfiles[id];
    }
  }
  // Now apply the validated profiles from the override on top.
  for (const [id, profile] of Object.entries(o.modelProfiles)) {
    mergedProfiles[id] = profile as ModelProfile;
  }

  return {
    version: "0.1",
    activePlugins:
      o.activePlugins.length > 0 || rawProfileEntries === undefined ? o.activePlugins : base.activePlugins,
    defaultTarget: o.defaultTarget !== "generic" || base.defaultTarget === "generic" ? o.defaultTarget : base.defaultTarget,
    modelProfiles: mergedProfiles,
    disabledProfileIds: [...new Set([...base.disabledProfileIds, ...o.disabledProfileIds])],
    routingPolicy: o.routingPolicy ?? base.routingPolicy,
    security: o.security ?? base.security,
    ...(o.budget !== undefined ? { budget: o.budget } : base.budget !== undefined ? { budget: base.budget } : {}),
    ...(o.modelPolicy !== undefined ? { modelPolicy: o.modelPolicy } : base.modelPolicy !== undefined ? { modelPolicy: base.modelPolicy } : {}),
    runtime: o.runtime ?? base.runtime,
    migrations: {
      defaultDisabledSeededProfileIds: [
        ...new Set([
          ...base.migrations.defaultDisabledSeededProfileIds,
          ...o.migrations.defaultDisabledSeededProfileIds,
        ]),
      ],
    },
    notices: {
      seenPinnedNoFallbackV013: o.notices.seenPinnedNoFallbackV013 || base.notices.seenPinnedNoFallbackV013,
      seenModelTestExplained: o.notices.seenModelTestExplained || base.notices.seenModelTestExplained,
    },
  };
}

/** Like `readConfigFile` but also returns the raw JSON object so caller can spot `null` profile suppressions. */
async function readConfigFileRaw(filePath: string): Promise<{ config: TierkitConfig; raw: Record<string, unknown> } | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    // Strip nulls before zod validation (we'll handle them in the merger).
    const sanitized = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    const profiles = sanitized.modelProfiles;
    if (profiles && typeof profiles === "object") {
      const cleaned: Record<string, unknown> = {};
      for (const [id, p] of Object.entries(profiles as Record<string, unknown>)) {
        if (p !== null) cleaned[id] = p;
      }
      sanitized.modelProfiles = cleaned;
    }
    return { config: TierkitConfigSchema.parse(sanitized), raw };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface LoadConfigOptions {
  /**
   * Whether to seed the result with `DEFAULT_MODEL_PROFILES`. Defaults to true (production behavior).
   * Tests that want deterministic, isolated profile state should pass `false` so they see only
   * what's in the workspace/user config files they explicitly created.
   */
  includeBundled?: boolean;
  /** Override `os.homedir()` — primarily for tests so they don't read the real ~/.tierkit/config.json. */
  homeDirOverride?: string;
}

/**
 * Load and merge config from three layers:
 *   1. Bundled defaults (lowest)         — opt-out via `includeBundled: false`
 *   2. User-level (~/.tierkit/config.json) — opt-out via `homeDirOverride` to a clean dir
 *   3. Workspace-level (<projectRoot>/tierkit.config.json) (highest)
 *
 * Each profile in the merged result carries an origin in `profileSources`. Workspace
 * profiles override user profiles override bundled defaults. A user/workspace config
 * can suppress a bundled profile by setting that profile id to `null`.
 */
export async function loadConfig(
  projectRoot: string,
  options: LoadConfigOptions = {},
): Promise<ConfigLoadResult> {
  // Tests set TIERKIT_NO_BUNDLED_DEFAULTS=1 so fixtures see only what they explicitly create.
  // Production never sets this so bundled defaults are the zero-config first-run experience.
  const envSuppression = process.env.TIERKIT_NO_BUNDLED_DEFAULTS === "1";
  const includeBundled = options.includeBundled ?? (envSuppression ? false : true);
  const workspacePath = path.join(projectRoot, CONFIG_FILENAME);
  const userPath = userConfigPath(options.homeDirOverride);

  const bundled = includeBundled ? bundledDefault() : BASE_DEFAULT;
  const profileSources: Record<string, ConfigSource> = {};
  if (includeBundled) {
    for (const id of Object.keys(bundled.modelProfiles)) profileSources[id] = "bundled";
  }

  // Track profile ids the user explicitly suppressed (via `null` in their config).
  // Discovery layer below MUST respect these so deletes of auto-discovered profiles stick.
  const suppressedIds = new Set<string>();

  // ── User-level overlay ──
  const userRead = await readConfigFileRaw(userPath);
  let acc = bundled;
  if (userRead) {
    const rawProfiles = (userRead.raw.modelProfiles ?? {}) as Record<string, unknown>;
    acc = mergeConfigs(acc, { config: userRead.config, rawProfiles });
    for (const [id, val] of Object.entries(rawProfiles)) {
      if (val === null) { delete profileSources[id]; suppressedIds.add(id); }
    }
    for (const id of Object.keys(userRead.config.modelProfiles)) profileSources[id] = "user";
  }

  // ── Workspace-level overlay ──
  const wsRead = await readConfigFileRaw(workspacePath);
  if (wsRead) {
    const rawProfiles = (wsRead.raw.modelProfiles ?? {}) as Record<string, unknown>;
    acc = mergeConfigs(acc, { config: wsRead.config, rawProfiles });
    for (const [id, val] of Object.entries(rawProfiles)) {
      if (val === null) { delete profileSources[id]; suppressedIds.add(id); }
    }
    for (const id of Object.keys(wsRead.config.modelProfiles)) profileSources[id] = "workspace";
  }

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

  await migrateSeedDefaultDisabled({ cwd: projectRoot, defaultProfiles: DEFAULT_MODEL_PROFILES });

  await migrateAddMissingRouterMetaFields({ cwd: projectRoot, defaultProfiles: DEFAULT_MODEL_PROFILES });

  // ── Ollama auto-discovery ─────────────────────────────────────────────────
  // After all explicit configs (bundled/user/workspace) are merged, look at the local
  // Ollama daemon to see what models the user actually has pulled and synthesize a
  // profile per chat-capable model. Discovered profiles fill in for users whose
  // installed models don't match Tierkit's bundled-default model names.
  //
  // Discovered profiles NEVER override existing ones — if a workspace/user/bundled
  // profile has the same id (very unlikely given the `ollama-` prefix), it wins.
  // Apply disabledProfileIds: any id in this list has enabled=false on its merged profile.
  const userDisabled = (userRead?.config.disabledProfileIds ?? []);
  const wsDisabled = (wsRead?.config.disabledProfileIds ?? []);
  const allDisabled = new Set<string>([...userDisabled, ...wsDisabled]);
  if (allDisabled.size > 0) {
    const profilesCopy: ModelProfileMap = { ...acc.modelProfiles };
    for (const id of allDisabled) {
      const p = profilesCopy[id];
      if (p) profilesCopy[id] = { ...p, enabled: false };
    }
    acc = { ...acc, modelProfiles: profilesCopy };
  }

  if (acc.runtime.discoverOllamaModels !== false) {
    const discovered = await discoverOllamaProfiles();
    // Build a Set of canonical identities already covered by explicit configs
    // (bundled/user/workspace). Auto-discovery skips anything already covered so
    // it doesn't synthesize a duplicate of a model the user has explicitly
    // configured under a different id.
    const coveredIdentities = new Set<string>();
    for (const p of Object.values(acc.modelProfiles)) {
      coveredIdentities.add(canonicalIdentity(p));
    }
    const merged: ModelProfileMap = { ...acc.modelProfiles };
    for (const [id, p] of Object.entries(discovered)) {
      if (suppressedIds.has(id)) continue; // User explicitly deleted this — don't re-add.
      if (coveredIdentities.has(canonicalIdentity(p))) continue; // Already covered by an explicit profile.
      if (!(id in merged)) {
        merged[id] = allDisabled.has(id) ? { ...p, enabled: false } : p;
        profileSources[id] = "discovered";
      }
    }
    if (Object.keys(discovered).length > 0) {
      acc = { ...acc, modelProfiles: merged };
    }
  }

  return {
    config: acc,
    configPath: wsRead ? workspacePath : null,
    userConfigPath: userRead ? userPath : null,
    found: !!wsRead,
    profileSources,
  };
}

/** Returns the bundled-default config (for tests / introspection). */
export function defaultConfig(): TierkitConfig {
  return bundledDefault();
}
