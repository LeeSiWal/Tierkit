import path from "node:path";
import { Command, Option } from "clipanion";
import {
  buildCompressedContext,
  writeArtifact,
  loadConfig,
  type ContextBudget,
} from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export class ContextBuildCommand extends Command<CliContext> {
  static override paths = [["context", "build"]];

  static override usage = Command.Usage({
    category: "Context",
    description: "Build a deterministic, compressed context artifact for a task (no LLM)",
    examples: [
      ["Build for a task", 'tierkit context build "fix Toss payment bug"'],
      ["Override file/hotspot limits", 'tierkit context build "..." --max-files 12 --max-hotspots 5'],
      ["Add ignore pattern", 'tierkit context build "..." --ignore "vendor/**"'],
    ],
  });

  task = Option.String({ required: true });
  maxFiles = Option.String("--max-files");
  maxHotspots = Option.String("--max-hotspots");
  hotspotLines = Option.String("--hotspot-lines");
  cloudBudget = Option.String("--cloud-budget");
  ignore = Option.Array("--ignore");
  cwdFlag = Option.String("--cwd");

  override async execute(): Promise<number> {
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    const cfg = await loadConfig(cwd);
    const cc = cfg.config.contextCompression;

    const budget: Partial<ContextBudget> = {};
    if (this.maxFiles !== undefined) budget.maxFiles = Number.parseInt(this.maxFiles, 10);
    else if (cc?.defaultMaxFiles !== undefined) budget.maxFiles = cc.defaultMaxFiles;

    if (this.maxHotspots !== undefined) budget.maxHotspotsPerFile = Number.parseInt(this.maxHotspots, 10);
    if (this.hotspotLines !== undefined) budget.hotspotContextLines = Number.parseInt(this.hotspotLines, 10);

    if (this.cloudBudget !== undefined) budget.cloudTokenBudget = Number.parseInt(this.cloudBudget, 10);
    else if (cc?.defaultCloudTokenBudget !== undefined) budget.cloudTokenBudget = cc.defaultCloudTokenBudget;

    const extraIgnoreGlobs = [...(this.ignore ?? []), ...(cc?.ignoreGlobs ?? [])];

    const result = await buildCompressedContext({
      task: this.task,
      workspaceRoot: cwd,
      budget,
      extraIgnoreGlobs,
    });
    if (!result.ok) {
      this.context.stderr.write(`${result.code}: ${result.message}\n`);
      return 1;
    }
    const { artifact, promptMd } = result;

    const { id } = await writeArtifact(cwd, artifact, promptMd);

    const out = this.context.stdout;
    out.write(`Context artifact: ${id}\n`);
    out.write(`  Task: "${truncate(artifact.task, 60)}"\n`);
    out.write(`  Keywords: ${artifact.keywords.join(", ")}\n`);
    out.write(`  Selected: ${artifact.candidates.length} files\n`);
    for (const c of artifact.candidates) {
      out.write(`    ${c.score.toFixed(2)}  ${c.path}  — ${c.reason}\n`);
    }
    out.write(`  Baseline (est):    ${artifact.estimatedBaselineInputTokens} tokens   [task + ${artifact.candidates.length} files raw]\n`);
    out.write(`  Compressed (est):  ${artifact.estimatedCompressedInputTokens} tokens   [prompt.md]\n`);
    const pct = artifact.estimatedBaselineInputTokens > 0
      ? (1 - artifact.compressionRatio) * 100
      : 0;
    out.write(`  Saved (est):       ${artifact.savedTokensEstimate} tokens   (${pct.toFixed(1)}%)\n`);
    out.write(`  Prompt: .tierkit/runtime/context-artifacts/${id}/prompt.md\n`);
    out.write(`  Next: tierkit context send ${id} --profile <profileId>\n`);
    out.write(`        tierkit context compare ${id} --profile <profileId>\n`);
    return 0;
  }
}
