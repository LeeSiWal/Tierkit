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
    routingPolicy: o.routingPolicy ?? base.routingPolicy,
    security: o.security ?? base.security,
    ...(o.budget !== undefined ? { budget: o.budget } : base.budget !== undefined ? { budget: base.budget } : {}),
    ...(o.modelPolicy !== undefined ? { modelPolicy: o.modelPolicy } : base.modelPolicy !== undefined ? { modelPolicy: base.modelPolicy } : {}),
    runtime: o.runtime ?? base.runtime,
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

  // ── User-level overlay ──
  const userRead = await readConfigFileRaw(userPath);
  let acc = bundled;
  if (userRead) {
    const rawProfiles = (userRead.raw.modelProfiles ?? {}) as Record<string, unknown>;
    acc = mergeConfigs(acc, { config: userRead.config, rawProfiles });
    for (const [id, val] of Object.entries(rawProfiles)) {
      if (val === null) delete profileSources[id];
    }
    for (const id of Object.keys(userRead.config.modelProfiles)) profileSources[id] = "user";
  }

  // ── Workspace-level overlay ──
  const wsRead = await readConfigFileRaw(workspacePath);
  if (wsRead) {
    const rawProfiles = (wsRead.raw.modelProfiles ?? {}) as Record<string, unknown>;
    acc = mergeConfigs(acc, { config: wsRead.config, rawProfiles });
    for (const [id, val] of Object.entries(rawProfiles)) {
      if (val === null) delete profileSources[id];
    }
    for (const id of Object.keys(wsRead.config.modelProfiles)) profileSources[id] = "workspace";
  }

  // ── Ollama auto-discovery ─────────────────────────────────────────────────
  // After all explicit configs (bundled/user/workspace) are merged, look at the local
  // Ollama daemon to see what models the user actually has pulled and synthesize a
  // profile per chat-capable model. Discovered profiles fill in for users whose
  // installed models don't match Tierkit's bundled-default model names.
  //
  // Discovered profiles NEVER override existing ones — if a workspace/user/bundled
  // profile has the same id (very unlikely given the `ollama-` prefix), it wins.
  if (acc.runtime.discoverOllamaModels !== false) {
    const discovered = await discoverOllamaProfiles();
    const merged: ModelProfileMap = { ...acc.modelProfiles };
    for (const [id, p] of Object.entries(discovered)) {
      if (!(id in merged)) {
        merged[id] = p;
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
