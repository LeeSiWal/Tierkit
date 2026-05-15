/**
 * `connectTool` writes the configuration needed to make an external coding agent route its
 * model calls through Tierkit's OpenAI-compatible endpoint.
 *
 * Supported targets:
 *   - **roo** / **cline**: VS Code extensions configured via workspace `.vscode/settings.json`.
 *     We add an OpenAI-compatible provider entry pointing at Tierkit. The user picks one
 *     of their Tierkit profile ids as the "model" inside that tool's UI; alternatively
 *     they can set it to `auto` and Tierkit will route per-task.
 *   - **continue**: agent that reads `.continue/config.yaml`. We append a model entry that
 *     uses the OpenAI provider with `apiBase` pointing at Tierkit.
 *
 * `tierkit.config.json` is the source of truth for profile ids; the connect step only
 * tells each tool *where* to send model calls. After connecting, `tierkit plugin sync`
 * keeps the per-tool rule/prompt files in sync with the active Tierkit plugins.
 *
 * Safety:
 *   - Existing settings files are read, mutated, then written back. JSON-with-comments
 *     in .vscode/settings.json is parsed permissively (line and block comments are
 *     stripped before JSON.parse, then we write back as plain JSON — VS Code re-accepts
 *     plain JSON so the file remains valid; we lose comments, which is the trade-off).
 *   - YAML edits use a minimal append strategy: if models: exists we add a single
 *     "- name: tierkit ..." entry; if not, we append a new models: section. We do not
 *     reformat or rewrite the user's other YAML.
 */
import fs from "node:fs/promises";
import path from "node:path";

export type ConnectableTool = "roo" | "cline" | "continue";

export interface ConnectToolInput {
  cwd: string;
  tool: ConnectableTool;
  /** Tierkit base URL the tool should hit. Defaults to http://127.0.0.1:4101 (the loopback daemon). */
  tierkitBaseUrl?: string;
  /** Profile id (e.g., "claudeSonnet") or "auto" — the value the tool will pass as `model`. */
  defaultProfile?: string;
}

export interface ConnectToolResult {
  tool: ConnectableTool;
  /** File that was created or updated. */
  configPath: string;
  /** Human-readable summary of what was written, for CLI/UI display. */
  summary: string;
  /** Manual follow-up the user must do in the tool's UI, if any. */
  followUp?: string;
}

const DEFAULT_BASE = "http://127.0.0.1:4101";

/** Strip line and block comments. VS Code's settings.json is JSON-with-comments. */
function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])\/\/.*$/gm, (_m, p1) => p1 ?? "");
}

async function readJsonMaybeWithComments(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * Inspect filesystem signals to report each tool's connection status:
 *   - `present`: the tool's own marker dir/file exists in the workspace (`.roomodes`,
 *     `.clinerules/`, `.continue/`). Doesn't imply Tierkit routing — just that the tool
 *     is set up here.
 *   - `routed`: the relevant config file points at our daemon's `/v1/openai` endpoint.
 *
 * Used by the sidebar Mission Control to render a "Connected tools" panel that shows
 * which tools we're proxying for vs which the user might want to connect.
 */
export interface ConnectionStatus {
  tool: ConnectableTool;
  /** Filesystem signal that this tool is set up in the workspace. */
  present: boolean;
  /** Whether the tool's config file points at the Tierkit daemon (vs. some other endpoint). */
  routed: boolean;
  /** Path to the config file we inspected (whether it exists or not — for hint display). */
  configPath: string;
  /** The model id the tool will pass as `model` in its OpenAI-compatible request. */
  modelId?: string;
}

export async function listConnections(cwd: string, tierkitBaseUrl: string = DEFAULT_BASE): Promise<ConnectionStatus[]> {
  return Promise.all([
    statusForRoo(cwd, tierkitBaseUrl),
    statusForCline(cwd, tierkitBaseUrl),
    statusForContinue(cwd, tierkitBaseUrl),
  ]);
}

async function statusForVsCodeKey(
  cwd: string,
  tierkitBaseUrl: string,
  tool: ConnectableTool,
  presentSignal: () => Promise<boolean>,
  baseUrlKey: string,
  modelIdKey: string,
): Promise<ConnectionStatus> {
  const settingsPath = `${cwd}/.vscode/settings.json`;
  const present = await presentSignal();
  let routed = false;
  let modelId: string | undefined;
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
    const baseUrl = parsed[baseUrlKey];
    if (typeof baseUrl === "string" && baseUrl.replace(/\/$/, "").startsWith(tierkitBaseUrl.replace(/\/$/, ""))) {
      routed = true;
    }
    const mid = parsed[modelIdKey];
    if (typeof mid === "string") modelId = mid;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { tool, present, routed, configPath: settingsPath, ...(modelId ? { modelId } : {}) };
}

async function statusForRoo(cwd: string, tierkitBaseUrl: string): Promise<ConnectionStatus> {
  return statusForVsCodeKey(
    cwd,
    tierkitBaseUrl,
    "roo",
    async () => {
      try {
        await fs.access(`${cwd}/.roomodes`);
        return true;
      } catch {
        try {
          await fs.access(`${cwd}/.roo`);
          return true;
        } catch {
          return false;
        }
      }
    },
    "roo-cline.openAiBaseUrl",
    "roo-cline.openAiModelId",
  );
}

async function statusForCline(cwd: string, tierkitBaseUrl: string): Promise<ConnectionStatus> {
  return statusForVsCodeKey(
    cwd,
    tierkitBaseUrl,
    "cline",
    async () => {
      try {
        await fs.access(`${cwd}/.clinerules`);
        return true;
      } catch {
        return false;
      }
    },
    "cline.openAiBaseUrl",
    "cline.openAiModelId",
  );
}

