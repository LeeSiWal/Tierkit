import path from "node:path";
import fs from "node:fs/promises";
import { runRoute, type RunRouteInput, type RunRouteResult } from "./runRoute.js";
import { readArtifact } from "../runtime/contextArtifactStore.js";
import type { RunMode } from "../context/TaskContextBuilder.js";
import type { StreamEvent } from "../model/providers/chatTypes.js";

export type RouteRunner = (input: RunRouteInput) => Promise<RunRouteResult>;

export interface SendCompressedContextInput {
  workspaceRoot: string;
  id: string;
  profileId: string;
  mode?: RunMode;
  /** When provided, the caller drives the stream; otherwise the response is fully buffered. */
  onDelta?: (text: string) => void;
}

export type SendCompressedContextResult =
  | {
      ok: true;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      latencyMs: number;
      responsePath: string;
      failureCode?: string;
    }
  | { ok: false; code: string; message: string };

export async function sendCompressedContext(
  input: SendCompressedContextInput,
  deps: { routeRunner?: RouteRunner } = {},
): Promise<SendCompressedContextResult> {
  const runner = deps.routeRunner ?? runRoute;
  const { artifact, promptMd, dir } = await readArtifact(input.workspaceRoot, input.id);

  const result = await runner({
    cwd: artifact.workspaceRoot,
    task: promptMd,
    profileId: input.profileId,
    mode: input.mode ?? "execute",
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  let buffered = "";
  let failureCode: string | undefined;
  for await (const evt of result.stream as AsyncIterable<StreamEvent>) {
    if (evt.type === "delta") {
      buffered += evt.text;
      input.onDelta?.(evt.text);
    } else if (evt.type === "error") {
      failureCode = evt.code;
    }
  }
  const done = await result.done;

  const responsePath = path.join(dir, "response-compressed.md");
  await fs.writeFile(responsePath, buffered || done.text);

  return {
    ok: true,
    inputTokens: done.inputTokens,
    outputTokens: done.outputTokens,
    costUsd: done.costUsd,
    latencyMs: done.latencyMs,
    responsePath,
    ...(failureCode ? { failureCode } : {}),
  };
}
