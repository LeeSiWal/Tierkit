import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME } from "../config/TierkitConfig.js";
import { TIERKIT_DIR, readRegistry, REGISTRY_FILENAME } from "../plugin/PluginRegistry.js";
import { loadConfig } from "../config/loadConfig.js";

export interface DoctorInput {
  cwd?: string;
}

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
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
