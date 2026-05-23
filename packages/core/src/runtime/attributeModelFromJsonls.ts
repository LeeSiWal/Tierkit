import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { encodeCwdForClaudeProjects } from "../usecases/listClaudeSessions.js";

const MAX_LOOKBACK_MS = 5 * 60 * 1000;

interface AssistantTurn {
  ts: number;
  model: string;
}

export interface ActivityForAttribution {
  ts: string;
  clientName: string;
  savedTokens: number;
}

export interface AttributedActivity extends ActivityForAttribution {
  model: string;
}

export interface AttributeInput {
  cwd: string;
  homeDirOverride?: string;
  activities: ActivityForAttribution[];
}

export async function attributeModelFromJsonls(
  input: AttributeInput,
): Promise<AttributedActivity[]> {
  const home = input.homeDirOverride ?? os.homedir();
  const dir = path.join(home, ".claude", "projects", encodeCwdForClaudeProjects(input.cwd));

  const turns: AssistantTurn[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return input.activities.map((a) => ({ ...a, model: "unknown" }));
    }
    throw err;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const full = path.join(dir, ent.name);
    try {
      turns.push(...(await readAssistantTurns(full)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  turns.sort((a, b) => a.ts - b.ts);

  return input.activities.map((a) => {
    if (!a.clientName.startsWith("claude")) {
      return { ...a, model: "unknown" };
    }
    const tMs = Date.parse(a.ts);
    if (!Number.isFinite(tMs)) return { ...a, model: "unknown" };
    let lo = 0, hi = turns.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (turns[mid]!.ts <= tMs) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found < 0) return { ...a, model: "unknown" };
    const turn = turns[found]!;
    if (tMs - turn.ts > MAX_LOOKBACK_MS) return { ...a, model: "unknown" };
    return { ...a, model: turn.model };
  });
}

async function readAssistantTurns(filePath: string): Promise<AssistantTurn[]> {
  const out: AssistantTurn[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let event: { type?: string; message?: { model?: unknown }; timestamp?: unknown };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "assistant") continue;
    const model = event.message?.model;
    const tsStr = event.timestamp;
    if (typeof model !== "string" || typeof tsStr !== "string") continue;
    const ts = Date.parse(tsStr);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, model });
  }
  return out;
}
