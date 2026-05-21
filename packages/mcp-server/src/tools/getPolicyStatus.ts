import fs from "node:fs/promises";
import path from "node:path";
import { listPatchTickets, TIERKIT_VERSION } from "@tierkit/core";
import { TOOL_NAMES } from "../server.js";

export interface GetPolicyStatusInput {
  workspaceRoot: string;
}

export type GetPolicyStatusResult =
  | {
      ok: true;
      workspaceRoot: string;
      bundledDenylist: string[];
      hasIgnoreFile: boolean;
      hasLegacyIgnoreFile: boolean;
      hasGitignore: boolean;
      respectGitignore: boolean;
      toolNames: string[];
      pendingPatches: number;
      version: string;
    }
  | { ok: false; code: string; message: string };

// Display-only list of bundled deny patterns for human reference.
// Kept in sync with ignoreSources.ts BUNDLED_DENYLIST — update both if adding patterns.
const BUNDLED_DENYLIST_DISPLAY = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.*",
  "id_dsa",
  "id_dsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_ecdsa",
  "id_ecdsa.*",
  "secrets.json",
  ".tierkit",
  ".tierkit/",
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function getPolicyStatusTool(input: GetPolicyStatusInput): Promise<GetPolicyStatusResult> {
  const root = await fs.realpath(input.workspaceRoot);
  const tickets = await listPatchTickets(root);
  const pendingPatches = tickets.filter(
    (t) => t.status === "proposed" || t.status === "awaiting_approval",
  ).length;

  return {
    ok: true,
    workspaceRoot: root,
    bundledDenylist: BUNDLED_DENYLIST_DISPLAY,
    hasIgnoreFile: await fileExists(path.join(root, ".tierkit", "ignore")),
    hasLegacyIgnoreFile: await fileExists(path.join(root, ".tierkit-ignore")),
    hasGitignore: await fileExists(path.join(root, ".gitignore")),
    respectGitignore: true, // v0.15.0 always respects .gitignore
    toolNames: [...TOOL_NAMES],
    pendingPatches,
    version: TIERKIT_VERSION,
  };
}
