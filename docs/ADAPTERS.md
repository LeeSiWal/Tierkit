# Tierkit — Adapters

> Status: v0.1 stub. `GenericMarkdownAdapter` ships; Roo/Zoo, Cline, Continue adapters land in v0.2–v0.4.

An adapter translates a Tierkit plugin into a target tool's native configuration.

## Interface

From `@tierkit/core`:

```ts
interface TierkitAdapter {
  readonly target: Target;
  readonly name: string;
  readonly description: string;
  export(input: AdapterExportInput): Promise<ExportResult>;
}

interface AdapterExportInput {
  plugins: LoadedPlugin[];
  outDir: string;
}

interface ExportResult {
  target: string;
  files: ExportFile[];
  warnings: ExportWarning[];
}
```

Adapters are pure: they return the list of files to write, never write them directly. The `exportTarget` usecase is the only code path that touches disk, and it resolves every output path under the adapter's `outDir` via `resolveUnder` — so a malicious adapter cannot escape the output directory.

## What the Roo adapter produces (v0.2)

For an output directory of `<outDir>` (defaults to the project root, which is where Roo expects `.roomodes`):

```
<outDir>/.roomodes                                  # Roo custom modes — one entry per Tierkit mode
<outDir>/.roo/TIERKIT.md                         # Export README (what is what, how to re-export)
<outDir>/.roo/commands/<pluginId>-<command>.md      # Slash command bodies with YAML frontmatter
<outDir>/.roo/rules/<pluginId>/<rule>.md            # Auto-loaded Roo rules
<outDir>/.roo/mcp/<pluginId>.json                   # MCP server config (NEVER auto-registered)
```

### Mode translation rules

- **Slug** is always `<pluginId>-<modeId>` to prevent collisions when multiple plugins are exported together.
- **roleDefinition** is the first paragraph of the mode markdown after the H1 title.
- **customInstructions** is the rest of the body.
- **groups** are derived from the mode's `tools[]`:
  - `read`, `search`, `grep`, `list` → `read`
  - `edit`, `write`, `patch`, `apply_diff` → `edit`
  - `command`, `run`, `terminal`, `shell`, `exec` → `command`
  - `browser`, `browse` → `browser`
  - `mcp` → `mcp`
- **Permission gates** drop groups the plugin doesn't have permission for:
  - `edit` requires `editFiles`
  - `command` requires `runCommands`
  - `mcp` requires `registerMcp`
  - `browser` requires `useNetwork`
  - Each dropped group is reported as an export warning.

## What the Cline adapter produces (v0.3)

Cline does not have first-class custom modes or registered slash commands the way Roo does, so the adapter renders **everything as `.clinerules/` markdown files**. Cline auto-loads them alphabetically — the numeric prefix establishes load order:

```
<outDir>/.clinerules/
  TIERKIT.md                              # generated overview + older-Cline single-file guidance
  00-<pluginId>-permission.md                # permission contract (loads first)
  10-<pluginId>-rule-<basename>.md           # original plugin rules
  20-<pluginId>-mode-<id>.md                 # modes translated to persona rules
  30-<pluginId>-command-<name>.md            # commands translated to slash-command-style rules
<outDir>/.cline/TIERKIT.md                # MCP staging README
<outDir>/.cline/mcp/<pluginId>.json          # MCP config — NOT auto-registered
```

### Permission contract

Cline has no `groups` mechanism, so Tierkit permissions become natural-language rules. For each permission flag, the contract emits either a "**You MAY** …" or "**You MUST NOT** …" line. Examples:

| Permission | Granted → MAY | Not granted → MUST NOT |
|---|---|---|
| `runCommands`        | "Run shell commands — always surface what will run and pause for approval first." | "Run shell commands of any kind." |
| `usePublicCloudModel`| "Use a public-cloud model — only in review-only mode and only after the user explicitly approves." | "Use public-cloud models." |
| `registerMcp`        | "Suggest registering an MCP server — but never silently auto-register." | "Register MCP servers." |
| `accessSecrets`      | "Read secrets only when the task demonstrably needs them." | "Access secrets, credentials, environment variables holding tokens, or `.env`-style files." |

The contract always includes an Escalation section reminding the agent that public-cloud output is review-only and remote-tier context must be redacted.

### Modes-as-personas

Cline has no first-class custom modes. A mode is rendered as a markdown file with the heading `# Persona: <Mode Name>` and a note explaining that the agent should adopt that stance when the user requests it. The mode's declared `tools[]` are listed as **intentions** — the permission contract still wins.

### Commands-as-rules

Cline has no slash-command registry. A command is rendered as a markdown file with the heading `# Command: /<name>` and a note explaining that when the user types `/<name>` or asks for that command's behavior, the agent should follow the body below.

### Older Cline versions

Older Cline releases expected `.clinerules` as a **single file** rather than a directory. The generated `.clinerules/TIERKIT.md` includes guidance: on those versions, concatenate the directory's files in alphabetical order into a single `.clinerules` file at the project root.

