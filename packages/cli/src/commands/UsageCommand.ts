import { Command, Option } from "clipanion";
import {
  aggregateByProfile,
  effectivePaymentModel,
  loadConfig,
  usage,
  type PaymentModel,
  type PerProfileBudget,
  type ProfileUsageEntry,
} from "@tierkit/core";
import type { CliContext } from "../context/CliContext.js";
import { formatUsage } from "../output/printUsage.js";

export class UsageCommand extends Command<CliContext> {
  static override paths = [["usage"]];

  static override usage = Command.Usage({
    category: "Savings",
    description: "Summarize runtime usage log (calls / tokens / cost per profile)",
    examples: [
      ["All-time totals", "tierkit usage"],
      ["Since a date", "tierkit usage --since 2026-05-01"],
      ["Per-profile breakdown with budget caps", "tierkit usage --by-profile"],
    ],
  });

  since = Option.String("--since", { description: "ISO date — only summarize records on or after this." });

  byProfile = Option.Boolean("--by-profile", false, {
    description: "Show per-profile breakdown of usage and budget caps.",
  });

  override async execute(): Promise<number> {
    const r = await usage({
      cwd: this.context.cwd,
      ...(this.since !== undefined ? { since: new Date(this.since) } : {}),
    });
    this.context.stdout.write(formatUsage(r) + "\n");

    if (this.byProfile) {
      const cfg = await loadConfig(this.context.cwd);
      const aggregate = aggregateByProfile(r.records, new Date());

      this.context.stdout.write("\nPer-profile (this month):\n");
      this.context.stdout.write(
        `  ${pad("Profile", 17)} ${pad("pm", 12)} ${pad("Monthly USD cap", 17)} ${pad("Monthly input cap", 19)} Status\n`,
      );

      const profileIds = Object.keys(cfg.config.modelProfiles);
      if (profileIds.length === 0) {
        this.context.stdout.write("  (no profiles configured)\n");
      } else {
        for (const profileId of profileIds) {
          const profile = cfg.config.modelProfiles[profileId];
          if (!profile) continue;
          const pm = effectivePaymentModel(profile);
          const cap = cfg.config.budget?.perProfile?.[profileId];
          const usdCap =
            cap?.monthlyUsdLimit !== undefined ? `$${cap.monthlyUsdLimit}/mo` : "—";
          const tokenCap =
            cap?.monthlyInputTokenLimit !== undefined
              ? `${formatNumber(cap.monthlyInputTokenLimit)}/mo`
              : "—";
          const monthEntry: ProfileUsageEntry["month"] =
            aggregate[profileId]?.month ??
            { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
          const status = computeStatusLabel(pm, monthEntry, cap);
          this.context.stdout.write(
            `  ${pad(profileId, 17)} ${pad(pm, 12)} ${pad(usdCap, 17)} ${pad(tokenCap, 19)} ${status}\n`,
          );
        }
      }
    }

    return 0;
  }
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/**
 * Compute the status label per the v0.12 spec §4 table:
 *   ratio = max(usdRatio, tokenRatio); reason = whichever is higher
 *   < 80%  → "OK (X% reason)"
 *   80-94% → "Warning (X% reason)"
 *   95-99% → "Near limit (X% reason)"
 *   ≥100%  → "Blocked (reason)"
 *   no cap → "—"
 *
 * For paymentModel='flat-rate' or 'free', USD ratio is excluded (USD not enforced).
 */
function computeStatusLabel(
  pm: PaymentModel,
  monthUsage: { inputTokens: number; costUsd: number },
  cap?: PerProfileBudget,
): string {
  if (!cap) return "—";
  const tokenRatio = cap.monthlyInputTokenLimit
    ? monthUsage.inputTokens / cap.monthlyInputTokenLimit
    : 0;
  const usdRatio =
    pm === "per-token" && cap.monthlyUsdLimit
      ? monthUsage.costUsd / cap.monthlyUsdLimit
      : 0;
  const ratio = Math.max(tokenRatio, usdRatio);
  if (ratio === 0) return "—";
  const reason = usdRatio >= tokenRatio ? "USD" : "input";
  const pct = Math.floor(ratio * 100);
  if (ratio >= 1.0)  return `Blocked (${reason})`;
  if (ratio >= 0.95) return `Near limit (${pct}% ${reason})`;
  if (ratio >= 0.80) return `Warning (${pct}% ${reason})`;
  return `OK (${pct}% ${reason})`;
}
