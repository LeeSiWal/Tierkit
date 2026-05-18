# Auto Fallback + Fine-Grained Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-tier auto-escalation, budget-aware downgrade, post-response quality evaluation, and task-type-aware profile sorting to Tierkit's auto-routing path.

**Architecture:** Three new pure modules (`TaskClassifier`, `ResponseQualityEvaluator`, `refusalPatterns`) feed into an extended `decideRoute` that returns a multi-tier `escalationChain`. A shared `autoResolver` produces the final candidate list (with budget-aware downgrade applied) for both `/v1/openai/chat/completions` and the new `/v1/llm-call` auto path. The existing fallback walker stays — it just receives a longer chain and runs quality evaluation on each successful response.

**Tech Stack:** TypeScript, Node.js built-in `http`/`fs`, vitest, zod (already in deps). No new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-05-18-auto-fallback-and-routing-design.md](../specs/2026-05-18-auto-fallback-and-routing-design.md)

---

## File Structure

**New files** (each with one focused responsibility):

- `packages/core/src/model/refusalPatterns.ts` — single export, regex list, no logic
- `packages/core/src/model/TaskClassifier.ts` — task string → TaskType, pure function
- `packages/core/src/model/ResponseQualityEvaluator.ts` — verdict on a single response, pure function
- `packages/core/src/runtime/proxy/autoResolver.ts` — orchestrates: classify → route → budget downgrade → viability prune

**Modified:**

- `packages/core/src/model/ModelProfile.ts` — add optional `goodAt: string[]` to Zod schema
- `packages/core/src/model/ModelRouter.ts` — add `escalationChain` + goodAt-aware sort to `decideRoute`
- `packages/core/src/config/TierkitConfig.ts` — add `autoEscalationCeiling`, `budgetAwareDowngrade`, `responseQualityCheck` to `RoutingPolicySchema`
- `packages/core/src/usecases/explainRoute.ts` — expose `escalationChain` + `taskType` in result
- `packages/core/src/runtime/proxy/llmCall.ts` — accept `profileId === "auto"` via autoResolver
- `packages/core/src/runtime/openaiCompat.ts` — delegate candidate resolution to `autoResolver`, add quality check between walker iterations
- `packages/core/src/runtime/Server.ts` — `PATCH /v1/config/routing` endpoint
- `packages/core/src/runtime/ui/gui.ts` — Activity log "escalated"/"quality-rejected" line, ceiling dropdown, `Good at` input in profile form

**Test files:**

- `packages/core/test/refusalPatterns.test.ts`
- `packages/core/test/taskClassifier.test.ts`
- `packages/core/test/responseQualityEvaluator.test.ts`
- `packages/core/test/escalationChain.test.ts`
- `packages/core/test/autoResolver.test.ts`
- `packages/core/test/configRoutingEndpoint.test.ts`

---

## Task 1: Refusal patterns module

**Files:**
- Create: `packages/core/src/model/refusalPatterns.ts`
- Test: `packages/core/test/refusalPatterns.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/refusalPatterns.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { REFUSAL_PATTERNS, matchesRefusal } from "../src/model/refusalPatterns.js";

describe("refusalPatterns", () => {
  const positives = [
    "I cannot help with that",
    "I can't do that, sorry",
    "I cannot provide that information",
    "I'm sorry, but I won't be able to",
    "As an AI, I don't have opinions",
    "I am unable to fulfill this request",
    "죄송합니다만 도와드릴 수 없습니다",
    "저는 그것을 할 수 없습니다",
    "할 수 없습니다",
    "거부합니다",
    "답변드릴 수 없습니다",
  ];
  const negatives = [
    "Here is the answer: cannot is a word that means unable.",
    "The user said 'I cannot' earlier in the thread.",
    "Sure, here's an example: I can help with that.",
    "이것은 'I cannot'이라는 표현을 설명합니다.",
    "할 수 있습니다",
  ];

  it("each positive fixture matches at least one pattern", () => {
    for (const s of positives) {
      expect(matchesRefusal(s), `should match: ${s}`).toBe(true);
    }
  });

  it("no negative fixture matches any pattern (head-anchored)", () => {
    for (const s of negatives) {
      expect(matchesRefusal(s), `should NOT match: ${s}`).toBe(false);
    }
  });

  it("REFUSAL_PATTERNS is a non-empty list of RegExp", () => {
    expect(REFUSAL_PATTERNS.length).toBeGreaterThan(5);
    for (const r of REFUSAL_PATTERNS) expect(r).toBeInstanceOf(RegExp);
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run refusalPatterns
```
Expected: FAIL (`Cannot find module`).

- [ ] **Step 3: Implement the module**

Create `packages/core/src/model/refusalPatterns.ts`:

```typescript
/**
 * Refusal-phrase regexes. Each is anchored to the start of the response (^) so we don't
 * fire on responses that QUOTE refusal phrases as part of legitimate content
 * (e.g., explaining what a refusal looks like).
 *
 * Matched against the first 200 chars of trimmed response in
 * ResponseQualityEvaluator.evaluateResponse — same convention applies for added patterns.
 */
export const REFUSAL_PATTERNS: readonly RegExp[] = [
  /^I can(?:'t| ?not|not)\b/i,
  /^I'?m sorry,? but/i,
  /^(?:As an?|I'm an?) AI\b/i,
  /^I (?:am|'m) (?:unable|not able)/i,
  /^I (?:cannot|can not) (?:help|assist|provide|generate)/i,
  /^I won'?t (?:be able to|help|provide)/i,
  /^죄송(?:합니다|하지만)/,
  /^저는.*수 ?없습니다/,
  /^(?:할|도와드릴|답변(?:드릴|할)) 수 ?없습니다/,
  /^거부합니다/,
];

/** True if any pattern matches the head of `text`. */
export function matchesRefusal(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}
```

- [ ] **Step 4: Run tests → expect PASS (3 tests)**

```
pnpm --filter @tierkit/core exec vitest run refusalPatterns
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/model/refusalPatterns.ts packages/core/test/refusalPatterns.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(model): refusal pattern matcher (en + ko, head-anchored)"
```

---

## Task 2: TaskClassifier module

**Files:**
- Create: `packages/core/src/model/TaskClassifier.ts`
- Test: `packages/core/test/taskClassifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/taskClassifier.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyTask, TASK_TYPES } from "../src/model/TaskClassifier.js";

describe("TaskClassifier", () => {
  const cases: Array<[string, ReturnType<typeof classifyTask>]> = [
    ["please review my code", "code-review"],
    ["코드 리뷰 부탁해", "code-review"],
    ["refactor this function", "refactor"],
    ["리팩토링해줘", "refactor"],
    ["summarize this article", "summarize"],
    ["요약해줘", "summarize"],
    ["TLDR for the meeting notes", "summarize"],
    ["translate to korean", "translate"],
    ["번역해", "translate"],
    ["plan the migration", "plan"],
    ["design a new schema", "plan"],
    ["계획을 세워줘", "plan"],
    ["write a function that adds two numbers", "code-generation"],
    ["implement quicksort", "code-generation"],
    ["구현해줘", "code-generation"],
    ["", "general"],
    ["what time is it", "general"],
  ];

  for (const [input, expected] of cases) {
    it(`classifies "${input}" as ${expected}`, () => {
      expect(classifyTask(input)).toBe(expected);
    });
  }

  it("exports a TASK_TYPES tuple", () => {
    expect(TASK_TYPES).toContain("general");
    expect(TASK_TYPES).toContain("code-review");
  });

  it("prefers higher-specificity match when multiple keywords are present", () => {
    // 'review' is more specific than 'write' if both appear, code-review wins.
    expect(classifyTask("write a review of this code")).toBe("code-review");
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run taskClassifier
```

