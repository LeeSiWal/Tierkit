import type { FileExcerpt, RelevantFile } from "./types.js";

export interface BuildPromptMdInput {
  task: string;
  relevantFiles: RelevantFile[];
  excerpts: FileExcerpt[];
}

function fence(lang?: string): string {
  return lang && lang !== "other" ? "```" + lang : "```";
}

function renderFileBlock(file: RelevantFile, excerpt: FileExcerpt): string {
  const lines: string[] = [];
  lines.push(`## ${excerpt.path}`);
  lines.push("");
  lines.push(`\`${excerpt.language ?? "other"}\`, ${excerpt.totalLines} lines total.`);
  lines.push("");
  if (excerpt.skeleton.length > 0) {
    lines.push("### Skeleton");
    lines.push("");
    lines.push(fence(excerpt.language));
    for (const sym of excerpt.skeleton) {
      lines.push(sym.text);
    }
    lines.push("```");
    lines.push("");
  }
  for (const hot of excerpt.hotspots) {
    const terms = hot.matchedTerms.join(", ");
    lines.push(`### Hotspot @ L${hot.startLine}-L${hot.endLine} (matched: ${terms})`);
    lines.push("");
    lines.push(fence(excerpt.language));
    lines.push(hot.code);
    lines.push("```");
    lines.push("");
  }
  if (excerpt.omittedLineRanges.length > 0) {
    lines.push("### Omitted");
    lines.push("");
    for (const [s, e] of excerpt.omittedLineRanges) {
      lines.push(s === e ? `- L${s}` : `- L${s}-L${e}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function buildPromptMd(input: BuildPromptMdInput): string {
  const out: string[] = [];

  out.push("# Task");
  out.push("");
  out.push(input.task);
  out.push("");

  out.push("# Files in scope");
  out.push("");
  out.push(`${input.relevantFiles.length} file(s) selected.`);
  out.push("");
  for (const f of input.relevantFiles) {
    const score = f.score.toFixed(2);
    out.push(`- \`${f.path}\` — score ${score}, matched: ${f.matchedTerms.join(", ")}`);
  }
  out.push("");

  out.push("# Excerpts");
  out.push("");

  const excerptByPath = new Map(input.excerpts.map((e) => [e.path, e]));
  for (const f of input.relevantFiles) {
    const ex = excerptByPath.get(f.path);
    if (!ex) continue;
    out.push(renderFileBlock(f, ex));
    out.push("---");
    out.push("");
  }

  return out.join("\n");
}
