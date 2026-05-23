import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "clipanion";
import { getFileDigestCached } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

export class DigestFileCommand extends Command<CliContext> {
  static override paths = [["digest", "file"]];

  static override usage = Command.Usage({
    category: "Context Gateway",
    description: "Generate a digest for a workspace file (skeleton + symbols + deps + risks), cached by content hash.",
    examples: [
      ["Single file", "tierkit digest file src/components/AdminMenuForm.tsx"],
      ["Force refresh", "tierkit digest file src/foo.ts --force"],
      ["JSON output", "tierkit digest file src/foo.ts --json"],
    ],
  });

  filePath = Option.String({ required: true });
  force = Option.Boolean("--force", false);
  out = Option.String("--out");
  json = Option.Boolean("--json", false);
  cwdFlag = Option.String("--cwd");

  override async execute(): Promise<number> {
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    const digest = await getFileDigestCached(this.filePath, {
      workspaceRoot: cwd,
      forceRefresh: this.force,
    });

    if (this.json) {
      this.context.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    } else {
      const o = this.context.stdout;
      o.write(`File Digest — ${digest.id}${digest.cacheHit ? " (cache hit)" : ""}\n`);
      o.write(`  Path: ${digest.path}\n`);
      if (digest.hash) o.write(`  Hash: ${digest.hash}\n`);
      o.write(`  Lines: ${digest.totalLines}\n`);
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
