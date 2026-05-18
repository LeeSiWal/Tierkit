# LLM-Generated Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GUI flow (and supporting endpoints) where users describe a plugin in natural language; Tierkit auto-routes the description through an LLM, validates the JSON, stashes it as a draft, and one-clicks install.

**Architecture:** A pure `generatePlugin` usecase produces validated manifest + rules from a description by calling `executeLlmCall({ profileId: "auto" })` and reusing Phase 2's auto-fallback/quality-check stack. Drafts land in `<dataDir>/plugin-drafts/<uuid>/` and are promoted to real plugins via the existing `installPlugin` + `enablePlugin` usecases.

**Tech Stack:** TypeScript, Node.js `node:crypto.randomUUID`, vitest, zod (existing). No new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-05-18-llm-generated-plugins-design.md](../specs/2026-05-18-llm-generated-plugins-design.md)

---

## File Structure

**New files:**

- `packages/core/src/usecases/generatePluginExample.ts` — exports a complete valid `{manifest, rules}` example used as a few-shot anchor in the prompt AND as a fixture in tests
- `packages/core/src/usecases/generatePlugin.ts` — the orchestrator: prompt → LLM → JSON parse → validate → retry → stash draft
- `packages/core/test/generatePlugin.test.ts` — unit tests with mocked `executeLlmCall`
- `packages/core/test/generatePluginEndpoint.test.ts` — integration tests for the 2 new endpoints

**Modified:**

- `packages/core/src/runtime/Server.ts` — 2 new endpoints
- `packages/core/src/runtime/ui/gui.ts` — Plugins card UI (button + form + preview panel)
- `packages/core/src/index.ts` — export the new usecase

---

## Task 1: Few-shot example fixture

**Files:**
- Create: `packages/core/src/usecases/generatePluginExample.ts`
- Test: `packages/core/test/generatePluginExample.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/generatePluginExample.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { GENERATE_PLUGIN_EXAMPLE, GENERATE_PLUGIN_EXAMPLE_JSON } from "../src/usecases/generatePluginExample.js";
import { PluginManifestSchema } from "../src/plugin/PluginManifest.js";

describe("generatePluginExample", () => {
  it("manifest passes PluginManifestSchema", () => {
    expect(() => PluginManifestSchema.parse(GENERATE_PLUGIN_EXAMPLE.manifest)).not.toThrow();
  });

  it("each rule has a valid filename", () => {
    const FILENAME_RE = /^[0-9a-z][0-9a-z._-]*\.md$/;
    for (const rule of GENERATE_PLUGIN_EXAMPLE.rules) {
      expect(rule.filename).toMatch(FILENAME_RE);
      expect(rule.content.length).toBeGreaterThan(20);
    }
  });

  it("manifest.components.rules matches the rule filenames (with rules/ prefix)", () => {
    const expected = GENERATE_PLUGIN_EXAMPLE.rules.map((r) => `rules/${r.filename}`).sort();
    expect([...GENERATE_PLUGIN_EXAMPLE.manifest.components.rules].sort()).toEqual(expected);
  });

  it("GENERATE_PLUGIN_EXAMPLE_JSON is a string serialization of the same data", () => {
    const parsed = JSON.parse(GENERATE_PLUGIN_EXAMPLE_JSON) as typeof GENERATE_PLUGIN_EXAMPLE;
    expect(parsed.manifest.id).toBe(GENERATE_PLUGIN_EXAMPLE.manifest.id);
    expect(parsed.rules.length).toBe(GENERATE_PLUGIN_EXAMPLE.rules.length);
  });
});
```

- [ ] **Step 2: Run test → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run generatePluginExample
```

- [ ] **Step 3: Create the example fixture**

Create `packages/core/src/usecases/generatePluginExample.ts`:

```typescript
import type { PluginManifest } from "../plugin/PluginManifest.js";

export interface GeneratedPluginShape {
  manifest: PluginManifest;
  rules: Array<{ filename: string; content: string }>;
}

export const GENERATE_PLUGIN_EXAMPLE: GeneratedPluginShape = {
  manifest: {
    schemaVersion: "0.1",
    id: "tdd-first-python",
    name: "TDD-first Python",
    version: "0.1.0",
    description: "Always require a failing pytest test before any implementation; prefer small commits.",
    author: "Tierkit auto-generator",
    license: "MIT",
    compatibility: { tierkit: "^0.3.0", targets: ["generic"] },
    components: {
      commands: [],
      modes: [],
      rules: ["rules/01-failing-test-first.md", "rules/02-prefer-pytest.md", "rules/03-small-commits.md"],
      workflows: [],
      hooks: [],
    },
    permissions: { fs: ["read"], net: [], shell: [] },
    freedom: { level: "balanced" },
  },
  rules: [
    {
      filename: "01-failing-test-first.md",
      content:
        "# Failing test first\n\n" +
        "Always write a failing pytest test BEFORE writing any implementation code. " +
        "The test must run and fail with an assertion error (not an import error) before the implementation begins. " +
        "Never modify both the test and the implementation in the same step.",
    },
    {
      filename: "02-prefer-pytest.md",
      content:
        "# Prefer pytest\n\n" +
        "When adding tests, use pytest idioms (`def test_x():`, fixtures, parametrize). " +
        "Never introduce unittest.TestCase classes unless the existing codebase already uses them.",
    },
    {
      filename: "03-small-commits.md",
      content:
        "# Small commits\n\n" +
        "Commit after each green test. " +
        "A commit must contain either (a) one failing test, or (b) the minimal implementation that makes the previously-failing test pass. " +
        "Never bundle test + implementation in the same commit.",
    },
  ],
};

