# Tierkit

Tierkit is a local-first hybrid plugin runtime for AI coding agents.

It lets you write one plugin format and adapt it to tools like Cline, Zoo/Roo Code, and Continue — while routing work across local models, private remote models, and public cloud models based on risk, cost, and workflow policy.

> Status: **v1.5 alpha.** Browser GUI + workflow sessions + 4 export adapters + HTTP daemon shipped. See the [roadmap in SPEC.md §15](docs/SPEC.md#15-roadmap).

> 🇰🇷 **한글 시작 가이드:** [docs/GUIDE.ko.md](docs/GUIDE.ko.md) — 설치부터 첫 모델 호출까지 4단계.

## What's in this monorepo

| Package | What it does |
|---|---|
| [`@tierkit/core`](packages/core)                                   | Plugin manifest, validator, loader, registry, model profile types, adapter interface, business-logic usecases. Has no dependency on any CLI framework or IDE. |
| [`@tierkit/cli`](packages/cli)                                     | The `tierkit` CLI built on [clipanion](https://mael.dev/clipanion/). Thin wrapper over `@tierkit/core` usecases. |
| [`@tierkit/adapter-roo`](packages/adapter-roo)                     | Exports Tierkit plugins for Roo Code / Zoo Code (`.roomodes` + `.roo/`). |
| [`@tierkit/adapter-cline`](packages/adapter-cline)                 | Exports Tierkit plugins for Cline (`.clinerules/` + `.cline/mcp/`). |
| [`@tierkit/adapter-continue`](packages/adapter-continue)           | Exports Tierkit plugins for Continue (`.continue/{config.yaml, rules, prompts, mcp}`). |
| [`@tierkit/plugin-superpowers`](packages/plugin-superpowers)       | Bundled sample plugins: `superpowers-free` (v0.1) plus `guided` / `balanced` / `strict` (later). |

## Quick start (v0.1)

```sh
pnpm install
pnpm -r build

# Validate the bundled sample plugin
node packages/cli/dist/index.js plugin validate packages/plugin-superpowers/plugins/superpowers-free

# Export it as plain markdown
node packages/cli/dist/index.js export generic --out ./dist/exports

# Or export for Roo / Zoo Code (.roomodes + .roo/ at the project root)
node packages/cli/dist/index.js export roo

# Or export for Cline (.clinerules/ + .cline/mcp/ at the project root)
node packages/cli/dist/index.js export cline

# Or export for Continue (.continue/{config.yaml, rules, prompts, mcp} at the project root)
node packages/cli/dist/index.js export continue

# v0.5 — inspect model routing
node packages/cli/dist/index.js models list
node packages/cli/dist/index.js models test localFast
node packages/cli/dist/index.js route explain "refactor the auth service" --files 8
node packages/cli/dist/index.js config show

# v0.6 — security checks
node packages/cli/dist/index.js check redact ./scratch.txt
node packages/cli/dist/index.js check command "rm -rf /"
node packages/cli/dist/index.js check path .env

# v1.0 — runtime alpha (loopback HTTP daemon)
node packages/cli/dist/index.js runtime start             # foreground; ^C to stop
node packages/cli/dist/index.js runtime status            # query daemon state
node packages/cli/dist/index.js usage                     # per-profile call/token/cost summary
node packages/cli/dist/index.js plugin enable superpowers-free
node packages/cli/dist/index.js plugin disable superpowers-free
node packages/cli/dist/index.js plugin remove superpowers-free

# Daemon endpoints (default http://127.0.0.1:4101)
#   GET  /                            ← browser GUI (alias for /v1/ui)
#   GET  /v1/health
#   POST /v1/route                    { task, filesTouchedEstimate?, involvesSecrets?, involvesProductionInfra? }
#   POST /v1/check/command            { command }
#   POST /v1/check/path               { path }
#   POST /v1/redact                   { text }
#   POST /v1/llm-call                 { profileId, messages, toolCommands? }
#   GET  /v1/usage
#   GET  /v1/budget
#   GET  /v1/session                  ← current session + effective freedom
#   POST /v1/session/start            { task }
#   POST /v1/session/approve-plan
#   POST /v1/session/advance          { toState: planning|implementing|reviewing|done|abandoned, reason? }
#   POST /v1/session/abandon          { reason? }
#   GET  /v1/models                   ← list configured profiles
#   GET  /v1/plugins                  ← list installed plugins

# Browser GUI — once `tierkit runtime start` is up:
#   open http://127.0.0.1:4101/       # run tasks, drive sessions, watch usage, no terminal

# v1.1 — actually run the model (streaming)
node packages/cli/dist/index.js route run "summarize this project"
node packages/cli/dist/index.js route run "outline a plan" --mode plan --files 8
node packages/cli/dist/index.js route run "review the auth diff" --mode review --profile privateRemoteStrong
node packages/cli/dist/index.js route run "say OK" --no-stream
node packages/cli/dist/index.js route run "audit prod secrets" --secrets --prod --local-only

# v1.2 — workflow sessions (guided/balanced/strict)
node packages/cli/dist/index.js plugin install packages/plugin-superpowers/plugins/superpowers-strict
node packages/cli/dist/index.js plugin enable superpowers-strict
node packages/cli/dist/index.js session start "refactor auth middleware"
node packages/cli/dist/index.js route run "outline plan" --mode plan
node packages/cli/dist/index.js session approve-plan
node packages/cli/dist/index.js session advance implementing
node packages/cli/dist/index.js route run "carry out the plan"
node packages/cli/dist/index.js session advance reviewing
node packages/cli/dist/index.js route run "review the diff" --mode review
node packages/cli/dist/index.js session advance done

# v1.3 — talk to the runtime from any tool (TypeScript SDK)
#   import { TierkitClient } from "@tierkit/client";
#   const client = new TierkitClient();        // defaults to http://127.0.0.1:4101
#   await client.health();
#   for await (const evt of client.llmCallStream({ profileId: "localFast", messages: [...] })) { ... }
#
#   See packages/vscode-tierkit/ for a VS Code companion that uses the same SDK.
#
# v1.4 — see docs/INTEGRATIONS.md for per-tool binding paths (Roo / Cline / Continue / your own)
```

## Design

See [docs/SPEC.md](docs/SPEC.md) for the full design specification — positioning, plugin format, model routing, security stance, and the v0.1+ roadmap.

## License

MIT