async function statusForContinue(cwd: string, tierkitBaseUrl: string): Promise<ConnectionStatus> {
  const configPath = `${cwd}/.continue/config.yaml`;
  let present = false;
  try {
    await fs.access(`${cwd}/.continue`);
    present = true;
  } catch {
    /* not present */
  }
  let routed = false;
  let modelId: string | undefined;
  try {
    const yaml = await fs.readFile(configPath, "utf8");
    if (yaml.includes("tierkit-routed-model") && yaml.includes(tierkitBaseUrl.replace(/\/$/, "") + "/v1/openai")) {
      routed = true;
      // Tiny YAML scrape: find `model:` line right after the tierkit marker.
      const idx = yaml.indexOf("tierkit-routed-model");
      const slice = yaml.slice(idx, idx + 400);
      const m = slice.match(/\n\s*model:\s*([^\s\n]+)/);
      if (m && m[1]) modelId = m[1];
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { tool: "continue", present, routed, configPath, ...(modelId ? { modelId } : {}) };
}

export async function connectTool(input: ConnectToolInput): Promise<ConnectToolResult> {
  const base = (input.tierkitBaseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const defaultProfile = input.defaultProfile ?? "auto";

  if (input.tool === "roo") return connectRoo(input.cwd, base, defaultProfile);
  if (input.tool === "cline") return connectCline(input.cwd, base, defaultProfile);
  if (input.tool === "continue") return connectContinue(input.cwd, base, defaultProfile);
  throw new Error(`unknown tool: ${(input as { tool: string }).tool}`);
}

/**
 * Roo Code reads its provider config from VS Code settings. It supports an "openai" /
 * "openai-compatible" provider where you specify `apiKey` and `baseUrl`. We write a
 * workspace-scoped config so it doesn't affect the user's other projects.
 */
async function connectRoo(cwd: string, base: string, defaultProfile: string): Promise<ConnectToolResult> {
  const settingsPath = path.join(cwd, ".vscode", "settings.json");
  const settings = await readJsonMaybeWithComments(settingsPath);

  // Roo Code (v3.x) reads these keys. They mirror the OpenAI-compatible provider preset.
  settings["roo-cline.apiProvider"] = "openai";
  settings["roo-cline.openAiBaseUrl"] = `${base}/v1/openai`;
  settings["roo-cline.openAiApiKey"] = "tierkit-loopback"; // any non-empty string; daemon ignores it
  settings["roo-cline.openAiModelId"] = defaultProfile;

  await writeJson(settingsPath, settings);
  return {
    tool: "roo",
    configPath: settingsPath,
    summary:
      `Roo Code routed through Tierkit (${base}/v1/openai). ` +
      `Default model id: ${defaultProfile}.`,
    followUp:
      "Reload VS Code (Cmd/Ctrl+Shift+P → Reload Window) so Roo picks up the new settings. " +
      "In Roo's chat input you can change the model id to any Tierkit profile (see /models in the Tierkit sidebar).",
  };
}

/**
 * Cline (v3+) reads provider config from VS Code settings as well. The relevant keys are
 * the openAi-compatible provider preset.
 */
async function connectCline(cwd: string, base: string, defaultProfile: string): Promise<ConnectToolResult> {
  const settingsPath = path.join(cwd, ".vscode", "settings.json");
  const settings = await readJsonMaybeWithComments(settingsPath);

  settings["cline.apiProvider"] = "openai";
  settings["cline.openAiBaseUrl"] = `${base}/v1/openai`;
  settings["cline.openAiApiKey"] = "tierkit-loopback";
  settings["cline.openAiModelId"] = defaultProfile;

  await writeJson(settingsPath, settings);
  return {
    tool: "cline",
    configPath: settingsPath,
    summary:
      `Cline routed through Tierkit (${base}/v1/openai). ` +
      `Default model id: ${defaultProfile}.`,
    followUp:
      "Reload VS Code so Cline picks up the new settings. " +
      "You can override the model id per-task from Cline's model picker.",
  };
}

/**
 * Continue reads `.continue/config.yaml`. We append a single model entry pointing at
 * Tierkit if one isn't already present.
 */
async function connectContinue(cwd: string, base: string, defaultProfile: string): Promise<ConnectToolResult> {
  const configPath = path.join(cwd, ".continue", "config.yaml");
  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const tierkitMarker = "# tierkit-routed-model";
  if (existing.includes(tierkitMarker)) {
    return {
      tool: "continue",
      configPath,
      summary: `Continue already has a Tierkit-routed model entry in ${configPath}.`,
    };
  }

  const block = [
    "",
    tierkitMarker,
    "- name: Tierkit (auto-route)",
    `  provider: openai`,
    `  model: ${defaultProfile}`,
    `  apiBase: ${base}/v1/openai`,
    "  apiKey: tierkit-loopback",
    "  roles:",
    "    - chat",
    "    - edit",
    "    - apply",
    "",
  ].join("\n");

  let next: string;
  if (existing.includes("\nmodels:\n") || existing.startsWith("models:\n")) {
    // Append entries under the existing models: list. We don't try to format-parse YAML;
    // we just insert the block immediately after the `models:` line.
    next = existing.replace(/(^models:\n)/m, `$1${block.replace(/\n$/, "\n")}`);
  } else {
    next = (existing.length > 0 && !existing.endsWith("\n") ? existing + "\n" : existing) + "models:\n" + block;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, next, "utf8");

  return {
    tool: "continue",
    configPath,
    summary: `Continue routed through Tierkit (${base}/v1/openai). Added "Tierkit (auto-route)" model entry.`,
    followUp:
      "Open Continue's model picker — the new 'Tierkit (auto-route)' entry should appear. " +
      "Set it as default if you want all Continue calls to go through Tierkit.",
  };
}
