/**
 * Scaffold a new Tierkit plugin directory: manifest + one sample command + one sample
 * mode + one sample rule. The result is immediately loadable via `PluginLoader` and
 * exportable to any of the target tools.
 *
 * Directory layout produced:
 *   <id>/
 *     tierkit.plugin.json     ← manifest
 *     commands/<command>.md   ← one sample command (Markdown body becomes the prompt)
 *     modes/<mode>.md         ← one sample mode (role definition)
 *     rules/baseline.md       ← one sample rule (always-on system prompt fragment)
 *
 * Defaults chosen for "minimal but realistic": read-only permissions, local-device tier,
 * `free` freedom. The user edits the manifest to broaden permissions or tighten freedom.
 *
 * The CLI calls this with `cwd: process.cwd()` and the user passes `--id` plus an
 * optional `--targetDir`. The daemon endpoint calls it with `cwd: opts.cwd` so plugins
 * scaffold into the workspace.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface PluginNewInput {
  /** Directory containing the new plugin folder. Defaults to current working directory. */
  cwd: string;
  /** Plugin id (kebab-case recommended). Also the folder name. */
  id: string;
  /** Human-readable name. Defaults to a Title-Cased version of id. */
  name?: string;
  /** One-line description. Defaults to a generated placeholder. */
  description?: string;
  /** Author string. Defaults to "you". */
  author?: string;
  /** Refuse to write if the folder exists; set to true to overwrite. */
  force?: boolean;
  /** Initial freedom level. Defaults to `"free"`. */
  freedomLevel?: "free" | "guided" | "balanced" | "strict";
  /** Override the first command name (default `"review"`). Kebab-case. */
  firstCommand?: string;
}

export interface PluginNewResult {
  pluginDir: string;
  created: string[];
  skipped: string[];
}

const PLUGIN_ID_RE = /^[a-z][a-z0-9_-]*$/;

export class PluginNewError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "PluginNewError";
  }
}

function titleize(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function pluginNew(input: PluginNewInput): Promise<PluginNewResult> {
  if (!PLUGIN_ID_RE.test(input.id)) {
    throw new PluginNewError("invalid-id", `plugin id must match ${PLUGIN_ID_RE} (got "${input.id}")`);
  }
  const force = input.force ?? false;
  const name = input.name ?? titleize(input.id);
  const description =
    input.description ??
    `Custom Tierkit plugin "${name}". Edit tierkit.plugin.json to customize commands, modes, rules, permissions.`;
  const author = input.author ?? "you";
  const freedomLevel = input.freedomLevel ?? "free";
  const firstCommand = input.firstCommand ?? "review";
  if (!PLUGIN_ID_RE.test(firstCommand)) {
    throw new PluginNewError("invalid-command-name", `firstCommand must match ${PLUGIN_ID_RE} (got "${firstCommand}")`);
  }

  const pluginDir = path.join(input.cwd, input.id);
  const exists = await fs.access(pluginDir).then(() => true, () => false);
  if (exists && !force) {
    throw new PluginNewError("exists", `directory "${pluginDir}" already exists (use force to overwrite)`);
  }

  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(path.join(pluginDir, "commands"), { recursive: true });
  await fs.mkdir(path.join(pluginDir, "modes"), { recursive: true });
  await fs.mkdir(path.join(pluginDir, "rules"), { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  async function writeFile(relPath: string, content: string): Promise<void> {
    const fullPath = path.join(pluginDir, relPath);
    if ((await fs.access(fullPath).then(() => true, () => false)) && !force) {
      skipped.push(relPath);
      return;
    }
    await fs.writeFile(fullPath, content, "utf8");
    created.push(relPath);
  }

  const manifest = {
    schemaVersion: "0.1",
    id: input.id,
    name,
    version: "0.1.0",
    description,
    author,
    license: "MIT",
    compatibility: {
      tierkit: ">=0.1.0",
      targets: ["generic", "roo", "zoo", "cline", "continue"],
    },
    components: {
      commands: [
        {
          name: firstCommand,
          file: `commands/${firstCommand}.md`,
          description:
            firstCommand === "review"
              ? "Review the current diff or selected files for issues"
              : `${titleize(firstCommand)} — describe what this command does in commands/${firstCommand}.md`,
          category: firstCommand === "review" ? "review" : "misc",
        },
      ],
      modes: [
        {
          id: "default",
          name: "Default",
          file: "modes/default.md",
          tools: ["read", "search"],
          role: "default",
        },
      ],
      rules: ["rules/baseline.md"],
    },
    permissions: {
      readFiles: true,
      editFiles: false,
      runCommands: false,
      registerMcp: false,
      useLocalDeviceModel: true,
      usePrivateRemoteModel: false,
      usePublicCloudModel: false,
      accessSecrets: false,
    },
    modelPolicy: {
      defaultTier: "localCoder",
      preferPrivateRemoteBeforePublicCloud: true,
      publicCloudRequiresApproval: true,
      publicCloudDefaultMode: "review-only",
    },
    freedom: {
      level: freedomLevel,
    },
  };
  await writeFile("tierkit.plugin.json", JSON.stringify(manifest, null, 2) + "\n");

  // Write the first command file. If the user kept the default "review" we ship a
  // realistic prompt; otherwise we ship a starter template they fill in.
  const commandBody =
    firstCommand === "review"
      ? [
          "# Review",
          "",
          "Review the current diff or the file(s) the user mentions.",
          "",
          "When invoked:",
          "1. Identify what code is in scope (uncommitted changes by default).",
          "2. For each non-trivial change, ask:",
          "   - Is the public API stable? Backwards compatible?",
          "   - Are error paths handled?",
          "   - Are there security or privacy implications?",
          "3. Cite specific lines with file:line references.",
          "4. End with: a short summary of severity (Critical / Major / Minor) and a recommended next action.",
          "",
        ].join("\n")
      : [
          `# ${titleize(firstCommand)}`,
          "",
          `Describe what \`/${firstCommand}\` does, what context it needs, and what output it produces.`,
          "",
          "When invoked:",
          "1. (Step 1 — replace with your instructions.)",
          "2. (Step 2 …)",
          "",
        ].join("\n");
  await writeFile(`commands/${firstCommand}.md`, commandBody);

  await writeFile(
    "modes/default.md",
    [
      `# Default mode for ${name}`,
      "",
      "Role: helpful assistant focused on the active workspace.",
      "",
      "Allowed tools: read, search.",
      "",
      "Guidance:",
      "- Read relevant files before answering.",
      "- Cite file:line for any claims about existing code.",
      "- Defer destructive actions (edits, shell commands) to the user.",
      "",
    ].join("\n"),
  );

  await writeFile(
    "rules/baseline.md",
    [
      `# Baseline rule for ${name}`,
      "",
      "- Prefer terse, accurate answers over verbose explanations.",
      "- When uncertain, ask one clarifying question instead of guessing.",
      "- Never expose secrets or credentials. Never propose `rm -rf`, `chmod 777`, or similarly destructive commands without explicit approval.",
      "",
    ].join("\n"),
  );

  return { pluginDir, created, skipped };
}
