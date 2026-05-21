# Claude Agent SDK — integration spike

**Date:** 2026-05-21
**Goal:** Determine whether Tierkit can embed `@anthropic-ai/claude-agent-sdk` as a provider while preserving Tierkit's policy stack (redaction, approval, command-gate, usage logging).
**Conclusion:** **HOLD** official Claude Agent SDK integration. Path A (SDK as a model client, AgentLoop owns tools) is architecturally not viable — the SDK is a subprocess orchestrator that delegates all LLM calls to the installed `claude` CLI binary; Tierkit cannot insert itself between the SDK and Anthropic. Path B (SDK as a wrapper, with `canUseTool`/`PreToolUse` hooks) is technically feasible but weakens Tierkit's redaction guarantee — conversation history and tool-loop context are managed inside Claude CLI, so Tierkit can pre-redact the initial prompt but cannot enforce redaction over the accumulating session. The product's "token firewall" promise would blur if shipped this way. Recommended pivot: **v0.15 = Tierkit MCP Bridge** — let Claude Code remain the agent, expose Tierkit's gated tools as an MCP server.

## Setup

- SDK package: `@anthropic-ai/claude-agent-sdk` v`0.3.146` (published 2026-05-21 — same day as spike; 190 versions exist)
- Install location: `/tmp/tierkit-sdk-spike`
- Node: v24.10.0
- Peer dependencies required (not auto-installed): `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`
- Optional platform binary: `@anthropic-ai/claude-agent-sdk-darwin-arm64` (not installed in spike — not needed since claude CLI is in PATH)

---

## Q1. Subscription auth resolution order

**Finding:** The SDK itself does NOT authenticate against Anthropic. It spawns the locally-installed `claude` CLI binary and that binary handles auth. The SDK is a process-management wrapper.

**Auth resolution (from SDK source `sdk.mjs`):**

1. **CLI binary discovery** — `G2()` function tries `require.resolve('@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude')` in order. On darwin-arm64, it checks `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`. Falls back to the next installed platform package. If none found, falls back to…

2. **PATH-based fallback** — if no native binary package is installed, the SDK calls whatever `claude` is on the system PATH (confirmed: `/opt/homebrew/bin/claude` on this machine).

3. **Custom binary** — callers can pass `options.pathToClaudeCodeExecutable` to override.

