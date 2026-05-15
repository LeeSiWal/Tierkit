import type { ExplainRouteUsecaseResult } from "@tierkit/core";

export function formatRouteDecision(r: ExplainRouteUsecaseResult): string {
  const lines: string[] = [`Task: "${r.task}"`, ""];
  lines.push(`Risk score:  ${r.decision.score} / 100`);
  lines.push(
    `Thresholds:  localStrongMax=${r.thresholds.localStrongMax}  privateRemoteMax=${r.thresholds.privateRemoteMax}  publicCloudReviewMin=${r.thresholds.publicCloudReviewMin}`,
  );
  lines.push("");
  lines.push(`Chosen tier:   ${r.decision.tier}`);
  if (r.decision.profileId) {
    lines.push(`Chosen profile: ${r.decision.profileId}${r.profile ? ` (provider=${r.profile.provider}, model=${r.profile.model})` : ""}`);
  } else {
    lines.push(`Chosen profile: (none configured for tier "${r.decision.tier}")`);
  }
  lines.push(`Approval:      ${r.decision.requiresApproval ? "REQUIRED" : "not required"}`);
  lines.push(`Mode:          ${r.decision.mode}`);
  lines.push("");

  if (r.decision.reasons.length > 0) {
    lines.push("Reasons:");
    for (const reason of r.decision.reasons) lines.push(`  - ${reason}`);
  } else {
    lines.push("Reasons: (baseline risk only)");
  }

  if (r.candidates.length > 1) {
    lines.push("");
    lines.push(`Other candidates for tier "${r.decision.tier}":`);
    for (const c of r.candidates) {
      if (c.id === r.decision.profileId) continue;
      lines.push(`  - ${c.id} (provider=${c.profile.provider}, model=${c.profile.model})`);
    }
  }

  if (r.decision.tier === "public-cloud") {
    lines.push("");
    lines.push("⚠️  public-cloud tier: output is review-only by default. Redact secrets, production URLs, and customer data before sending.");
  }

  return lines.join("\n");
}
