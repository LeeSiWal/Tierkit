/**
 * `syncPlugins` re-runs the export adapters for every currently-active Tierkit plugin
 * to every tool we detect as "connected" in the workspace.
 *
 * Detection is signal-based:
 *   - `.roomodes` or `.roo/` present → Roo Code is connected
 *   - `.clinerules/` present → Cline is connected
 *   - `.continue/` present → Continue is connected
 *
 * Detection runs once per call. Tools NOT detected are skipped silently. The user opted
 * into a tool by either creating its config dir manually or by running `tierkit connect <tool>`.
 *
 * Called automatically by `enablePlugin` / `disablePlugin` so plugin activation propagates
 * to every connected tool without an explicit sync step. Also exposed as a standalone
 * command (`tierkit plugin sync`) for cases where the workspace state drifts.
 *
 * Adapters are passed in via the input so this usecase doesn't have to import any
 * `@tierkit/adapter-*` package — keeps `@tierkit/core` free of adapter dependencies. The
 * CLI and daemon wire up the real adapters at call time.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { exportTarget } from "./exportTarget.js";
import type { Target } from "../plugin/PluginManifest.js";
import type { TierkitAdapter } from "../adapter/TierkitAdapter.js";

export type ConnectableTool = "roo" | "cline" | "continue";

export interface SyncPluginsInput {
  cwd: string;
  /** Adapters available to this sync run; missing targets are skipped. */
  adapters: Partial<Record<Target, TierkitAdapter>>;
  /**
   * Force-include or force-exclude specific tools. If omitted, all detected tools are
   * synced. If provided, ONLY the listed tools are synced (regardless of detection).
   */
  tools?: ConnectableTool[];
}

export interface SyncPluginsResult {
  detected: ConnectableTool[];
  synced: { tool: ConnectableTool; target: Target; filesWritten: number; warnings: number }[];
  skipped: { tool: ConnectableTool; reason: string }[];
}

const TOOL_TO_TARGET: Record<ConnectableTool, Target> = {
  roo: "roo",
  cline: "cline",
  continue: "continue",
};

/** Probe filesystem signals for each tool. */
export async function detectConnectedTools(cwd: string): Promise<ConnectableTool[]> {
  const found: ConnectableTool[] = [];
  if (await pathExists(path.join(cwd, ".roomodes")) || await pathExists(path.join(cwd, ".roo"))) {
    found.push("roo");
  }
  if (await pathExists(path.join(cwd, ".clinerules"))) {
    found.push("cline");
  }
  if (await pathExists(path.join(cwd, ".continue"))) {
    found.push("continue");
  }
  return found;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function syncPlugins(input: SyncPluginsInput): Promise<SyncPluginsResult> {
  const candidates = input.tools ?? (await detectConnectedTools(input.cwd));
  const synced: SyncPluginsResult["synced"] = [];
  const skipped: SyncPluginsResult["skipped"] = [];

  for (const tool of candidates) {
    const target = TOOL_TO_TARGET[tool];
    const adapter = input.adapters[target];
    if (!adapter) {
      skipped.push({ tool, reason: `no adapter registered for target "${target}"` });
      continue;
    }
    const r = await exportTarget({
      cwd: input.cwd,
      target,
      outDir: input.cwd,
      adapters: { [target]: adapter },
    });
    synced.push({
      tool,
      target,
      filesWritten: r.written.length,
      warnings: r.warnings.length,
    });
  }

  return {
    detected: await detectConnectedTools(input.cwd),
    synced,
    skipped,
  };
}
