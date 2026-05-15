# Changelog

## 0.3.3 — 2026-05-16

**Tool-shim: weak local models can now drive Roo / Cline / Continue.** Tierkit transparently bridges OpenAI structured tool calling to text-format tool calls (XML tags or JSON-in-content) for models that don't reliably emit `tool_calls`.

### The problem
Coding agents (Roo, Cline, Continue) send OpenAI-format `tools` array and expect `tool_calls` back. But most local Ollama models — even `qwen2.5-coder:7b` — emit the call as TEXT in `content` rather than as a structured `tool_calls` field:

```json
{
  "role": "assistant",
  "content": "{\n  \"name\": \"ask_followup_question\",\n  \"arguments\": {\n    \"question\": \"What's the goal?\"\n  }\n}"
  // ← tool_calls is missing
}
```

Result: caller sees `tool_calls: undefined` and reports "model didn't use any tool". The agent loop breaks.

### The fix
Tierkit now does exactly what Cline / Roo themselves do internally — XML-tag tool calling in the system prompt:

1. **Inbound**: Convert OpenAI `tools` array → XML-tag instructions appended as a system prompt with examples
2. **Outbound to provider**: Strip `tools` from the wire request — the model sees only the natural-language prompt
3. **Inbound from provider**: Parse the model's text response for matching patterns
4. **Outbound to caller**: Return as OpenAI-shape `tool_calls`

Patterns the parser recognizes (whichever the model emits, Tierkit handles):
- XML tags: `<read_file><path>src/foo.ts</path></read_file>`
- Code-fenced JSON: ` ```json {"name": "...", "arguments": {...}} ``` `
- Bare JSON consuming whole content: `{"name": "X", "arguments": {...}}`
- Multiple tool calls in one response (each translated independently)
- JSON-typed XML param values (arrays, numbers, bools) parsed as JSON

### Config
`runtime.toolShim`:
- `"auto"` (default) — apply for local-device profiles only; Anthropic/OpenAI use their native structured tool calling
- `"on"` — force shim for every profile
- `"off"` — never shim, pass `tools` through unmodified

### Compatibility
Caller doesn't see the shim. Roo / Cline / Continue / curl / any OpenAI-compatible client gets a uniform structured response regardless of which path the model took. The original `tools` array stays in `request.tools` for parser bounds checking but isn't sent on the wire when the shim is active.

### Tests
340 pass (234 core + 28 client + adapter/cli unchanged). 9 new tests cover:
- XML extraction with single + multiple tags
- JSON-typed XML param values
- Unknown tool names ignored
- Pure JSON-in-content (the qwen2.5-coder pattern)
- Code-fenced JSON in mixed content
- Arguments emitted as JSON string vs object
- Malformed input ignored
- End-to-end through `/v1/openai/chat/completions` with weak-model simulation

### Result
A user with `qwen2.5-coder:7b` and `superpowers-balanced` plugin enabled can now run real coding tasks through Roo Code with all of Tierkit's policy gates (routing, redaction, command-gate, budget, sessions, plugin rules) applied — entirely on-machine, no API key needed.

## 0.3.2 — 2026-05-16

**Plugin rules now actually influence the model — system-prompt injection on every `/v1/llm-call`.**

### What was missing
Tierkit plugins (`superpowers-balanced`, `-strict`, …) ship with `rules/*.md` files like `plan-approval-gate.md`, `tests-first.md`, `local-first.md`. Before 0.3.2, those rules only made it to the model through **per-tool export** — when you ran `tierkit export roo`, the rules landed in `.roomodes` / `.roo/rules/` and Roo Code used them when building its system prompt.

But the Tierkit daemon's own `/v1/openai/chat/completions` path **didn't inject the rules**. So callers that hit Tierkit directly (Roo via the OpenAI-compatible endpoint, Cline via the same, raw curl, the sidebar) sent plain messages to the model with no Tierkit-defined guidance. Result: weaker tool-use behavior, plugins that "do nothing visible" until you ran an explicit export.

