import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "clipanion";
import { compressErrorLog } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { readTextInput } from "./readStdin.js";

export class DigestErrorCommand extends Command<CliContext> {
  static override paths = [["digest", "error"]];

  static override usage = Command.Usage({
    category: "Context Gateway",
    description: "Summarize an error log: extract typed errors, dedup repeats, drop node_modules frames.",
    examples: [
      ["From stdin", "npm run build 2>&1 | tierkit digest error"],
      ["From file", "tierkit digest error --file ./build-error.log"],
      ["Inline (rare)", 'tierkit digest error "src/foo.ts:1:1 - error TS2345: x"'],
    ],
  });

  log = Option.String({ required: false });
  file = Option.String("--file");
  out = Option.String("--out");
  json = Option.Boolean("--json", false);
  keepVendor = Option.Boolean("--keep-vendor-frames", false);

  override async execute(): Promise<number> {
    const text = await readTextInput(this.log, this.file, this.context.stdin);
    if (!text || text.trim().length === 0) {
      this.context.stderr.write("error: no log supplied (pipe stdin, use --file, or pass inline)\n");
      return 1;
    }
    const digest = compressErrorLog(text, { keepVendorFrames: this.keepVendor });

    if (this.json) {
      this.context.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    } else {
      const o = this.context.stdout;
      o.write(`Error Digest — ${digest.id}\n`);
      o.write(`  ${digest.mainErrors.length} error(s) · ${digest.likelyFiles.length} likely file(s)\n`);
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
