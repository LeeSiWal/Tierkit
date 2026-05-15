# /review

Review the current diff (or specified files) for quality, safety, and reuse.

## Scope

If no files are specified, review the diff against the default branch. Otherwise review the provided files.

## Checklist

For each file or hunk, check:

- **Reuse.** Does this duplicate logic that already exists? Is there a helper that should be used instead?
- **Quality.** Names, error handling, dead code, magic numbers, complexity.
- **Safety.** Input validation at boundaries, command injection, path traversal, secret handling.
- **Tests.** Is the new behavior covered? Are there edge cases without coverage?
- **Scope creep.** Are there changes that don't belong to this task and should land in a separate change?

## Output

Group findings by file. For each finding:

- **Severity**: blocker / warning / nit
- **Location**: `path/to/file.ts:line`
- **What's wrong**
- **Suggested change** (specific, not "consider improving")

End with a one-line verdict: `ship it`, `needs fixes`, or `needs redesign`.

## Guardrails

- Don't review style that the formatter already enforces.
- Don't ask for tests for code that is trivially correct (re-exports, constant tables).
- Be specific. "This could be cleaner" is not a review comment.
