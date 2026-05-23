import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "clipanion";
import {
  compressCommand,
  isProfileDisabled,
  loadConfig,
  makeRefineCallback,
} from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import { readTextInput } from "./readStdin.js";

export class DigestCommandCommand extends Command<CliContext> {
  static override paths = [["digest", "command"]];

  static override usage = Command.Usage({
    category: "Context Gateway",
    description: "Compress a natural-language task command into a compact implementation brief (no LLM by default).",
    examples: [
      ["Inline command", 'tierkit digest command "Add CRUD for AdminMenuForm, keep existing structure"'],
      ["From file", "tierkit digest command --file ./task.txt"],
      ["Piped", "cat task.txt | tierkit digest command"],
      ["JSON output", "tierkit digest command --json ..."],
    ],
  });

  command = Option.String({ required: false });
  file = Option.String("--file");
  out = Option.String("--out");
  json = Option.Boolean("--json", false);
  refine = Option.String("--refine");
  cwdFlag = Option.String("--cwd");

  override async execute(): Promise<number> {
    const text = await readTextInput(this.command, this.file, this.context.stdin);
    if (!text || text.trim().length === 0) {
      this.context.stderr.write("error: no command supplied (use positional arg, --file, or stdin)\n");
      return 1;
    }

    let refineOptions: Parameters<typeof compressCommand>[1] | undefined;
    if (this.refine) {
      const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
      const cfg = await loadConfig(cwd);
      const profile = cfg.config.modelProfiles[this.refine];
      if (!profile) {
        this.context.stderr.write(`error: model profile "${this.refine}" not found\n`);
        return 1;
      }
      if (isProfileDisabled(cfg.config, this.refine)) {
        this.context.stderr.write(`error: model profile "${this.refine}" is disabled\n`);
        return 1;
      }
      refineOptions = {
        refine: makeRefineCallback(profile),
        provider: "ollama",
        model: profile.model,
      };
    }

    const digest = await compressCommand(text, refineOptions);

    if (this.json) {
      this.context.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    } else {
      const o = this.context.stdout;
      o.write(`Compressed Task — ${digest.id}\n`);
      o.write(`  Title: ${digest.taskTitle}\n`);
      o.write(`  Provider: ${digest.provider}${digest.model ? ` (${digest.model})` : ""}\n`);
      o.write(`  Saved: ${digest.stats.savedTokens} tokens (${(digest.stats.savedRatio * 100).toFixed(1)}%)\n`);
      o.write(`\n${digest.compressed}\n`);
      if (digest.uncertainty.length > 0) {
        o.write(`\nUncertainty:\n`);
        for (const u of digest.uncertainty) o.write(`  - ${u}\n`);
      }
    }

    if (this.out) {
      const target = path.resolve(this.context.cwd, this.out);
      await fs.writeFile(target, digest.compressed);
      this.context.stdout.write(`Wrote: ${target}\n`);
    }
    return 0;
  }
}
