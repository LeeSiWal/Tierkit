# Tierkit — Architecture

> Status: v1.0 alpha. Export-first pipeline + runtime daemon shipped.

## Package boundaries

```
@tierkit/core
  ├─ plugin/                  # manifest schema, validator, loader, registry
  ├─ command/                 # command definitions and template rendering
  ├─ model/                   # model profile types, risk scorer, route decider
  │  └─ providers/            # provider clients (ollama, openai-compatible, anthropic) — probe() + chat()
  ├─ security/                # permissions, secret redaction, sensitive files, dangerous commands
  ├─ adapter/                 # TierkitAdapter interface + generic markdown adapter
  ├─ config/                  # tierkit.config.json schema + loader
  ├─ fs/                      # safePath (path traversal guard)
  ├─ errors/                  # TierkitError base
  ├─ runtime/                 # HTTP daemon, usage log, budget, llm-call proxy
  └─ usecases/                # business logic: plain async functions per CLI command

@tierkit/cli
  └─ clipanion class commands → call @tierkit/core usecases

@tierkit/adapter-{roo,cline,continue}
  └─ TierkitAdapter implementations consumed by CLI export commands
```

## Non-negotiable rules

1. **`@tierkit/core` must not import `clipanion`** or any CLI framework. It is consumable by VS Code extensions, web UI, or a Tierkit daemon without modification.
2. **All business logic lives in `core/usecases/`** as plain async functions.
3. **Adapters are pure transformers**: `(plugins, outDir) → { files, warnings }`. They never write to disk; `usecases/exportTarget.ts` is the only place that does, and only after resolving every output path via `resolveUnder` AND verifying against the sensitive-file blocklist.
4. **MCP server registration is never automatic** — always approval-gated.
5. **Path traversal must be blocked on both input and output sides.**
6. **Runtime daemon binds to loopback only by default.** No authentication; security depends on the bind address. Do not change to a non-loopback address without adding auth.
7. **Every `/v1/llm-call` is logged** to `usage.jsonl` (success and failure both), and is gated by command-classification, budget, and redaction in that order.

## Data flow: `tierkit export generic --out ./dist`

```
CLI command (ExportGenericCommand)
  ↓ Option parsing
@tierkit/core::exportTarget({ target: "generic", outDir })
  ↓ readRegistry()           — find installed plugins
  ↓ loadPluginFromDirectory  — validate manifest, refuse sensitive references, load files
  ↓ loadConfig               — for adapters that need modelProfiles (Continue)
  ↓ adapter.export({ plugins, outDir, config? })
  ↓ For each emitted file:
  │    match against sensitive blocklist → block (or warn if --allowSensitive)
  │    resolveUnder(outDir, file.path)   → write
ExportTargetResult
  ↑ formatExportResult — render human-readable summary
```

## Data flow: `tierkit runtime start` + `POST /v1/llm-call`

```
CLI (RuntimeStartCommand)
  ↓
@tierkit/core::startRuntime → startServer (node:http on 127.0.0.1:PORT)
  ↓ write {dataDir}/daemon.pid + daemon.port
  ↓ install SIGINT/SIGTERM handler → server.close() + cleanup

[Caller hits POST /v1/llm-call with { profileId, messages, toolCommands? }]
  ↓
executeLlmCall(request, { cwd, env })
  ↓ loadConfig                                — find profile
  ↓ classify each toolCommand                 — refuse if any is "block"
  ↓ checkBudget(usageLogPath, config.budget)  — refuse if status="block"
  ↓ if profile.kind is remote AND security.redactSecretsForRemote:
  │    redactSecrets(message.content) for every message
  ↓ pickProviderClient(profile).chat(profile, request, env)
  ↓ appendUsage(usageLogPath, record)         — success OR failure
  ↓ return LlmCallResult
```

## Where state lives

```
<projectRoot>/
  tierkit.config.json            # user-owned: profiles, routingPolicy, budget, security, runtime
  .tierkit/
    plugins.json                 # registry of installed plugins
    plugins/<id>/                # installed plugin trees
    runtime/
      daemon.pid                 # process pid (deleted on stop)
      daemon.port                # bound port
      usage.jsonl                # append-only LLM call log
```

See [SPEC.md](SPEC.md) for the full design, [PLUGIN_FORMAT.md](PLUGIN_FORMAT.md) for the manifest schema, [SECURITY.md](SECURITY.md) for the security stance, [MODEL_ROUTING.md](MODEL_ROUTING.md) for routing details, and [ADAPTERS.md](ADAPTERS.md) for adapter authoring.
