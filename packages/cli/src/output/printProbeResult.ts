import type { TestModelResult } from "@tierkit/core";

export function formatProbeResult(result: TestModelResult): string {
  const p = result.profile;
  const lines: string[] = [
    `Probing "${result.profileId}" (${p.kind}, provider=${p.provider}, model=${p.model})`,
  ];
  if (result.result.ok) {
    lines.push(`  status     OK`);
    lines.push(`  latency    ${result.result.latencyMs} ms`);
    if (result.result.modelCount !== undefined) {
      lines.push(`  models     ${result.result.modelCount}`);
    }
    if (result.result.modelAvailable !== undefined) {
      lines.push(`  configured model available  ${result.result.modelAvailable ? "yes" : "no"}`);
    }
    if (result.result.note) lines.push(`  note       ${result.result.note}`);
  } else {
    lines.push(`  status     FAIL (${result.result.code})`);
    lines.push(`  latency    ${result.result.latencyMs} ms`);
    if (result.result.status !== undefined) lines.push(`  http       ${result.result.status}`);
    lines.push(`  message    ${result.result.message}`);
  }
  return lines.join("\n");
}
