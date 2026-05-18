# Auto Fallback + Fine-Grained Routing

**Date:** 2026-05-18
**Status:** Approved (Phase 2 of 3)
**Scope:** Tierkit ModelRouter + LLM call path

## Problem

Tierkit currently routes a task to a single tier, picks one profile in that tier, and falls back **within the same tier** when calls fail. Three gaps:

1. **No cross-tier fallback.** If every local Ollama profile is down (server off, model not pulled, all candidates fail), the call fails — Tierkit will not auto-escalate to the user's available Claude / OpenAI / Gemini API.
2. **No quality awareness.** A local model returning `"I cannot help with that"` or an empty/truncated response is treated as success. Tierkit hands the bad response back to the caller.
3. **Coarse profile selection.** Within a tier, the first matching profile wins (declaration order). There's no way to say "use claudeSonnet for code-review tasks, localCoder for code-generation tasks" without changing the order in `tierkit.config.json` (which affects every task).

## Non-Goals

- ❌ Mid-stream abort + restart (user explicitly opted into "evaluate after completion" only).
- ❌ Fallback / quality check when the caller passes an **explicit** profile id (only `model: "auto"` / `"tierkit"` calls participate — explicit picks respect user intent).
- ❌ LLM-based task classifier (cost vs. value doesn't justify it; rule-based classifier is enough).
- ❌ Real-time response grading by another model.
- ❌ Touching `RiskScorer.ts` keyword sets (out of scope; the algorithm is fine).

## Design

### 1. Escalation chain in `RouteDecision`

`decideRoute` today returns `{ tier, profileId, score, reasons, requiresApproval, mode }`. We add:

```ts
export interface RouteCandidate {
  id: string;
  tier: ModelTier;
  /** False for primary-tier candidates, true for candidates added by escalation. */
  isEscalation: boolean;
}

export interface RouteDecision {
  // ... existing fields unchanged ...
  /** Ordered list — try in sequence on transient failures. */
  escalationChain: RouteCandidate[];
}
```

Chain construction:

1. Start with all profiles whose `kind === primaryTier`, sorted by **task-type fit** (see §4).
2. Walk up tiers until the configured ceiling (§2). At each step, append that tier's profiles in the same fit-sorted order, with `isEscalation: true`.
3. **No downgrade** in the chain itself — downgrade is handled by budget-aware logic (§3) which mutates the starting tier *before* chain construction.

`explainRoute` exposes the chain so the GUI + SDK can show what will be tried.

### 2. Ceiling policy

New `routingPolicy.autoEscalationCeiling: "local-device" | "private-remote" | "public-cloud"` (default `"public-cloud"` per user choice). Chain construction stops at this tier.

- `"local-device"`: no escalation, current behavior.
- `"private-remote"`: escalate up to Claude / Vertex / etc. Still safe — these require explicit key.
- `"public-cloud"`: full chain. Combined with `budget` cap to prevent runaways.

When a candidate from a tier requiring approval (`requiresApproval: true`) is reached in the chain, **its `requiresApproval` flag is dropped to `false` for the auto-escalation path** — the user already opted into auto-escalation by raising the ceiling. Approval still applies when the user *manually* picks that profile.

### 3. Budget-aware downgrade

New `routingPolicy.budgetAwareDowngrade: boolean` (default `true`).

Pre-chain logic when `true`:

1. Read budget status via `checkBudget`.
2. If today's spend ≥ 80% of daily cap, **downgrade the primary tier by one notch** before building the chain (local-fast / local-coder stays local; private-remote → local-coder; public-cloud → private-remote).
3. If today's spend ≥ 100% (over cap), remove **all** `public-cloud` candidates from the constructed chain (the existing budget gate already 4xx's such calls, but pruning ahead of time avoids the wasted round-trip and gives a cleaner "downgraded due to budget" log message).

No effect when budget is unset or `budgetAwareDowngrade: false`.

### 4. Task-type aware sorting (`goodAt`)

`ModelProfile` schema gains an optional field:

```ts
goodAt?: string[];   // declared capabilities, e.g. ["code-review", "korean", "summarize"]
```

`TaskClassifier` (new module `model/TaskClassifier.ts`) maps a task string to a `TaskType`:

```ts
export type TaskType =
  | "code-generation"
  | "code-review"
  | "refactor"
  | "summarize"
  | "translate"
  | "plan"
  | "general";

export function classifyTask(task: string): TaskType;
```

Rule-based:

| Pattern (case-insensitive, `string.includes` or simple regex) | Type |
|---|---|
| `review`, `리뷰`, `검토` | `code-review` |
| `refactor`, `리팩토`, `재구성` | `refactor` |
| `summarize`, `summary`, `요약`, `tldr` | `summarize` |
| `translate`, `번역` | `translate` |
| `plan`, `design`, `architect`, `계획`, `설계` | `plan` |
| `write`, `implement`, `add`, `구현`, `작성` | `code-generation` |
| else | `general` |

Within a tier, profiles are sorted by:

1. Profiles with `goodAt.includes(taskType)` first.
2. Then profiles without `goodAt` (neutral).
3. Then profiles with `goodAt` that **excludes** this taskType.

Ties broken by declaration order (today's behavior).

### 5. Response quality evaluation

New module `model/ResponseQualityEvaluator.ts`:

```ts
export interface QualityVerdict {
  acceptable: boolean;
  reason?: "empty" | "refusal" | "truncated" | "repetition";
}

export function evaluateResponse(
  text: string,
  finishReason: string | undefined,
  prompt: string,
): QualityVerdict;
```

Heuristics (each independently configurable would be over-engineering — keep simple, tune as a unit):

- **empty**: trimmed text is `""` OR (length < 20 chars AND prompt length > 100).
- **refusal**: text matches any regex in `model/refusalPatterns.ts` (curated list, English + Korean). Patterns must match near the start (first 200 chars) to avoid false positives where the model discusses refusals as topic.
- **truncated**: `finishReason !== "stop"` AND last non-whitespace char is NOT in `.!?。、:;]})』」` AND text length > 0.
- **repetition**: last 80 chars equal the preceding 80 chars (loop detector).

If any heuristic fires, verdict is `{ acceptable: false, reason }`.

New `refusalPatterns.ts` exports:

```ts
export const REFUSAL_PATTERNS: RegExp[] = [
  /^I can(?:'t| ?not|not)\b/i,
  /^I'?m sorry,? but/i,
  /^(?:As an?|I'm an?) AI\b/i,
  /^I (?:am|'m) (?:unable|not able)/i,
  /^I (?:cannot|can not) (?:help|assist|provide|generate)/i,
  /^죄송(?:합니다|하지만)/,
  /^저는.*수 ?없습니다/,
  /(?:할|도와드릴) 수 ?없습니다/,
  /^거부합니다/,
  /^답변(?:드릴|할) 수 ?없습니다/,
];
```

Integration: when the auto-fallback walker gets `result.ok === true`, it runs `evaluateResponse` (only when `routingPolicy.responseQualityCheck !== false`, default on). If the verdict is `{ acceptable: false }`, the result is **treated as a transient failure** (synthesized code `"quality-rejected"`) and walking continues. The rejected attempt is logged with the reason.

### 6. Refactor: shared candidate resolver

Today the auto-fallback logic lives only in `openaiCompat.ts:60-147`. Phase 2 extracts it:

New file `runtime/proxy/autoResolver.ts`:

```ts
export interface AutoResolveInput {
  cwd: string;
  env: Record<string, string | undefined>;
  lastUserMessage: string;
}

export interface AutoResolveResult {
  candidateIds: string[];
  /** What classifyTask returned, propagated for logging. */
  taskType: TaskType;
  /** Filled when budgetAwareDowngrade kicked in. */
  downgradedFromTier?: ModelTier;
}

export async function resolveAutoCandidates(
  input: AutoResolveInput,
): Promise<AutoResolveResult>;
```

Both `openaiCompat.ts` and the new `/v1/llm-call` "auto" path call this resolver.

### 7. `/v1/llm-call` auto support

`LlmCallRequest.profileId` accepts the literal string `"auto"`. When seen:

1. Extract `lastUserMessage` from `messages` (most recent user message; fallback to `""`).
2. `resolveAutoCandidates({ cwd, env, lastUserMessage })` → `candidateIds`.
3. Walk candidates with the same logic as `openaiCompat.ts`, applying quality evaluation on success.

Explicit profile ids continue to behave as today (single profile, no fallback, no quality check).

### 8. GUI changes

- **Activity log**: add a one-line summary above the existing entry when an auto call escalated or used quality fallback:
  ```
  auto: localFast → claudeHaiku  (escalated: ollama-unreachable)
  auto: localCoder → claudeSonnet  (quality-rejected: refusal)
  ```
- **Models card**: small inline indicator showing current `autoEscalationCeiling` value with a `[change ▼]` dropdown that writes back via a new `PATCH /v1/config/routing` endpoint. Keep it visually minimal — one line below the section header.
- **+ Add / edit profile form**: optional `Good at (comma-separated)` input that maps to `goodAt`. Hidden behind a "More" disclosure to keep the default form simple.

### 9. New endpoints

- `PATCH /v1/config/routing` body: `{ autoEscalationCeiling?, budgetAwareDowngrade?, responseQualityCheck? }` — workspace-scoped writes to `tierkit.config.json`. Validates against the Zod schema before save.
- `GET /v1/route/preview?task=<text>` (optional, nice-to-have): returns the full `RouteDecision` including chain. Useful for debugging and the GUI's "what would auto do?" affordance. **Skipped from MVP** — punt to Phase 2b if time-constrained.

### 10. Safety / observability

- Each escalation OR quality rejection writes a structured `usage.jsonl` row marker: `{ ts, fromProfileId, toProfileId, reason: "ollama-unreachable" | "quality-rejected:refusal" | ... }`. Reuses the existing log file; new row type so existing readers ignore it.
- Quality check is opt-OUTable. If a downstream client is intentionally extracting refusal patterns (e.g., a safety eval tool), they set `responseQualityCheck: false` in config.
- No keys, prompts, or responses are added to logs by this feature (re-uses existing usage log fields only).

### 11. Tests

Unit tests:

- `TaskClassifier`: each pattern hits the right type, "general" falls through, edge cases (empty, very long, mixed-language).
- `ResponseQualityEvaluator`: each verdict reason with concrete fixtures, no false positives on legitimate apology-like content (e.g. "I'm sorry, here's the fixed code:" must be acceptable because the regex requires *start of string*).
- `refusalPatterns`: every regex matches at least one fixture, doesn't match negative fixtures.
- `decideRoute` chain construction: chain length, ordering, ceiling enforcement, budget-aware downgrade.

Integration tests:

- `resolveAutoCandidates` with mocked viability — escalates correctly when local viable list is empty.
- `executeLlmCall` with `profileId: "auto"` walks the chain, succeeds on a viable later candidate.
- Quality fallback: mock provider returns a refusal → walker advances to next candidate.
- `PATCH /v1/config/routing` validates input, writes the file, reads it back.

### 12. Backward compatibility

- `routingPolicy.autoEscalationCeiling` defaults to `"public-cloud"` on new configs; **existing configs without the field also default to `"public-cloud"`** (matches user choice). Users who want old behavior set it to `"local-device"`.
- `budgetAwareDowngrade` default `true`. Configs without budget unaffected.
- `responseQualityCheck` default `true`.
- Profiles without `goodAt`: neutral ranking, no change in selection.
- Explicit profile ids: zero behavior change.

## File Changes Summary

**New:**
- `packages/core/src/model/TaskClassifier.ts` (+ test)
- `packages/core/src/model/ResponseQualityEvaluator.ts` (+ test)
- `packages/core/src/model/refusalPatterns.ts` (+ test)
- `packages/core/src/runtime/proxy/autoResolver.ts` (+ test)

**Modified:**
- `packages/core/src/model/ModelRouter.ts` — escalation chain + goodAt-aware sort
- `packages/core/src/model/ModelProfile.ts` — `goodAt?: string[]` field + Zod schema
- `packages/core/src/usecases/explainRoute.ts` — expose chain + taskType
- `packages/core/src/runtime/proxy/llmCall.ts` — auto + quality integration
- `packages/core/src/runtime/openaiCompat.ts` — delegate to `autoResolver`, add quality check
- `packages/core/src/config/...` (schema + loader) — new `routingPolicy` fields
- `packages/core/src/runtime/Server.ts` — `PATCH /v1/config/routing`
- `packages/core/src/runtime/ui/gui.ts` — Activity log format, ceiling dropdown, `goodAt` input

**Estimated diff:** ~900 lines added, ~150 modified.