export const GENERATE_PLUGIN_EXAMPLE_JSON = JSON.stringify(GENERATE_PLUGIN_EXAMPLE, null, 2);
```

- [ ] **Step 4: Run test → expect PASS**

```
pnpm --filter @tierkit/core exec vitest run generatePluginExample
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/usecases/generatePluginExample.ts packages/core/test/generatePluginExample.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(usecases): few-shot example fixture for generatePlugin"
```

---

## Task 2: generatePlugin — happy path (no retry)

**Files:**
- Create: `packages/core/src/usecases/generatePlugin.ts`
- Test: `packages/core/test/generatePlugin.test.ts`

- [ ] **Step 1: Write the failing tests (happy path only)**

Create `packages/core/test/generatePlugin.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePlugin, PluginGenerateError } from "../src/usecases/generatePlugin.js";
import { GENERATE_PLUGIN_EXAMPLE_JSON } from "../src/usecases/generatePluginExample.js";
import * as llmCallModule from "../src/runtime/proxy/llmCall.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-genplugin-"));
  await fs.mkdir(path.join(tmp, ".tierkit"), { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("generatePlugin — happy path", () => {
  it("returns parsed manifest+rules and writes draft files when LLM returns valid JSON", async () => {
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true,
      text: GENERATE_PLUGIN_EXAMPLE_JSON,
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0,
      latencyMs: 1234,
      profileId: "claudeHaiku",
      model: "claude-haiku-4-5-20251001",
      redactionHits: [],
      commandClassifications: [],
      budget: { status: "ok" },
    });

    const r = await generatePlugin({
      description: "TDD-first Python plugin",
      cwd: tmp,
      env: {},
    });

    expect(r.manifest.id).toBe("tdd-first-python");
    expect(r.rules.length).toBe(3);
    expect(r.modelUsed).toBe("claudeHaiku");
    expect(r.draftId).toMatch(/^[0-9a-f-]{36}$/);

    // Files exist on disk.
    const manifestExists = await fs
      .access(path.join(r.draftPath, "tierkit.plugin.json"))
      .then(() => true)
      .catch(() => false);
    expect(manifestExists).toBe(true);

    for (const rule of r.rules) {
      const ruleExists = await fs
        .access(path.join(r.draftPath, "rules", rule.filename))
        .then(() => true)
        .catch(() => false);
      expect(ruleExists).toBe(true);
    }
  });

  it("strips markdown code fences around the JSON before parsing", async () => {
    const wrapped = "```json\n" + GENERATE_PLUGIN_EXAMPLE_JSON + "\n```";
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true,
      text: wrapped,
      inputTokens: 100, outputTokens: 200, costUsd: 0, latencyMs: 1, profileId: "x", model: "x",
      redactionHits: [], commandClassifications: [], budget: { status: "ok" },
    });
    const r = await generatePlugin({ description: "x", cwd: tmp, env: {} });
    expect(r.manifest.id).toBe("tdd-first-python");
  });

  it("rejects descriptions longer than 4000 chars", async () => {
    await expect(
      generatePlugin({ description: "x".repeat(4001), cwd: tmp, env: {} }),
    ).rejects.toBeInstanceOf(PluginGenerateError);
  });

  it("rejects empty description", async () => {
    await expect(
      generatePlugin({ description: "", cwd: tmp, env: {} }),
    ).rejects.toBeInstanceOf(PluginGenerateError);
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run generatePlugin.test
```

- [ ] **Step 3: Implement minimal `generatePlugin` (no retry yet)**

Create `packages/core/src/usecases/generatePlugin.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/loadConfig.js";
import { executeLlmCall } from "../runtime/proxy/llmCall.js";
import { PluginManifestSchema, type PluginManifest } from "../plugin/PluginManifest.js";
import { TierkitError } from "../errors/TierkitError.js";
import { GENERATE_PLUGIN_EXAMPLE_JSON, type GeneratedPluginShape } from "./generatePluginExample.js";

export class PluginGenerateError extends TierkitError {
  public readonly code: string;
  public readonly rawOutput?: string;
  constructor(code: string, message: string, rawOutput?: string) {
    super(message);
    this.name = "PluginGenerateError";
    this.code = code;
    if (rawOutput !== undefined) this.rawOutput = rawOutput;
  }
}

export interface GeneratedRule {
  filename: string;
  content: string;
}

export interface GeneratePluginInput {
  description: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface GeneratePluginResult {
  draftId: string;
  draftPath: string;
  manifest: PluginManifest;
  rules: GeneratedRule[];
  modelUsed: string;
}

const FILENAME_RE = /^[0-9a-z][0-9a-z._-]*\.md$/;
const MAX_DESC_LEN = 4000;

const SYSTEM_PROMPT =
  `You are generating a Tierkit plugin. Tierkit plugins guide AI coding agents by ` +
  `injecting behavior rules into every model call.\n\n` +
  `Output ONLY valid JSON matching this exact shape, with NO markdown wrappers, NO ` +
  `commentary, NO trailing text:\n\n` +
  `{\n` +
  `  "manifest": {\n` +
  `    "schemaVersion": "0.1",\n` +
  `    "id": "kebab-case-id",\n` +
  `    "name": "Human-readable Name",\n` +
  `    "version": "0.1.0",\n` +
  `    "description": "One-line description.",\n` +
  `    "author": "Tierkit auto-generator",\n` +
  `    "license": "MIT",\n` +
  `    "compatibility": { "tierkit": "^0.3.0", "targets": ["generic"] },\n` +
  `    "components": { "commands": [], "modes": [], "rules": ["rules/01-...md"], "workflows": [], "hooks": [] },\n` +
  `    "permissions": { "fs": ["read"], "net": [], "shell": [] },\n` +
  `    "freedom": { "level": "guided" }\n` +
  `  },\n` +
  `  "rules": [\n` +
  `    { "filename": "01-foo.md", "content": "# Foo\\n\\nAlways do X. Never do Y." }\n` +
  `  ]\n` +
  `}\n\n` +
  `Rules:\n` +
  `- "id" is kebab-case starting with a letter (a-z), max 40 chars.\n` +
  `- "freedom.level" is one of: "free", "guided", "balanced", "strict".\n` +
  `- 3 to 7 rule files. Filenames: "01-...md", "02-...md", numeric-prefixed for sort order.\n` +
  `- Each rule's content is markdown in present-tense imperative ("Always X. Never Y.").\n` +
  `- Rules are guidance text, NEVER shell commands or executable code.\n` +
  `- "components.rules" lists each generated rule filename WITH the "rules/" prefix.\n` +
  `- "permissions.fs" should be ["read"] unless the plugin clearly needs writes.\n\n` +
  `Example output for "TDD-first Python plugin":\n\n` +
  GENERATE_PLUGIN_EXAMPLE_JSON +
  `\n\nReturn ONLY the JSON object. No prose, no markdown fences.`;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1]! : trimmed;
}

function parseAndValidate(raw: string): GeneratedPluginShape {
  const stripped = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new Error(`JSON parse failed: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("response is not an object");
  const shape = parsed as { manifest?: unknown; rules?: unknown };
  if (!shape.manifest || !Array.isArray(shape.rules)) {
    throw new Error("response missing manifest or rules");
  }
  const manifest = PluginManifestSchema.parse(shape.manifest);
  const rules: GeneratedRule[] = [];
  for (const r of shape.rules) {
    if (typeof r !== "object" || r === null) throw new Error("rule entry not an object");
    const entry = r as { filename?: unknown; content?: unknown };
    if (typeof entry.filename !== "string" || typeof entry.content !== "string") {
      throw new Error("rule entry must have string filename + content");
    }
    if (!FILENAME_RE.test(entry.filename)) {
      throw new Error(`invalid rule filename: ${entry.filename}`);
    }
    rules.push({ filename: entry.filename, content: entry.content });
  }
  // Auto-correct components.rules to match the generated rule filenames.
  manifest.components.rules = rules.map((r) => `rules/${r.filename}`);
  return { manifest, rules };
}

async function writeDraft(
  dataDir: string,
  draftId: string,
  shape: GeneratedPluginShape,
): Promise<string> {
  const draftRoot = path.join(dataDir, "plugin-drafts", draftId);
  await fs.mkdir(path.join(draftRoot, "rules"), { recursive: true });
  await fs.writeFile(
    path.join(draftRoot, "tierkit.plugin.json"),
    JSON.stringify(shape.manifest, null, 2),
  );
  for (const rule of shape.rules) {
    await fs.writeFile(path.join(draftRoot, "rules", rule.filename), rule.content);
  }
  return draftRoot;
}

export async function generatePlugin(input: GeneratePluginInput): Promise<GeneratePluginResult> {
  if (input.description.length === 0) {
    throw new PluginGenerateError("invalid-description", "description must be non-empty");
  }
  if (input.description.length > MAX_DESC_LEN) {
    throw new PluginGenerateError(
      "description-too-long",
      `description must be at most ${MAX_DESC_LEN} chars (got ${input.description.length})`,
    );
  }

  const cfg = await loadConfig(input.cwd);
  const dataDir = path.join(input.cwd, cfg.config.runtime.dataDir);

  const result = await executeLlmCall(
    {
      profileId: "auto",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input.description },
      ],
    },
    { cwd: input.cwd, env: input.env },
  );

  if (!result.ok) {
    throw new PluginGenerateError("llm-call-failed", `${result.code}: ${result.message}`);
  }

  let shape: GeneratedPluginShape;
  try {
    shape = parseAndValidate(result.text);
  } catch (e) {
    throw new PluginGenerateError("validation-failed", (e as Error).message, result.text);
  }

  const draftId = randomUUID();
  const draftPath = await writeDraft(dataDir, draftId, shape);

  return {
    draftId,
    draftPath,
    manifest: shape.manifest,
    rules: shape.rules,
    modelUsed: result.profileId,
  };
}
```

- [ ] **Step 4: Run tests → expect PASS (4 tests in this file plus the 4 from Task 1)**

```
pnpm --filter @tierkit/core exec vitest run generatePlugin
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/usecases/generatePlugin.ts packages/core/test/generatePlugin.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(usecases): generatePlugin happy path (LLM → JSON → validate → draft)"
```

---

## Task 3: generatePlugin retry on validation failure

**Files:**
- Modify: `packages/core/src/usecases/generatePlugin.ts`
- Modify: `packages/core/test/generatePlugin.test.ts`

- [ ] **Step 1: Add retry tests**

Append to `packages/core/test/generatePlugin.test.ts`:

```typescript
describe("generatePlugin — retry", () => {
  it("retries once when the first response is unparseable JSON", async () => {
    const calls = [
      { ok: true, text: "not valid json {{{", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" as const } },
      { ok: true, text: GENERATE_PLUGIN_EXAMPLE_JSON, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" as const } },
    ];
    const spy = vi.spyOn(llmCallModule, "executeLlmCall");
    spy.mockResolvedValueOnce(calls[0]!).mockResolvedValueOnce(calls[1]!);
    const r = await generatePlugin({ description: "x", cwd: tmp, env: {} });
    expect(r.manifest.id).toBe("tdd-first-python");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retries once when the schema validation fails", async () => {
    const badManifest = JSON.stringify({
      manifest: { id: "missing-required-fields" },
      rules: [],
    });
    const spy = vi.spyOn(llmCallModule, "executeLlmCall");
    spy
      .mockResolvedValueOnce({ ok: true, text: badManifest, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" } })
      .mockResolvedValueOnce({ ok: true, text: GENERATE_PLUGIN_EXAMPLE_JSON, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" } });
    const r = await generatePlugin({ description: "x", cwd: tmp, env: {} });
    expect(r.manifest.id).toBe("tdd-first-python");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns validation-failed with rawOutput when both attempts fail", async () => {
    const badText = "still not json {{";
    const spy = vi.spyOn(llmCallModule, "executeLlmCall");
    spy.mockResolvedValue({ ok: true, text: badText, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m", redactionHits: [], commandClassifications: [], budget: { status: "ok" } });
    try {
      await generatePlugin({ description: "x", cwd: tmp, env: {} });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PluginGenerateError);
      const err = e as PluginGenerateError;
      expect(err.code).toBe("validation-failed");
      expect(err.rawOutput).toBe(badText);
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL**

```
pnpm --filter @tierkit/core exec vitest run generatePlugin
```

The retry tests will fail because there's no retry logic yet.

- [ ] **Step 3: Add retry logic to `generatePlugin`**

In `packages/core/src/usecases/generatePlugin.ts`, replace the section starting at `const result = await executeLlmCall(` through to the end of the `try/catch` block that parses `shape`. Replace with:

```typescript
  let lastRaw = "";
  let lastError = "";
  let modelUsed = "";
  let shape: GeneratedPluginShape | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: input.description },
    ];
    if (attempt > 0) {
      messages.push({
        role: "user",
        content:
          `Your previous response was rejected:\n\n${lastError}\n\n` +
          `Your previous output was:\n\n${lastRaw}\n\n` +
          `Please return a corrected JSON object. Output ONLY the JSON, no markdown fences, no commentary.`,
      });
    }
    const result = await executeLlmCall(
      { profileId: "auto", messages },
      { cwd: input.cwd, env: input.env },
    );
    if (!result.ok) {
      throw new PluginGenerateError("llm-call-failed", `${result.code}: ${result.message}`);
    }
    lastRaw = result.text;
    modelUsed = result.profileId;
    try {
      shape = parseAndValidate(result.text);
      break;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  if (!shape) {
    throw new PluginGenerateError("validation-failed", lastError, lastRaw);
  }
```

- [ ] **Step 4: Run tests → expect PASS**

```
pnpm --filter @tierkit/core exec vitest run generatePlugin
```

All 7 tests in generatePlugin.test.ts plus all 4 in generatePluginExample.test.ts pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/usecases/generatePlugin.ts packages/core/test/generatePlugin.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(usecases): generatePlugin retries once on validation failure"
```

---

## Task 4: Export usecase + register in barrel

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the exports**

In `packages/core/src/index.ts`, find an appropriate place (near other `usecases/` exports — search for `installPlugin` to anchor) and add:

```typescript
export {
  generatePlugin,
  PluginGenerateError,
  type GeneratePluginInput,
  type GeneratePluginResult,
  type GeneratedRule,
} from "./usecases/generatePlugin.js";
```

- [ ] **Step 2: Build → expect success**

```
pnpm --filter @tierkit/core build
pnpm --filter @tierkit/core test
```

All tests still pass.

- [ ] **Step 3: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/index.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(core): export generatePlugin from public API"
```

---

## Task 5: Endpoints — POST /v1/plugins/generate + install

**Files:**
- Modify: `packages/core/src/runtime/Server.ts`
- Test: `packages/core/test/generatePluginEndpoint.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/generatePluginEndpoint.test.ts`:

```typescript
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";
import { GENERATE_PLUGIN_EXAMPLE_JSON } from "../src/usecases/generatePluginExample.js";
import * as llmCallModule from "../src/runtime/proxy/llmCall.js";

let tmp: string;
let server: RunningServer | undefined;

async function boot() {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-genplugin-ep-"));
  await fs.writeFile(
    path.join(tmp, "tierkit.config.json"),
    JSON.stringify({
      version: "0.1",
      modelProfiles: {
        // single local-fake profile so resolveAutoCandidates has at least one candidate
        localFake: { kind: "local-device", provider: "mock", model: "tiny", roles: [] },
      },
      routingPolicy: { autoEscalationCeiling: "local-device" },
      runtime: { port: 0, dataDir: ".tierkit", host: "127.0.0.1" },
    }),
  );
  server = await startServer({ cwd: tmp, host: "127.0.0.1", port: 0 });
  return `http://${server.address}:${server.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { await server.close(); server = undefined; }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe("POST /v1/plugins/generate", () => {
  it("returns draftId + manifest when LLM returns valid JSON", async () => {
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true,
      text: GENERATE_PLUGIN_EXAMPLE_JSON,
      inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "localFake", model: "tiny",
      redactionHits: [], commandClassifications: [], budget: { status: "ok" },
    });
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/plugins/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "TDD-first python" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; draftId: string; manifest: { id: string }; rules: unknown[]; modelUsed: string };
    expect(body.ok).toBe(true);
    expect(body.draftId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.manifest.id).toBe("tdd-first-python");
    expect(body.rules.length).toBe(3);
    expect(body.modelUsed).toBe("localFake");
  });

  it("returns 400 with empty description", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/plugins/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 + code='validation-failed' + rawOutput when LLM consistently produces invalid JSON", async () => {
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true, text: "not json", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m",
      redactionHits: [], commandClassifications: [], budget: { status: "ok" },
    });
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/plugins/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { ok: boolean; code: string; rawOutput: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("validation-failed");
    expect(body.rawOutput).toBe("not json");
  });
});

describe("POST /v1/plugins/generate/install", () => {
  it("promotes a draft to an installed plugin", async () => {
    vi.spyOn(llmCallModule, "executeLlmCall").mockResolvedValue({
      ok: true, text: GENERATE_PLUGIN_EXAMPLE_JSON, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 1, profileId: "p", model: "m",
      redactionHits: [], commandClassifications: [], budget: { status: "ok" },
    });
    const baseUrl = await boot();
    const gen = await fetch(`${baseUrl}/v1/plugins/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    }).then((r) => r.json()) as { draftId: string };
    const ins = await fetch(`${baseUrl}/v1/plugins/generate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftId: gen.draftId, enable: false }),
    });
    expect(ins.status).toBe(200);
    const body = await ins.json() as { ok: boolean; pluginId: string };
    expect(body.ok).toBe(true);
    expect(body.pluginId).toBe("tdd-first-python");

    // Plugin is now in the registry.
    const registryRaw = await fs.readFile(path.join(tmp, ".tierkit", "plugins.json"), "utf8").catch(() => "{}");
    const registry = JSON.parse(registryRaw) as { plugins: Array<{ id: string }> };
    expect(registry.plugins.some((p) => p.id === "tdd-first-python")).toBe(true);

    // Draft is cleaned up.
    const draftExists = await fs.access(path.join(tmp, ".tierkit", "plugin-drafts", gen.draftId))
      .then(() => true).catch(() => false);
    expect(draftExists).toBe(false);
  });

  it("returns 404 for an unknown draftId", async () => {
    const baseUrl = await boot();
    const r = await fetch(`${baseUrl}/v1/plugins/generate/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftId: "00000000-0000-0000-0000-000000000000", enable: false }),
    });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests → expect FAIL (routes don't exist yet)**

```
pnpm --filter @tierkit/core exec vitest run generatePluginEndpoint
```

- [ ] **Step 3: Implement the endpoints**

In `packages/core/src/runtime/Server.ts`, find the `GET /v1/plugins` route. Insert this NEW block AFTER its closing brace, BEFORE the next route:

```typescript
      if (route === "POST /v1/plugins/generate") {
        const body = await readJsonBody<{ description: string }>(req);
        if (!body || typeof body.description !== "string") {
          return sendJson(res, 400, { error: "request must be { description: string }" });
        }
        try {
          const { generatePlugin } = await import("../usecases/generatePlugin.js");
          const r = await generatePlugin({ description: body.description, cwd: opts.cwd, env });
          return sendJson(res, 200, {
            ok: true,
            draftId: r.draftId,
            manifest: r.manifest,
            rules: r.rules,
            modelUsed: r.modelUsed,
          });
        } catch (err) {
          const e = err as { code?: string; message?: string; rawOutput?: string };
          if (e.code === "invalid-description" || e.code === "description-too-long") {
            return sendJson(res, 400, { ok: false, code: e.code, message: e.message });
          }
          return sendJson(res, 400, {
            ok: false,
            code: e.code ?? "generate-failed",
            message: e.message ?? "generation failed",
            ...(e.rawOutput ? { rawOutput: e.rawOutput } : {}),
          });
        }
      }

      if (route === "POST /v1/plugins/generate/install") {
        const body = await readJsonBody<{ draftId: string; enable?: boolean }>(req);
        if (!body || typeof body.draftId !== "string" || !/^[0-9a-f-]{36}$/.test(body.draftId)) {
          return sendJson(res, 400, { error: "request must be { draftId: uuid }" });
        }
        const cfg = await loadConfig(opts.cwd);
        const draftPath = path.join(opts.cwd, cfg.config.runtime.dataDir, "plugin-drafts", body.draftId);
        try {
          await fs.access(draftPath);
        } catch {
          return sendJson(res, 404, { ok: false, code: "draft-not-found", message: "draft not found or expired" });
        }
        const { installPlugin } = await import("../usecases/installPlugin.js");
        const ins = await installPlugin({ pluginPath: draftPath, cwd: opts.cwd, force: true });
        let enabled = false;
        if (body.enable) {
          const { enablePlugin } = await import("../usecases/pluginLifecycle.js");
          await enablePlugin({ pluginId: ins.pluginId, cwd: opts.cwd });
          enabled = true;
        }
        await fs.rm(draftPath, { recursive: true, force: true });
        return sendJson(res, 200, { ok: true, pluginId: ins.pluginId, version: ins.version, installedPath: ins.installedPath, enabled });
      }
```

Confirm `fs` (`node:fs/promises`) and `path` are already imported at the top of Server.ts. Both were added in Phase 1/2 if not pre-existing — should be present.

- [ ] **Step 4: Run tests → expect PASS**

```
pnpm --filter @tierkit/core test
```

Expected: full suite passes, 5 new tests from this task.

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/runtime/Server.ts packages/core/test/generatePluginEndpoint.test.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(runtime): POST /v1/plugins/generate + /generate/install"
```

---

## Task 6: GUI — Describe & generate button + form + preview

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Add i18n strings**

In `gui.ts`, find `RUNTIME.en` block. Append at the end:

```javascript
      genPluginBtn: '+ Describe & generate',
      genDescribeLabel: 'Describe the plugin you want',
      genDescribePlaceholder: 'e.g. A TDD-first plugin for Python that requires a failing pytest test before any implementation. Prefers small commits.',
      genButton: 'Generate →',
      genGenerating: 'Generating… this may take 10–30s (auto-routed)',
      genPreviewTitle: 'Preview',
      genGeneratedBy: 'generated by',
      genRulesCount: 'rules',
      genInstallEnable: 'Install + Enable',
      genInstallOnly: 'Install only',
      genDiscard: 'Discard',
      genInstalled: 'plugin installed',
      genRawOutputLabel: 'Last raw output (for debugging)',
```

`RUNTIME.ko`:

```javascript
      genPluginBtn: '+ 설명으로 만들기',
      genDescribeLabel: '원하는 플러그인을 설명하세요',
      genDescribePlaceholder: '예: Python 프로젝트용 TDD-first 플러그인. 구현 전에 항상 실패하는 pytest 테스트를 먼저 작성하게 함. 작은 커밋 선호.',
      genButton: '생성 →',
      genGenerating: '생성 중… 10–30초 소요 (auto-routed)',
      genPreviewTitle: '미리보기',
      genGeneratedBy: '생성 모델',
      genRulesCount: '규칙',
      genInstallEnable: '설치 + 활성화',
      genInstallOnly: '설치만',
      genDiscard: '취소',
      genInstalled: '플러그인 설치됨',
      genRawOutputLabel: '마지막 원본 출력 (디버깅용)',
```

- [ ] **Step 2: Add the button to the Plugins card header**

Find the Plugins card `<section class="card">` block (search for `cardPlugins` data-i18n). The `<h2>` `<span class="h2-actions">` block currently has a `+ New` button. Add the new button right after it. The current span:

```html
      <span class="h2-actions">
        <button id="btn-plugin-new" class="tiny" data-i18n="pluginNew">+ New</button>
      </span>
```

Replace with:

```html
      <span class="h2-actions">
        <button id="btn-plugin-new" class="tiny" data-i18n="pluginNew">+ New</button>
        <button id="btn-plugin-gen" class="tiny" data-i18n="genPluginBtn">+ Describe &amp; generate</button>
      </span>
```

(If the actual button id or i18n key for `+ New` differs — use grep to find the right Plugins card block, then add the new button right next to the existing `+ New` button button.)

- [ ] **Step 3: Wire the click handler**

In the JS section of `gui.ts`, find where `$('btn-plugin-new').onclick = ...` is wired. Below that handler, add:

```javascript
  $('btn-plugin-gen').onclick = () => openGeneratePluginForm();

  function openGeneratePluginForm() {
    const host = $('plugin-new-form'); // reuse the same host div the "+ New" form uses
    if (!host) return;
    host.style.display = 'block';
    host.innerHTML =
      '<div class="inline-form">' +
        '<div style="margin-bottom:6px">' + escapeHtml(i18n.genDescribeLabel) + '</div>' +
        '<textarea id="gen-desc" rows="5" style="width:100%;font-family:inherit;font-size:12px" placeholder="' + escapeHtml(i18n.genDescribePlaceholder) + '"></textarea>' +
        '<div class="actions">' +
          '<button id="gen-cancel">' + escapeHtml(i18n.cancelBtn) + '</button>' +
          '<button id="gen-go" class="primary">' + escapeHtml(i18n.genButton) + '</button>' +
        '</div>' +
      '</div>';
    $('gen-cancel').onclick = () => { host.innerHTML = ''; host.style.display = 'none'; };
    $('gen-go').onclick = async () => {
      const desc = ($('gen-desc').value || '').trim();
      if (!desc) { toast('description required', 'err'); return; }
      $('gen-go').disabled = true;
      $('gen-go').textContent = '…';
      host.innerHTML = '<div class="empty">' + escapeHtml(i18n.genGenerating) + '</div>';
      try {
        const resp = await jpost('/v1/plugins/generate', { description: desc });
        if (!resp.ok) {
          const code = resp.data && resp.data.code ? resp.data.code : 'error';
          const msg = resp.data && resp.data.message ? resp.data.message : 'failed';
          const raw = resp.data && resp.data.rawOutput ? resp.data.rawOutput : '';
          host.innerHTML =
            '<div class="empty" style="color:var(--warn)">' + escapeHtml(code + ': ' + msg) + '</div>' +
            (raw ? '<details><summary>' + escapeHtml(i18n.genRawOutputLabel) + '</summary><pre style="white-space:pre-wrap;font-size:11px">' + escapeHtml(raw) + '</pre></details>' : '') +
            '<div class="actions"><button id="gen-back">' + escapeHtml(i18n.cancelBtn) + '</button></div>';
          $('gen-back').onclick = () => { host.innerHTML = ''; host.style.display = 'none'; };
          return;
        }
        renderGenPreview(host, resp.data);
      } catch (e) {
        host.innerHTML = '<div class="empty" style="color:var(--warn)">' + escapeHtml(e.message) + '</div>';
      }
    };
  }

  function renderGenPreview(host, data) {
    const m = data.manifest || {};
    const rules = data.rules || [];
    const meta = [
      'id: ' + (m.id || '?'),
      'name: ' + (m.name || '?'),
      'version: ' + (m.version || '?'),
      'freedom: ' + (m.freedom && m.freedom.level ? m.freedom.level : '?'),
    ].join('<br>');
    let rulesHtml = '';
    for (const r of rules) {
      rulesHtml +=
        '<details>' +
          '<summary>' + escapeHtml(r.filename) + ' <span class="dim">(' + r.content.length + ' chars)</span></summary>' +
          '<pre style="white-space:pre-wrap;font-size:11px">' + escapeHtml(r.content) + '</pre>' +
        '</details>';
    }
    host.innerHTML =
      '<div class="inline-form">' +
        '<div style="font-weight:600;margin-bottom:6px">' + escapeHtml(i18n.genPreviewTitle) + '</div>' +
        '<div class="mono" style="font-size:11px;margin-bottom:8px">' + meta + '</div>' +
        '<div class="dim" style="font-size:11px;margin-bottom:6px">' + escapeHtml(i18n.genRulesCount) + ' (' + rules.length + ')</div>' +
        rulesHtml +
        '<div class="dim" style="font-size:11px;margin-top:8px">' + escapeHtml(i18n.genGeneratedBy) + ' <span class="mono">' + escapeHtml(data.modelUsed || '?') + '</span></div>' +
        '<div class="actions">' +
          '<button id="gen-discard">' + escapeHtml(i18n.genDiscard) + '</button>' +
          '<button id="gen-install-only">' + escapeHtml(i18n.genInstallOnly) + '</button>' +
          '<button id="gen-install-enable" class="primary">' + escapeHtml(i18n.genInstallEnable) + '</button>' +
        '</div>' +
      '</div>';
    $('gen-discard').onclick = () => { host.innerHTML = ''; host.style.display = 'none'; };
    $('gen-install-only').onclick = () => installDraft(host, data.draftId, false);
    $('gen-install-enable').onclick = () => installDraft(host, data.draftId, true);
  }

  async function installDraft(host, draftId, enable) {
    const resp = await jpost('/v1/plugins/generate/install', { draftId: draftId, enable: enable });
    if (!resp.ok) {
      toast((resp.data && resp.data.message) || i18n.failed, 'err');
      return;
    }
    toast(resp.data.pluginId + ' ✓ ' + i18n.genInstalled, 'ok');
    host.innerHTML = '';
    host.style.display = 'none';
    if (typeof refreshPlugins === 'function') await refreshPlugins();
  }
```

NOTE: the host element. The plan reuses `#plugin-new-form` (the existing host used by `+ New`). If that id doesn't exist (the Plugins card may not have an inline form host), wrap the form in a `<div id="plugin-gen-form">` and update the HTML in step 2 accordingly. Check by grepping for `plugin-new-form` first.

- [ ] **Step 4: Build + run tests**

```
pnpm --filter @tierkit/core build
pnpm --filter @tierkit/core test
```

Full suite passes.

- [ ] **Step 5: Commit**

```bash
git -C /Users/siwal/code/Tierkit add packages/core/src/runtime/ui/gui.ts
git -C /Users/siwal/code/Tierkit commit -m "feat(gui): Describe & generate flow for plugins (preview + install)"
```

---

## Task 7: End-to-end verification

**Files:** none

- [ ] **Step 1: Run the full core test suite**

```
pnpm --filter @tierkit/core test
```

Expected: all green. 7 new tests from Tasks 1–5 on top of 335 from Phase 2 ≈ 350+ total.

- [ ] **Step 2: Build the CLI + VS Code extension targets**

```
pnpm --filter @tierkit/core build
pnpm --filter @tierkit/cli build
```

Expected: no TS errors.

- [ ] **Step 3: Visual confirmation (browser at http://127.0.0.1:4101/)**

Start the daemon and verify in the Plugins card:

- [ ] `+ Describe & generate` button appears next to `+ New`.
- [ ] Clicking it shows a textarea + Generate button.
- [ ] Submitting a real description (e.g., "Python TDD plugin") triggers a "Generating…" indicator and (when the auto route has a viable model) returns a preview panel.
- [ ] Each rule row is clickable to expand its content.
- [ ] `[Install + Enable]` adds the plugin to the registry; `Plugins` list refreshes to show it as enabled.
- [ ] `[Discard]` clears the preview with no side effects (verify by checking `.tierkit/plugin-drafts/` is empty after).

- [ ] **Step 4: Final commit (if any cleanups). Skip otherwise.**

---

## Self-Review

Spec coverage:

| Spec section | Plan task |
|---|---|
| §1 `generatePlugin` usecase (parse, validate, retry, stash) | Tasks 2, 3 |
| §2 Draft storage in `.tierkit/plugin-drafts/<uuid>/` | Task 2 (`writeDraft`) |
| §3 `POST /v1/plugins/generate` | Task 5 |
| §3 `POST /v1/plugins/generate/install` | Task 5 |
| §4 GUI button + form + preview | Task 6 |
| §5 System prompt + few-shot example | Tasks 1, 2 |
| §6 Validation + retry (auto-correct components.rules) | Tasks 2, 3 |
| §7 Safety (id regex, filename regex, no auto-execute) | Tasks 2 (regex validation) |
| §8 Unit + integration tests | Tasks 1, 2, 3, 5 |
| §9 Backward compat (no schema changes) | Implicit (no existing types touched) |

Spec ↔ plan deltas:

- **Draft TTL cleanup** (spec §2): the spec says drafts older than 1h are cleaned on daemon startup. **Plan defers this**: the draft directory cleanup only happens on successful install. A stale-draft sweeper can land in Phase 3b — the safety impact is minimal because drafts are isolated and not auto-loaded. If implementing now, add a `cleanupStaleDrafts()` call inside `startServer` boot. Document as known follow-up.
- **DELETE draft endpoint** (spec §4 mentions optional): explicitly skipped per spec ("MVP: rely on TTL only").

No placeholders. Type/method names consistent across tasks (`generatePlugin`, `PluginGenerateError`, `GeneratePluginResult`, `GeneratedRule`, `GENERATE_PLUGIN_EXAMPLE_JSON`, route paths `/v1/plugins/generate` and `/v1/plugins/generate/install`).
