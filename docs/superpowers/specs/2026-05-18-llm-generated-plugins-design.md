# LLM-Generated Plugins

**Date:** 2026-05-18
**Status:** Approved (Phase 3 of 3)
**Scope:** GUI Plugins card + new "generate plugin from description" usecase + 2 endpoints

## Problem

Users today can install bundled plugins (the `superpowers-*` series) or hand-author their own via `tierkit plugin new` scaffold (empty manifest + empty rule file). There's no path from "I want a plugin that enforces TDD + Korean code reviews" to a working plugin without writing the manifest by hand. Phase 3 closes that gap by having Tierkit itself ask the auto-routed LLM to draft a plugin from a natural-language description.

## Non-Goals

- ❌ Generating commands or modes — only manifest + rule files (`rules/*.md`).
- ❌ Conversational refinement ("make it stricter") — one-shot generate → preview → install. Iteration = generate again.
- ❌ A marketplace, remote registry, or shared plugin store.
- ❌ Auto-installing without preview. Every generated plugin requires a manual `[Install + Enable]` click.

## Design

### 1. Backend usecase

New file `packages/core/src/usecases/generatePlugin.ts`:

```ts
export interface GeneratePluginInput {
  description: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface GeneratedRule {
  filename: string;   // "01-tdd.md", validated against /^[0-9a-z][0-9a-z._-]*\.md$/
  content: string;
}

export interface GeneratePluginResult {
  draftId: string;                    // uuid
  draftPath: string;                  // <dataDir>/plugin-drafts/<draftId>/
  manifest: PluginManifest;
  rules: GeneratedRule[];
  modelUsed: string;                  // profile id that actually answered
}

export async function generatePlugin(input: GeneratePluginInput): Promise<GeneratePluginResult>;
```

Flow:

1. Build a system prompt (see §5) that teaches the LLM the `PluginManifestSchema` shape + rule-writing conventions, with one worked example.
2. Build a user message with the description verbatim.
3. Call `executeLlmCall({ profileId: "auto", messages: [...] })` — Phase 2's `autoResolver` picks the right tier, runs quality checks, escalates on failure.
4. Extract JSON from the response: strip leading/trailing markdown code fences (``` ```json ... ``` ```), parse with `JSON.parse`.
5. Validate the parsed object against `PluginManifestSchema` (existing Zod schema).
6. Validate each rule filename against the regex above (prevents path traversal).
7. If parse or validation fails: build a retry message that includes the previous output + the Zod error, call `executeLlmCall` **once** more (`profileId: "auto"`). If retry also fails, throw `PluginGenerateError` with the raw output attached.
8. On success, write the files to `<dataDir>/plugin-drafts/<draftId>/`:
   - `tierkit.plugin.json` (the manifest)
   - `rules/<filename>.md` for each generated rule
9. Return the result.

### 2. Draft storage

`<dataDir>/plugin-drafts/<uuid>/` (default `.tierkit/plugin-drafts/<uuid>/`). Drafts are temporary and:

- **TTL:** drafts older than 1 hour are cleaned up on daemon startup AND lazily when the directory is read.
- **Cleanup on success:** when a draft is installed via `/v1/plugins/generate/install`, the draft directory is removed.
- **Not loaded:** the `PluginLoader` / registry never scans `plugin-drafts/`. Only the explicit install endpoint promotes a draft to a real plugin.

### 3. New endpoints

**`POST /v1/plugins/generate`** body `{ description: string }`

- Validates description is non-empty + ≤ 4000 chars (prevents runaway prompt size).
- Calls `generatePlugin`.
- Returns `{ ok: true, draftId, manifest, rules, modelUsed }` on success.
- Returns `{ ok: false, code: "generate-failed", message, rawOutput? }` on failure. `rawOutput` is the LLM's last attempt so the GUI can show the user what came back.

**`POST /v1/plugins/generate/install`** body `{ draftId: string, enable?: boolean }`

- Resolves the draft path; 404 if unknown/expired.
- Reuses `installPlugin({ pluginPath: draftPath, cwd })` (the existing usecase).
- If `enable: true`, then also calls `enablePlugin({ pluginId, cwd })`.
- On success, removes the draft directory.
- Returns `{ ok: true, pluginId, version, installedPath, enabled }`.

### 4. GUI

In the Plugins card (existing in [`gui.ts`](../../../packages/core/src/runtime/ui/gui.ts)), add a new button next to `+ New`:

```
[+ New]  [+ Describe & generate]
```

Click handler opens an inline form below the plugins list:

```
Describe the plugin you want
┌────────────────────────────────────────┐
│ A TDD-first plugin for Python projects │
│ that always asks the model to write a  │
│ failing pytest test before any         │
│ implementation. Prefers small commits. │
└────────────────────────────────────────┘
[Cancel]  [Generate →]
```

On Generate click:

1. Disable the button, show "Generating… this may take 10–30s (auto-routed)".
2. POST `/v1/plugins/generate`. On success, replace the form with a preview panel:

```
Preview — TDD-first Python plugin
─────────────────────────────────
manifest                                [▾ details]
  id: tdd-first-python
  name: TDD-first Python
  version: 0.1.0
  freedom: balanced
  ...

rules (3)
  ▸ 01-failing-test-first.md   (1.2 KB)
  ▸ 02-prefer-pytest.md         (640 B)
  ▸ 03-small-commits.md         (480 B)

generated by  claudeSonnet

[Discard]  [Install only]  [Install + Enable]
```

Clicking a rule row expands to show its content (collapsible).

