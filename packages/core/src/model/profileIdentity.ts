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
