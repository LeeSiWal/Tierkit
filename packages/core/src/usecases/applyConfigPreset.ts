/**
 * Named routing presets — one-click config bundles that tune `riskThresholds`,
 * `autoEscalationCeiling`, and the `goodAt` tags on any matching local profile.
 * Used by the GUI's "🚀 Preset" buttons and the CLI `tierkit preset apply <name>`.
 *
 * Each preset writes to the workspace `tierkit.config.json` (not user-level), uses raw
 * JSON merge to preserve any null-suppression markers from prior deletes (same pattern
 * as profileCrud.addProfile / updateProfileEnabled), and leaves untouched fields alone.
 *
 * Presets are intentionally a small, curated set — they're for ergonomics, not a
 * substitute for hand-editing. Adding a new preset is one new entry below.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME } from "../config/TierkitConfig.js";
import { TierkitError } from "../errors/TierkitError.js";

export class PresetError extends TierkitError {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PresetError";
    this.code = code;
  }
}

export interface ApplyPresetInput {
  cwd: string;
  /** Preset key — see PRESETS below. */
  name: string;
}

export interface ApplyPresetResult {
  name: string;
  path: string;
  /** Snapshot of what changed (for the GUI toast / CLI output). */
  changes: {
    riskThresholds?: Record<string, number>;
    autoEscalationCeiling?: string;
    profilesUpdated?: string[];
  };
}

interface PresetDef {
  description: string;
  routing: {
    riskThresholds?: Record<string, number>;
    autoEscalationCeiling?: "local-device" | "private-remote" | "public-cloud";
    budgetAwareDowngrade?: boolean;
    responseQualityCheck?: boolean;
  };
  /**
   * For each profile in workspace OR discovered profiles whose model name matches one of
   * these patterns, set the listed goodAt tags (replacing any existing). Profiles that
   * don't match are untouched.
   */
  goodAtByModelPattern?: Array<{ pattern: RegExp; goodAt: string[] }>;
  /**
   * Same idea as goodAtByModelPattern but for notGoodAt — explicit exclusions for weak /
   * tiny models so they stay out of code-* chains. The router hard-filters these.
   */
  notGoodAtByModelPattern?: Array<{ pattern: RegExp; notGoodAt: string[] }>;
}

const PRESETS: Record<string, PresetDef> = {
  /**
   * Optimize for a strong local coder (Qwen3-Coder, DeepSeek-Coder, Codestral 22B+, etc.)
   * Lifts the local-device upper threshold so most coding tasks stay local; pushes the
   * escalation ceiling out so only genuinely critical work hits Claude/GPT-4. Tags any
   * discovered coder model with code-generation/refactor/code-review/plan so the router
   * picks it FIRST within local-device tier.
   */
  "local-coder-first": {
    description: "Optimized for strong local coder models (Qwen3-Coder, DeepSeek-Coder, Codestral...)",
    routing: {
      riskThresholds: {
        localFastMax: 30,
        localStrongMax: 65,
        privateRemoteMax: 85,
        publicCloudReviewMin: 86,
      },
      autoEscalationCeiling: "public-cloud",
      budgetAwareDowngrade: true,
      responseQualityCheck: true,
    },
    goodAtByModelPattern: [
      {
        // 14B+ coder. Tagged as primary for code-* + plan.
        pattern: /(?:coder|codestral|codellama|starcoder|granite-code|codeqwen).*(?:14b|22b|30b|32b|34b|70b|72b)/i,
        goodAt: ["code-generation", "refactor", "code-review", "plan"],
      },
      {
        // Smaller coders — still goodAt code-generation + refactor but not review.
        pattern: /coder|codestral|codellama|starcoder|granite-code|codeqwen/i,
        goodAt: ["code-generation", "refactor"],
      },
    ],
    notGoodAtByModelPattern: [
      {
        // < 7B and "tiny"/"small"/"nano" — never try for code-* / plan.
        pattern: /\b(0\.5b|1b|1\.5b|2b|3b|4b|5b|tiny|small|nano)\b/i,
        notGoodAt: ["code-generation", "refactor", "code-review", "plan"],
      },
      {
        // Mid-size general models (7B-13B not coder) — code-review excluded.
        // (Pattern: 7b/8b/9b/10b/11b/12b/13b that's NOT one of the coder families.)
        pattern: /^(?!.*(?:coder|codestral|codellama|starcoder|granite-code|codeqwen)).*\b(7b|8b|9b|10b|11b|12b|13b)\b/i,
        notGoodAt: ["code-review"],
      },
    ],
  },

  /**
   * Conservative — keep public-cloud out of the auto path entirely, raise the
   * local-coder ceiling so most tasks stay local + Claude only on hard stuff.
   */
  "private-only": {
    description: "Local + private-remote (Claude) only — no public cloud autoescalation",
    routing: {
      riskThresholds: {
        localFastMax: 30,
        localStrongMax: 65,
        privateRemoteMax: 100,
        publicCloudReviewMin: 100,
      },
      autoEscalationCeiling: "private-remote",
      budgetAwareDowngrade: true,
      responseQualityCheck: true,
    },
    goodAtByModelPattern: [
      {
        pattern: /coder|codestral|codellama|starcoder|granite-code|codeqwen/i,
        goodAt: ["code-generation", "refactor", "code-review"],
      },
    ],
  },

  /**
   * Default thresholds (matches the original Tierkit policy). Useful as a "reset" button.
   */
  "tierkit-default": {
    description: "Tierkit defaults — balanced across all tiers",
    routing: {
      riskThresholds: {
        localFastMax: 25,
        localStrongMax: 50,
        privateRemoteMax: 75,
        publicCloudReviewMin: 76,
      },
      autoEscalationCeiling: "public-cloud",
      budgetAwareDowngrade: true,
      responseQualityCheck: true,
    },
  },
};

