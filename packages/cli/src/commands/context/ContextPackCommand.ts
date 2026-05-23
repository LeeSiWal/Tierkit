import fs from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "clipanion";
import { buildContextPack } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

async function readFileIfPresent(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) return undefined;
  return await fs.readFile(filePath, "utf8");
}

export class ContextPackCommand extends Command<CliContext> {
  static override paths = [["context", "pack"]];

  static override usage = Command.Usage({
    category: "Context Gateway",
    description: "Build a Claude Code-ready Context Pack: task brief + file digests + diff + error/test/json digests + cleaned context, all in one Markdown payload.",
    examples: [
      [
        "Full pack",
        'tierkit context pack \\\n  --command "Add CRUD for AdminMenuForm" \\\n  --files src/components/AdminMenuForm.tsx,src/store/menuStore.ts \\\n  --include-diff \\\n  --error ./logs/build.txt \\\n  --test ./logs/test.txt \\\n  --json ./response.json \\\n  --out .tierkit/context/admin-menu-pack.md',
      ],
      ["Just task + files", 'tierkit context pack --command "fix payment" --files src/lib/payment.ts'],
    ],
  });

  command = Option.String("--command");
  files = Option.String("--files"); // comma-separated
  includeDiff = Option.Boolean("--include-diff", false);
  stagedDiff = Option.Boolean("--staged-diff", false);
  errorFile = Option.String("--error");
  testFile = Option.String("--test");
  jsonFile = Option.String("--json");
  rawFile = Option.String("--raw");
  out = Option.String("--out");
  cwdFlag = Option.String("--cwd");
  jsonOutput = Option.Boolean("--json-output", false);

  override async execute(): Promise<number> {
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    const files = this.files
      ? this.files.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

    const [errorLog, testOutput, jsonInput, rawContext] = await Promise.all([
      readFileIfPresent(this.errorFile),
      readFileIfPresent(this.testFile),
      readFileIfPresent(this.jsonFile),
      readFileIfPresent(this.rawFile),
    ]);

    const pack = await buildContextPack({
      workspaceRoot: cwd,
      ...(this.command !== undefined ? { command: this.command } : {}),
      ...(files !== undefined ? { files } : {}),
      includeDiff: this.includeDiff,
      stagedDiff: this.stagedDiff,
      ...(errorLog !== undefined ? { errorLog } : {}),
      ...(testOutput !== undefined ? { testOutput } : {}),
      ...(jsonInput !== undefined ? { jsonInput } : {}),
      ...(rawContext !== undefined ? { rawContext } : {}),
    });

    if (this.jsonOutput) {
      this.context.stdout.write(JSON.stringify(pack, null, 2) + "\n");
    } else {
      const o = this.context.stdout;
      o.write(`Context Pack — ${pack.id}\n`);
      o.write(`  Title: ${pack.title}\n`);
      o.write(`  Files: ${pack.relevantFileDigests.length}`);
      const cached = pack.relevantFileDigests.filter((d) => d.cacheHit).length;
      if (cached > 0) o.write(` (${cached} cached)`);
      o.write(`\n`);
      o.write(`  Saved: ${pack.stats.savedTokens} tokens (${(pack.stats.savedRatio * 100).toFixed(1)}%)\n`);
      o.write(`  Provider: ${pack.provider}${pack.model ? ` (${pack.model})` : ""}\n`);
      if (pack.uncertainty.length > 0) {
        o.write(`  Uncertainty:\n`);
        for (const u of pack.uncertainty) o.write(`    - ${u}\n`);
      }
      o.write(`\n${pack.contentMd}\n`);
    }

    if (this.out) {
      const target = path.resolve(cwd, this.out);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, pack.contentMd);
      this.context.stdout.write(`\nWrote pack to: ${target}\n`);
    }
    return 0;
  }
}
