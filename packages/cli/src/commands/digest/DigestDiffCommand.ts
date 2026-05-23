import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "clipanion";
import { summarizeGitDiff } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class DigestDiffCommand extends Command<CliContext> {
  static override paths = [["digest", "diff"]];

  static override usage = Command.Usage({
    category: "Context Gateway",
    description: "Summarize the current git diff (working tree by default, or --staged). Heuristic — see CHANGELOG.",
    examples: [
      ["Working tree", "tierkit digest diff"],
      ["Staged only", "tierkit digest diff --staged"],
    ],
  });

  staged = Option.Boolean("--staged", false);
  cwdFlag = Option.String("--cwd");
  out = Option.String("--out");
  json = Option.Boolean("--json", false);

  override async execute(): Promise<number> {
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    const digest = await summarizeGitDiff(cwd, { staged: this.staged });

    if (this.json) {
      this.context.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    } else {
      const o = this.context.stdout;
      o.write(`Diff Summary — ${digest.id}\n`);
      o.write(`  Changed: ${digest.changedFiles.length} file(s) · +${digest.totalInsertions}/-${digest.totalDeletions}\n`);
      o.write(`  Saved: ${digest.stats.savedTokens} tokens (${(digest.stats.savedRatio * 100).toFixed(1)}%)\n`);
      o.write(`\n${digest.summaryMd}\n`);
      if (digest.uncertainty.length > 0) {
        o.write(`\nUncertainty:\n`);
        for (const u of digest.uncertainty) o.write(`  - ${u}\n`);
      }
    }

    if (this.out) {
      const target = path.resolve(this.context.cwd, this.out);
      await fs.writeFile(target, digest.summaryMd);
      this.context.stdout.write(`Wrote: ${target}\n`);
    }
    return 0;
  }
}
