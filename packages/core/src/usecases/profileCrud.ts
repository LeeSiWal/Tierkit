/**
 * Add / update / remove model profiles by writing to tierkit.config.json (workspace) or
 * ~/.tierkit/config.json (user). These usecases are invoked from:
 *   - HTTP daemon endpoints (`POST /v1/config/profile`, `DELETE /v1/config/profile/:id`)
 *   - CLI (`tierkit profile add`, `tierkit profile remove`)
 *   - VS Code native command (via the typed client SDK)
 *
 * Writes are atomic-ish (write to temp + rename) so the file isn't half-written on crash.
 * The user-level config dir (`~/.tierkit/`) is created on first write.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_FILENAME,
  TierkitConfigSchema,
  type TierkitConfig,
} from "../config/TierkitConfig.js";
import { ModelProfileSchema, type ModelProfile } from "../model/ModelProfile.js";
import { userConfigPath } from "../config/loadConfig.js";

export type ProfileScope = "workspace" | "user";

export interface AddProfileInput {
  cwd?: string;
  id: string;
  profile: ModelProfile;
  scope?: ProfileScope;
}

export interface RemoveProfileInput {
  cwd?: string;
  id: string;
  scope?: ProfileScope;
}

export interface ProfileCrudResult {
  path: string;
  scope: ProfileScope;
  id: string;
}

export class ProfileCrudError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ProfileCrudError";
  }
}

function resolveConfigPath(cwd: string, scope: ProfileScope): string {
  return scope === "user" ? userConfigPath() : path.join(cwd, CONFIG_FILENAME);
}

async function readConfigOrInit(targetPath: string): Promise<TierkitConfig> {
  try {
    const text = await fs.readFile(targetPath, "utf8");
    return TierkitConfigSchema.parse(JSON.parse(text));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return TierkitConfigSchema.parse({ version: "0.1" });
    }
    throw err;
  }
}

async function writeConfig(targetPath: string, config: TierkitConfig): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const text = JSON.stringify(config, null, 2) + "\n";
  const tempPath = targetPath + ".tmp";
  await fs.writeFile(tempPath, text, "utf8");
  await fs.rename(tempPath, targetPath);
}

const PROFILE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Add or overwrite a profile in the target config file. Validates the new profile schema
 * (but not the whole file — null entries from prior deletes must survive as suppression
 * markers, and `TierkitConfigSchema` rejects nulls in `modelProfiles`).
 */
export async function addProfile(input: AddProfileInput): Promise<ProfileCrudResult> {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope ?? "workspace";
  if (!PROFILE_ID_RE.test(input.id)) {
    throw new ProfileCrudError("invalid-id", `profile id must match ${PROFILE_ID_RE} (got "${input.id}")`);
  }
  const validated = ModelProfileSchema.parse(input.profile);
  const targetPath = resolveConfigPath(cwd, scope);

  // Read raw so prior null suppressions are preserved. We deliberately do NOT pass through
  // TierkitConfigSchema here because it would reject any null entry left by removeProfile.
  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(targetPath, "utf8");
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = { version: "0.1" };
  }
  if (typeof raw.modelProfiles !== "object" || raw.modelProfiles === null) {
    raw.modelProfiles = {};
  }
  (raw.modelProfiles as Record<string, unknown>)[input.id] = validated;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const text = JSON.stringify(raw, null, 2) + "\n";
  const tempPath = targetPath + ".tmp";
  await fs.writeFile(tempPath, text, "utf8");
  await fs.rename(tempPath, targetPath);
  return { path: targetPath, scope, id: input.id };
}

/**
 * Remove a profile from the target config file. If the profile only exists in a lower-priority
 * source (e.g., bundled), this writes an explicit `null` in the workspace/user config so the
 * lower-priority profile is suppressed by the loader's merge logic.
 */
export async function removeProfile(input: RemoveProfileInput): Promise<ProfileCrudResult> {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope ?? "workspace";
  const targetPath = resolveConfigPath(cwd, scope);

  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(targetPath, "utf8");
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = { version: "0.1" };
  }

  if (typeof raw.modelProfiles !== "object" || raw.modelProfiles === null) {
    raw.modelProfiles = {};
  }
  // Always write `null` to suppress whatever lower-priority layer might still expose this id.
  (raw.modelProfiles as Record<string, unknown>)[input.id] = null;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const text = JSON.stringify(raw, null, 2) + "\n";
  const tempPath = targetPath + ".tmp";
  await fs.writeFile(tempPath, text, "utf8");
  await fs.rename(tempPath, targetPath);

  return { path: targetPath, scope, id: input.id };
}

export interface UpdateProfileEnabledInput {
  id: string;
  cwd?: string;
  scope?: ProfileScope;
  enabled: boolean;
}

export async function updateProfileEnabled(input: UpdateProfileEnabledInput): Promise<ProfileCrudResult> {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope ?? "workspace";
  const targetPath = resolveConfigPath(cwd, scope);

  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(targetPath, "utf8");
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = { version: "0.1" };
  }
  const list = Array.isArray(raw.disabledProfileIds) ? (raw.disabledProfileIds as string[]) : [];
  const filtered = list.filter((x) => x !== input.id);
  if (!input.enabled) filtered.push(input.id);
  raw.disabledProfileIds = filtered;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const text2 = JSON.stringify(raw, null, 2) + "\n";
  const tempPath = targetPath + ".tmp";
  await fs.writeFile(tempPath, text2, "utf8");
  await fs.rename(tempPath, targetPath);
  return { path: targetPath, scope, id: input.id };
}

export interface UpdateProfileFieldsInput {
  id: string;
  cwd?: string;
  scope?: ProfileScope;
  roles?: string[];
  goodAt?: string[];
  notGoodAt?: string[];
}

/**
 * Patch specific fields (roles, goodAt, notGoodAt) of an existing profile in the target
 * config file. If the profile does not exist in the target scope, it is created as a
 * partial override (other fields remain from lower-priority layers after load-time merge).
 */
export async function updateProfileFields(input: UpdateProfileFieldsInput): Promise<ProfileCrudResult> {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope ?? "workspace";
  const targetPath = resolveConfigPath(cwd, scope);

  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(targetPath, "utf8");
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = { version: "0.1" };
  }

  if (typeof raw.modelProfiles !== "object" || raw.modelProfiles === null) {
    raw.modelProfiles = {};
  }
  const profiles = raw.modelProfiles as Record<string, Record<string, unknown>>;
  const existing = typeof profiles[input.id] === "object" && profiles[input.id] !== null
    ? profiles[input.id]
    : {};

  const updated = { ...existing };
  if (input.roles !== undefined) updated.roles = input.roles;
  if (input.goodAt !== undefined) updated.goodAt = input.goodAt;
  if (input.notGoodAt !== undefined) updated.notGoodAt = input.notGoodAt;
  profiles[input.id] = updated;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const text3 = JSON.stringify(raw, null, 2) + "\n";
  const tempPath3 = targetPath + ".tmp";
  await fs.writeFile(tempPath3, text3, "utf8");
  await fs.rename(tempPath3, targetPath);

  return { path: targetPath, scope, id: input.id };
}