The spawned `claude` CLI then does its own auth in this order (from SDK's session-resume prep code):

1. Reads `CLAUDE_CONFIG_DIR` env var (default: `~/.claude`) — computed at startup as `(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC")`
2. Loads `$CLAUDE_CONFIG_DIR/.credentials.json` (contains `claudeAiOauth.accessToken`, `refreshToken`, `expiresAt`, `scopes`, `subscriptionType`)
3. If `CLAUDE_CONFIG_DIR` is NOT set AND `ANTHROPIC_API_KEY` is NOT set AND `CLAUDE_CODE_OAUTH_TOKEN` is NOT set → falls back to macOS Keychain (`security find-generic-password`) on darwin platforms (5s timeout)
4. Reads `ANTHROPIC_API_KEY` env var for direct API key auth (bypasses subscription)
5. Reads `CLAUDE_CODE_OAUTH_TOKEN` env var for OAuth token

**Key SDK source lines (minified, from `sdk.mjs`):**
```js
// Config dir resolution
var p6 = v$(()=>{
  return (process.env.CLAUDE_CONFIG_DIR ?? Ok(wk(), ".claude")).normalize("NFC")
}, ()=>process.env.CLAUDE_CONFIG_DIR);

// During session resume prep — credentials copy + fallback:
try {
  z = await BS(u6(B, ".credentials.json"), "utf-8")
} catch(N) { if(!Z1(N)) throw N }
if (!V && !(Y??process.env).ANTHROPIC_API_KEY && !(Y??process.env).CLAUDE_CODE_OAUTH_TOKEN)
  z = await S6$() ?? z;   // S6$ = macOS keychain lookup

// S6$ = macOS keychain:
function S6$() {
  if (process.platform !== "darwin") return Promise.resolve(void 0);
  return new Promise((Q) => {
    D6$("security", ["find-generic-password", "-a", gZ(), "-w", "-s", fZ(yZ)],
      {encoding:"utf-8", timeout:5000}, (J,Y) => Q(J ? void 0 : Y.trim()||void 0))
  });
}
```

**Verified credentials.json structure on this machine:**
```json
{
  "claudeAiOauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": "...",
    "scopes": "...",
    "subscriptionType": "...",
    "rateLimitTier": "..."
  },
  "organizationUuid": "..."
}
```

**`apiKeySource` in init message:** Reports `"none"` when using subscription OAuth (not `ANTHROPIC_API_KEY`). This is the `ApiKeySource` union: `'user' | 'project' | 'org' | 'temporary' | 'oauth'`.

---

## Q2. Behavior without ANTHROPIC_API_KEY

**Repro script:** `/tmp/tierkit-sdk-spike/repro-no-key.mjs`

**Observed behavior:**

- `ANTHROPIC_API_KEY` unset, `CLAUDE_CODE_OAUTH_TOKEN` unset
- SDK import succeeds immediately (no key check at import time)
- `query()` is non-blocking — returns an `AsyncGenerator` immediately
- Iteration triggers subprocess spawn → `claude` CLI at `/opt/homebrew/bin/claude` is found via PATH
- CLI starts with credentials from `~/.claude/.credentials.json` (subscription OAuth)
- A `system:init` message is emitted after ~2s (CLI startup)
- Session proceeds using subscription token — **no `ANTHROPIC_API_KEY` needed at all**
- `apiKeySource: "none"` in the init message confirms OAuth subscription path

**If neither OAuth credentials nor API key exist:**
- On darwin: macOS Keychain lookup runs (`security find-generic-password`, 5s timeout)
- On other platforms: Claude CLI would emit auth error (`SDKAuthStatusMessage` with `error`)
- The `SDKAssistantMessageError` union includes `'authentication_failed'` for this case

**Conclusion for Tierkit:** A user with a `claude` subscription and logged-in CLI **requires no configuration** — the SDK just works. A user with only an API key sets `ANTHROPIC_API_KEY` in the subprocess env via `options.env`. Tierkit can pass its configured key this way.

---

## Q3-Q5. Tool gating

**Repro script:** `/tmp/tierkit-sdk-spike/repro-tool-gating.mjs`

### allowedTools

**Test:** `allowedTools: ['Read', 'Glob', 'Grep']`

**Result: CONFIRMED BUG / MISNAMED OPTION.** The `allowedTools` option does NOT restrict which tools are exposed to the model. It controls which tools are **auto-approved without user prompting** (maps to `--allowedTools` CLI flag). With `allowedTools: ['Read', 'Glob', 'Grep']`, the INIT message reported **all 87 tools** including `Task`, `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`.

From the SDK source: `if(U1.length>0)i.push("--allowedTools",U1.join(","))` — this is a permission-approval allowlist, not an exposure filter.

The user's cited GitHub issue (allowedTools doesn't limit tool exposure) is confirmed real.

### disallowedTools

**Test:** `disallowedTools: ['Bash', 'Edit', 'Write']`

**Result: WORKS CORRECTLY.** The INIT message showed `Bash`, `Edit`, and `Write` absent from the tools list. All other tools remained. `disallowedTools` genuinely removes tools from the model's context.

From source: `if(u$.length>0)i.push("--disallowedTools",u$.join(","))` → CLI flag removes tools from system prompt.

### tools option (base set restriction)

**Test 1:** `tools: []` — disable all built-ins