### What changed
Whenever `executeLlmCall` runs, the daemon now:

1. Reads `activePlugins` from `tierkit.config.json`
2. Loads each plugin's manifest + `rules/*.md` files via `PluginLoader`
3. Concatenates the rule contents with section headers per plugin
4. Prepends as a `system` message before any caller-supplied messages

So when you enable `superpowers-balanced`, **every model call** — whether triggered from Roo, Cline, Continue, or curl — gets the balanced workflow rules in its system prompt. Small models (qwen2.5:7b-instruct etc.) follow tool-use guidance much more reliably with the rules present.

### Behavior
- Caller's own `system` messages are **preserved** — Tierkit's plugin rules go first, caller's system messages second, then the conversation.
- Disable per-workspace with `runtime.injectPluginRules: false` (default true).
- No-op when no plugins are active: zero overhead, plain pass-through.

### Tests
331 pass (222 core + 27 client + adapter/cli unchanged). 4 new tests pin: rules prepended; caller system preserved; off-switch works; no-plugins is no-op.

### Why this matters
This is the missing link that makes "one Tierkit plugin = consistent behavior across all your tools" real end-to-end, not just at export time. The combination with 0.3.1 viability pre-flighting and 0.3.0 tool calling means:
- Tierkit picks a viable profile
- Forwards the model's tools
- AND seeds the system prompt with whatever your active plugin tells it to do

Small local models like `qwen2.5-coder:7b` go from "ignores tools, chats" to "follows the plugin's rules, calls tools" with no per-call configuration.

## 0.3.1 — 2026-05-16

**Auto-route now pre-flights candidates — skips Ollama profiles whose model isn't pulled, skips remote profiles whose API key isn't set.**

### What changed
Auto-route in 0.3.0 walked the candidate list and tried each until one succeeded. That worked, but it burned a full HTTP round-trip per non-viable candidate before the fallback kicked in. The common case was painful: bundled defaults `localCoder` (qwen2.5-coder:7b) and `localFast` (llama3.2:3b) both fail with 404 on a fresh Ollama install — three retries before reaching a user-added profile that actually works.

0.3.1 adds a **cheap viability probe** that runs before the fallback chain:
- **Ollama**: hit `{baseUrl}/api/tags` once, check if the profile's model is in the installed list (matches exact OR prefix with `:tag`)
- **Anthropic / OpenAI / public-cloud**: check the `apiKeyEnv` env var is set

The probes run in parallel and time out at 1.5s. Then auto-route filters: **if any candidate is viable, drop the non-viable ones entirely**. If none are viable (e.g., Ollama is down), keep them all so the user still sees the informative provider error.

### Real-world effect
On a Mac with only `qwen2.5:7b-instruct` installed and a user-added profile pointing at it:

```
Before 0.3.1:                    After 0.3.1:
auto → localCoder (qwen2.5-coder:7b)  auto → viability probe (one /api/tags call)
       → 404 (~80ms)                         → finds: ghostCoder ✗, ghostFast ✗, myCoder ✓
auto → localFast (llama3.2:3b)             → use myCoder directly
       → 404 (~80ms)
auto → myCoder (qwen2.5:7b-instruct)
       → success
       
Total: ~250ms of wasted retries      Total: ~50ms probe, no wasted retries
```

### Internals
- New `model/profileViability.ts`: `checkProfileViability(profile, env)` + `partitionByViability(candidates, resolveProfile, env)`
- 7 unit tests (mocked fetch) covering: env-var presence, /api/tags exact + prefix match, unreachable Ollama, model-not-installed
- 1 integration test via the HTTP daemon: confirms an unviable Ollama profile is silently skipped and a viable mock profile is chosen

### Build
327 tests pass (218 core + 27 client + adapter/cli totals unchanged).

## 0.3.0 — 2026-05-16

**Tool calling. Roo Code, Cline, Continue, and other agentic clients now actually work through Tierkit.**

