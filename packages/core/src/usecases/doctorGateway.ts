import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/loadConfig.js";
import type { DoctorCheck } from "./doctor.js";
import { gatewayLogPath } from "../runtime/gatewayLog.js";
import { resolveRuntimeDataDir } from "../runtime/runtimePaths.js";
import { loopbackControlUrl } from "../runtime/loopback.js";

export interface DoctorGatewayInput { cwd?: string; }

export async function doctorGateway(input: DoctorGatewayInput = {}): Promise<DoctorCheck[]> {
  const cwd = input.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  const cfgResult = await loadConfig(cwd);
  const runtime = cfgResult.config.runtime;
  const baseUrl = loopbackControlUrl(runtime.host, runtime.port);
  const resolvedDataDir = resolveRuntimeDataDir(runtime.dataDir, cwd);

  if (runtime.gatewayMode === "on") {
    checks.push({ id: "gateway-mode", label: "runtime.gatewayMode", status: "ok", detail: "on" });
  } else {
    checks.push({
      id: "gateway-mode",
      label: "runtime.gatewayMode",
      status: "warn",
      detail: `gatewayMode is "off" (default). Toggle "Route Claude Code through Tierkit" in the sidebar, or set runtime.gatewayMode: "on" in tierkit.config.json.`,
    });
  }

  if (runtime.gatewayMode === "on") {
    const reach = await probeDaemon(baseUrl);
    if (reach.ok) {
      checks.push({ id: "gateway-daemon", label: `daemon @ ${baseUrl}`, status: "ok" });
      checks.push(await probeStatusEndpoint(baseUrl));
    } else {
      checks.push({ id: "gateway-daemon", label: `daemon @ ${baseUrl}`, status: "fail", detail: reach.detail });
    }
  }

  checks.push(checkGatewayTransformations(runtime.gatewayTransformations));
  checks.push(...checkMeasuredCompact(runtime.measuredCompact, runtime.gatewayTransformations));
  checks.push(await checkLogWritable(resolvedDataDir));
  checks.push(checkClaudeBinary());
  checks.push(checkCredentialMode());
  return checks;
}

function checkMeasuredCompact(
  measuredCompact: {
    mode: "off" | "measured_compact";
    eligibleSources: { tierkitMcpCompactTools: string[] };
    officialTokenMeasurement: { mode: "off" | "anthropic_count_tokens_opt_in"; consentAcknowledged: boolean };
    privacy: { rawBaselineStorage: "memory_only" };
  },
  gatewayTransformations: {
    mode: "off" | "observe" | "envelope";
  },
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({
    id: "measured-compact-mode",
    label: "Measured Compact Context",
    status: measuredCompact.mode === "off" ? "ok" : "warn",
    detail: measuredCompact.mode === "off" ? "OFF" : "ENABLED (request-level official measurement currently blocked)",
  });
  checks.push({
    id: "measured-compact-official-token-measurement",
    label: "Official Token Measurement",
    status:
      measuredCompact.officialTokenMeasurement.mode === "off"
        ? "ok"
        : measuredCompact.officialTokenMeasurement.consentAcknowledged
          ? "warn"
          : "fail",
    detail:
      measuredCompact.officialTokenMeasurement.mode === "off"
        ? "OFF — explicit consent required"
        : measuredCompact.officialTokenMeasurement.consentAcknowledged
          ? "ENABLED BY USER OPT-IN; raw baseline may be transmitted to Anthropic Token Counting API only when a safe memory-only bridge exists."
          : "invalid: opt-in mode requires consentAcknowledged=true",
  });
  checks.push({
    id: "measured-compact-mcp-contract",
    label: "MCP Compact Tool Contract",
    status: "ok",
    detail: `READY for tierkit.get_file_digest; configured eligible count=${measuredCompact.eligibleSources.tierkitMcpCompactTools.length}`,
  });
  checks.push({
    id: "measured-compact-request-level",
    label: "Request-Level Counterfactual Measurement",
    status: measuredCompact.mode === "off" ? "ok" : "warn",
    detail:
      "BLOCKED: MCP compact tools run in a separate process from the Gateway daemon, so no memory-only raw-baseline registry is currently shared.",
  });
  checks.push({
    id: "measured-compact-raw-baseline-storage",
    label: "Raw Baseline Storage",
    status: measuredCompact.privacy.rawBaselineStorage === "memory_only" ? "ok" : "fail",
    detail: "MEMORY ONLY",
  });
  checks.push({
    id: "measured-compact-legacy-envelope-conflict",
    label: "Legacy Gateway Envelope Conflict",
    status: measuredCompact.mode === "measured_compact" && gatewayTransformations.mode === "envelope" ? "fail" : "ok",
    detail:
      measuredCompact.mode === "measured_compact" && gatewayTransformations.mode === "envelope"
        ? "measured compact and legacy gateway envelope cannot be enabled together"
        : "NONE",
  });
  return checks;
}

