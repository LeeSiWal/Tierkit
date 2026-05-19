import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME, type PerProfileBudget } from "../config/TierkitConfig.js";
import { TIERKIT_DIR, readRegistry, REGISTRY_FILENAME } from "../plugin/PluginRegistry.js";
import { loadConfig } from "../config/loadConfig.js";
import { effectivePaymentModel, type ModelProfile } from "../model/ModelProfile.js";
import {
  aggregateByProfile,
  readUsage,
  type ProfileUsageEntry,
} from "../runtime/usageLog.js";

export interface DoctorInput {
  cwd?: string;
}

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  /**
   * v0.12 additive: profile id this check targets, when applicable. Lets
   * callers filter/group budget checks by profile without parsing `detail`.
   */
  targetProfileId?: string;
}

export interface DoctorResult {
  projectRoot: string;
  status: CheckStatus;
  checks: DoctorCheck[];
}

export async function doctor(input: DoctorInput = {}): Promise<DoctorResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  checks.push(await checkNodeVersion());
  checks.push(await checkConfigFile(projectRoot));
  checks.push(await checkRegistryFile(projectRoot));
  checks.push(await checkRegistryPluginPaths(projectRoot));
  checks.push(await checkSecurityPolicy(projectRoot));
  checks.push(await checkPluginRiskCombos(projectRoot));
  checks.push(await checkApiKeyEnvVars(projectRoot));
  for (const c of await checkPerProfileBudgets(projectRoot)) checks.push(c);

  const status: CheckStatus = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";

  return { projectRoot, status, checks };
}

async function checkNodeVersion(): Promise<DoctorCheck> {
  const required = 20;
  const actual = process.versions.node;
  const major = Number.parseInt(actual.split(".")[0] ?? "0", 10);
  if (major >= required) {
    return { id: "node-version", label: `Node.js ${actual}`, status: "ok" };
  }
  return {
    id: "node-version",
    label: "Node.js version",
    status: "fail",
    detail: `Tierkit requires Node.js >= ${required}.x, found ${actual}`,
  };
}

async function checkConfigFile(projectRoot: string): Promise<DoctorCheck> {
  try {
    const result = await loadConfig(projectRoot);
    if (!result.found) {
      return {
        id: "config",
        label: CONFIG_FILENAME,
        status: "warn",
        detail: `${CONFIG_FILENAME} not found; run 'tierkit init'`,
      };
    }
    return { id: "config", label: CONFIG_FILENAME, status: "ok" };
  } catch (err) {
    return {
      id: "config",
      label: CONFIG_FILENAME,
      status: "fail",
      detail: (err as Error).message,
    };
  }
}

async function checkRegistryFile(projectRoot: string): Promise<DoctorCheck> {
  const registryPath = path.join(projectRoot, TIERKIT_DIR, REGISTRY_FILENAME);
  try {
    await fs.access(registryPath);
    return { id: "registry", label: `${TIERKIT_DIR}/${REGISTRY_FILENAME}`, status: "ok" };
  } catch {
    return {
      id: "registry",
      label: `${TIERKIT_DIR}/${REGISTRY_FILENAME}`,
      status: "warn",
      detail: "registry not initialized; run 'tierkit init'",
    };
  }
}

async function checkSecurityPolicy(projectRoot: string): Promise<DoctorCheck> {
  try {
    const r = await loadConfig(projectRoot);
    if (!r.found) {
      return { id: "security-policy", label: "security policy", status: "warn", detail: "config not found — using defaults" };
    }
    const s = r.config.security;
    const weak: string[] = [];
    if (!s.redactSecretsForRemote) weak.push("redactSecretsForRemote=false");
    if (!s.blockSecretFiles) weak.push("blockSecretFiles=false");
    if (!s.dangerousCommandsRequireApproval) weak.push("dangerousCommandsRequireApproval=false");
    if (weak.length > 0) {
      return {
        id: "security-policy",
        label: "security policy",
        status: "warn",
        detail: `weakened defaults: ${weak.join(", ")}`,
      };
    }
    return { id: "security-policy", label: "security policy", status: "ok", detail: "all defaults intact" };
  } catch (err) {
    return { id: "security-policy", label: "security policy", status: "warn", detail: (err as Error).message };
  }
}

