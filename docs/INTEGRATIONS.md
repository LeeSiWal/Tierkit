# Tierkit — Tool integrations (v1.3 / v1.4)

How third-party AI coding agents (Roo, Cline, Continue, your-own) connect to a running Tierkit runtime so that **every model call inherits Tierkit's policy** (routing, redaction, command-gating, budget, usage log, session enforcement).

## Two integration paths

### 1. Export-first (v0.2–v0.4) — no runtime required

Author your workflow once in the [Tierkit plugin format](PLUGIN_FORMAT.md), then export:

```sh
tierkit export roo        # → .roomodes + .roo/{commands,rules,mcp}
tierkit export cline      # → .clinerules/00-…/10-…/20-…/30-…
tierkit export continue   # → .continue/{config.yaml, rules, prompts, mcp}
```

The target tool reads its own files. Tierkit isn't in the loop at execution time. Permission contracts and rules are surfaced *linguistically*; runtime enforcement is the tool's job. Use this path when you want zero infra and accept that the policy is advisory.

### 2. Runtime-integrated (v1.0+) — daemon in the loop

Run the daemon:

```sh
tierkit runtime start          # http://127.0.0.1:4101
```

Then have the tool call **through** the daemon for every model call:

```ts
import { TierkitClient } from "@tierkit/client";

const tierkit = new TierkitClient();          // defaults to http://127.0.0.1:4101
for await (const evt of tierkit.llmCallStream({
  profileId: "localFast",
  messages: [{ role: "user", content: userTask }],
  toolCommands: pendingShellCommands,         // optional — daemon classifies before sending
})) {
  if (evt.type === "delta") writeChunk(evt.text);
  else if (evt.type === "error") surfaceError(evt);
}
```

Every call now goes through:
- `runRoute` workflow gate (refuses execute when session policy says no — v1.2)
- `classifyCommand` for any `toolCommands[]` (block / warn / ok — v0.6)
- `checkBudget` (refuses past daily/monthly limit — v1.0)
- `redactSecrets` for messages bound for remote tiers (v0.6 rules — v1.1 wire-up)
- `appendUsage` (every call, success or failure — v1.0)

## Recommended bindings per tool

### Roo / Zoo Code

**Status: v1.3 scaffold available** ([@tierkit/vscode-tierkit](../packages/vscode-tierkit)).

- Short term: install the Tierkit companion extension. Run `tierkit export roo` to get `.roomodes` + rules. Use the command palette entries to call Tierkit explicitly from inside VS Code.
- Long term: when Roo's extension API exposes a model-call interception hook, the Tierkit companion patches in. Until then, the companion runs alongside Roo, not inside it.

### Cline

- Cline reads `.clinerules/` as auto-loaded context. `tierkit export cline` populates that — including a generated **permission contract** that puts the workflow stance in front of the model on every turn.
- For runtime enforcement: a Cline plugin that wraps its provider clients in `@tierkit/client` would route through the daemon. Cline doesn't yet expose a public extension API for that swap; if/when it does, the path is `import { TierkitClient } from "@tierkit/client"` and shim the provider class.

### Continue

- Continue auto-loads `.continue/{config.yaml, rules, prompts}` after `tierkit export continue`. Prompts become native slash commands (e.g. `/superpowers-free-brainstorm`).
- For runtime: Continue supports OpenAI-compatible providers. **You can point Continue at the Tierkit daemon as if it were an OpenAI-compatible API** — a future v1.5 endpoint `POST /v1/openai/chat/completions` would make this drop-in. (Open question: do we want to ship that proxy? It would let Continue's existing chat/edit/autocomplete pipelines route through Tierkit policy with zero Continue-side code.)

### Your own tool / web UI / CLI

Use [`@tierkit/client`](../packages/client). One package, typed surface, talks to the same daemon as everyone else.

## Integration checklist

Before you bind a tool to Tierkit, confirm:

- [ ] The tool can be configured to call a local HTTP endpoint for model requests, OR you have a way to intercept its model-call code path.
- [ ] You can pass the user's task verbatim as a `messages: ChatMessage[]` array (Tierkit doesn't enforce a prompt template — `TaskContextBuilder` only kicks in when you call `route run`, not `/v1/llm-call`).
- [ ] You're OK with the daemon's stable failure codes (`unknown-profile`, `dangerous-command-blocked`, `budget-exceeded`, `workflow-gate-blocked`, …). Each one is recoverable; your wrapper can branch on `code` to render a useful UI.
- [ ] Your tool can degrade gracefully when the daemon isn't running. The companion extension renders an "offline" status bar item; your tool should at minimum fall back to a clear error.

## Running in code-server (browser VS Code)

Tierkit's VS Code extension works in [code-server](https://github.com/coder/code-server)
(VS Code in a browser) starting with v0.8.0. The setup is identical to Desktop:

1. Build the VSIX: `cd packages/vscode-tierkit && pnpm package:sideload`
2. Copy the VSIX into your code-server container or host.
3. Install: `code-server --install-extension tierkit-vscode-X.Y.Z.vsix`
4. Open the Tierkit icon in the activity bar.

Under the hood, the sidebar webview communicates with the extension host
via postMessage; the extension host proxies all calls to the daemon
running on `127.0.0.1:4101`. No port forwarding or external daemon URL is
needed — the daemon stays loopback-only on the server.

**Limitation:** `vscode.dev` and other web-only extension hosts are not
supported, because they cannot spawn the Node-based daemon process.

## What this milestone (v1.4) intentionally does NOT do

- No automatic in-process patching of Roo/Cline/Continue. Those tools change their internals on their own schedules; Tierkit refuses to monkey-patch their globals.
- No published .vsix on the VS Code marketplace yet. The companion is a scaffold; releasing it is its own work item that includes integration tests against the VS Code extension host harness.
- No "auto-detect installed tools" feature. Each tool wires itself in by depending on `@tierkit/client` or by being pointed at the daemon's URL.

The point of v1.4 is that **the path is documented and the SDK exists.** Adding new tools is now a per-tool integration, not a Tierkit-core feature.