function checkGatewayTransformations(runtimeTransformations: {
  mode: "off" | "observe" | "envelope";
  toolResultEnvelope: { allowlistedToolNames: string[] };
}): DoctorCheck {
  const mode = runtimeTransformations.mode;
  if (mode === "off") {
    return {
      id: "gateway-transformations",
      label: "experimental request transformations",
      status: "ok",
      detail: "off",
    };
  }
  if (mode === "observe") {
    return {
      id: "gateway-transformations",
      label: "experimental request transformations",
      status: "warn",
      detail: "observe enabled; request bodies are not rewritten.",
    };
  }
  const count = runtimeTransformations.toolResultEnvelope.allowlistedToolNames.length;
  return {
    id: "gateway-transformations",
    label: "experimental request transformations",
    status: count > 0 ? "warn" : "fail",
    detail:
      count > 0
        ? `envelope enabled with explicit allowlist count=${count}; production activation still requires gate evidence.`
        : "envelope enabled without allowlisted tools; add an explicit allowlist or set mode off.",
  };
}

async function probeDaemon(baseUrl: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, detail: `daemon responded ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message}` };
  }
}

async function probeStatusEndpoint(baseUrl: string): Promise<DoctorCheck> {
  try {
    const res = await fetch(`${baseUrl}/v1/gateway/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { id: "gateway-routes", label: "/v1/gateway/status", status: "fail", detail: `status ${res.status}` };
    const body = (await res.json()) as { routesEnabled?: boolean; messagesPath?: string };
    if (body.routesEnabled !== true) return { id: "gateway-routes", label: "routes", status: "fail", detail: `routesEnabled=${body.routesEnabled}` };
    return { id: "gateway-routes", label: "routes", status: "ok", detail: body.messagesPath ?? "/v1/messages" };
  } catch (err) {
    return { id: "gateway-routes", label: "/v1/gateway/status", status: "fail", detail: (err as Error).message };
  }
}

async function checkLogWritable(resolvedDataDir: string): Promise<DoctorCheck> {
  const logPath = gatewayLogPath(resolvedDataDir);
  try {
    await fs.mkdir(resolvedDataDir, { recursive: true });
    const probe = `${logPath}.probe-${process.pid}`;
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
    return { id: "gateway-log-path", label: "safe gateway log", status: "ok", detail: logPath };
  } catch (err) {
    return { id: "gateway-log-path", label: "safe gateway log", status: "fail", detail: `${logPath} — ${(err as Error).message}` };
  }
}

function checkClaudeBinary(): DoctorCheck {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status === 0 && (r.stdout?.trim()?.length ?? 0) > 0) {
    return { id: "gateway-claude-code", label: "claude (Claude Code CLI)", status: "ok", detail: r.stdout.trim() };
  }
  return { id: "gateway-claude-code", label: "claude (Claude Code CLI)", status: "warn", detail: "not detected on PATH — install Claude Code, then re-run." };
}

function checkCredentialMode(): DoctorCheck {
  const hasApiKey = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
  return { id: "gateway-credential-mode", label: "credential mode", status: "ok", detail: hasApiKey ? "api-key (ANTHROPIC_API_KEY is set)" : "subscription / unknown (no ANTHROPIC_API_KEY)" };
}
