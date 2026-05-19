import path from "node:path";
import { Command, Option } from "clipanion";
import { readArtifact, ContextArtifactStoreError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class ContextShowCommand extends Command<CliContext> {
  static override paths = [["context", "show"]];

  static override usage = Command.Usage({
    category: "Context",
    description: "Print a context artifact summary (or its raw JSON with --json)",
    examples: [
      ["Pretty print", "tierkit context show ctx_a3b2c1d4e5"],
      ["Raw JSON", "tierkit context show ctx_a3b2c1d4e5 --json"],
    ],
  });

  id = Option.String({ required: true });
  json = Option.Boolean("--json", false);
  cwdFlag = Option.String("--cwd");

  override async execute(): Promise<number> {
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    let result;
    try {
      result = await readArtifact(cwd, this.id);
    } catch (err) {
      if (err instanceof ContextArtifactStoreError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    const { artifact } = result;
    if (cwd !== artifact.workspaceRoot) {
      this.context.stdout.write(
        `Warning: artifact was built for ${artifact.workspaceRoot} but current cwd is ${cwd}\n`,
      );
    }
    if (this.json) {
      this.context.stdout.write(JSON.stringify(artifact, null, 2) + "\n");
      return 0;
    }
    const out = this.context.stdout;
    out.write(`Context artifact: ${artifact.id}\n`);
    out.write(`  Created: ${artifact.createdAt}\n`);
    out.write(`  Task: ${artifact.task}\n`);
    out.write(`  Keywords: ${artifact.keywords.join(", ")}\n`);
    out.write(`  Selected: ${artifact.candidates.length} files\n`);
    for (const c of artifact.candidates) {
      out.write(`    ${c.score.toFixed(2)}  ${c.path}  — ${c.reason}\n`);
    }
    out.write(`  Baseline (est):    ${artifact.estimatedBaselineInputTokens} tokens\n`);
    out.write(`  Compressed (est):  ${artifact.estimatedCompressedInputTokens} tokens\n`);
    const pct =
      artifact.estimatedBaselineInputTokens > 0
        ? (1 - artifact.compressionRatio) * 100
        : 0;
    out.write(`  Saved (est):       ${artifact.savedTokensEstimate} tokens   (${pct.toFixed(1)}%)\n`);
    if (artifact.compare) {
      out.write(`  Last compare: ${artifact.compare.ranAt} (profile ${artifact.compare.profileId})\n`);
      const cmp = artifact.compare;
      if (cmp.savedInputTokensActual !== undefined) {
        out.write(`    Actual saved input tokens: ${cmp.savedInputTokensActual}\n`);
      }
      if (cmp.savedCostUsdActual !== undefined) {
        out.write(`    Actual saved cost: $${cmp.savedCostUsdActual.toFixed(6)}\n`);
      }
    }
    return 0;
  }
}
