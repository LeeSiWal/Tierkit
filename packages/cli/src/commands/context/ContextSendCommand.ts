import path from "node:path";
import { Command, Option } from "clipanion";
import { sendCompressedContext, readArtifact, ContextArtifactStoreError } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import type { RunMode } from "@tierkit/core";

const MODES: ReadonlySet<RunMode> = new Set(["plan", "review", "execute"]);

export class ContextSendCommand extends Command<CliContext> {
  static override paths = [["context", "send"]];

  static override usage = Command.Usage({
    category: "Context",
    description: "Send a context artifact's prompt.md to a model via the existing runRoute pipeline",
    examples: [
      ["Send to Claude", "tierkit context send ctx_a3b2c1d4e5 --profile claudeSonnet"],
    ],
  });

  id = Option.String({ required: true });
  profile = Option.String("--profile", { required: true });
  mode = Option.String("--mode", "execute");
  noStream = Option.Boolean("--no-stream", false);
  cwdFlag = Option.String("--cwd");

  override async execute(): Promise<number> {
    const cwd = this.cwdFlag ? path.resolve(this.cwdFlag) : this.context.cwd;
    if (!MODES.has(this.mode as RunMode)) {
      this.context.stderr.write(`invalid --mode "${this.mode}"\n`);
      return 1;
    }

    let artifact;
    try {
      ({ artifact } = await readArtifact(cwd, this.id));
    } catch (err) {
      if (err instanceof ContextArtifactStoreError) {
        this.context.stderr.write(`${err.code}: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    if (cwd !== artifact.workspaceRoot) {
      this.context.stdout.write(
        `Warning: artifact was built for ${artifact.workspaceRoot} but current cwd is ${cwd}\n`,
      );
    }
    this.context.stdout.write(
      `[${this.id} → ${this.profile}] mode=${this.mode}\n` +
      `[input: prompt.md, ${artifact.estimatedCompressedInputTokens} tokens est]\n\n`,
    );

    const result = await sendCompressedContext(
      { workspaceRoot: cwd, id: this.id, profileId: this.profile, mode: this.mode as RunMode,
        ...(this.noStream ? {} : { onDelta: (t) => this.context.stdout.write(t) }) },
    );
    if (!result.ok) {
      this.context.stderr.write(`${result.code}: ${result.message}\n`);
      return 1;
    }
    if (this.noStream) {
      const fs = await import("node:fs/promises");
      const text = await fs.readFile(result.responsePath, "utf8");
      this.context.stdout.write(text);
    }
    this.context.stdout.write(
      `\n— ${result.inputTokens} in / ${result.outputTokens} out · ${result.latencyMs}ms · $${result.costUsd.toFixed(6)}\n` +
      `  saved to: ${path.relative(cwd, result.responsePath)}\n`,
    );
    if (result.failureCode) {
      this.context.stdout.write(`  (stream failure: ${result.failureCode})\n`);
    }
    return 0;
  }
}