`[Install only]` → POST `/v1/plugins/generate/install` with `enable: false`.
`[Install + Enable]` → POST with `enable: true`.
`[Discard]` → POST a separate DELETE `/v1/plugins/generate/draft/:id` (optional cleanup endpoint) OR rely on TTL. **MVP: rely on TTL only**, don't add a delete endpoint.

After install: refresh plugins list, show toast.

### 5. System prompt

The prompt is the load-bearing piece. Stored as a constant in `generatePlugin.ts`:

```ts
const SYSTEM_PROMPT = `You are generating a Tierkit plugin. Tierkit plugins guide AI coding agents
by injecting behavior rules into every model call.

Output ONLY valid JSON matching this shape, with NO markdown wrappers, NO commentary,
NO trailing text:

{
  "manifest": {
    "schemaVersion": "0.1",
    "id": "kebab-case-id",
    "name": "Human-readable Name",
    "version": "0.1.0",
    "description": "One-line description.",
    "author": "Tierkit auto-generator",
    "license": "MIT",
    "compatibility": { "tierkit": "^0.3.0", "targets": ["generic"] },
    "components": { "commands": [], "modes": [], "rules": ["rules/01-...md"], "workflows": [], "hooks": [] },
    "permissions": { "fs": ["read"], "net": [], "shell": [] },
    "freedom": { "level": "guided" }
  },
  "rules": [
    { "filename": "01-foo.md", "content": "# Foo\\n\\nAlways do X. Never do Y." }
  ]
}

Rules:
- The "id" field is kebab-case starting with a letter (a-z), max 40 chars.
- "freedom.level" must be one of: "free", "guided", "balanced", "strict".
- 3 to 7 rule files. Filenames: "01-...md", "02-...md", numeric-prefixed for sort order.
- Each rule's "content" is markdown in present-tense imperative ("Always X. Never Y.").
- Rules are guidance text, NEVER shell commands or executable code.
- "components.rules" array must list each generated rule filename (with the "rules/" prefix).
- "permissions.fs" should be ["read"] unless the plugin clearly needs writes.

Example output for "TDD-first Python plugin":

<embed a complete example here — 60–80 lines of JSON>

Return ONLY the JSON object. No prose, no markdown fences.`;
```

The embedded example is one well-formed plugin used as a few-shot anchor. Quality of generated output depends on this example being good — write it carefully.

### 6. Validation + retry

After receiving the LLM response:

1. **Strip markdown fences** if present: regex `^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$` → group 1.
2. `JSON.parse`. If throws: retry.
3. Extract `parsed.manifest` and `parsed.rules`. If either missing: retry.
4. `PluginManifestSchema.safeParse(parsed.manifest)`. If fails: retry with the Zod error included in the retry prompt.
5. Validate each rule's `filename` against `/^[0-9a-z][0-9a-z._-]*\.md$/`. If any fails: retry.
6. Verify `parsed.manifest.components.rules` matches the rule filenames in `parsed.rules` (with `rules/` prefix). If mismatched: auto-correct by overwriting `components.rules` with the filenames from `parsed.rules`. (Don't retry — this is a common-enough LLM mistake to be worth tolerating.)

**Retry message** (only one retry):

```
Your previous response was rejected:

<error message>

Your previous output was:

<raw output>

Please return a corrected JSON object. Output ONLY the JSON, no markdown fences,
no commentary.
```

If retry also fails, return the failure with `rawOutput` so the GUI can show it.

### 7. Safety

- LLM cannot execute anything during generation — it just produces JSON.
- Generated files land in `.tierkit/plugin-drafts/<uuid>/`, NOT in the plugins directory. Nothing auto-loads from drafts.
- The plugin id regex and rule filename regex prevent path-traversal attacks via crafted filenames.
- The `permissions` field in the manifest can request `fs.write`, `net`, `shell` — but these are honored by the existing plugin runtime safety system (already enforced; not a new attack surface).
- Description length capped at 4000 chars to prevent prompt-injection storms.
- The LLM response is not directly executed as code anywhere — it's parsed as JSON, validated as a Zod schema, and written as static `.md` files.

### 8. Tests

Unit (`packages/core/test/generatePlugin.test.ts`):

- Strips markdown fences from response.
- Parses a valid response → returns manifest + rules.
- Auto-corrects `components.rules` mismatch.
- Retries once on JSON parse failure.
- Retries once on schema validation failure.
- Returns `generate-failed` with `rawOutput` after 2 failed attempts.
- Rejects rule filenames with path-traversal patterns (`../foo.md`).
- Caps description length at 4000 chars (rejects 4001).

Integration (`packages/core/test/generatePluginEndpoint.test.ts`):

- `POST /v1/plugins/generate` with mock LLM → returns draftId + draft files exist on disk.
- `POST /v1/plugins/generate/install` → draft is moved to plugins dir, registry updated, draft cleaned up.
- Generate twice in a row → two different draftIds, neither overwrites the other.
- Draft TTL: a draft older than 1h is treated as expired.

GUI: manual verification only.

### 9. Backward compatibility

- No existing endpoints change.
- No existing config fields change.
- No existing schemas change.
- The `auto` LLM routing path is reused as-is (Phase 2).

## File Changes Summary

**New:**
- `packages/core/src/usecases/generatePlugin.ts` (~250 lines including prompt + example)
- `packages/core/test/generatePlugin.test.ts`
- `packages/core/test/generatePluginEndpoint.test.ts`
- `packages/core/src/usecases/generatePluginExample.ts` (the JSON example, exported separately so it's reusable in tests)

**Modified:**
- `packages/core/src/runtime/Server.ts` — 2 new endpoints
- `packages/core/src/runtime/ui/gui.ts` — new button, generate form, preview panel, i18n keys
- `packages/core/src/index.ts` — export `generatePlugin`

**Estimated diff:** ~700 lines added.