export function listPresets(): Array<{ name: string; description: string }> {
  return Object.entries(PRESETS).map(([name, def]) => ({ name, description: def.description }));
}

export async function applyConfigPreset(input: ApplyPresetInput): Promise<ApplyPresetResult> {
  const def = PRESETS[input.name];
  if (!def) throw new PresetError("unknown-preset", `unknown preset "${input.name}"`);

  const targetPath = path.join(input.cwd, CONFIG_FILENAME);

  // Read raw — preserve nulls (suppression markers).
  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(targetPath, "utf8");
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = { version: "0.1" };
  }
  if (typeof raw.routingPolicy !== "object" || raw.routingPolicy === null) {
    raw.routingPolicy = {};
  }
  if (typeof raw.modelProfiles !== "object" || raw.modelProfiles === null) {
    raw.modelProfiles = {};
  }

  // Apply routing changes — merge over existing fields without dropping unrelated ones.
  const routing = raw.routingPolicy as Record<string, unknown>;
  if (def.routing.riskThresholds) {
    routing.riskThresholds = { ...(routing.riskThresholds as Record<string, unknown> | undefined), ...def.routing.riskThresholds };
  }
  if (def.routing.autoEscalationCeiling !== undefined) routing.autoEscalationCeiling = def.routing.autoEscalationCeiling;
  if (def.routing.budgetAwareDowngrade !== undefined) routing.budgetAwareDowngrade = def.routing.budgetAwareDowngrade;
  if (def.routing.responseQualityCheck !== undefined) routing.responseQualityCheck = def.routing.responseQualityCheck;

  // Apply goodAt + notGoodAt patterns to any existing profile whose model name matches.
  // We only touch profiles already declared in the workspace config — discovery layer
  // profiles are matched by discoverOllamaProfiles.ts's own inferCapabilities at load
  // time. First-matching rule wins per dimension so finer patterns (large coder) come
  // before coarser ones (any coder) in PRESETS.
  const profilesUpdated = new Set<string>();
  const profiles = raw.modelProfiles as Record<string, unknown>;
  for (const [id, p] of Object.entries(profiles)) {
    if (!p || typeof p !== "object") continue;
    const profile = p as Record<string, unknown>;
    const model = typeof profile.model === "string" ? profile.model : "";
    if (def.goodAtByModelPattern) {
      for (const rule of def.goodAtByModelPattern) {
        if (rule.pattern.test(model)) {
          profile.goodAt = rule.goodAt;
          profilesUpdated.add(id);
          break;
        }
      }
    }
    if (def.notGoodAtByModelPattern) {
      for (const rule of def.notGoodAtByModelPattern) {
        if (rule.pattern.test(model)) {
          profile.notGoodAt = rule.notGoodAt;
          profilesUpdated.add(id);
          break;
        }
      }
    }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const text = JSON.stringify(raw, null, 2) + "\n";
  const tempPath = targetPath + ".tmp";
  await fs.writeFile(tempPath, text, "utf8");
  await fs.rename(tempPath, targetPath);

  const changes: ApplyPresetResult["changes"] = {};
  if (def.routing.riskThresholds) changes.riskThresholds = def.routing.riskThresholds;
  if (def.routing.autoEscalationCeiling) changes.autoEscalationCeiling = def.routing.autoEscalationCeiling;
  if (profilesUpdated.size > 0) changes.profilesUpdated = Array.from(profilesUpdated);

  return { name: input.name, path: targetPath, changes };
}