async function checkPluginRiskCombos(projectRoot: string): Promise<DoctorCheck> {
  try {
    const registry = await readRegistry(projectRoot);
    if (registry.plugins.length === 0) {
      return { id: "plugin-risk", label: "plugin permission risk", status: "ok", detail: "no plugins installed" };
    }
    const risky: string[] = [];
    for (const p of registry.plugins) {
      const perms = p.manifest.permissions;
      const reasons: string[] = [];
      if (perms.accessSecrets && perms.usePublicCloudModel) {
        reasons.push("accessSecrets + usePublicCloudModel (secrets could be sent to public cloud)");
      }
      if (perms.runCommands && perms.usePublicCloudModel) {
        reasons.push("runCommands + usePublicCloudModel (public-cloud output executed locally)");
      }
      if (perms.registerMcp && p.manifest.freedom.level === "free") {
        reasons.push("registerMcp combined with freedom.level=free (no workflow gates)");
      }
      if (reasons.length > 0) risky.push(`${p.id}: ${reasons.join("; ")}`);
    }
    if (risky.length === 0) {
      return { id: "plugin-risk", label: "plugin permission risk", status: "ok", detail: `${registry.plugins.length} plugin(s) reviewed` };
    }
    return {
      id: "plugin-risk",
      label: "plugin permission risk",
      status: "warn",
      detail: risky.join(" | "),
    };
  } catch (err) {
    return { id: "plugin-risk", label: "plugin permission risk", status: "warn", detail: (err as Error).message };
  }
}

