import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "clipanion";
import { compressTestOutput } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { readTextInput } from "./readStdin.js";

export class DigestTestCommand extends Command<CliContext> {
  static override paths = [["digest", "test"]];

  static override usage = Command.Usage({
    category: "Context Gateway",
    description: "Summarize test output (vitest/jest/pytest): pass counts, failures, expected/received, relevant frames.",
    examples: [
      ["Pipe vitest", "npm test 2>&1 | tierkit digest test"],
      ["From file", "tierkit digest test --file ./test-out.txt"],
    ],
  });

  output = Option.String({ required: false });
  file = Option.String("--file");
  out = Option.String("--out");
  json = Option.Boolean("--json", false);
  keepVendor = Option.Boolean("--keep-vendor-frames", false);

  override async execute(): Promise<number> {
    const text = await readTextInput(this.output, this.file, this.context.stdin);
    if (!text || text.trim().length === 0) {
      this.context.stderr.write("error: no test output supplied (pipe stdin, use --file, or pass inline)\n");
      return 1;
    }
    const digest = compressTestOutput(text, { keepVendorFrames: this.keepVendor });

    if (this.json) {
      this.context.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    } else {
      const o = this.context.stdout;
      o.write(`Test Digest — ${digest.id}\n`);
      o.write(`  Passed: ${digest.passedCount} · Failed: ${digest.failedCount}\n`);
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