## What the Continue adapter produces (v0.4)

```
<outDir>/.continue/
  config.yaml                                # Continue assistant config
  TIERKIT.md                              # generated overview + older-Continue guidance
  rules/
    00-<pluginId>-permission.md              # permission contract
    10-<pluginId>-rule-<basename>.md         # plugin rules
    20-<pluginId>-mode-<id>.md               # modes-as-personas (Continue has no first-class modes)
  prompts/
    <pluginId>-<command>.prompt              # native slash commands — `/...` in Continue chat
  mcp/<pluginId>.json                        # MCP staging — NOT auto-registered
```

### `config.yaml` model translation

Unique to the Continue adapter: `AdapterExportInput.config` carries the `tierkit.config.json` payload (loaded by `exportTarget` for adapters that ask). Each entry under `modelProfiles` is translated to a Continue `models[]` entry:

| Tierkit profile field | Continue field |
|---|---|
| `provider`        | `provider` — mapped: `ollama`→`ollama`, `openai-compatible`→`openai`, etc. Unknown providers default to `ollama` (for `local-device`) or `openai`. |
| `model`           | `model` |
| `baseUrl`         | `apiBase` |
| `apiKeyEnv: "X"`  | `apiKey: ${{ secrets.X }}` — Continue resolves from its secrets store. |
| `roles[]`         | Continue's `roles[]` — `chat`/`edit`/`autocomplete`/`embed`/`rerank`. Tierkit role hints (`coder`/`complex-coder`/`simple-coder`/`reviewer`/`planner`) are mapped to Continue roles. |

### Role filtering by tier (safety stance)

| Tier | Roles permitted in Continue config |
|---|---|
| `local-device`    | `chat`, `edit`, `autocomplete` (full local use is fine) |
| `private-remote`  | `chat`, `edit` (autocomplete stays local to keep latency low) |
| `public-cloud`    | **`chat` ONLY** — public-cloud profiles are forced chat-only regardless of the plugin's role hints. Wiring a cloud model into Continue's `edit` or `autocomplete` would bypass the review-only stance. A warning is emitted whenever this filter strips a role. |

### Modes-as-personas

Same translation as the Cline adapter — Continue has no first-class custom modes either, so each Tierkit mode becomes a `20-` rule file with a "Persona:" heading.

### Commands → native slash commands

Continue **does** have native slash commands via `.continue/prompts/<name>.prompt` (YAML frontmatter + body). After export, `/superpowers-free-brainstorm` is available in Continue's chat. This is the only adapter so far where commands become genuine first-class commands rather than rule files.

### MCP stays non-registered

Even though Continue's config.yaml *can* declare MCP servers, Tierkit does not write them into `config.yaml`. They land in `.continue/mcp/<pluginId>.json` as staging files; the TIERKIT.md explains how to merge them into `config.yaml::mcpServers` manually. Same stance as Roo and Cline.

### Older Continue versions

Continue versions before workspace assistant support (~0.9.0) only honor `~/.continue/config.json`. The TIERKIT.md explains how to translate the workspace `.continue/` into the legacy global config.

## Authoring rules

1. **Never `import "clipanion"`.** Adapters live in core or in standalone `adapter-*` packages and must remain CLI-framework-agnostic.
2. **Translate permissions, do not downgrade them.** A plugin's high-risk permissions must surface as visible config in the target tool, not as a silent default.
3. **MCP servers**: render guidance, but never produce a config that auto-registers them. The target tool should still prompt for user approval.
4. **Hooks** in v0.x: translate into target-native rules / instructions (a "soft hook"). Do not pretend runtime enforcement.

## Roadmap

| Adapter | Milestone | Status |
|---|---|---|
| `GenericMarkdownAdapter` | v0.1 | Shipped — dumps `README.md`, `commands/`, `modes/`, `rules/`, `workflows/`, `hooks/`, `mcp/`. |
| `RooAdapter` (Zoo/Roo)  | v0.2 | Shipped — produces `.roomodes` + `.roo/{commands,rules,mcp,TIERKIT.md}`. CLI: `tierkit export roo` (also `export zoo`). |
| `ClineAdapter`          | v0.3 | Shipped — produces `.clinerules/` (numeric-prefixed: `00-` permission contract, `10-` rules, `20-` modes-as-personas, `30-` commands-as-rules) + `.cline/mcp/` for manual MCP setup. CLI: `tierkit export cline`. |
| `ContinueAdapter`       | v0.4 | Shipped — produces `.continue/{config.yaml, rules/, prompts/, mcp/, TIERKIT.md}`. Native `.prompt` slash commands; YAML config with model profiles translated from `tierkit.config.json`. CLI: `tierkit export continue`. |
| Runtime-integrated      | v1.0 | Pending. Live interception of agent loop. |
