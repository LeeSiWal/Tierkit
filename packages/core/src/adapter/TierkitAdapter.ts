import type { PluginManifest, Target } from "../plugin/PluginManifest.js";
import type { ExportResult } from "./ExportResult.js";
import type { TierkitConfig } from "../config/TierkitConfig.js";

export interface LoadedPlugin {
  manifest: PluginManifest;
  pluginDir: string;
  files: Map<string, string>;
}

export interface AdapterExportInput {
  plugins: LoadedPlugin[];
  outDir: string;
  /**
   * Project-level Tierkit config. Adapters that need model profiles or routing policy
   * (e.g. ContinueAdapter) read this; adapters that only depend on plugin content
   * (RooAdapter, ClineAdapter, GenericMarkdownAdapter) can ignore it.
   *
   * Undefined when no `tierkit.config.json` exists at the project root.
   */
  config?: TierkitConfig;
}

export interface TierkitAdapter {
  readonly target: Target;
  readonly name: string;
  readonly description: string;

  export(input: AdapterExportInput): Promise<ExportResult>;
}
