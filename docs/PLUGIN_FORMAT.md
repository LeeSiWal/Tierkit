# Tierkit Plugin Format

> Status: v0.1. Schema version `"0.1"`. Validated by `@tierkit/core` via [zod](https://zod.dev).

An Tierkit plugin is a directory containing:

- `tierkit.plugin.json` — the plugin manifest (this document).
- Any files the manifest references (commands, modes, rules, workflows, hooks, MCP config). All paths are **relative to the plugin directory** and must not escape it; path traversal is rejected at validate/load time.

A minimal example lives at [`packages/plugin-superpowers/plugins/superpowers-free`](../packages/plugin-superpowers/plugins/superpowers-free).

## Manifest reference

### Required top-level fields

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `"0.1"` | Must match this exact string. |
| `id` | string | Kebab-case, starts with a letter (`[a-z][a-z0-9-]*`). Used as the install/store key. |
| `name` | string | Human-readable name. |
| `version` | semver string | e.g. `"0.1.0"`. |
| `description` | string | One-line description. |
| `author` | string | |
| `license` | string | Defaults to `"MIT"`. |
| `compatibility.tierkit` | semver range | e.g. `">=0.1.0"`. |
| `compatibility.targets` | string[] | Subset of `roo`, `zoo`, `cline`, `continue`, `claude-code`, `generic`. Must be non-empty. |
| `permissions` | object | See *Permissions* below. |
| `freedom.level` | `"free" \| "guided" \| "balanced" \| "strict"` | Determines how aggressively adapters enforce workflow gates. |

### Optional top-level fields

| Field | Type | Notes |
|---|---|---|
| `components` | object | Empty by default. See *Components* below. |
| `modelPolicy` | object | Plugin-level overrides for model routing defaults. |

## Components

All component fields default to empty arrays / undefined.

```json
"components": {
  "commands":  [ { "name": "...", "file": "...", "description": "...", "category": "..." } ],
  "modes":     [ { "id": "...", "name": "...", "file": "...", "tools": [], "role": "..." } ],
  "rules":     [ "rules/local-first.md" ],
  "workflows": [ "workflows/planning.json" ],
  "hooks":     [ "hooks/dangerous-command-require-approval.json" ],
  "mcpServers": "mcp/mcp.json"
}
```

### `commands[]`

| Field | Type | Notes |
|---|---|---|
| `name` | string | Kebab-case, exposed as a slash command (`/brainstorm`). |
| `file` | path | Markdown body of the command prompt. Relative, must stay inside the plugin dir. |
| `description` | string | Shown in help and exports. |
| `category` | `"planning" \| "review" \| "debugging" \| "execution" \| "routing" \| "misc"` | Defaults to `"misc"`. |

### `modes[]`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Kebab-case. |
| `name` | string | Human-readable. |
| `file` | path | Markdown describing the mode's stance and out-of-scope behavior. |
| `tools` | string[] | Tool names the mode is permitted to use (`read`, `edit`, `search`, ...). |
| `role` | string | Free-form, e.g. `planner`, `reviewer`, `implementer`. |

### `rules[]`, `workflows[]`, `hooks[]`

Each entry is a path to a file inside the plugin directory. Adapters render rules and workflows as natural-language instructions; hooks are declarative-only in v0.1 (see [SPEC §13](SPEC.md)).

### `mcpServers`

Path to a JSON file describing MCP servers the plugin would like to register. **MCP server registration always requires user approval** — adapters surface this at install time and Tierkit never auto-registers MCP servers.

## Permissions

A permission map. Unset values default per the schema (most default to `false`; `useLocalDeviceModel` defaults to `true`).

```json
"permissions": {
  "readFiles": true,
  "editFiles": true,
  "runCommands": false,
  "registerMcp": false,
  "useLocalDeviceModel": true,
  "usePrivateRemoteModel": false,
  "usePublicCloudModel": false,
  "accessSecrets": false,
  "modifyAgentSettings": false,
  "installDependencies": false,
  "useNetwork": false
}
```

The full enum is exported as `PERMISSIONS` from `@tierkit/core`. The following are flagged as high-risk at install time:

`runCommands`, `registerMcp`, `accessSecrets`, `modifyAgentSettings`, `installDependencies`, `usePublicCloudModel`.

### Warnings emitted by the validator

The validator returns `warnings[]` (non-fatal unless `--strict`):

- Requesting `usePublicCloudModel` without also requesting `usePrivateRemoteModel`.
- Requesting `registerMcp` (always requires approval).
- `freedom.level === "free"` combined with `runCommands: true`.
- `modelPolicy` weakening Tierkit's public-cloud defaults.
- Plugin defines no components (it would be a no-op when exported).

## Model policy

Optional per-plugin overrides. Tierkit defaults always apply unless this object overrides them.

```json
"modelPolicy": {
  "preferPrivateRemoteBeforePublicCloud": true,
  "publicCloudRequiresApproval": true,
  "publicCloudDefaultMode": "review-only"
}
```

`publicCloudRequiresApproval: false` or `publicCloudDefaultMode: "execute"` triggers a validator warning. Public-cloud profiles are review-only by default (see [MODEL_ROUTING.md](MODEL_ROUTING.md)).

## Freedom level

| Level | Meaning |
|---|---|
| `free`     | Command pack with minimal enforcement. |
| `guided`   | Encourages good habits; dangerous commands require approval. |
| `balanced` | Plan before multi-file edits; review after large diffs; dangerous commands require approval. |
| `strict`   | Closest to Superpowers original: plan approval required before implementation, TDD enforced, review before "finish". |

v0.1 ships `superpowers-free` only. The other tiers land in subsequent milestones.

## File path safety

All path strings in `commands[].file`, `modes[].file`, `rules[]`, `workflows[]`, `hooks[]`, and `mcpServers` are:

- Required to be relative paths.
- Required to resolve to a location inside the plugin directory.
- Rejected if they begin with `/` or escape via `..`.

The same rule applies on the output side: adapters must resolve their output paths under the explicit `outDir`. Both sides use `resolveUnder` from `@tierkit/core`.

## End-to-end check

```sh
# Validate the manifest and referenced files exist
tierkit plugin validate ./my-plugin

# Treat warnings as errors
tierkit plugin validate ./my-plugin --strict

# Install into the current Tierkit project
tierkit plugin install ./my-plugin

# Inspect what got installed
tierkit plugin list

# Render the plugin as tool-neutral markdown
tierkit export generic --out ./dist/exports
```
