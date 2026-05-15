import { Command, Option } from "clipanion";
import { runRoute, type RunMode } from "@tierkit/core";
import type { CliContext } from "../../context/CliContext.js";

const MODES: ReadonlySet<RunMode> = new Set(["plan", "review", "execute"]);

export class RouteRunCommand extends Command<CliContext> {
  static override paths = [["route", "run"]];

  static override usage = Command.Usage({
    category: "Routing",
    description: "Route a task through Tierkit and stream the model response",
    examples: [
      ['Auto-routed (default streaming)', 'tierkit route run "summarize this project"'],
      ['Force a profile', 'tierkit route run "review the auth diff" --profile privateRemoteStrong'],
      ['Plan mode + local-only', 'tierkit route run "rewrite auth middleware" --mode plan --local-only'],
      ['Non-streaming', 'tierkit route run "say OK" --no-stream'],
    ],
  });

  task = Option.String({ required: true });
  profile = Option.String("--profile", { description: "Force a specific model profile id." });
  mode = Option.String("--mode", "execute", {
    description: "Run mode: plan | review | execute. Affects the system prompt.",
  });
  noStream = Option.Boolean("--no-stream", false, {
    description: "Print the full response after the model finishes instead of streaming deltas.",
  });
  localOnly = Option.Boolean("--local-only", false, {
    description: "Refuse any tier above local-device — even if the router would have escalated.",
  });
  privateOnly = Option.Boolean("--private", false, {
    description: "Allow private-remote but never public-cloud (downgrade if needed).",
  });
  files = Option.String("--files", { description: "Estimated number of files touched (feeds risk scoring)." });
  secrets = Option.Boolean("--secrets", false, { description: "Mark task as touching secrets." });
  prod = Option.Boolean("--prod", false, { description: "Mark task as touching production infrastructure." });

  override async execute(): Promise<number> {
    if (!MODES.has(this.mode as RunMode)) {
      this.context.stderr.write(`invalid --mode "${this.mode}". Allowed: plan, review, execute.\n`);
      return 1;
    }
    const tierConstraint: "local-only" | "private" | "none" = this.localOnly
      ? "local-only"
      : this.privateOnly
        ? "private"
        : "none";

    const result = await runRoute({
      cwd: this.context.cwd,
      task: this.task,
      mode: this.mode as RunMode,
      ...(this.profile !== undefined ? { profileId: this.profile } : {}),
      ...(tierConstraint !== "none" ? { tierConstraint } : {}),
      ...(this.files !== undefined ? { filesTouchedEstimate: Number.parseInt(this.files, 10) } : {}),
      involvesSecrets: this.secrets,
      involvesProductionInfra: this.prod,
    });

    if (!result.ok) {
      this.context.stderr.write(`${result.code}: ${result.message}\n`);
      return 1;
    }

    const ctx = result.context;
    // Header — always emit so the user sees what was selected.
    this.context.stdout.write(
      `[${ctx.decision.tier}] ${ctx.profileId} (${ctx.profile.provider}/${ctx.profile.model}, mode=${this.mode})\n`,
    );
    if (ctx.decision.requiresApproval) {
      this.context.stdout.write(`⚠️  approval required — output is ${ctx.decision.mode}\n`);
    }
    if (ctx.redactionHits.length > 0) {
      const total = ctx.redactionHits.reduce((s, h) => s + h.count, 0);
      this.context.stdout.write(
        `🔒 redacted ${total} secret(s) before remote send (${ctx.redactionHits.map((h) => `${h.ruleId}×${h.count}`).join(", ")})\n`,
      );
    }
    if (ctx.budgetStatus === "warn") {
      this.context.stdout.write(`⚠️  budget warning: ${ctx.budgetReason ?? "(no reason)"}\n`);
    }
    this.context.stdout.write("\n");

    // Drive the stream.
    let buffered = "";
    let errored = false;
    for await (const evt of result.stream) {
      switch (evt.type) {
        case "start":
          // header already printed
          break;
        case "delta":
          if (this.noStream) buffered += evt.text;
          else this.context.stdout.write(evt.text);
          break;
        case "usage":
          // surfaced via `done` summary below
          break;
        case "end":
          break;
        case "error":
          errored = true;
          this.context.stderr.write(`\n${evt.code}: ${evt.message}\n`);
          break;
      }
    }
    if (this.noStream && buffered.length > 0) this.context.stdout.write(buffered);
    this.context.stdout.write("\n");

    const done = await result.done;
    this.context.stdout.write(
      `\n— ${done.inputTokens} in / ${done.outputTokens} out · ${done.latencyMs}ms · $${done.costUsd.toFixed(6)}\n`,
    );
    return errored ? 1 : 0;
  }
}
