import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "clipanion";
import { compressJson } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { readTextInput } from "./readStdin.js";

export class DigestJsonCommand extends Command<CliContext> {
  static override paths = [["digest", "json"]];

  static override usage = Command.Usage({
    category: "Context Gateway",
    description: "Compress a large JSON / API response into a shape summary + field paths + mismatch hints.",
    examples: [
      ["Pipe", "curl https://api.example.com/data | tierkit digest json"],
      ["From file", "tierkit digest json --file ./response.json"],
    ],
  });

  json = Option.String({ required: false });
  file = Option.String("--file");
  out = Option.String("--out");
  asJsonOutput = Option.Boolean("--json-output", false);
  maxDepth = Option.String("--max-depth");
  maxStringLen = Option.String("--max-string-len");

  override async execute(): Promise<number> {
    const text = await readTextInput(this.json, this.file, this.context.stdin);
    if (!text || text.trim().length === 0) {
      this.context.stderr.write("error: no JSON supplied (pipe stdin, use --file, or pass inline)\n");
      return 1;
    }
    const options: Parameters<typeof compressJson>[1] = {};
    if (this.maxDepth !== undefined) options.maxDepth = Number.parseInt(this.maxDepth, 10);
    if (this.maxStringLen !== undefined) options.maxStringLen = Number.parseInt(this.maxStringLen, 10);
    const digest = compressJson(text, options);

    if (this.asJsonOutput) {
      this.context.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    } else {
      const o = this.context.stdout;
      o.write(`JSON Digest — ${digest.id}\n`);
      o.write(`  ${digest.fieldPaths.length} field path(s) · ${digest.possibleMismatches.length} mismatch hint(s)\n`);
      o.write(`  Saved: ${digest.stats.savedTokens} tokens (${(digest.stats.savedRatio * 100).toFixed(1)}%)\n`);
      o.write(`\n${digest.summaryMd}\n`);
    }

    if (this.out) {
      const target = path.resolve(this.context.cwd, this.out);
      await fs.writeFile(target, digest.summaryMd);
      this.context.stdout.write(`Wrote: ${target}\n`);
    }
    return 0;
  }
}
