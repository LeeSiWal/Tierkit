# Tierkit — Model Routing

> Status: v0.5. Types + risk scorer + `route explain` + `models test` CLI shipped. Live runtime integration (auto-route on every agent action) lands in v1.0+.

## Tiers

| Tier | When to use | Approval |
|---|---|---|
| `local-device`    | Most tasks. Default starting point. | No |
| `private-remote`  | Tasks too heavy for local but trusted infrastructure. | Configurable per profile. |
| `public-cloud`    | Architecture, debugging non-obvious bugs, production-sensitive design. | **Yes — always**. Review-only by default. |

Tierkit always *starts* at `local-device`. Escalation requires either:
- An explicit `/escalate` from the plugin's command pack, or
- A risk score that crosses the configured threshold (see *Risk scoring*).

## Public-cloud is review-only

Public-cloud model output is treated as a suggestion. It does not directly modify the working tree. A local or private-remote model applies the change after a human reviews it.

This is enforced at two layers:
1. **Schema**: `ModelProfile` rejects `kind: "public-cloud"` with `requiresApproval: false`.
2. **Policy defaults**: `RoutingPolicy.publicCloudDefaultMode` defaults to `"review-only"`. The validator warns if a plugin tries to weaken this.

## Risk scoring

`scoreRisk` returns `0–100` based on:

- Task keywords (high-risk: `production`, `secret`, `auth`, `migration`, `delete`, `drop`, …; medium-risk: `refactor`, `schema`, `infrastructure`, …).
- Estimated files touched.
- Flags for `involvesSecrets`, `involvesProductionInfra`.

Default thresholds:

| Score | Tier |
|---|---|
| ≤ 50 | `local-device` |
| ≤ 75 | `private-remote` |
| ≥ 76 | `public-cloud` (always review-only) |

Thresholds are overridable via `tierkit.config.json::routingPolicy.riskThresholds`.

## `tierkit route explain`

Explain which tier and profile Tierkit would pick for a task:

```sh
tierkit route explain "rename a helper function"
# Risk score: 10/100  →  local-device, no approval

tierkit route explain "audit production auth secret rotation" --secrets --prod --files 12
# Risk score: 100/100  →  public-cloud, approval REQUIRED, review-only
```

Optional flags:
- `--files <N>` — estimated number of files touched (adds to risk)
- `--secrets` — flag the task as touching secrets
- `--prod` — flag the task as touching production infrastructure

The output includes the chosen tier, the chosen profile (if any matches), every reason that contributed to the score, and a list of other candidate profiles for the chosen tier (the router picks the first one declared).

## `tierkit models list` / `models test`

List profiles configured in `tierkit.config.json`:

```sh
tierkit models list
# ID                  KIND          PROVIDER        MODEL              ROLES         COST  APPROVAL
# localFast           local-device  ollama          qwen2.5-coder:7b   simple-coder  free  no
# privateRemoteStrong private-remote openai-compat  qwen-coder-72b     coder         —     no
# publicCloudPremium  public-cloud  anthropic       claude-sonnet      architect     —     yes
```

Probe a profile to verify reachability and credentials:

```sh
tierkit models test localFast
# Probing "localFast" (local-device, provider=ollama, model=qwen2.5-coder:7b)
#   status     OK
#   latency    54 ms
#   models     28
#   configured model available  no
#   note       28 model(s) installed but "qwen2.5-coder:7b" is NOT one of them — run `ollama pull qwen2.5-coder:7b`
```

### Provider clients shipped in v0.5

| Provider value | Endpoint hit | Auth |
|---|---|---|
| `ollama`             | `GET {baseUrl}/api/tags`            | none |
| `openai`             | `GET {baseUrl}/models`              | `Authorization: Bearer ${apiKeyEnv}` |
| `openai-compatible`  | `GET {baseUrl}/models`              | `Authorization: Bearer ${apiKeyEnv}` |
| `anthropic`          | `GET {baseUrl}/v1/models`           | `x-api-key: ${apiKeyEnv}` + `anthropic-version: 2023-06-01` |

Unsupported providers return `not-implemented` rather than guessing. Failure codes are stable for scripting: `unreachable`, `unauthorized`, `bad-status`, `missing-api-key`, `missing-base-url`, `not-implemented`.

