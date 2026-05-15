/**
 * Load the rules from every currently-active Tierkit plugin and concatenate them as a
 * single system-prompt-ready text block. This is what makes Tierkit a "policy + behavior"
 * layer for ANY tool that routes through it: when the user enables `superpowers-strict`,
 * its rules (plan-approval-gate, tests-first, …) show up as system prompt for every
 * `/v1/llm-call`, whether the caller is the Tierkit sidebar, Roo Code, Cline, Continue,
 * or a raw curl.
 *
 * Without this, plugins are only useful as an EXPORT format for the per-tool config
 * directories. Once exported, the tools-side prompts include them — but Tierkit's own
 * proxy path didn't. This closes that gap.
 *
 * Behavior:
 *   - Reads active plugin ids from `tierkit.config.json::activePlugins`.
 *   - For each, loads the plugin from its registry directory.
 *   - Concatenates every rule file referenced in `components.rules`.
 *   - Separates plugins with a header line so the model can attribute rules.
 *
 * Returns an empty string when no plugins are active or no rules exist — caller should
 * skip injection in that case.
 */
import path from "node:path";
import { readRegistry } from "./PluginRegistry.js";
import { loadPluginFromDirectory } from "./PluginLoader.js";
import { loadConfig } from "../config/loadConfig.js";

export interface AssembledRulesResult {
  /** The concatenated rule text. Empty string when no active plugin contributed rules. */
  text: string;
  /** Plugin ids whose rules made it into `text`. */
  contributingPluginIds: string[];
  /** Total number of rule files included. */
  ruleFileCount: number;
}

export async function assembleActiveRules(cwd: string): Promise<AssembledRulesResult> {
  const empty: AssembledRulesResult = { text: "", contributingPluginIds: [], ruleFileCount: 0 };

  const cfg = await loadConfig(cwd);
  const activeIds = cfg.config.activePlugins;
  if (activeIds.length === 0) return empty;

  let registry;
  try {
    registry = await readRegistry(cwd);
  } catch {
    return empty;
  }

  const sections: string[] = [];
  const contributing: string[] = [];
  let totalRuleFiles = 0;

  for (const id of activeIds) {
    const entry = registry.plugins.find((p) => p.id === id);
    if (!entry) continue;
    let plugin;
    try {
      plugin = await loadPluginFromDirectory(entry.pluginDir);
    } catch {
      // Plugin dir gone or manifest invalid — skip but don't break the whole call.
      continue;
    }
    const ruleFiles = plugin.manifest.components.rules ?? [];
    if (ruleFiles.length === 0) continue;

    const pluginSection: string[] = [];
    pluginSection.push(`# Tierkit plugin: ${plugin.manifest.id}${plugin.manifest.name ? ` (${plugin.manifest.name})` : ""}`);
    if (plugin.manifest.description) pluginSection.push(plugin.manifest.description);

    for (const ruleRel of ruleFiles) {
      const content = plugin.files.get(ruleRel);
      if (!content || content.trim().length === 0) continue;
      // Header for each rule file so the model can reference it.
      pluginSection.push(`## ${path.basename(ruleRel)}`);
      pluginSection.push(content.trim());
      totalRuleFiles++;
    }

    if (pluginSection.length > 1) {
      sections.push(pluginSection.join("\n\n"));
      contributing.push(id);
    }
  }

  if (sections.length === 0) return empty;

  // Prefix the whole block with one explanation so the model knows what it's reading.
  const preamble =
    "The following Tierkit plugin rules are active in this workspace and apply to your behavior. " +
    "Follow these rules in addition to any other instructions you receive.";
  return {
    text: `${preamble}\n\n${sections.join("\n\n---\n\n")}`,
    contributingPluginIds: contributing,
    ruleFileCount: totalRuleFiles,
  };
}