**Result: PARTIALLY WORKS.** `tools: []` removed all standard built-in tools. However, MCP tools from the user's `~/.claude/settings.json` (`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`, etc.) still appeared. `LSP` also remained. MCP tools are loaded independently of the `--tools` flag.

To truly isolate, also pass `settingSources: []` to prevent loading user MCP server configs.

**Test 2:** `tools: ['Read', 'Glob']`

**Result: WORKS.** Only `Glob`, `LSP`, and `Read` appeared plus MCP tools. Using `tools: ['Read', 'Glob']` + `settingSources: []` gives a fully restricted, clean toolset.

### permissionMode

**Test:** `permissionMode: 'plan'`

**Result: Mode is set in init message, but all tools still listed.** `permissionMode: 'plan'` appears in the INIT message's `permissionMode` field. In plan mode the CLI refuses to execute write/edit tools but all tools still appear in the `tools` array. This is expected — the system prompt enforces plan-mode restrictions.

**Test:** `permissionMode: 'dontAsk'`

**Result: Tools are not removed, permissions are auto-denied.** When a tool call was attempted (Read), the user message came back with the tool denied automatically: `"Permission to use Read has been denied because Claude Code is running in don't ask mode."` No `canUseTool` callback fired in dontAsk mode.

### customTools only (can we replace built-ins entirely?)

The `tools` option set to an explicit array (e.g., `['Read', 'Glob']`) combined with `settingSources: []` effectively creates a clean, restricted tool environment. There is no MCP-server-based custom tool API in the current SDK — custom tools must be defined as MCP servers registered via `mcpServers` option or `createSdkMcpServer()`.

The `canUseTool` callback provides a programmatic gate that fires **before execution** even when tools are listed — so Tierkit can use it to deny at runtime regardless of which tools are in the system prompt.

---

## Q6. tool_use round-trip

**Repro scripts:** `/tmp/tierkit-sdk-spike/repro-canUseToolHook.mjs`, `/tmp/tierkit-sdk-spike/repro-canUseToolHook2.mjs`

**Finding: `canUseTool` IS the interception point. It is synchronous-from-the-model's-perspective and fires before tool execution.**

**Mechanism:**