## `tierkit route run "<task>"` (v1.1)

`route explain` (v0.5) tells you which tier *would* be picked. `route run` (v1.1) actually picks it, builds the prompt, sends the request, and streams the response back.

```sh
tierkit route run "summarize the project structure"
# [local-device] localFast (ollama/qwen2.5:7b-instruct, mode=execute)
# (streaming output…)
# — 82 in / 134 out · 1240ms · $0.000000
```

### Mode flag

| `--mode` | System prompt | Default? |
|---|---|---|
| `plan`    | "Plan first, no code." Forces a structured "Restate / Known / Unknown / Approaches / Next step" output. | No |
| `review`  | "Read and review only." Forces blocker/warning/nit severities + a one-line verdict. | No |
| `execute` | "Carry out the task." Tightest preamble; default. | Yes |

### Other flags

| Flag | Behavior |
|---|---|
| `--profile <id>`  | Force a specific profile; bypasses the router. Synthesizes a `decision.reasons` entry noting the force. |
| `--no-stream`     | Buffer the response and print at the end. Useful for shell capture. |
| `--local-only`    | Refuse any tier above `local-device`. If the router escalates, downgrade. |
| `--private`       | Allow `private-remote`; refuse `public-cloud`. |
| `--files N`       | Estimated files touched (feeds RiskScorer). |
| `--secrets` / `--prod` | Flag the task as touching secrets / production infra (raises risk score). |

### What the runtime does, in order

```
task + flags
  ↓ loadConfig
  ↓ resolve profile (forced via --profile OR explainRoute + tier constraint)
  ↓ buildTaskContext(mode) → [system, user] messages
  ↓ remote tier? → redactSecrets() applied to messages
  ↓ checkBudget → refuse on `block`
  ↓ provider.stream() — emits start / delta / usage / end | error
  ↓ tee events to consumer; accumulate text + tokens
  ↓ appendUsage() (success OR failure) when stream terminates
```

### Provider streaming endpoints (v1.1)

| Provider | Stream endpoint | Format |
|---|---|---|
| `ollama`            | `POST {baseUrl}/api/chat` with `stream: true`                | NDJSON (one JSON per line) |
| `openai-compatible` | `POST {baseUrl}/chat/completions` with `stream: true`        | SSE (`data: {…}\n\n`)      |
| `openai`            | same as openai-compatible                                    | SSE                        |
| `anthropic`         | `POST {baseUrl or api.anthropic.com}/v1/messages` with `stream: true` | SSE (Anthropic event variant) |

## Cost policy

Each profile may declare a `cost` field — one of:
- `{ "type": "free" }` — local models, no marginal cost
- `{ "type": "per-token", "inputUsdPerMillion": <N>, "outputUsdPerMillion": <N> }` — typical cloud APIs
- `{ "type": "flat", "monthlyUsd": <N> }` — subscription tiers

`tierkit models list` shows the cost compactly. `tierkit usage` rolls up calls / tokens / cost per profile from the usage log written by `route run` (and the runtime daemon's `/v1/llm-call`). **Budget enforcement** (`budget.dailyUsdLimit` / `monthlyUsdLimit`) is applied at call time since v1.0: `checkBudget` runs before any provider call and refuses with `budget-exceeded` when the limit is reached.

## `tierkit config show`

Print the loaded config. By default, `apiKeyEnv` values resolved from `process.env` are **masked** as `***` or shown as `(not set)`:

```sh
tierkit config show
# ...
# # API key env vars
#   TIERKIT_PRIVATE_LLM_KEY = ***    [used by profile "privateRemoteStrong"]
#   ANTHROPIC_API_KEY = (not set)    [used by profile "publicCloudPremium"]
```

Pass `--reveal-env` to unmask (use only when debugging — the output goes to stdout).

## Roadmap

- v0.1 — Types, scorer, decider. No execution. ✅
- v0.5 — `tierkit route explain`, `tierkit models list/test`, `tierkit config show`. Provider clients for ollama/openai/openai-compatible/anthropic. Cost display. ✅
- v0.6 — Budget enforcement; secret-redactor wired into outbound requests; dangerous-command runtime policy.
- v1.0 — Live routing inside an integrated adapter (auto-route every model call, not just explain).
