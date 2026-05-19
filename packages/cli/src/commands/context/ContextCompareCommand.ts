import path from "node:path";
import { Command, Option } from "clipanion";
import {
  compareCompressedContext,
  readArtifact,
  ContextArtifactStoreError,
} from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";
import type { RunMode } from "@tierkit/core";
import { resolveConfirm, readYesNo } from "./confirmPrompt.js";

const MODES: ReadonlySet<RunMode> = new Set(["plan", "review", "execute"]);

function fmt(n: number | undefined): string {
  return n === undefined ? "—" : n.toLocaleString();
}
function fmtCost(n: number | undefined): string {
  return n === undefined ? "unknown" : `$${n.toFixed(3)}`;
}

export class ContextCompareCommand extends Command<CliContext> {
  static override paths = [["context", "compare"]];

  static override usage = Command.Usage({
    category: "Savings",
    description: "Run baseline + compressed via the same profile and compare; mutates artifact.json",
    examples: [
      ["Compare with Claude", "tierkit context compare ctx_a3b2c1d4e5 --profile claudeSonnet --yes"],
    ],
  });

  id = Option.String({ required: true });
  profile = Option.String("--profile", { required: true });
  mode = Option.String("--mode", "execute");
  noStream = Option.Boolean("--no-stream", false);
  yes = Option.Boolean("--yes", false);
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

    const out = this.context.stdout;
    out.write(`[${this.id}] tierkit context compare → ${this.profile} (mode=${this.mode})\n\n`);
    if (artifact.compare) {
      out.write(`⚠ previous compare result will be overwritten (last ran ${artifact.compare.ranAt})\n\n`);
    }
    out.write(`About to make 2 paid model calls (estimated input cost only — output unknown):\n`);
    out.write(`  Baseline      ~${fmt(artifact.estimatedBaselineInputTokens)} input tokens\n`);
    out.write(`  Compressed    ~${fmt(artifact.estimatedCompressedInputTokens)} input tokens\n`);
    out.write(`  Token savings target:  ~${fmt(artifact.savedTokensEstimate)}\n\n`);

    const tty = Boolean((this.context.stdin as any)?.isTTY);
    const decision = resolveConfirm({ tty, yes: this.yes });
    if (decision.mode === "refuse") {
      this.context.stderr.write(`${decision.message}\n`);
      return 1;
    }
    if (decision.mode === "skip") {
      out.write(`proceeding (${decision.note})\n\n`);
    } else {
      const ok = await readYesNo(this.context.stdin, this.context.stdout);
      if (!ok) {
        out.write(`Aborted. No model calls were made.\n`);
        return 0;
      }
    }

    out.write("═══ BASELINE ═══════════════════════════════════════════════\n\n");
    const result = await compareCompressedContext(
      {
        workspaceRoot: cwd,
        id: this.id,
        profileId: this.profile,
        mode: this.mode as RunMode,
        ...(this.noStream ? {} : {
          onBaselineDelta: (t) => out.write(t),
          onCompressedDelta: (t) => out.write(t),
        }),
        onPhase: (p) => {
          if (p === "baseline-end") out.write("\n\n═══ COMPRESSED ═════════════════════════════════════════════\n\n");
        },
      },
    );

    if (!result.ok) {
      this.context.stderr.write(`\n${result.code} (phase: ${result.phase}): ${result.message}\n`);
      if (result.phase === "baseline") {
        out.write(`baseline.md was generated, but artifact.json was not updated.\n`);
      }
      return 1;
    }

    const c = result.compare;
    out.write("\n\n═══ COMPARE SUMMARY ═══════════════════════════════════════\n\n");
    out.write(`                Baseline      Compressed      Savings\n`);
    out.write(`Input (est)     ${fmt(c.baseline.estimatedInputTokens).padEnd(13)} ${fmt(c.compressed.estimatedInputTokens).padEnd(15)} ${fmt(c.savedInputTokensEstimate)}\n`);
    out.write(`Input (actual)  ${fmt(c.baseline.actualInputTokens).padEnd(13)} ${fmt(c.compressed.actualInputTokens).padEnd(15)} ${fmt(c.savedInputTokensActual)}\n`);
    out.write(`Output          ${fmt(c.baseline.actualOutputTokens).padEnd(13)} ${fmt(c.compressed.actualOutputTokens).padEnd(15)} —\n`);
    out.write(`Cost            ${fmtCost(c.baseline.actualCostUsd).padEnd(13)} ${fmtCost(c.compressed.actualCostUsd).padEnd(15)} ${fmtCost(c.savedCostUsdActual)}\n`);
    out.write(`Latency         ${fmt(c.baseline.latencyMs).padEnd(13)} ${fmt(c.compressed.latencyMs).padEnd(15)} —\n`);
    out.write(`Failures        baseline:${c.baseline.failureCode ?? "none"}  compressed:${c.compressed.failureCode ?? "none"}\n\n`);
    out.write(`Files in scope (${artifact.candidates.length}):\n`);
    for (const f of artifact.candidates) out.write(`  ${f.path}\n`);
    out.write(`\nResponses for side-by-side review:\n`);
    out.write(`  baseline:   .tierkit/runtime/context-artifacts/${this.id}/response-baseline.md\n`);
    out.write(`  compressed: .tierkit/runtime/context-artifacts/${this.id}/response-compressed.md\n`);
    out.write(`  Tip: compare these files in your editor or run \`diff\` / \`git diff --no-index\`.\n\n`);
    out.write(`Result saved to artifact:\n`);
    out.write(`  .tierkit/runtime/context-artifacts/${this.id}/artifact.json\n`);
    return 0;
  }
}
