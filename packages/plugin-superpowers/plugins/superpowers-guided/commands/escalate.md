# /escalate

Use this command when the current model tier (local-device) is not sufficient and you want to move work to a stronger tier.

## When to escalate

Escalate **only** when one of the following is true:

- The local model has produced a clearly wrong answer twice on the same prompt.
- The task involves architecture-level design across many files.
- The task involves debugging a non-obvious correctness or concurrency bug.
- The task involves reading or writing production-sensitive code (auth, billing, migrations).

Do **not** escalate just to "see what a bigger model says."

## Output shape

1. **Task summary.** One paragraph.
2. **What was tried.** What the local model produced and why it was insufficient.
3. **Risk class.** local-safe / multi-file / production-sensitive / secret-adjacent.
4. **Requested tier.** `private-remote` (preferred) or `public-cloud` (last resort, review-only).
5. **Redaction note.** What in the context must be removed before sending to the remote tier (secrets, prod URLs, customer data).
6. **Approval needed?** Always **yes** for `public-cloud`.

## Guardrails

- Public-cloud answers are review-only by default — never let the public-cloud model directly write to the working tree.
- If `accessSecrets` is needed to do the task, do not escalate to public-cloud at all.