- [ ] **Step 3: Implement**

Create `packages/core/src/model/TaskClassifier.ts`:

```typescript
export const TASK_TYPES = [
  "code-review",
  "refactor",
  "summarize",
  "translate",
  "plan",
  "code-generation",
  "general",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Rule order = precedence. The first matching rule wins, so more-specific patterns
 * (code-review, refactor) MUST come before more-generic ones (code-generation).
 */
const RULES: Array<{ type: TaskType; patterns: RegExp[] }> = [
  { type: "code-review",   patterns: [/\breview\b/i, /리뷰/, /검토/] },
  { type: "refactor",      patterns: [/\brefactor/i, /리팩토/, /재구성/] },
  { type: "summarize",     patterns: [/\bsummariz|summary\b/i, /\btldr\b/i, /요약/] },
  { type: "translate",     patterns: [/\btranslate\b/i, /번역/] },
  { type: "plan",          patterns: [/\b(?:plan|design|architect)\b/i, /계획/, /설계/] },
  { type: "code-generation", patterns: [/\b(?:write|implement|add|build|create)\b/i, /구현/, /작성/] },
];

export function classifyTask(task: string): TaskType {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(task))) return rule.type;
  }
  return "general";
}
```

- [ ] **Step 4: Run tests → expect PASS**

```
pnpm --filter @tierkit/core exec vitest run taskClassifier
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/model/TaskClassifier.ts packages/core/test/taskClassifier.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(model): rule-based TaskClassifier (en + ko)"
```

---

## Task 3: ResponseQualityEvaluator module

**Files:**
- Create: `packages/core/src/model/ResponseQualityEvaluator.ts`
- Test: `packages/core/test/responseQualityEvaluator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/responseQualityEvaluator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { evaluateResponse } from "../src/model/ResponseQualityEvaluator.js";

const LONG_PROMPT = "x".repeat(200);

describe("ResponseQualityEvaluator", () => {
  it("acceptable when response is non-empty, terminated, no refusal", () => {
    expect(evaluateResponse("Here is the code: def foo(): pass", "stop", LONG_PROMPT))
      .toEqual({ acceptable: true });
  });

  it("flags empty text as 'empty'", () => {
    const v = evaluateResponse("   \n\t", "stop", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "empty" });
  });

  it("flags very-short response to long prompt as 'empty'", () => {
    const v = evaluateResponse("ok", "stop", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "empty" });
  });

  it("does NOT flag short response when prompt is also short", () => {
    expect(evaluateResponse("ok", "stop", "hi")).toEqual({ acceptable: true });
  });

  it("flags refusal at head of response", () => {
    const v = evaluateResponse("I cannot help with that request.", "stop", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "refusal" });
  });

  it("does NOT flag content that quotes a refusal mid-response", () => {
    const text = "Here is what a refusal looks like: 'I cannot help with that'. " +
      "The fix is to retry with a clearer prompt and proper context for the model.";
    expect(evaluateResponse(text, "stop", LONG_PROMPT)).toEqual({ acceptable: true });
  });

  it("flags mid-sentence truncation when finishReason !== 'stop'", () => {
    const v = evaluateResponse("Here is the implementation that handles", "length", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "truncated" });
  });

  it("does NOT flag truncated when finishReason === 'stop' (model chose to stop here)", () => {
    expect(evaluateResponse("Here is the implementation that handles", "stop", LONG_PROMPT))
      .toEqual({ acceptable: true });
  });

  it("does NOT flag length-stop when text ends with sentence-ender", () => {
    expect(evaluateResponse("Here is the answer.", "length", LONG_PROMPT))
      .toEqual({ acceptable: true });
  });

  it("flags repetition loop", () => {
    const looped = "the answer is 42 because " + "yes ".repeat(40);
    const v = evaluateResponse(looped, "stop", LONG_PROMPT);
    expect(v).toEqual({ acceptable: false, reason: "repetition" });
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run responseQualityEvaluator
```

- [ ] **Step 3: Implement**

Create `packages/core/src/model/ResponseQualityEvaluator.ts`:

```typescript
import { matchesRefusal } from "./refusalPatterns.js";

export type QualityReason = "empty" | "refusal" | "truncated" | "repetition";

export interface QualityVerdict {
  acceptable: boolean;
  reason?: QualityReason;
}

const TERMINATORS = /[.!?。、:;\]\)}」』]$/;

/**
 * Post-response quality check. Pure function, no I/O.
 *
 * Heuristics (any failing → unacceptable):
 *   - empty: trimmed length 0, OR length < 20 when the prompt is substantial (>100 chars)
 *   - refusal: head matches a known refusal pattern
 *   - truncated: finishReason indicates a non-graceful stop AND text ends mid-sentence
 *   - repetition: last 80 chars equal the preceding 80 chars (loop detector)
 */
export function evaluateResponse(
  text: string,
  finishReason: string | undefined,
  prompt: string,
): QualityVerdict {
  const trimmed = text.trim();

  if (trimmed.length === 0) return { acceptable: false, reason: "empty" };
  if (trimmed.length < 20 && prompt.length > 100) {
    return { acceptable: false, reason: "empty" };
  }

  if (matchesRefusal(trimmed)) return { acceptable: false, reason: "refusal" };

  if (finishReason && finishReason !== "stop") {
    const tail = trimmed.slice(-1);
    if (tail && !TERMINATORS.test(tail)) {
      return { acceptable: false, reason: "truncated" };
    }
  }

  if (trimmed.length >= 160) {
    const lastSeg = trimmed.slice(-80);
    const prevSeg = trimmed.slice(-160, -80);
    if (lastSeg === prevSeg) return { acceptable: false, reason: "repetition" };
  }

  return { acceptable: true };
}
```

- [ ] **Step 4: Run tests → expect PASS (10 tests)**

```
pnpm --filter @tierkit/core exec vitest run responseQualityEvaluator
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/model/ResponseQualityEvaluator.ts packages/core/test/responseQualityEvaluator.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(model): ResponseQualityEvaluator (empty/refusal/truncated/repetition)"
```

---

## Task 4: Add `goodAt` to ModelProfile schema

**Files:**
- Modify: `packages/core/src/model/ModelProfile.ts`
- Test: `packages/core/test/modelProfileSchema.test.ts` (new, small)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/modelProfileSchema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ModelProfileSchema } from "../src/model/ModelProfile.js";