This is the last big missing piece. Earlier versions could proxy plain chat messages, but the moment a coding agent sent a `tools` array (which they all do — they need read_file / edit_file / shell_exec etc. to function as agents), Tierkit dropped it and returned plain text. The agent would then complain "model didn't use any tool" and fail.

0.3.0 adds full tool-call passthrough in both directions, end-to-end.

### What it does

**Inbound** (from Roo / Cline / Continue → Tierkit):
- `tools` array on the request — forwarded to the underlying provider
- `tool_choice` (`auto` / `none` / `required` / `{type:"function", function:{name}}`) — forwarded
- Multi-turn conversations with `assistant` messages carrying `tool_calls` and `tool` messages carrying `tool_call_id` — accepted and forwarded

**Outbound** (Tierkit → caller):
- When the model requests tool invocations, Tierkit surfaces them as OpenAI-shape `tool_calls` on the assistant message
- `finish_reason: "tool_calls"` set appropriately
- `content` is `null` when the model only emitted tool_calls (per OpenAI's contract); a plain string otherwise

### Provider support
- **Ollama** (0.4+) — uses native `tools` parameter on `/api/chat`; OpenAI-format tool_calls returned. Models like `qwen2.5-coder:7b`, `llama3.2`, `mistral-nemo`, etc. work out of the box.
- **OpenAI / OpenAI-compatible** — passthrough, including SSE streaming with tool-call delta reassembly.
- **Anthropic** — full conversion in both directions:
  - OpenAI `tools` → Anthropic `tools` (renaming `parameters` → `input_schema`)
  - Anthropic `tool_use` blocks → OpenAI `tool_calls` 
  - OpenAI `role: "tool"` messages → Anthropic `user` messages with `tool_result` content blocks
  - Streaming `tool_use` events accumulated via `input_json_delta` then emitted as complete `tool_call`s

### Result
- Roo Code can now read your code, edit files, run commands — all through Tierkit's policy stack (routing, redaction, command-gate, budget, sessions).
- Same for Cline, Continue, aider, or any OpenAI-compatible client.
- 5 new round-trip tests (319 total).

### Verified
With Mac terminal + the daemon running, the exact request shape Roo sends:
```json
{
  "model": "auto",
  "messages": [{"role":"user","content":[{"type":"text","text":"list files in src"}]}],
  "tools": [{"type":"function","function":{"name":"read_file",...}}]
}
```
returns:
```json
{
  "choices": [{
    "message": { "role": "assistant", "content": null, "tool_calls": [{"id":"...", "type":"function", "function":{"name":"read_file","arguments":"{}"}}] },
    "finish_reason": "tool_calls"
  }]
}
```
which is exactly what Roo expects to drive its agent loop.

## 0.2.3 — 2026-05-16

**Fix: Roo Code (and any OpenAI-compatible client using the multimodal message format) now works.**

### What broke
Roo Code 3.x sends `message.content` as an array of content parts:
```json
{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }
```
This is OpenAI's newer multimodal format (used so clients can mix text, images, tool results, etc. in a single message). Tierkit's `/v1/openai/chat/completions` handler was checking `typeof content !== "string"` and rejecting any non-string with `400: each message.content must be a string`. So every Roo Code call failed before reaching the model.

### Fix
The handler now flattens array content into a plain string:
- Text parts (`{ type: "text", text }`) — concatenated with newlines
- Tool result parts (`{ type: "tool_result", content }`) — included as text
- Image / audio / tool_use parts — silently dropped (Tierkit's underlying providers don't all support multimodal; safe default is "ignore unknown parts so the text portion still gets through")

Plain string content still works (full backward compatibility).

### Verified end-to-end
Three scenarios pass on Mac with Ollama + auto-route:
1. Array content (Roo format) → ✓ response
2. Mixed array (text + image_url dropped) → ✓ response with image portion ignored
3. Plain string (legacy) → ✓ response

After upgrading, Roo Code on either Windows or Mac should send a task and get a real answer, with the call appearing in Tierkit's "Recent activity" card.

## 0.2.2 — 2026-05-16

**Auto-route now falls back to the next-best profile on transient failures.**

### What changed

Previously, `model: "auto"` (or unspecified, which Roo/Cline/Continue send by default) picked exactly one profile and gave up if that profile couldn't be used right now. So if a user had Tierkit's default `localCoder` profile pointing at `qwen2.5-coder:7b` but hadn't pulled that model yet, every `auto` call failed with `bad-status` (Ollama's 404 for "model not found"), even when other usable profiles existed in the same tier.

