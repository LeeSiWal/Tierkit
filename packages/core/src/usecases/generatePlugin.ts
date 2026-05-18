import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/loadConfig.js";
import { executeLlmCall } from "../runtime/proxy/llmCall.js";
import { PluginManifestSchema, type PluginManifest } from "../plugin/PluginManifest.js";
import { TierkitError } from "../errors/TierkitError.js";
import { GENERATE_PLUGIN_EXAMPLE_JSON, type GeneratedPluginShape } from "./generatePluginExample.js";

export class PluginGenerateError extends TierkitError {
  public readonly code: string;
  public readonly rawOutput?: string;
  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = "PluginGenerateError";
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

export interface GeneratedRule {
  filename: string;
  content: string;
}

export interface GeneratePluginInput {
  description: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface GeneratePluginResult {
  draftId: string;
  draftPath: string;
  manifest: PluginManifest;
  rules: GeneratedRule[];
  modelUsed: string;
}

const FILENAME_RE = /^[0-9a-z][0-9a-z._-]*\.md$/;
const MAX_DESC_LEN = 4000;

const SYSTEM_PROMPT =
  `You are generating a Tierkit plugin. Tierkit plugins guide AI coding agents by ` +
  `injecting behavior rules into every model call.\n\n` +
  `Output ONLY valid JSON matching this exact shape, with NO markdown wrappers, NO ` +
  `commentary, NO trailing text:\n\n` +
  `{\n` +
  `  "manifest": {\n` +
  `    "schemaVersion": "0.1",\n` +
  `    "id": "kebab-case-id",\n` +
  `    "name": "Human-readable Name",\n` +
  `    "version": "0.1.0",\n` +
  `    "description": "One-line description.",\n` +
  `    "author": "Tierkit auto-generator",\n` +
  `    "license": "MIT",\n` +
  `    "compatibility": { "tierkit": "^0.3.0", "targets": ["generic"] },\n` +
  `    "components": { "commands": [], "modes": [], "rules": ["rules/01-...md"], "workflows": [], "hooks": [] },\n` +
  `    "permissions": {\n` +
  `      "readFiles": true, "editFiles": false, "runCommands": false, "registerMcp": false,\n` +
  `      "useLocalDeviceModel": true, "usePrivateRemoteModel": false, "usePublicCloudModel": false,\n` +
  `      "accessSecrets": false, "modifyAgentSettings": false, "installDependencies": false, "useNetwork": false\n` +
  `    },\n` +
  `    "freedom": { "level": "guided" }\n` +
  `  },\n` +
  `  "rules": [\n` +
  `    { "filename": "01-foo.md", "content": "# Foo\\n\\nAlways do X. Never do Y." }\n` +
  `  ]\n` +
  `}\n\n` +
  `Rules:\n` +
  `- "id" is kebab-case starting with a letter (a-z), max 40 chars.\n` +
  `- "freedom.level" is one of: "free", "guided", "balanced", "strict".\n` +
  `- 3 to 7 rule files. Filenames: "01-...md", "02-...md", numeric-prefixed for sort order.\n` +
  `- Each rule's content is markdown in present-tense imperative ("Always X. Never Y.").\n` +
  `- Rules are guidance text, NEVER shell commands or executable code.\n` +
  `- "components.rules" lists each generated rule filename WITH the "rules/" prefix.\n` +
  `- All permission fields are booleans (true/false).\n\n` +
  `Example output for "TDD-first Python plugin":\n\n` +
  GENERATE_PLUGIN_EXAMPLE_JSON +
  `\n\nReturn ONLY the JSON object. No prose, no markdown fences.`;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1]! : trimmed;
}

function parseAndValidate(raw: string): GeneratedPluginShape {
  const stripped = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new Error(`JSON parse failed: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("response is not an object");
  const shape = parsed as { manifest?: unknown; rules?: unknown };
  if (!shape.manifest || !Array.isArray(shape.rules)) {
    throw new Error("response missing manifest or rules");
  }
  const manifest = PluginManifestSchema.parse(shape.manifest);
  const rules: GeneratedRule[] = [];
  for (const r of shape.rules) {
    if (typeof r !== "object" || r === null) throw new Error("rule entry not an object");
    const entry = r as { filename?: unknown; content?: unknown };
    if (typeof entry.filename !== "string" || typeof entry.content !== "string") {
      throw new Error("rule entry must have string filename + content");
    }
    if (!FILENAME_RE.test(entry.filename)) {
      throw new Error(`invalid rule filename: ${entry.filename}`);
    }
    rules.push({ filename: entry.filename, content: entry.content });
  }
  manifest.components.rules = rules.map((r) => `rules/${r.filename}`);
  return { manifest, rules };
}

async function writeDraft(
  dataDir: string,
  draftId: string,
  shape: GeneratedPluginShape,
): Promise<string> {
  const draftRoot = path.join(dataDir, "plugin-drafts", draftId);
  await fs.mkdir(path.join(draftRoot, "rules"), { recursive: true });
  await fs.writeFile(
    path.join(draftRoot, "tierkit.plugin.json"),
    JSON.stringify(shape.manifest, null, 2),
  );
  for (const rule of shape.rules) {
    await fs.writeFile(path.join(draftRoot, "rules", rule.filename), rule.content);
  }
  return draftRoot;
}

export async function generatePlugin(input: GeneratePluginInput): Promise<GeneratePluginResult> {
  if (input.description.length === 0) {
    throw new PluginGenerateError("invalid-description", "description must be non-empty");
  }
  if (input.description.length > MAX_DESC_LEN) {
    throw new PluginGenerateError(
      "description-too-long",
      `description must be at most ${MAX_DESC_LEN} chars (got ${input.description.length})`,
    );
  }

  const cfg = await loadConfig(input.cwd);
  const dataDir = path.join(input.cwd, cfg.config.runtime.dataDir);

  let lastRaw = "";
  let lastError = "";
  let modelUsed = "";
  let shape: GeneratedPluginShape | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: input.description },
    ];
    if (attempt > 0) {
      messages.push({
        role: "user",
        content:
          `Your previous response was rejected:\n\n${lastError}\n\n` +
          `Your previous output was:\n\n${lastRaw}\n\n` +
          `Please return a corrected JSON object. Output ONLY the JSON, no markdown fences, no commentary.`,
      });
    }
    const result = await executeLlmCall(
      { profileId: "auto", messages },
      { cwd: input.cwd, env: input.env },
    );
    if (!result.ok) {
      throw new PluginGenerateError("llm-call-failed", `${result.code}: ${result.message}`);
    }
    lastRaw = result.text;
    modelUsed = result.profileId;
    try {
      shape = parseAndValidate(result.text);
      break;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  if (!shape) {
    throw new PluginGenerateError("validation-failed", lastError, lastRaw);
  }

  const draftId = randomUUID();
  const draftPath = await writeDraft(dataDir, draftId, shape);

  return {
    draftId,
    draftPath,
    manifest: shape.manifest,
    rules: shape.rules,
    modelUsed,
  };
}