1. Model emits `tool_use` block (arrives as `SDKAssistantMessage` with `message.content[n].type === 'tool_use'`)
2. SDK's internal control channel sends `can_use_tool` `control_request` to the caller's `canUseTool` callback
3. The callback returns `PermissionResult` synchronously (from the async generator's perspective)
4. SDK passes the decision back to the CLI subprocess
5. If `behavior: 'allow'`, tool executes. If `behavior: 'deny'`, tool result comes back as `is_error: true`

**Verified callback signature:**
```typescript
canUseTool: async (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal,
  suggestions?: PermissionUpdate[],
  blockedPath?: string,
  decisionReason?: string,
  title?: string,
  displayName?: string,
  description?: string,
  toolUseID: string,
  agentID?: string,
}) => Promise<PermissionResult>
```

**Verified `PermissionResult` shapes:**
```typescript
// Allow
{ behavior: 'allow', updatedInput?: Record<string, unknown>, updatedPermissions?: PermissionUpdate[], toolUseID?: string }
// Deny  
{ behavior: 'deny', message: string, interrupt?: boolean, toolUseID?: string }
```

**Key observations from live repro:**
- `canUseTool` fires with `toolName: 'Read'`, `input: { file_path: '/tmp/test.txt' }`, `toolUseID: 'toolu_01RAewL5aXu3iqSpd3fUjaK1'`
- Denying returns `tool_result` with `is_error: true, content: '"Tierkit policy gate: blocked"'`
- The model sees the error and can continue the conversation
- `dontAsk` mode auto-denies WITHOUT firing `canUseTool` — the callback is only invoked in modes that prompt

**`updatedInput` for redaction:** The `PermissionResult` allows returning `updatedInput` to modify tool arguments before execution. This is how Tierkit could inject redacted versions of file paths or command arguments. However, the **prompt text itself** (what the user asked for) goes directly to the model and cannot be intercepted via `canUseTool`.

**Hooks as secondary gate:** The `hooks.PreToolUse` callback fires with the same `tool_name` + `tool_input` + `tool_use_id` and allows `permissionDecision: 'deny'`. This is a lower-level hook that fires even in `dontAsk` mode.

**tool_use interception is Path B (wrapper), not Path A (provider substitution).** The SDK runs `tool_use` blocks itself inside the CLI subprocess. Tierkit cannot intercept the raw Anthropic API `tool_use` JSON before it reaches the model — that happens inside the CLI. What Tierkit gets is the post-decision callback (`canUseTool`). This is sufficient for command-gate and approval but insufficient for pre-prompt redaction.

---

## Q7. Event shape

All shapes captured from live run (no secret content included). The init message reflects the user's full Claude Code configuration including MCP servers from `~/.claude/settings.json`.

### Init message (`system:init`)
```typescript
{
  type: "system",
  subtype: "init",
  cwd: string,                // Current working directory
  session_id: UUID,
  tools: string[],            // All available tool names
  mcp_servers: Array<{name: string, status: string}>,
  model: string,              // e.g. "claude-opus-4-7[1m]"
  permissionMode: PermissionMode,
  slash_commands: string[],
  apiKeySource: ApiKeySource,  // "none" for subscription OAuth
  claude_code_version: string, // e.g. "2.1.146"
  output_style: string,
  agents: string[],
  skills: string[],
  plugins: Array<{name: string, path: string}>,
  analytics_disabled: boolean,
  uuid: UUID,
  memory_paths: Record<string, string>,  // e.g. {"auto": "/Users/..."}
  fast_mode_state?: "off" | "cooldown" | "on",
  betas?: string[],
}
```

### Assistant message with text (`assistant:`)
```typescript
{
  type: "assistant",
  message: BetaMessage,      // Full Anthropic API message object
  // message.content[n] can be:
  //   { type: "text", text: string }
  //   { type: "tool_use", id: string, name: string, input: Record<string, unknown> }
  //   { type: "thinking", thinking: string, signature: string }
  parent_tool_use_id: string | null,
  session_id: UUID,
  uuid: UUID,
  request_id?: string,       // Anthropic API request ID
  subagent_type?: string,
  task_description?: string,
  error?: SDKAssistantMessageError,
}
```

BetaMessage includes full usage (input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, service_tier, etc.).

### User message with tool_result (`user:`)
```typescript
{
  type: "user",
  message: {
    role: "user",
    content: Array<{
      type: "tool_result",
      tool_use_id: string,
      content: string,
      is_error: boolean,
    } | {
      type: "text",
      text: string,
    }>
  },
  parent_tool_use_id: string | null,
  session_id: UUID,
  uuid: UUID,
  timestamp?: string,         // ISO 8601
  tool_use_result?: string,   // Full error message for is_error results
  isSynthetic?: boolean,
  priority?: "now" | "next" | "later",
  origin?: SDKMessageOrigin,
}
```

### Result message — success (`result:success`)
```typescript
{
  type: "result",
  subtype: "success",
  duration_ms: number,
  duration_api_ms: number,
  ttft_ms?: number,
  is_error: false,
  num_turns: number,
  result: string,            // Final text response
  stop_reason: string | null,
  total_cost_usd: number,    // Cumulative USD cost for entire session
  usage: NonNullableUsage,   // Cumulative BetaUsage across all turns
  modelUsage: Record<string, ModelUsage>,  // Per-model breakdown with costUSD
  permission_denials: SDKPermissionDenial[],
  structured_output?: unknown,
  terminal_reason?: TerminalReason,
  fast_mode_state?: FastModeState,
  uuid: UUID,
  session_id: UUID,
}
```

### Result message — error (`result:error_max_turns`, `result:error_during_execution`, `result:error_max_budget_usd`)
```typescript
{
  type: "result",
  subtype: "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries",
  duration_ms: number,
  duration_api_ms: number,
  is_error: true,
  num_turns: number,
  stop_reason: string | null,
  total_cost_usd: number,
  usage: NonNullableUsage,
  modelUsage: Record<string, ModelUsage>,
  permission_denials: SDKPermissionDenial[],
  errors: string[],
  terminal_reason?: TerminalReason,
  uuid: UUID,
  session_id: UUID,
}
```

**Usage and cost are always in the `result` message.** Per-turn token counts are in each `SDKAssistantMessage.message.usage`. The `modelUsage` record breaks down by model string (e.g., `"claude-opus-4-7[1m]"` vs `"claude-haiku-4-5-20251001"`) with `costUSD`, `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `contextWindow`, `maxOutputTokens`.

### Rate limit event
```typescript
{
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected",
    resetsAt?: number,        // Unix timestamp
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage",
    overageStatus?: "allowed" | "allowed_warning" | "rejected",
    overageDisabledReason?: string,
    isUsingOverage?: boolean,
    surpassedThreshold?: number,
  },
  uuid: UUID,
  session_id: UUID,
}
```

**Observation:** This fires on EVERY turn, even when `status: "allowed"`. Tierkit can use this to monitor subscription rate limit status.

---

## Q8. Bundle impact

**Raw SDK on disk (sdk.mjs entry point only):** 844 KB

**All SDK .mjs/.js files:**
- `sdk.mjs` — 844 KB (main entry)
- `assistant.mjs` — 1.5 MB (remote control / bridge worker)
- `bridge.mjs` — 1.1 MB (claude.ai WebSocket bridge)
- `browser-sdk.js` — 621 KB (browser build)
- `extractFromBunfs.js` — 6.5 KB (bun compile helper)
- **Total: ~4 MB pre-bundle**

**tsup `noExternal` bundle estimate:** Not run (tsup not installed in spike sandbox; would require full peer deps). However, since `sdk.mjs` already ships pre-bundled (it's a self-contained minified file with all deps inlined including `@anthropic-ai/sdk`, `zod`, and `@modelcontextprotocol/sdk`), a tsup `noExternal` pass would essentially just re-wrap it. Expected output: ~850–900 KB for the main `sdk.mjs` surface.

**Dynamic import feasibility:** The SDK uses `import()` internally (for platform binary resolution). Tierkit could `import('@anthropic-ai/claude-agent-sdk')` lazily when `claude` adapter is requested, keeping the SDK out of the main bundle's critical path. This is the recommended approach.

**Peer deps note:** The SDK ships pre-bundled with `@anthropic-ai/sdk`, `zod/v4`, and `@modelcontextprotocol/sdk` inlined into its `.mjs` files. The peer dependency declarations in `package.json` are for TypeScript type resolution, not runtime. This avoids version conflicts with Tierkit's own zod/sdk installations.

**Bundle path recommendation for Tierkit:** Do NOT `noExternal` this SDK. Instead, import it as a peer dep and let pnpm resolve it. The binary is already distributed via optional platform packages; Tierkit's `vscode-tierkit` tsup build should `external: ['@anthropic-ai/claude-agent-sdk']`.

---

## Stakeholder decision (post-spike)

**Result:** HOLD official Claude Agent SDK integration.

**Reason:**
- Path A is not viable: the SDK is not a pure model client; it is a Claude CLI-backed agent runner.
- Path B works functionally but weakens Tierkit's redaction guarantee because conversation history and tool-loop context are managed inside Claude CLI.
- The safest next direction is the MCP Bridge: let Claude Code remain the agent, and let Tierkit provide gated tools via MCP.

**What we will NOT do:**
- Do not ship Claude Agent SDK as a normal `ProviderClient` in v0.15.
- Do not replace the `claudeCode` profile with SDK-backed behavior.
- Do not claim Tierkit redacts prompts typed directly into Claude Code.

**What we will do:**
- Start a new v0.15 spec for **Tierkit MCP Bridge** at
  `docs/superpowers/specs/2026-05-21-v0.15-tierkit-mcp-bridge-design.md`.
- Tierkit becomes a local policy-gated tool gateway that Claude Code (and any
  MCP-aware client) can invoke. Redaction, approval, command-gate, and
  activity logging continue to apply at the tool boundary.

The technical recommendation below is preserved as a record of what the spike
found; the stakeholder decision above governs Tierkit's product direction.

---

## Technical recommendation (spike findings)

**Path B — Wrapper, not Provider** (as a record of what the spike investigated, not what we will ship).

The SDK is fundamentally a subprocess orchestrator. It spawns the installed `claude` CLI and communicates via JSON streams over stdin/stdout. Tierkit cannot insert itself as an Anthropic API provider (Path A) because the actual API calls happen inside the CLI subprocess — Tierkit is upstream of the subprocess, not between the subprocess and Anthropic.

**What Tierkit CAN do via the SDK:**

1. **Command gate** — `canUseTool` callback fires synchronously before each tool execution. Return `{ behavior: 'deny', message: '...' }` to block. The callback receives tool name, full input, and a `toolUseID`. This is Tierkit's strongest gate.

2. **Approval UI** — `canUseTool` can show a UI dialog and return the decision. The callback supports `updatedInput` to modify arguments (useful for path normalization, not full redaction).

3. **Usage logging** — The `result` message includes `total_cost_usd`, `modelUsage` (per-model cost breakdown), and `usage` (cumulative tokens). The `rate_limit_event` fires every turn with subscription rate limit status. Per-turn cost is derivable from `SDKAssistantMessage.message.usage`.

4. **Tool restriction** — `disallowedTools` removes tools from the model's context (verified). `tools: []` + `settingSources: []` creates a fully sandboxed tool environment. `permissionMode: 'plan'` enforces read-only.

5. **Hooks** — `hooks.PreToolUse` provides a second gate that fires even in `dontAsk` mode (where `canUseTool` does NOT fire).

**What Tierkit CANNOT do via the SDK:**

1. **Pre-prompt redaction** — the `prompt` string and conversation history go directly to the CLI subprocess. Tierkit has no intercept point between the user's query and the model's context window. If a user's prompt contains a secret, the SDK will send it. Tierkit would have to redact the string before calling `query()` — a separate pre-processing step, not an SDK feature.

2. **Provider substitution** — cannot route to Ollama/OpenAI/Anthropic API directly; the SDK always goes through the `claude` CLI binary and its auth.

3. **Raw tool_use JSON inspection before model processing** — by the time `canUseTool` fires, the model has already decided on the tool call and sent it. Tierkit cannot intercept the decision, only the execution.

**Caveats:**

- The SDK's architecture assumes `claude` CLI is installed. In environments without it (CI containers, fresh installs), Tierkit must either bundle a native binary or fall back to its own provider stack.
- `settingSources: []` is essential for isolation. Without it, the user's `~/.claude/settings.json` MCP servers load automatically (51+ tools on this machine), bypassing Tierkit's tool whitelist.
- The `canUseTool` path requires `permissionMode` to be `'default'` or `'acceptEdits'`. In `'dontAsk'` or `'bypassPermissions'` modes the callback is NOT invoked. Tierkit must enforce `'default'` mode when gates are active.
- `Glob`, `Read`, and MCP tools from the claude.ai sidebar (Gmail, Google Calendar, etc.) require handling. In Tierkit's use case, `disallowedTools` should enumerate all MCP tools from user config, or `settingSources: []` should suppress them entirely.

---

## Followups / unknowns

1. **Pre-prompt redaction architecture:** Tierkit must apply its redaction engine to the prompt string before calling `query()`. This is an external pipeline step, not SDK-native. Needs design work.

2. **Provider fallback when `claude` CLI is absent:** The SDK will throw `"Claude Code executable not found at ..."`. Tierkit needs a graceful error path and should document the CLI requirement for the claude-agent adapter.

3. **canUseTool with dontAsk mode:** The live test confirmed `canUseTool` does NOT fire in `dontAsk` mode — auto-denial happens inside the CLI. To use Tierkit's approval UI, `permissionMode` must be `'default'`. Confirm this is acceptable for the v0.15 use case.

4. **Subscription rate limits vs per-token billing:** The SDK exposes subscription rate limit info via `rate_limit_event`. If the user is on a subscription plan, Tierkit's `total_cost_usd` from the result message may report correctly (derived from token counts × model rates), but the actual charge to the user is a flat subscription fee. The v0.12 paymentModel dimension needs a new value: `'subscription'`.

5. **Multi-turn sessions:** The SDK's `resume` option allows continuing existing sessions. Tierkit's session management needs to map to SDK session IDs. `persistSession: false` disables this.

6. **`settingSources: []` isolation completeness:** Even with this flag, `LSP` tool remained in some tests. Verify whether LSP is a built-in that cannot be removed.

7. **Version stability:** The SDK published 190 versions; the current `claudeCodeVersion: "2.1.146"` bumps with every Claude Code release. Semver pinning with `^0.3.0` would track Claude Code 2.x but may get breaking changes. Recommend pinning exact version in Tierkit's package and updating manually.

---

## Appendix: Repro scripts

### repro-no-key.mjs (Q2)

```js
// See /tmp/tierkit-sdk-spike/repro-no-key.mjs
// Key finding: SDK starts without ANTHROPIC_API_KEY by using ~/.claude/.credentials.json
// apiKeySource reports "none" for subscription OAuth path
// SDK emits system:hook_started and system:hook_response before system:init
// query() hangs waiting for model response if no timeout is set
```

### repro-tool-gating.mjs (Q3-Q5)

```js
// See /tmp/tierkit-sdk-spike/repro-tool-gating.mjs
// Key findings:
// - allowedTools: ['Read'] → all 87 tools still in init (CONFIRMED BUG/MISNAME)
// - disallowedTools: ['Bash','Edit','Write'] → those 3 absent from init (WORKS)
// - tools: [] → built-ins removed but MCP tools remain unless settingSources: []
// - permissionMode: 'plan' → sets mode in init but tools all listed
// - permissionMode: 'dontAsk' → tools listed, auto-denied without canUseTool call
```

### repro-canUseToolHook2.mjs (Q6)

```js
// See /tmp/tierkit-sdk-spike/repro-canUseToolHook2.mjs
// Key findings:
// - canUseTool fires before tool execution in 'default' permissionMode
// - callback receives: toolName, input, {signal, suggestions, blockedPath, decisionReason,
//   title, displayName, description, toolUseID, agentID}
// - deny returns tool_result with is_error: true visible in SDK stream
// - canUseTool does NOT fire in 'dontAsk' mode
// - updatedInput allows modifying tool arguments (path for redaction)
// - Actual cost of this test: $0.107 (1 API call, claude-opus-4-7, 14K cached tokens)
```

### repro-event-shapes.mjs (Q7)

```js
// See /tmp/tierkit-sdk-spike/repro-event-shapes.mjs
// Captured: system:init, rate_limit_event, assistant:, user:, result:error_max_turns
// Full shapes with field names documented above in Q7
// Actual cost of this test: $0.043 (1 API call, claude-opus-4-7, 14K cached tokens)
```

---

*Spike conducted 2026-05-21. No Tierkit production code was modified. All API calls used the user's existing `claude` subscription. Total charges from repro scripts: approximately $0.25 USD (4 short sessions, subscription OAuth, mostly cache hits).*