async function checkApiKeyEnvVars(projectRoot: string): Promise<DoctorCheck> {
  try {
    const r = await loadConfig(projectRoot);
    if (!r.found) {
      return { id: "api-key-env", label: "model API key env vars", status: "ok", detail: "no config" };
    }
    const missing: string[] = [];
    for (const [profileId, profile] of Object.entries(r.config.modelProfiles)) {
      if (!profile.apiKeyEnv) continue;
      const v = process.env[profile.apiKeyEnv];
      if (!v || v.length === 0) missing.push(`${profile.apiKeyEnv} (used by "${profileId}")`);
    }
    if (missing.length === 0) {
      return { id: "api-key-env", label: "model API key env vars", status: "ok" };
    }
    return {
      id: "api-key-env",
      label: "model API key env vars",
      status: "warn",
      detail: `missing: ${missing.join(", ")}`,
    };
  } catch (err) {
    return { id: "api-key-env", label: "model API key env vars", status: "warn", detail: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// v0.12 — per-profile budget checks
// ---------------------------------------------------------------------------

const EMPTY_USAGE: ProfileUsageEntry = {
  today: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  month: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
};

/**
 * v0.12 Task 7 — emit doctor checks for every entry in `config.budget.perProfile`:
 *
 *  1. `flat-rate-or-free-with-usd-limit` (warning) — USD limit set on a profile
 *     whose effectivePaymentModel is not "per-token". Message differs per pm:
 *     - free       → "USD limits are IGNORED"
 *     - flat-rate  → "USD limits are DISPLAY-ONLY METADATA"
 *  2. `per-profile-budget-near-threshold` (warning) — per-token profile usage
 *     is in [80%, 100%) of monthly cap. Optionally appends an estimated
 *     "cap reached in ~N days" tail (6 gating conditions, see helper).
 *  3. `per-profile-budget-blocked` (fail/blocker) — per-token profile usage is
 *     ≥ 100% of monthly cap. Note: the CLI special-cases this id to NOT cause
 *     exit code 1 — budget block is policy state, not a system failure.
 *
 * Orphan budgets (entries whose `profileId` no longer exists in
 * `modelProfiles`) are silently skipped — out of scope here.
 */
async function checkPerProfileBudgets(projectRoot: string): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  let cfg;
  try {
    cfg = await loadConfig(projectRoot);
  } catch {
    return out;
  }
  if (!cfg.found) return out;
  const perProfile = cfg.config.budget?.perProfile;
  if (!perProfile) return out;

  // Aggregate usage once for the whole loop. Failed to read → empty aggregate.
  let aggregate: Record<string, ProfileUsageEntry> = {};
  try {
    const usagePath = path.join(projectRoot, cfg.config.runtime.dataDir, "usage.jsonl");
    const records = await readUsage(usagePath);
    aggregate = aggregateByProfile(records, new Date());
  } catch {
    aggregate = {};
  }

  for (const [profileId, budget] of Object.entries(perProfile)) {
    const profile = cfg.config.modelProfiles[profileId];
    if (!profile) continue; // orphan budget entry
    const usage = aggregate[profileId] ?? EMPTY_USAGE;

    const c1 = checkFlatRateOrFreeWithUsdLimit(profileId, profile, budget);
    if (c1) out.push(c1);
    const c2 = checkPerProfileBudgetNearThreshold(profileId, profile, budget, usage);
    if (c2) out.push(c2);
    const c3 = checkPerProfileBudgetBlocked(profileId, profile, budget, usage);
    if (c3) out.push(c3);
  }
  return out;
}

function checkFlatRateOrFreeWithUsdLimit(
  profileId: string,
  profile: ModelProfile,
  budget: PerProfileBudget,
): DoctorCheck | null {
  const pm = effectivePaymentModel(profile);
  if (pm === "per-token") return null;
  const hasUsd =
    budget.dailyUsdLimit !== undefined || budget.monthlyUsdLimit !== undefined;
  if (!hasUsd) return null;
  const detail =
    pm === "free"
      ? `profile '${profileId}' has a USD limit set, but paymentModel='free'. ` +
        `For 'free' profiles, USD limits are IGNORED (Tierkit has no per-call cost ` +
        `to bill against). Use 'monthlyInputTokenLimit' for local resource protection.`
      : `profile '${profileId}' has a USD limit set, but paymentModel='flat-rate'. ` +
        `For 'flat-rate' profiles, USD limits are DISPLAY-ONLY METADATA — the ` +
        `subscription is already paid, so Tierkit will not block calls on USD. ` +
        `Use 'monthlyInputTokenLimit' to protect subscription quota.`;
  return {
    id: "flat-rate-or-free-with-usd-limit",
    label: `per-profile budget: ${profileId}`,
    status: "warn",
    targetProfileId: profileId,
    detail,
  };
}

function checkPerProfileBudgetNearThreshold(
  profileId: string,
  profile: ModelProfile,
  budget: PerProfileBudget,
  usage: ProfileUsageEntry,
): DoctorCheck | null {
  const pm = effectivePaymentModel(profile);
  if (pm !== "per-token") return null;
  const tokenRatio =
    budget.monthlyInputTokenLimit && budget.monthlyInputTokenLimit > 0
      ? usage.month.inputTokens / budget.monthlyInputTokenLimit
      : 0;
  const usdRatio =
    budget.monthlyUsdLimit && budget.monthlyUsdLimit > 0
      ? usage.month.costUsd / budget.monthlyUsdLimit
      : 0;
  const ratio = Math.max(tokenRatio, usdRatio);
  if (ratio < 0.8 || ratio >= 1.0) return null;

  const usdDominant = usdRatio >= tokenRatio;
  const reasonLabel = usdDominant ? "USD" : "input token";
  const pct = Math.floor(ratio * 100);
  const usedAmount = usdDominant
    ? `$${usage.month.costUsd.toFixed(2)} / $${(budget.monthlyUsdLimit ?? 0).toFixed(2)}`
    : `${usage.month.inputTokens.toLocaleString()} / ${(budget.monthlyInputTokenLimit ?? 0).toLocaleString()}`;
  let detail = `profile '${profileId}' is at ${pct}% of monthly ${reasonLabel} cap (${usedAmount}).`;

  // Conditional "cap reached in ~N days" — all 6 conditions must hold:
  //   (1) pm === "per-token"   [already verified above]
  //   (2) some monthly cap set [already verified by ratio > 0]
  //   (3) ratio >= 50%         [implied by ratio >= 80% here]
  //   (4) day-of-month >= 3    [need >=3 days of history for a useful avg]
  //   (5) not yet blocked      [ratio < 1.0 already enforced]
  //   (6) daily-avg > 0
  const now = new Date();
  const day = now.getUTCDate();
  if (day >= 3 && ratio >= 0.5) {
    const usedNow = usdDominant ? usage.month.costUsd : usage.month.inputTokens;
    const limit = usdDominant
      ? (budget.monthlyUsdLimit ?? 0)
      : (budget.monthlyInputTokenLimit ?? 0);
    const dailyAvg = usedNow / day;
    if (dailyAvg > 0) {
      const remaining = Math.max(0, limit - usedNow);
      const daysUntilCap = Math.round(remaining / dailyAvg);
      detail +=
        ` Estimated based on this month's daily average so far: cap reached in ~${daysUntilCap} days.`;
    }
  }

  return {
    id: "per-profile-budget-near-threshold",
    label: `per-profile budget: ${profileId}`,
    status: "warn",
    targetProfileId: profileId,
    detail,
  };
}

function checkPerProfileBudgetBlocked(
  profileId: string,
  profile: ModelProfile,
  budget: PerProfileBudget,
  usage: ProfileUsageEntry,
): DoctorCheck | null {
  const pm = effectivePaymentModel(profile);
  if (pm !== "per-token") return null;
  const tokenRatio =
    budget.monthlyInputTokenLimit && budget.monthlyInputTokenLimit > 0
      ? usage.month.inputTokens / budget.monthlyInputTokenLimit
      : 0;
  const usdRatio =
    budget.monthlyUsdLimit && budget.monthlyUsdLimit > 0
      ? usage.month.costUsd / budget.monthlyUsdLimit
      : 0;
  if (Math.max(tokenRatio, usdRatio) < 1.0) return null;
  const usdDominant = usdRatio >= tokenRatio;
  const reason = usdDominant
    ? `monthly USD cap ($${(budget.monthlyUsdLimit ?? 0).toFixed(2)} reached)`
    : `monthly input token cap (${(budget.monthlyInputTokenLimit ?? 0).toLocaleString()} reached)`;
  return {
    id: "per-profile-budget-blocked",
    label: `per-profile budget: ${profileId}`,
    status: "fail",
    targetProfileId: profileId,
    detail:
      `profile '${profileId}' is blocked by ${reason}. ` +
      `Routing to this profile will be skipped until next reset (monthly) or until cap raised.`,
  };
}

async function checkRegistryPluginPaths(projectRoot: string): Promise<DoctorCheck> {
  try {
    const registry = await readRegistry(projectRoot);
    if (registry.plugins.length === 0) {
      return { id: "plugins", label: "installed plugins", status: "ok", detail: "no plugins installed" };
    }
    const missing: string[] = [];
    for (const p of registry.plugins) {
      try {
        await fs.access(p.pluginDir);
      } catch {
        missing.push(p.id);
      }
    }
    if (missing.length > 0) {
      return {
        id: "plugins",
        label: "installed plugins",
        status: "fail",
        detail: `plugin directories missing: ${missing.join(", ")}`,
      };
    }
    return {
      id: "plugins",
      label: "installed plugins",
      status: "ok",
      detail: `${registry.plugins.length} plugin(s) installed`,
    };
  } catch (err) {
    return {
      id: "plugins",
      label: "installed plugins",
      status: "warn",
      detail: (err as Error).message,
    };
  }
}