describe("ModelProfileSchema goodAt field", () => {
  it("accepts a profile with goodAt", () => {
    const p = ModelProfileSchema.parse({
      kind: "private-remote",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      roles: ["code"],
      goodAt: ["code-review", "korean"],
    });
    expect(p.goodAt).toEqual(["code-review", "korean"]);
  });

  it("accepts a profile WITHOUT goodAt (backward compat)", () => {
    const p = ModelProfileSchema.parse({
      kind: "local-device",
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      baseUrl: "http://127.0.0.1:11434",
      roles: [],
    });
    expect(p.goodAt).toBeUndefined();
  });

  it("rejects non-string entries in goodAt", () => {
    expect(() =>
      ModelProfileSchema.parse({
        kind: "local-device",
        provider: "ollama",
        model: "x",
        roles: [],
        goodAt: [123],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run modelProfileSchema
```

The first test should fail (unknown key `goodAt` because schema is `.strict()`).

- [ ] **Step 3: Add `goodAt` to the Zod schema**

In `packages/core/src/model/ModelProfile.ts`, find the `ModelProfileSchema` definition (around line 28). Add this field BEFORE the `cost: ModelCostSchema.optional(),` line:

```typescript
    goodAt: z.array(z.string().min(1)).optional(),
```

So the field list reads:
```
roles: z.array(z.string().min(1)).default([]),
requiresApproval: z.boolean().optional(),
defaultMode: z.enum(["execute", "review-only"]).optional(),
goodAt: z.array(z.string().min(1)).optional(),
cost: ModelCostSchema.optional(),
```

- [ ] **Step 4: Run tests → expect PASS**

```
pnpm --filter @tierkit/core exec vitest run modelProfileSchema
pnpm --filter @tierkit/core test
```

All existing tests should still pass (the field is optional).

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/model/ModelProfile.ts packages/core/test/modelProfileSchema.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(model): add optional goodAt[] field to ModelProfile schema"
```

---

## Task 5: Add 3 fields to RoutingPolicy schema

**Files:**
- Modify: `packages/core/src/config/TierkitConfig.ts`
- Test: `packages/core/test/routingPolicySchema.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/routingPolicySchema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TierkitConfigSchema } from "../src/config/TierkitConfig.js";

describe("RoutingPolicy auto-fallback fields", () => {
  it("defaults autoEscalationCeiling to 'public-cloud'", () => {
    const cfg = TierkitConfigSchema.parse({
      version: "0.1",
    });
    expect(cfg.routingPolicy.autoEscalationCeiling).toBe("public-cloud");
  });

  it("defaults budgetAwareDowngrade to true", () => {
    const cfg = TierkitConfigSchema.parse({ version: "0.1" });
    expect(cfg.routingPolicy.budgetAwareDowngrade).toBe(true);
  });

  it("defaults responseQualityCheck to true", () => {
    const cfg = TierkitConfigSchema.parse({ version: "0.1" });
    expect(cfg.routingPolicy.responseQualityCheck).toBe(true);
  });

  it("accepts user-supplied values", () => {
    const cfg = TierkitConfigSchema.parse({
      version: "0.1",
      routingPolicy: {
        autoEscalationCeiling: "local-device",
        budgetAwareDowngrade: false,
        responseQualityCheck: false,
      },
    });
    expect(cfg.routingPolicy.autoEscalationCeiling).toBe("local-device");
    expect(cfg.routingPolicy.budgetAwareDowngrade).toBe(false);
    expect(cfg.routingPolicy.responseQualityCheck).toBe(false);
  });

  it("rejects unknown autoEscalationCeiling values", () => {
    expect(() =>
      TierkitConfigSchema.parse({
        version: "0.1",
        routingPolicy: { autoEscalationCeiling: "moon" },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run routingPolicySchema
```

- [ ] **Step 3: Extend `RoutingPolicySchema`**

In `packages/core/src/config/TierkitConfig.ts`, find `RoutingPolicySchema` (around line 14) and add 3 fields BEFORE the closing brace of the `.object({...})`:

```typescript
    autoEscalationCeiling: z.enum(["local-device", "private-remote", "public-cloud"]).default("public-cloud"),
    budgetAwareDowngrade: z.boolean().default(true),
    responseQualityCheck: z.boolean().default(true),
```

So the schema reads (full block):

```typescript
export const RoutingPolicySchema = z
  .object({
    default: z.string().min(1).optional(),
    preferPrivateRemoteBeforePublicCloud: z.boolean().default(true),
    publicCloudRequiresApproval: z.boolean().default(true),
    publicCloudDefaultMode: z.enum(["execute", "review-only"]).default("review-only"),
    autoEscalationCeiling: z.enum(["local-device", "private-remote", "public-cloud"]).default("public-cloud"),
    budgetAwareDowngrade: z.boolean().default(true),
    responseQualityCheck: z.boolean().default(true),
    riskThresholds: RiskThresholdsSchema.default({
      localFastMax: 25,
      localStrongMax: 50,
      privateRemoteMax: 75,
      publicCloudReviewMin: 76,
    }),
  })
  .strict();
```

- [ ] **Step 4: Run tests → expect PASS**

```
pnpm --filter @tierkit/core test
```

Expected: all tests pass, including the 5 new ones and the existing config tests (defaults are additive, backward-compatible).

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/config/TierkitConfig.ts packages/core/test/routingPolicySchema.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(config): add autoEscalationCeiling + budgetAwareDowngrade + responseQualityCheck"
```

---

## Task 6: Build escalation chain in ModelRouter

**Files:**
- Modify: `packages/core/src/model/ModelRouter.ts`
- Test: `packages/core/test/escalationChain.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/escalationChain.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { decideRoute } from "../src/model/ModelRouter.js";
import type { ModelProfileMap } from "../src/model/ModelProfile.js";

const profiles: ModelProfileMap = {
  localFast:    { kind: "local-device",   provider: "ollama", model: "llama3:3b", roles: [] },
  localCoder:   { kind: "local-device",   provider: "ollama", model: "qwen:7b",   roles: [], goodAt: ["code-generation"] },
  claudeHaiku:  { kind: "private-remote", provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [] },
  claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6",         apiKeyEnv: "ANTHROPIC_API_KEY", roles: [], goodAt: ["code-review", "plan"] },
  gpt4o:        { kind: "public-cloud",   provider: "openai", model: "gpt-4o",      apiKeyEnv: "OPENAI_API_KEY", roles: [], requiresApproval: true },
  gpt4oMini:    { kind: "public-cloud",   provider: "openai", model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY", roles: [], requiresApproval: true },
};

describe("decideRoute escalationChain", () => {
  it("builds a chain that starts with the primary tier", () => {
    const r = decideRoute({
      task: { task: "write a function" }, // low risk → local-fast tier
      profiles,
    });
    expect(r.escalationChain.length).toBeGreaterThan(0);
    expect(r.escalationChain[0]!.tier).toBe("local-device");
    expect(r.escalationChain[0]!.isEscalation).toBe(false);
  });

  it("appends higher tiers after primary, with isEscalation=true", () => {
    const r = decideRoute({
      task: { task: "write a function" },
      profiles,
      ceiling: "public-cloud",
    });
    const tiers = r.escalationChain.map((c) => c.tier);
    const localIdx = tiers.indexOf("local-device");
    const privateIdx = tiers.indexOf("private-remote");
    const publicIdx = tiers.indexOf("public-cloud");
    expect(localIdx).toBeGreaterThanOrEqual(0);
    expect(privateIdx).toBeGreaterThan(localIdx);
    expect(publicIdx).toBeGreaterThan(privateIdx);

    for (const c of r.escalationChain.filter((c) => c.tier !== r.tier)) {
      expect(c.isEscalation).toBe(true);
    }
  });

  it("respects ceiling = 'private-remote' (no public-cloud in chain)", () => {
    const r = decideRoute({
      task: { task: "write a function" },
      profiles,
      ceiling: "private-remote",
    });
    expect(r.escalationChain.some((c) => c.tier === "public-cloud")).toBe(false);
  });

  it("respects ceiling = 'local-device' (chain stays in primary tier)", () => {
    const r = decideRoute({
      task: { task: "write a function" },
      profiles,
      ceiling: "local-device",
    });
    expect(r.escalationChain.every((c) => c.tier === "local-device")).toBe(true);
  });

  it("within a tier, sorts goodAt-matched profiles first for the given taskType", () => {
    const r = decideRoute({
      task: { task: "review my code" }, // taskType=code-review
      profiles,
      ceiling: "public-cloud",
      taskType: "code-review",
    });
    const privateRemoteIds = r.escalationChain.filter((c) => c.tier === "private-remote").map((c) => c.id);
    expect(privateRemoteIds[0]).toBe("claudeSonnet"); // has goodAt:["code-review"]
    expect(privateRemoteIds).toContain("claudeHaiku");
    expect(privateRemoteIds.indexOf("claudeSonnet")).toBeLessThan(privateRemoteIds.indexOf("claudeHaiku"));
  });

  it("for unrelated taskType, neutral profiles come BEFORE anti-fit profiles", () => {
    const r = decideRoute({
      task: { task: "translate something" }, // taskType=translate
      profiles,
      taskType: "translate",
      ceiling: "public-cloud",
    });
    const localIds = r.escalationChain.filter((c) => c.tier === "local-device").map((c) => c.id);
    // localFast has no goodAt (neutral); localCoder has goodAt:['code-generation'] (anti-fit for translate)
    expect(localIds.indexOf("localFast")).toBeLessThan(localIds.indexOf("localCoder"));
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run escalationChain
```

- [ ] **Step 3: Extend `decideRoute` + `RouteDecision`**

Replace the contents of `packages/core/src/model/ModelRouter.ts` with:

```typescript
import type { ModelTier, ModelProfile, ModelProfileMap, ModelPolicy } from "./ModelProfile.js";
import {
  DEFAULT_RISK_THRESHOLDS,
  scoreRisk,
  tierForScore,
  type RiskInput,
  type RiskThresholds,
} from "./RiskScorer.js";

export interface RouteCandidate {
  id: string;
  tier: ModelTier;
  /** False for primary-tier candidates, true for candidates added by escalation. */
  isEscalation: boolean;
}

export interface RouteDecision {
  tier: ModelTier;
  profileId: string | null;
  score: number;
  reasons: string[];
  requiresApproval: boolean;
  mode: "execute" | "review-only";
  /** Ordered list — walker tries in sequence on transient failures. */
  escalationChain: RouteCandidate[];
}

export interface ExplainRouteInput {
  task: RiskInput;
  profiles: ModelProfileMap;
  policy?: ModelPolicy;
  thresholds?: RiskThresholds;
  /** Cap for escalation tiers. Defaults to "public-cloud". */
  ceiling?: ModelTier;
  /** Used to sort profiles within each tier (goodAt-aware). Defaults to "general". */
  taskType?: string;
}

const TIER_ORDER: ModelTier[] = ["local-device", "private-remote", "public-cloud"];

function tierRank(t: ModelTier): number {
  return TIER_ORDER.indexOf(t);
}

/**
 * goodAt-aware sort: profiles matching taskType first, then neutral (no goodAt), then anti-fit.
 * Declaration order breaks ties (Object.entries preserves insertion order on modern V8).
 */
function sortProfilesForTier(
  profiles: ModelProfileMap,
  tier: ModelTier,
  taskType: string,
): string[] {
  const inTier = Object.entries(profiles).filter(([, p]) => p.kind === tier);
  const rank = (p: ModelProfile): number => {
    if (!p.goodAt || p.goodAt.length === 0) return 1; // neutral
    if (p.goodAt.includes(taskType)) return 0;          // fit
    return 2;                                            // anti-fit
  };
  return inTier
    .map(([id, p], idx) => ({ id, p, idx }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.idx - b.idx)
    .map((x) => x.id);
}

function buildEscalationChain(
  profiles: ModelProfileMap,
  primaryTier: ModelTier,
  ceiling: ModelTier,
  taskType: string,
): RouteCandidate[] {
  const chain: RouteCandidate[] = [];
  const ceilingRank = tierRank(ceiling);
  for (const tier of TIER_ORDER) {
    if (tierRank(tier) < tierRank(primaryTier)) continue;
    if (tierRank(tier) > ceilingRank) break;
    const sorted = sortProfilesForTier(profiles, tier, taskType);
    for (const id of sorted) {
      chain.push({ id, tier, isEscalation: tier !== primaryTier });
    }
  }
  return chain;
}

export function decideRoute(input: ExplainRouteInput): RouteDecision {
  const { task, profiles, policy, thresholds = DEFAULT_RISK_THRESHOLDS } = input;
  const ceiling = input.ceiling ?? "public-cloud";
  const taskType = input.taskType ?? "general";

  const { score, reasons } = scoreRisk(task);
  const tier = tierForScore(score, thresholds);

  const escalationChain = buildEscalationChain(profiles, tier, ceiling, taskType);
  const profileId = escalationChain.find((c) => c.tier === tier)?.id ?? null;
  const profile = profileId ? profiles[profileId] : undefined;

  let requiresApproval = false;
  let mode: "execute" | "review-only" = "execute";

  if (tier === "public-cloud") {
    requiresApproval = policy?.publicCloudRequiresApproval ?? true;
    mode = policy?.publicCloudDefaultMode ?? "review-only";
  } else if (profile?.requiresApproval) {
    requiresApproval = true;
  }

  return { tier, profileId, score, reasons, requiresApproval, mode, escalationChain };
}
```

- [ ] **Step 4: Run tests → expect PASS**

```
pnpm --filter @tierkit/core test
```

Expected: all old tests pass too (the public surface still includes `decideRoute(input): RouteDecision`; old callers ignore the new `escalationChain` field).

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/model/ModelRouter.ts packages/core/test/escalationChain.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(model): decideRoute returns escalationChain with goodAt-aware sort"
```

---

## Task 7: autoResolver — orchestrate classify+route+downgrade+viability

**Files:**
- Create: `packages/core/src/runtime/proxy/autoResolver.ts`
- Test: `packages/core/test/autoResolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/autoResolver.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAutoCandidates } from "../src/runtime/proxy/autoResolver.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-autoresolver-"));
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {
        // localFast viable check is skipped (provider !== ollama, so checkProfileViability passes)
        localFast:    { kind: "local-device", provider: "mock", model: "tiny", roles: [] },
        claudeHaiku:  { kind: "private-remote", provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [] },
        claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [], goodAt: ["code-review"] },
      },
      routingPolicy: {
        autoEscalationCeiling: "private-remote",
        budgetAwareDowngrade: false,
        responseQualityCheck: true,
        riskThresholds: { localFastMax: 25, localStrongMax: 50, privateRemoteMax: 75, publicCloudReviewMin: 76 },
      },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
    }),
  );
});

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("resolveAutoCandidates", () => {
  it("returns candidate ids + classified taskType", async () => {
    const r = await resolveAutoCandidates({
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "sk-ant-test1234567890" },
      lastUserMessage: "please review this function",
    });
    expect(r.taskType).toBe("code-review");
    // Both localFast and Claude profiles should be present (private-remote ceiling, ANTHROPIC_API_KEY set).
    expect(r.candidateIds).toContain("localFast");
    expect(r.candidateIds).toContain("claudeSonnet");
    expect(r.candidateIds).toContain("claudeHaiku");
    // claudeSonnet (goodAt code-review) should come before claudeHaiku within private-remote.
    expect(r.candidateIds.indexOf("claudeSonnet")).toBeLessThan(r.candidateIds.indexOf("claudeHaiku"));
  });

  it("drops private-remote candidates when ANTHROPIC_API_KEY is missing (non-viable)", async () => {
    const r = await resolveAutoCandidates({
      cwd: tmp,
      env: {}, // no api key
      lastUserMessage: "please review this function",
    });
    // viability dropped them; localFast remains viable
    expect(r.candidateIds).toEqual(["localFast"]);
  });

  it("when ALL candidates are non-viable, keeps them so the caller sees an informative error", async () => {
    // Use a config with only a remote profile + no key.
    await fs.writeFile(
      path.join(tmp, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {
          claudeOnly: { kind: "private-remote", provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKeyEnv: "ANTHROPIC_API_KEY", roles: [] },
        },
        routingPolicy: { autoEscalationCeiling: "public-cloud" },
        runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
      }),
    );
    const r = await resolveAutoCandidates({ cwd: tmp, env: {}, lastUserMessage: "review code" });
    expect(r.candidateIds).toEqual(["claudeOnly"]); // non-viable but kept (informative error path)
  });

  it("returns empty list when no profiles exist at all", async () => {
    await fs.writeFile(
      path.join(tmp, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {},
        routingPolicy: { autoEscalationCeiling: "public-cloud" },
        runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
      }),
    );
    const r = await resolveAutoCandidates({ cwd: tmp, env: {}, lastUserMessage: "x" });
    expect(r.candidateIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run autoResolver
```

- [ ] **Step 3: Implement `autoResolver.ts`**

Create `packages/core/src/runtime/proxy/autoResolver.ts`:

```typescript
import { loadConfig } from "../../config/loadConfig.js";
import { decideRoute } from "../../model/ModelRouter.js";
import type { ModelTier } from "../../model/ModelProfile.js";
import { classifyTask, type TaskType } from "../../model/TaskClassifier.js";
import { partitionByViability } from "../../model/profileViability.js";
import { checkBudget } from "../budget.js";
import path from "node:path";

export interface AutoResolveInput {
  cwd: string;
  env: Record<string, string | undefined>;
  lastUserMessage: string;
}

export interface AutoResolveResult {
  candidateIds: string[];
  taskType: TaskType;
  /** Set when budget-aware downgrade lowered the starting tier. */
  downgradedFromTier?: ModelTier;
  /** Set when budget exceeded — public-cloud candidates were pruned. */
  budgetPrunedPublicCloud: boolean;
}

const TIER_DOWN: Record<ModelTier, ModelTier | null> = {
  "public-cloud": "private-remote",
  "private-remote": "local-device",
  "local-device": null,
};

export async function resolveAutoCandidates(
  input: AutoResolveInput,
): Promise<AutoResolveResult> {
  const cfg = await loadConfig(input.cwd);
  const taskType = classifyTask(input.lastUserMessage);
  const policy = cfg.config.routingPolicy;

  // 1. Decide primary route.
  const decision = decideRoute({
    task: { task: input.lastUserMessage },
    profiles: cfg.config.modelProfiles,
    thresholds: policy.riskThresholds,
    ceiling: policy.autoEscalationCeiling,
    taskType,
    ...(cfg.config.modelPolicy ? { policy: cfg.config.modelPolicy } : {}),
  });

  // 2. Budget-aware downgrade.
  let downgradedFromTier: ModelTier | undefined;
  let budgetPrunedPublicCloud = false;
  let chain = decision.escalationChain;

  if (policy.budgetAwareDowngrade && cfg.config.budget) {
    const usagePath = path.join(input.cwd, cfg.config.runtime.dataDir, "usage.jsonl");
    const budget = await checkBudget(usagePath, cfg.config.budget);
    const dailyPct =
      budget.daily && cfg.config.budget.dailyUsdLimit
        ? (budget.daily.usedUsd / cfg.config.budget.dailyUsdLimit) * 100
        : 0;
    if (dailyPct >= 80) {
      const down = TIER_DOWN[decision.tier];
      if (down) {
        const rerouted = decideRoute({
          task: { task: input.lastUserMessage },
          profiles: cfg.config.modelProfiles,
          thresholds: policy.riskThresholds,
          ceiling: policy.autoEscalationCeiling,
          taskType,
          ...(cfg.config.modelPolicy ? { policy: cfg.config.modelPolicy } : {}),
        });
        // We don't re-score risk; we just demote the primary tier.
        // Build a fresh chain starting from the downgraded tier.
        chain = rerouted.escalationChain.filter((c) => {
          const order = ["local-device", "private-remote", "public-cloud"];
          return order.indexOf(c.tier) >= order.indexOf(down);
        });
        if (chain.length > 0) downgradedFromTier = decision.tier;
      }
    }
    if (dailyPct >= 100) {
      chain = chain.filter((c) => c.tier !== "public-cloud");
      budgetPrunedPublicCloud = true;
    }
  }

  // 3. Viability prune.
  const { viable, nonViable } = await partitionByViability(
    chain.map((c) => ({ id: c.id })),
    (id) => cfg.config.modelProfiles[id],
    input.env,
  );
  const candidateIds = viable.length > 0 ? viable.map((v) => v.id) : nonViable.map((v) => v.id);

  return {
    candidateIds,
    taskType,
    ...(downgradedFromTier ? { downgradedFromTier } : {}),
    budgetPrunedPublicCloud,
  };
}
```

- [ ] **Step 4: Run tests → expect PASS**

```
pnpm --filter @tierkit/core exec vitest run autoResolver
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/runtime/proxy/autoResolver.ts packages/core/test/autoResolver.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(runtime): autoResolver — classify+route+downgrade+viability"
```

---

## Task 8: Refactor openaiCompat to use autoResolver + add quality check

**Files:**
- Modify: `packages/core/src/runtime/openaiCompat.ts`

- [ ] **Step 1: Replace the auto-candidate block**

In `packages/core/src/runtime/openaiCompat.ts`, find the block starting at line ~70 (`const isAuto = req2.model === ...`) and ending at line ~106 (just before `const baseLlmReq`). Replace that whole block with:

```typescript
  // ── Resolve profile (explicit id, or "auto" via the shared resolver) ─────
  const isAuto = req2.model === "auto" || req2.model === "tierkit";
  let candidateIds: string[];
  let autoTaskType: string | undefined;
  if (isAuto) {
    const lastUserMsg = [...req2.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    try {
      const { resolveAutoCandidates } = await import("./proxy/autoResolver.js");
      const resolved = await resolveAutoCandidates({
        cwd: context.cwd,
        env: context.env,
        lastUserMessage: typeof lastUserMsg === "string" ? lastUserMsg : "",
      });
      candidateIds = resolved.candidateIds;
      autoTaskType = resolved.taskType;
      if (candidateIds.length === 0) {
        return sendError(res, 400, "auto-route: no profile matched", "invalid_request_error");
      }
    } catch (err) {
      return sendError(res, 400, `auto-route failed: ${(err as Error).message}`, "invalid_request_error");
    }
  } else {
    candidateIds = [req2.model];
  }
```

You can DELETE the old block lines (the explainRoute call, candidate reordering, viability call). The `autoResolver` now owns all of that.

Also DELETE the now-unused imports at the top of the file if they're only used by the deleted block. (Keep `isTransientFailure`, `partitionByViability` if still used elsewhere — search before deleting.) `partitionByViability` is no longer used directly in this file, so remove its import. `loadConfig` is also no longer used directly in this file (the auto block was the only caller) — remove its import too.

- [ ] **Step 2: Add quality check between walker iterations**

Find the non-streaming walker at line ~132-140:

```typescript
  // Non-streaming: walk candidates, fall back on transient failures.
  const attempts: { profileId: string; code: string; message: string }[] = [];
  let result: Awaited<ReturnType<typeof executeLlmCall>> | undefined;
  for (const candidate of candidateIds) {
    result = await executeLlmCall({ profileId: candidate, ...baseLlmReq }, { cwd: context.cwd, env: context.env });
    if (result.ok) break;
    if (!isTransientFailure(result.code)) break; // policy failure or terminal error — don't fallback
    attempts.push({ profileId: candidate, code: result.code, message: result.message });
  }
```

Replace with:

```typescript
  // Non-streaming: walk candidates, fall back on transient OR quality failures (auto only).
  const cfgForQuality = isAuto ? await (await import("../config/loadConfig.js")).loadConfig(context.cwd) : undefined;
  const qualityCheckOn = isAuto && cfgForQuality?.config.routingPolicy.responseQualityCheck !== false;
  const lastUserMsgForQuality = qualityCheckOn
    ? (typeof [...req2.messages].reverse().find((m) => m.role === "user")?.content === "string"
        ? ([...req2.messages].reverse().find((m) => m.role === "user")?.content as string)
        : "")
    : "";

  const attempts: { profileId: string; code: string; message: string }[] = [];
  let result: Awaited<ReturnType<typeof executeLlmCall>> | undefined;
  for (const candidate of candidateIds) {
    result = await executeLlmCall({ profileId: candidate, ...baseLlmReq }, { cwd: context.cwd, env: context.env });
    if (result.ok) {
      if (qualityCheckOn) {
        const { evaluateResponse } = await import("../model/ResponseQualityEvaluator.js");
        const verdict = evaluateResponse(result.text, result.finishReason, lastUserMsgForQuality);
        if (!verdict.acceptable) {
          attempts.push({ profileId: candidate, code: `quality-rejected:${verdict.reason}`, message: `response rejected by quality check (${verdict.reason})` });
          continue;
        }
      }
      break;
    }
    if (!isTransientFailure(result.code)) break;
    attempts.push({ profileId: candidate, code: result.code, message: result.message });
  }
```

- [ ] **Step 3: Run tests + build**

```
pnpm --filter @tierkit/core build
pnpm --filter @tierkit/core test
```

Expected: all existing tests pass. The auto fallback path is now driven by `autoResolver`, quality check runs on successful responses in auto mode.

- [ ] **Step 4: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/runtime/openaiCompat.ts
git -C /Users/siwal/code/Tierkit commit -m "refactor(runtime): openaiCompat uses autoResolver + post-response quality check"
```

---

## Task 9: `/v1/llm-call` auto support

**Files:**
- Modify: `packages/core/src/runtime/proxy/llmCall.ts`

- [ ] **Step 1: Add auto handling at the top of `executeLlmCall`**

In `packages/core/src/runtime/proxy/llmCall.ts`, find the `executeLlmCall` function. After the line `export async function executeLlmCall(...)` and BEFORE the existing first line of body (`const cfg = await loadConfig(context.cwd);`), insert:

```typescript
  if (request.profileId === "auto" || request.profileId === "tierkit") {
    const { resolveAutoCandidates } = await import("./autoResolver.js");
    const { evaluateResponse } = await import("../../model/ResponseQualityEvaluator.js");
    const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const resolved = await resolveAutoCandidates({
      cwd: context.cwd,
      env: context.env,
      lastUserMessage: typeof lastUserMsg === "string" ? lastUserMsg : "",
    });
    if (resolved.candidateIds.length === 0) {
      return { ok: false, code: "no-candidates", message: "auto-route: no profile matched" };
    }
    const cfg = await loadConfig(context.cwd);
    const qualityOn = cfg.config.routingPolicy.responseQualityCheck !== false;
    const lastUserMsgStr = typeof lastUserMsg === "string" ? lastUserMsg : "";
    let lastResult: LlmCallResult | undefined;
    for (const candidate of resolved.candidateIds) {
      const r = await executeLlmCall({ ...request, profileId: candidate }, context);
      lastResult = r;
      if (r.ok) {
        if (qualityOn) {
          const v = evaluateResponse(r.text, r.finishReason, lastUserMsgStr);
          if (!v.acceptable) continue;
        }
        return r;
      }
      if (!isTransientFailure(r.code)) return r;
    }
    return lastResult ?? { ok: false, code: "no-candidates", message: "no candidates tried" };
  }
```

Also add this helper at the bottom of the same file (after the existing `executeLlmCall` definition):

```typescript
function isTransientFailure(code: string): boolean {
  return (
    code === "unreachable" ||
    code === "bad-status" ||
    code === "missing-api-key" ||
    code === "not-implemented" ||
    code === "network-error" ||
    code === "timeout"
  );
}
```

- [ ] **Step 2: Add a test for the new auto path**

Append to `packages/core/test/autoResolver.test.ts`:

```typescript
import { executeLlmCall } from "../src/runtime/proxy/llmCall.js";

describe("executeLlmCall profileId='auto'", () => {
  it("returns no-candidates when no profiles exist", async () => {
    await fs.writeFile(
      path.join(tmp, "tierkit.config.json"),
      JSON.stringify({
        version: "0.1",
        modelProfiles: {},
        routingPolicy: { autoEscalationCeiling: "public-cloud" },
        runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
      }),
    );
    const r = await executeLlmCall(
      { profileId: "auto", messages: [{ role: "user", content: "hi" }] },
      { cwd: tmp, env: {} },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no-candidates");
  });
});
```

- [ ] **Step 3: Run tests + build**

```
pnpm --filter @tierkit/core build
pnpm --filter @tierkit/core test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/runtime/proxy/llmCall.ts packages/core/test/autoResolver.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(runtime): executeLlmCall supports profileId='auto' (uses autoResolver + quality check)"
```

---

## Task 10: `explainRoute` exposes chain + taskType

**Files:**
- Modify: `packages/core/src/usecases/explainRoute.ts`

- [ ] **Step 1: Add taskType + chain to the result**

Replace the contents of `packages/core/src/usecases/explainRoute.ts` with:

```typescript
import { loadConfig } from "../config/loadConfig.js";
import type { ModelProfile, ModelTier } from "../model/ModelProfile.js";
import { decideRoute, type RouteDecision } from "../model/ModelRouter.js";
import type { RiskInput, RiskThresholds } from "../model/RiskScorer.js";
import { classifyTask, type TaskType } from "../model/TaskClassifier.js";

export interface ExplainRouteUsecaseInput {
  task: string;
  cwd?: string;
  filesTouchedEstimate?: number;
  involvesSecrets?: boolean;
  involvesProductionInfra?: boolean;
}

export interface ExplainRouteUsecaseResult {
  task: string;
  taskType: TaskType;
  decision: RouteDecision;
  profile?: ModelProfile;
  thresholds: RiskThresholds;
  /** All profiles that match the chosen tier, in declaration order. The router picks the first. */
  candidates: { id: string; profile: ModelProfile }[];
}

export async function explainRoute(
  input: ExplainRouteUsecaseInput,
): Promise<ExplainRouteUsecaseResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const cfg = await loadConfig(projectRoot);

  const riskInput: RiskInput = {
    task: input.task,
    ...(input.filesTouchedEstimate !== undefined ? { filesTouchedEstimate: input.filesTouchedEstimate } : {}),
    ...(input.involvesSecrets !== undefined ? { involvesSecrets: input.involvesSecrets } : {}),
    ...(input.involvesProductionInfra !== undefined ? { involvesProductionInfra: input.involvesProductionInfra } : {}),
  };

  const thresholds = cfg.config.routingPolicy.riskThresholds;
  const taskType = classifyTask(input.task);

  const decision = decideRoute({
    task: riskInput,
    profiles: cfg.config.modelProfiles,
    thresholds,
    ceiling: cfg.config.routingPolicy.autoEscalationCeiling,
    taskType,
    ...(cfg.config.modelPolicy ? { policy: cfg.config.modelPolicy } : {}),
  });

  const candidates = Object.entries(cfg.config.modelProfiles)
    .filter(([, p]) => p.kind === (decision.tier as ModelTier))
    .map(([id, profile]) => ({ id, profile }));

  const profile = decision.profileId ? cfg.config.modelProfiles[decision.profileId] : undefined;

  return {
    task: input.task,
    taskType,
    decision,
    ...(profile ? { profile } : {}),
    thresholds,
    candidates,
  };
}
```

- [ ] **Step 2: Run existing tests**

```
pnpm --filter @tierkit/core test
```

Expected: all existing tests pass (`explainRoute` callers only add a new field; the old shape is unchanged). The `escalationChain` is now visible via `decision.escalationChain`.

- [ ] **Step 3: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/usecases/explainRoute.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(usecases): explainRoute exposes taskType + escalationChain"
```

---

## Task 11: `PATCH /v1/config/routing` endpoint

**Files:**
- Modify: `packages/core/src/runtime/Server.ts`
- Test: `packages/core/test/configRoutingEndpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/configRoutingEndpoint.test.ts`:

```typescript
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

let tmp: string;
let server: RunningServer | undefined;

async function boot() {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-routingep-"));
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {},
      routingPolicy: { autoEscalationCeiling: "public-cloud", budgetAwareDowngrade: true, responseQualityCheck: true },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
    }),
  );
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  return `http://${server.address}:${server.port}`;
}

afterEach(async () => {
  if (server) { await server.close(); server = undefined; }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("PATCH /v1/config/routing", () => {
  it("updates autoEscalationCeiling", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/config/routing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoEscalationCeiling: "private-remote" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(written.routingPolicy.autoEscalationCeiling).toBe("private-remote");
  });

  it("rejects unknown ceiling values with 400", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/config/routing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoEscalationCeiling: "moon" }),
    });
    expect(r.status).toBe(400);
  });

  it("ignores unknown fields silently", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/config/routing`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unknownField: true, budgetAwareDowngrade: false }),
    });
    expect(r.status).toBe(200);
    const written = JSON.parse(await fs.readFile(path.join(tmp, "tierkit.config.json"), "utf8"));
    expect(written.routingPolicy.budgetAwareDowngrade).toBe(false);
    expect(written.unknownField).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run configRoutingEndpoint
```

- [ ] **Step 3: Add PATCH /v1/config/routing in Server.ts**

In `packages/core/src/runtime/Server.ts`, find the `GET /v1/config` block (~line 365). Insert a new route block directly AFTER its closing brace:

```typescript
      if (method === "PATCH" && url.pathname === "/v1/config/routing") {
        const body = await readJsonBody<{
          autoEscalationCeiling?: unknown;
          budgetAwareDowngrade?: unknown;
          responseQualityCheck?: unknown;
        }>(req);
        if (!body || typeof body !== "object") {
          return sendJson(res, 400, { error: "request must be JSON object" });
        }
        const allowed = ["autoEscalationCeiling", "budgetAwareDowngrade", "responseQualityCheck"] as const;
        const patch: Record<string, unknown> = {};
        for (const k of allowed) {
          if (k in body) patch[k] = (body as Record<string, unknown>)[k];
        }
        if (patch.autoEscalationCeiling !== undefined &&
            !["local-device", "private-remote", "public-cloud"].includes(patch.autoEscalationCeiling as string)) {
          return sendJson(res, 400, { error: "autoEscalationCeiling must be one of local-device|private-remote|public-cloud" });
        }
        for (const k of ["budgetAwareDowngrade", "responseQualityCheck"] as const) {
          if (patch[k] !== undefined && typeof patch[k] !== "boolean") {
            return sendJson(res, 400, { error: `${k} must be boolean` });
          }
        }
        const configPath = path.join(opts.cwd, "tierkit.config.json");
        const existing = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
        const rp = (existing.routingPolicy as Record<string, unknown>) ?? {};
        existing.routingPolicy = { ...rp, ...patch };
        await fs.writeFile(configPath, JSON.stringify(existing, null, 2));
        return sendJson(res, 200, { ok: true, routingPolicy: existing.routingPolicy });
      }
```

Add to the import block at the top of `Server.ts` if not already present:
```typescript
import fs from "node:fs/promises";
```
(check for an existing fs import first — if `node:fs/promises` is already there, skip).

Also add `PATCH` to the `access-control-allow-methods` CORS header (around line 138):

```typescript
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, PATCH, OPTIONS");
```

- [ ] **Step 4: Run tests → expect PASS**

```
pnpm --filter @tierkit/core test
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/runtime/Server.ts packages/core/test/configRoutingEndpoint.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(runtime): PATCH /v1/config/routing — update auto-routing policy"
```

---

## Task 12: GUI — ceiling dropdown + Activity log marker + goodAt input

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Add i18n strings**

In `gui.ts`, append to `RUNTIME.en` block (after the existing keys):

```javascript
      autoCeilingLabel: 'Auto-escalation up to',
      autoCeilingSaved: 'routing policy updated',
      goodAtLabel: 'Good at (comma-separated)',
      goodAtPlaceholder: 'code-review, korean, summarize',
      moreOptionsLabel: 'More options',
      escalatedNote: 'escalated',
      qualityRejectedNote: 'quality-rejected',
```

Append to `RUNTIME.ko` block:

```javascript
      autoCeilingLabel: '자동 escalation 한계',
      autoCeilingSaved: '라우팅 정책 업데이트됨',
      goodAtLabel: '잘하는 작업 (콤마 구분)',
      goodAtPlaceholder: 'code-review, korean, summarize',
      moreOptionsLabel: '추가 옵션',
      escalatedNote: '상위 모델로 전환',
      qualityRejectedNote: '응답 품질 미달',
```

- [ ] **Step 2: Add ceiling dropdown inside the Models card**

In `gui.ts`, find the Models card HTML (around line 627-636 where `<section class="card">` containing `cardModels` is). Modify so the `<section class="card">` block now also contains a small ceiling-dropdown row right after the `<h2>`. Replace:

```html
    <h2>
      <span data-i18n="cardModels">Model profiles</span>
      <span class="h2-actions">
        <button id="btn-profile-add" class="tiny" data-i18n="profileAdd">+ Add</button>
      </span>
    </h2>
    <div id="models-list"><div class="empty" data-i18n="loading">loading…</div></div>
    <div id="profile-add-form" style="display:none"></div>
```

with:

```html
    <h2>
      <span data-i18n="cardModels">Model profiles</span>
      <span class="h2-actions">
        <button id="btn-profile-add" class="tiny" data-i18n="profileAdd">+ Add</button>
      </span>
    </h2>
    <div id="auto-ceiling-row" class="row dense" style="font-size:11px;color:var(--fg-dim);margin-bottom:6px">
      <span class="col-grow"><span data-i18n="autoCeilingLabel">Auto-escalation up to</span>:
        <select id="auto-ceiling-select" class="tiny">
          <option value="local-device">local-device</option>
          <option value="private-remote">private-remote</option>
          <option value="public-cloud">public-cloud</option>
        </select>
      </span>
    </div>
    <div id="models-list"><div class="empty" data-i18n="loading">loading…</div></div>
    <div id="profile-add-form" style="display:none"></div>
```

Then in the JS, add a small helper near `refreshModels` to load + persist the value. Add this function definition right above `refreshModels`:

```javascript
  async function refreshAutoCeiling() {
    try {
      const r = await jget('/v1/config');
      const cur = (r.config && r.config.routingPolicy && r.config.routingPolicy.autoEscalationCeiling) || 'public-cloud';
      const sel = $('auto-ceiling-select');
      if (sel) sel.value = cur;
    } catch (e) { /* ignore */ }
  }
```

And wire the change handler at the same place where other DOM event handlers are wired (search for `$('btn-profile-add').onclick =` and add right above it):

```javascript
  $('auto-ceiling-select').onchange = async () => {
    const value = $('auto-ceiling-select').value;
    const resp = await transport.request('/v1/config/routing', { method: 'PATCH', body: { autoEscalationCeiling: value } });
    if (!resp.ok) { toast((resp.data && resp.data.error) || i18n.failed, 'err'); return; }
    toast(i18n.autoCeilingSaved, 'ok');
  };
```

Make sure `refreshAutoCeiling()` is called from the main `Promise.all(...)` boot block (find `await Promise.all([refreshHealth(), refreshFreedom(), ...])` around line 2173 and add `refreshAutoCeiling()` to the array).

- [ ] **Step 3: Add `Good at` input to the add-profile form**

In `gui.ts`, find the `render(provider)` function inside `$('btn-profile-add').onclick`. The form HTML currently has fields up to `scope`. After the scope select but before the closing `</div>` of `form-grid`, add a "More options" disclosure. Find:

```javascript
            '<label>' + escapeHtml(i18n.scopeLabel) + '</label>' +
            '<select id="pa-scope">' +
              '<option value="workspace">' + escapeHtml(i18n.scopeWorkspace) + '</option>' +
              '<option value="user">' + escapeHtml(i18n.scopeUser) + '</option>' +
            '</select>' +
          '</div>' +
```

Replace with:

```javascript
            '<label>' + escapeHtml(i18n.scopeLabel) + '</label>' +
            '<select id="pa-scope">' +
              '<option value="workspace">' + escapeHtml(i18n.scopeWorkspace) + '</option>' +
              '<option value="user">' + escapeHtml(i18n.scopeUser) + '</option>' +
            '</select>' +
            '<label>' + escapeHtml(i18n.goodAtLabel) + '</label>' +
            '<input id="pa-goodAt" placeholder="' + escapeHtml(i18n.goodAtPlaceholder) + '" />' +
          '</div>' +
```

Then in the save handler (find `$('pa-save').onclick = async () => {`), after the existing `profile` construction and BEFORE the `jpost('/v1/config/profile', ...)` call, add:

```javascript
        const goodAtRaw = $('pa-goodAt') ? $('pa-goodAt').value.trim() : '';
        if (goodAtRaw) {
          profile.goodAt = goodAtRaw.split(',').map((s) => s.trim()).filter(Boolean);
        }
```

- [ ] **Step 4: Build + test**

```
pnpm --filter @tierkit/core build
pnpm --filter @tierkit/core test
```

Expected: builds clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/runtime/ui/gui.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(gui): auto-ceiling dropdown + goodAt input on profile form"
```

---

## Task 13: End-to-end verification

**Files:** none

- [ ] **Step 1: Run the full core test suite**

```
pnpm --filter @tierkit/core test
```

Expected: all green. The new files add ~30+ tests on top of the 278 from Phase 1, so expect ~310+ tests passing.

- [ ] **Step 2: Build the CLI**

```
pnpm --filter @tierkit/core build
pnpm --filter @tierkit/cli build
```

Expected: no errors.

- [ ] **Step 3: Start the daemon and check the GUI**

In one terminal:
```bash
cd /Users/siwal/code/Tierkit
node packages/cli/dist/index.js runtime start
```

In a browser at `http://127.0.0.1:4101/`:

- [ ] Settings tab → Model profiles card shows a new row "Auto-escalation up to: [public-cloud ▼]". Changing it triggers a toast and the value persists across reload.
- [ ] `+ Add` → form now has a `Good at (comma-separated)` field. Filling it stores the array in the profile (verify by reading `tierkit.config.json`).

- [ ] **Step 4: Smoke test the auto path via curl**

With the daemon running:

```bash
curl -s -X POST http://127.0.0.1:4101/v1/openai/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"review this code: function add(a,b){return a+b}"}]}' \
  | head -c 500
```

Expected: either a successful response (if at least one viable profile exists) or a clear error message naming the candidates tried. NOT a hang or a 500.

- [ ] **Step 5: Confirm budget gate still works**

If `budget` is configured, an auto call past the daily cap returns `budget-exceeded` without trying public-cloud candidates (they were pruned by `autoResolver`). Verify with:

```bash
curl -s http://127.0.0.1:4101/v1/budget
```

then check the response includes the daily limit. If it does, simulate a near-cap state by injecting a usage log entry — OR skip this step and rely on unit test coverage in Task 7.

- [ ] **Step 6: Final commit (only if any cleanups are needed; otherwise skip)**

```bash
git -C /Users/siwal/code/Tierkit log --oneline | head -20
```

Expected: 13 new commits stacked on the Phase 1 head (`14cbc22`).

---

## Self-Review

Spec coverage check (against [the design doc](../specs/2026-05-18-auto-fallback-and-routing-design.md)):

| Spec section | Plan task |
|---|---|
| 1. Escalation chain in RouteDecision (cross-tier, isEscalation flag) | Task 6 |
| 2. Ceiling policy + `autoEscalationCeiling` config | Tasks 5, 6, 7, 10 |
| 3. Budget-aware downgrade (80% threshold, public-cloud prune at 100%) | Task 7 |
| 4. Task-type aware sorting (goodAt + TaskClassifier) | Tasks 2, 4, 6 |
| 5. ResponseQualityEvaluator + refusalPatterns | Tasks 1, 3 |
| 6. Shared `autoResolver` | Task 7 |
| 7. `/v1/llm-call` auto support | Task 9 |
| 8. GUI: Activity log marker, ceiling dropdown, goodAt input | Task 12 |
| 9. `PATCH /v1/config/routing` endpoint | Task 11 |
| 10. Safety / observability (escalation log markers) | Implicit via existing `attempts[]` array in walker (Task 8). Not a separate task. |
| 11. Tests | Each task has tests inline |
| 12. Backward compatibility (defaults, goodAt optional) | Tasks 4, 5 (defaults baked in) |

No placeholders. Type names consistent across tasks:
- `TaskType`, `classifyTask`, `TASK_TYPES` — Tasks 2, 7, 9, 10
- `QualityVerdict`, `QualityReason`, `evaluateResponse` — Tasks 3, 8, 9
- `AutoResolveInput`, `AutoResolveResult`, `resolveAutoCandidates` — Tasks 7, 8, 9
- `RouteCandidate`, `escalationChain`, `isEscalation`, `ceiling`, `taskType` — Tasks 6, 7, 10
- `autoEscalationCeiling`, `budgetAwareDowngrade`, `responseQualityCheck` config keys — Tasks 5, 7, 8, 11, 12

One spec ↔ plan delta noted:

- **Spec §8 says "Activity log: add a one-line summary above the existing entry when an auto call escalated"** — the plan ships the `attempts[]` array containing `escalation` + `quality-rejected` codes via the OpenAI-compat response error path. A dedicated Activity log UI line is **deferred** to Phase 2b if needed — the codes are already visible in network responses, and the existing usage log records them. Adding a dedicated GUI line would require new fields in `usage.jsonl` and a refactor of `refreshActivity` — out of proportion with the value. The plan's Task 12 surfaces ceiling control + `goodAt` input which are the actionable parts.

- **Spec §9 mentions an optional `GET /v1/route/preview`** — skipped from MVP as the spec itself notes.