Now `auto` walks the ordered candidate list for the chosen tier and tries each in sequence on **transient** failures:
- `unreachable` — provider isn't reachable (Ollama not running, OpenAI 500, etc.)
- `bad-status` — provider responded with a non-2xx (model not pulled, deprecated model id)
- `missing-api-key` — this profile's env var isn't set; another profile's might be
- `not-implemented` / `network-error` / `timeout` — same idea

**Policy failures are never fallback-able** — those are intentional refusals, not transient problems:
- `dangerous-command-blocked`, `plan-not-approved` (workflow gate)
- `budget-exceeded` (budget gate)
- `unknown-profile` (config issue — retry won't help)

The response's `tierkit.fallback` field surfaces what was attempted before success:

```json
{
  "tierkit": {
    "profileId": "workingLocal",
    "fallback": {
      "attempts": [{ "profileId": "fakeFirst", "code": "bad-status" }],
      "chosen": "workingLocal"
    }
  }
}
```

When all candidates fail, the error includes the full trail:
```
"ollama responded with 404 Not Found (tried 3: localCoder=bad-status, localFast=bad-status, last=bad-status)"
```

### Why
First-run users see this exact scenario constantly: bundled defaults expect certain Ollama models that may not be pulled, certain env vars that may not be set. Hard failure on the first try defeated the "zero-config first-run" promise from 0.1.6. Now the user gets a real answer from whichever profile happens to be usable right now.

### Scope
- Non-streaming path (`POST /v1/openai/chat/completions` without `stream: true`) — full fallback.
- Streaming path — only tries the primary pick (mid-stream switching is hairy; future improvement).
- Explicit `model: "claudeSonnet"` (non-auto) — no fallback (you asked for a specific profile, you get that profile or its error).

## 0.2.1 — 2026-05-16

**Sidebar redesign: Mission Control.** No more chat input — Tierkit is a routing/policy layer that sits behind Roo Code / Cline / Continue, not an agent itself. The sidebar now reflects that identity.

### What's new

The sidebar is a 5-card dashboard:

1. **Connected tools** — Roo, Cline, Continue with status (`detected` / `routed to Tierkit`). One-click [Connect] button per tool runs the equivalent of `tierkit connect <tool>` and writes the config file.
2. **Active plugins** — toggle Enable / Disable inline. Each toggle auto-runs `tierkit plugin sync` so the change propagates to every connected tool. **+ New** scaffolds a plugin in the workspace.
3. **Recent activity** — auto-refreshing every 5s, showing the last ~12 model calls Tierkit handled. You see Roo's calls appear in real time as you use Roo.
4. **Today's usage** — call / token / cost totals + per-profile breakdown.
5. **Model profiles** — every profile with source (bundled / user / workspace) + inline [test] button. **+ Add** opens an inline form.

Plus a **Sync plugins** button in the Connected-tools card and global ↻ in the top bar.

### Why
Earlier versions had a chat input in the sidebar which conflated Tierkit (policy layer) with the agent's job (chat + tool use). Real coding happens in Roo / Cline / Continue / etc. — Tierkit's sidebar should be a control panel for monitoring + configuration, like a server admin UI. Mission Control is that.

### Daemon
- New `GET /v1/connections` — reports each tool's detection + Tierkit-routing status.
- New `POST /v1/plugins/enable` + `POST /v1/plugins/disable` — sidebar toggles use these; both auto-trigger sync.
- `@tierkit/client` SDK gains `connections()`, `pluginEnable()`, `pluginDisable()`.

### Migration
Slash commands (`/connect`, `/profile add`, etc.) are no longer in the sidebar — they're replaced by inline buttons. The CLI mirrors (`tierkit connect roo`, `tierkit plugin enable …`) still work the same. If you scripted against the chat input, switch to the CLI or the HTTP endpoints.

## 0.2.0 — 2026-05-16

**Connect any agent. Author your own plugins. One plugin → every tool.**

This is the milestone that delivers the original Tierkit promise: one plugin format runs everywhere — Tierkit itself (via the sidebar), Roo Code, Cline, Continue, or anything else that speaks OpenAI-compatible.

### New: OpenAI-compatible endpoint

`POST /v1/openai/chat/completions` and `POST /v1/chat/completions` accept standard OpenAI Chat Completions requests. The `model` field is your Tierkit profile id (`localCoder` / `claudeSonnet` / etc.) or the magic value `auto` for risk-based auto-routing.

This means **any tool that supports OpenAI-compatible custom endpoints can route through Tierkit** and inherit:
- Tier-based routing (local / private-remote / public-cloud)
- Secret redaction before remote calls
- Dangerous-command classifier
- Budget enforcement
- Workflow session gate (plan-approval / freedom levels)
- Usage log

Streaming (`stream: true`) returns SSE chunks in OpenAI's `chat.completion.chunk` format.

### New: `tierkit connect <tool>`

One command wires an existing agent to route through Tierkit:
- `tierkit connect roo` — writes `.vscode/settings.json` so Roo Code uses Tierkit as its OpenAI-compatible endpoint
- `tierkit connect cline` — same for Cline
- `tierkit connect continue` — writes a Tierkit-routed model entry to `.continue/config.yaml`

Idempotent (safe to re-run), preserves any other settings already in those files.

### New: `tierkit plugin sync`

Re-exports active Tierkit plugins to every detected tool. Runs **automatically on `plugin enable/disable`** so plugin activation propagates without an explicit step. Detection is filesystem-based: `.roomodes` / `.roo` → Roo; `.clinerules/` → Cline; `.continue/` → Continue.

### New: `tierkit plugin new <id>`

Scaffolds a complete plugin directory with manifest + sample command + sample mode + sample rule. Ready to install + enable + sync.

```sh
tierkit plugin new my-team-rules
tierkit plugin install ./my-team-rules
tierkit plugin enable my-team-rules    # auto-syncs to all connected tools
```

### New sidebar slash commands

- `/connect roo` · `/connect cline` · `/connect continue`
- `/plugin sync`
- `/plugin new <id>`

Plus the regular `/init`, `/models`, `/profile add`, etc. from 0.1.6.

### Daemon endpoints (new)

- `POST /v1/openai/chat/completions` · `POST /v1/chat/completions` — OpenAI-compatible chat
- `POST /v1/connect` — wire an external tool to route through Tierkit
- `POST /v1/plugins/sync` — re-export plugins to detected tools
- `POST /v1/plugins/new` — scaffold a new plugin

### `@tierkit/client` SDK

New methods: `connectTool`, `pluginsSync`, `pluginNew`.

### Tests

314 tests pass (211 core + 21 client + 15+15+19 adapters + 31 CLI + 0 vscode). 16 new tests for connect / sync / plugin-new / OpenAI-compatible endpoint.

## 0.1.8 — 2026-05-16

Fix: model responses now actually render in the chat thread.

### What broke in 0.1.6 – 0.1.7
The chat UI read `d.content` and `d.usage.inputTokens` from the `/v1/llm-call` response. The daemon's actual response shape is flat — `{ ok, text, inputTokens, outputTokens, costUsd, latencyMs, ... }`. So calls succeeded (latency + routing card showed up), but the assistant text rendered empty and the token counts were missing from the meta line.

### Fix
GUI now reads `d.text` and the flat token/cost fields. The chat thread renders the actual model output.

## 0.1.7 — 2026-05-16

Fix: bundled default profiles now usable without a workspace `tierkit.config.json`.

### What broke in 0.1.6
After 0.1.6 shipped 6 bundled default profiles, sending a task to one (e.g., `claudeSonnet`) in a folder with no `tierkit.config.json` returned `no-config: no tierkit.config.json found; run \`tierkit init\` first`. That error predated the 3-tier config layering — it required a workspace config file to exist before any model call would proceed. With bundled defaults that requirement is wrong.

### Fix
Removed the `cfg.found` precondition from `executeLlmCall`, `runRoute`, and `testModel`. The canonical error is now `unknown-profile` when a profile id has no match across any of the three config layers (bundled, user, workspace). `plugin enable/disable/remove` still require a workspace config because plugin tracking is per-project — those error paths are unchanged.

## 0.1.6 — 2026-05-16

Zero-config first-run: bundled defaults, 3-tier config, in-product profile management, and Ollama auto-launch.

### Features

**Bundled default model profiles**
- Six templates ship with Tierkit core and show up in `/models` immediately, no JSON editing required: `localCoder` / `localFast` (Ollama), `claudeSonnet` / `claudeHaiku` (Anthropic), `gpt4o` / `gpt4oMini` (OpenAI).
- Each profile becomes usable when its prerequisite is satisfied (env var set or Ollama installed). `/test <profileId>` reports readiness without spending tokens.

**3-tier config layering** (low → high)
1. Bundled defaults (shipped in `@tierkit/core`)
2. User-level: `~/.tierkit/config.json` (set once, shared across folders)
3. Workspace-level: `./tierkit.config.json` (overrides for this project)

A profile in a higher layer overrides one with the same id in a lower layer. Setting a profile id to `null` in user or workspace config suppresses the bundled default. `/models` now shows a `source` column (`bundled` / `user` / `workspace`).

**`/profile add` wizard in the sidebar**
- Inline multi-step card: pick provider → fill model + id → choose scope → Save.
- Posts to `POST /v1/config/profile` and refreshes the sidebar profile dropdown automatically.
- Korean fully localized.

**`Tierkit: Add model profile` VS Code command**
- Native QuickPick + InputBox flow for VS Code users who prefer the platform's native dropdowns.
- Same backend endpoint as the sidebar wizard — both UIs are pure clients.

**`/init` slash command** scaffolds `tierkit.config.json` + `.tierkit/plugins.json` in the active workspace via `POST /v1/config/init`.

**`tierkit profile add` / `tierkit profile remove` CLI commands**
- Headless mirror of the wizard. Useful for scripts, CI, and dotfile setups.
- `--scope user` writes to `~/.tierkit/config.json`; default is workspace.

**Ollama auto-launch + auto-shutdown**
- When a call to an Ollama-backed profile hits connection-refused, Tierkit shells out to `ollama serve` and retries once. If Ollama was already running (system service, tray app), Tierkit leaves it alone.
- When the Tierkit daemon shuts down — which on the VS Code extension means when VS Code closes — any Ollama instance Tierkit started goes with it. Pre-existing Ollama installs are never killed.

### Internal
- New `POST /v1/config/profile`, `DELETE /v1/config/profile/:id`, `POST /v1/config/init` daemon endpoints.
- `@tierkit/client` gains `configAddProfile`, `configRemoveProfile`, `configInit`.
- `listModels` response now includes `source`, `configPath`, `userConfigPath`.
- 13 new tests (config layering + profile CRUD). Total: 198 tests.

## 0.1.5 — 2026-05-15

**Actual fix for "Daemon unreachable" in the webview.**

The 0.1.4 portMapping work was on the right track but not the actual cause. The real blocker (visible in the webview's DevTools console) was **CORS**: the VS Code webview runs at origin `vscode-webview://<id>` and treats `http://localhost:4101` as cross-origin. Without `Access-Control-Allow-Origin` on responses, the browser blocked every fetch *before it left the page*.

### Fix
Tierkit daemon (`@tierkit/core` `Server.ts`) now sets standard CORS headers on every response and answers OPTIONS preflights with 204:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: content-type, authorization`

Daemon is still bound to `127.0.0.1` (loopback only) so the wildcard ACAO doesn't widen the attack surface — anything that can already reach the daemon is already on the same machine.

The 0.1.4 portMapping + localhost rewrite is kept (the right pattern for Remote-SSH / Codespaces scenarios), but the CORS fix is what actually unblocks the webview on local desktop.

## 0.1.4 — 2026-05-15

**Windows fix: webview can now actually reach the daemon.**

### What broke (0.1.0 – 0.1.3 on Windows)
Even after auto-start succeeded and the daemon was confirmed listening at `http://127.0.0.1:4101` (verified by opening that URL in a regular browser on the same machine), the sidebar webview kept showing "offline" / "Failed to fetch" for every fetch. Cause: VS Code webviews on Windows can run inside a sandboxed network namespace (UWP AppContainer if installed from Microsoft Store, or under some AV/enterprise security configurations) where the webview iframe is blocked from making HTTP requests to `127.0.0.1`, while the extension host (Node.js) is fully allowed.

### Fix
Use VS Code's [`portMapping`](https://code.visualstudio.com/api/references/vscode-api#WebviewOptions) — the canonical mechanism for exactly this scenario. With portMapping configured, the webview's fetch to `http://localhost:<port>` is routed by VS Code itself to `localhost:<port>` on the extension host machine, completely bypassing the webview's own network sandbox. The webview's base URL now uses `localhost` (required for the mapping to match) instead of `127.0.0.1`.

Works on all platforms — no Windows-only branch.

## 0.1.3 — 2026-05-15

**Sidebar redesign — Claude Code style.** The dashboard is now a single conversation thread with a bottom input box and slash commands, instead of 6 separate control-panel cards.

### What changed

- **Conversation thread** — type a task, see the answer streamed in line. No more clicking between Run / Models / Usage / Session tabs.
- **Slash commands** replace the per-card UI:
  - `/help` — list all commands
  - `/models` · `/test <id>` — list / probe model profiles
  - `/route <task>` — show routing decision without running it
  - `/usage` — per-profile call / token / cost summary
  - `/session [start <task>|approve|advance <state>|abandon]` — drive workflow sessions inline
  - `/check command|path|redact <input>` — secret-redaction · command-classifier · sensitive-path checks
  - `/profile <id|auto>` · `/mode execute|plan|review` — change routing target on the fly
  - `/clear` — clear the conversation
- **Auto-routing** — selecting profile `auto-route` in the dropdown below the input sends each task through `POST /v1/route` first, then `POST /v1/llm-call` with the chosen profile. The routing decision is shown inline.
- **Pickers below the input** (Claude Code-like): profile + mode dropdowns sit under the textarea, not as a separate panel. Selection is persisted in `localStorage`.
- **Enter to send, Shift+Enter for newline.**

### Why
Previous dashboard exposed every daemon capability as a top-level panel — useful for "what can Tierkit do?" demos but bad for daily use, where the only flow that matters is *type task → see answer*. Slash commands keep the secondary features one keystroke away (`/`) without competing for screen space with the conversation.

The browser GUI at `http://127.0.0.1:4101/` gets the same redesign because both contexts share the same `GUI_HTML`.

## 0.1.2 — 2026-05-15

Diagnostics for the "Daemon unreachable: Failed to fetch" case (especially on Windows).

### Features

**Diagnostic Output channel**
- New "Tierkit" Output channel logs every step of `maybeStartDaemon`: VS Code version, Node version, workspace folders, configured baseUrl, existing-daemon probe, port-binding attempts, fallback to port 0, and the full stack of any failure.
- New command **`Tierkit: Show diagnostic output`** opens it from anywhere.
- When auto-start fails, the warning toast now has an **Open output** button.

**Restart daemon command**
- New command **`Tierkit: Restart daemon`** closes the in-process server (if any) and re-runs auto-start. Useful after opening a folder, changing `tierkit.config.json`, or unblocking a port.

**In-sidebar daemon banner**
- When the host (VS Code) flags an auto-start failure, the sidebar shows a clearly worded banner at the top with two buttons: **진단 로그 열기 / Show output** and **데몬 재시작 / Restart daemon**. No more hunting through 5 separate "Failed to fetch" messages.

### Why this matters
The sidebar previously gave 5 identical "Failed to fetch" errors when the daemon didn't start, with no clue why. On Windows in particular, common silent-failure modes are: no workspace folder open, port 4101 inside Hyper-V's reserved port range, AV blocking `node:http.listen`, or a missing `tierkit.config.json`. The new Output channel surfaces the exact failure so it can actually be fixed.

## 0.1.1 — 2026-05-15

Zero-config first run + Korean localization.

### Features

**Auto-start daemon**
- On extension activation the runtime daemon now starts **in-process** at the configured `tierkit.baseUrl` (default `http://127.0.0.1:4101`). No more `Daemon unreachable: Failed to fetch` on first install.
- If something else already owns port 4101, Tierkit transparently falls back to an OS-chosen port and the sidebar uses that base URL automatically.
- If a Tierkit daemon is already running (e.g., you ran `tierkit runtime start` in a terminal), the extension reuses it instead of starting a second one.
- Opt out with `tierkit.autoStartDaemon: false` if you prefer to manage the daemon yourself.

**Korean localization (한글화)**
- Command palette titles, configuration descriptions, and runtime messages are now translated via VS Code's standard `package.nls.*.json` + `l10n/bundle.l10n.*.json` mechanism — VS Code picks the locale automatically.
- The embedded sidebar dashboard (and the GUI served at `http://127.0.0.1:4101/`) localizes labels, placeholders, tooltips, and inline status text based on `navigator.language`. Browsers/VS Code instances set to `ko*` get Korean; everything else stays English.

### Configuration

```jsonc
// .vscode/settings.json
{
  "tierkit.baseUrl":         "http://127.0.0.1:4101",
  "tierkit.statusBar":       true,
  "tierkit.autoStartDaemon": true
}
```

## 0.1.0 — 2026-05-15

Initial sideload release. Not yet on the VS Code Marketplace.

### Features

**Sidebar dashboard** (the main reason to install this extension)
- Activity bar entry **Tierkit** with a three-stacked-tiers icon.
- A webview view (`tierkit.sidebar`) that embeds the same GUI the daemon serves at `http://127.0.0.1:4101/` — no separate browser tab needed.
- Reloads when `tierkit.baseUrl` changes; preserves state when you flip to another sidebar.

What you can do in the sidebar:
- See daemon health + effective freedom at a glance.
- Run a task — pick profile, choose `execute` / `plan` / `review` mode, see the response inline.
- Drive a workflow session (start / approve plan / advance / abandon) with the appropriate buttons for the current state.
- **Security check** card with three tabs:
  - **Redact** — paste text, see which secret patterns hit and the redacted output.
  - **Command** — classify a shell command (`block` / `warn` / `ok`) with matched-rule details.
  - **Path** — check if a file path matches the sensitive-file blocklist.
- **Models** table with a `Test` button per row — probes the provider for reachability + model availability without paying for tokens.
- Usage summary (calls / tokens / cost), per-profile breakdown.

**Status bar + command palette** (unchanged)
- Status bar item polls `GET /v1/health` every 30s.
- Command palette: health, route explain, route run, classify command, usage, session status (now points to the sidebar), and `Tierkit: Focus dashboard sidebar` to open the dashboard from anywhere.

### Configuration

```jsonc
// .vscode/settings.json
{
  "tierkit.baseUrl": "http://127.0.0.1:4101",
  "tierkit.statusBar": true
}
```

### Known limitations
- `routeRun` palette command still requires an explicit profile id (sidebar already routes through `/v1/llm-call`, so use the sidebar Run panel for the smoothest path).
- The Run panel renders the response in one chunk because `/v1/llm-call` currently returns a single JSON after the upstream stream completes. A future `/v1/llm-call/stream` endpoint will give live token-by-token output without changing the sidebar UI.
- No `.vsix` integration tests against the VS Code Extension Development Host yet.
