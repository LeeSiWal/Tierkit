import { Command } from "clipanion";
import { doctor } from "@tierkit/core";
import type { CliContext } from "../context/CliContext.js";

/**
 * v0.12 — per-profile budget block (`per-profile-budget-blocked`) emits with
 * status="fail" so it renders with the FAIL icon and is surfaced clearly. But
 * a budget block is *policy state* (user's monthly cap hit), not a system
 * failure (broken config, missing daemon, etc.) — so we must NOT exit 1 just
 * because a budget is exhausted. Otherwise `tierkit doctor` would falsely
 * fail CI / pre-commit hooks once a quota is reached.
 *
 * Real failures (config errors, plugin paths missing, etc.) keep exit 1.
 */
const BUDGET_BLOCKER_IDS = new Set<string>([
  "per-profile-budget-blocked",
  // Future: any other budget-policy "blocker" that should stay exit 0
]);

export class DoctorCommand extends Command<CliContext> {
  static override paths = [["doctor"]];

  static override usage = Command.Usage({
    category: "Diagnostics",
    description: "Diagnose the current Tierkit project",
    examples: [["Run diagnostics", "tierkit doctor"]],
  });

  override async execute(): Promise<number> {
    const result = await doctor({ cwd: this.context.cwd });
    this.context.stdout.write(`Tierkit doctor — ${result.projectRoot}\n`);
    for (const c of result.checks) {
      const tag = c.status === "ok" ? "OK  " : c.status === "warn" ? "WARN" : "FAIL";
      const detail = c.detail ? ` — ${c.detail}` : "";
      this.context.stdout.write(`  [${tag}] ${c.label}${detail}\n`);
    }
    this.context.stdout.write(`\nOverall: ${result.status.toUpperCase()}\n`);
    const hasNonBudgetFailure = result.checks.some(
      (c) => c.status === "fail" && !BUDGET_BLOCKER_IDS.has(c.id),
    );
    return hasNonBudgetFailure ? 1 : 0;
  }
}
