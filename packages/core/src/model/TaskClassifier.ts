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
