# /debug

Use this command when you hit unexpected behavior, a failing test, or a stack trace you don't immediately understand.

## Goal

Find the root cause, not the first plausible patch. Resist the urge to "just try something."

## Workflow

1. **Reproduce.** State the exact commands or inputs that produce the failure. If you cannot reproduce, that is the first problem to solve.
2. **State the expected vs. actual.** Two sentences.
3. **Hypotheses.** Write 2–4 hypotheses for what could cause this. Rank by likelihood.
4. **Test the top hypothesis.** Smallest possible experiment — a print, a focused unit test, a git bisect step.
5. **Update beliefs.** What did the experiment rule in / rule out?
6. **Repeat** from step 3 until you have a single root cause.
7. **Fix.** Patch the root cause, not the symptom. If a test was missing for this case, add one.

## Guardrails

- No "shotgun" fixes — don't change three things at once.
- Don't add defensive code that hides the failure (silent catches, fallback values) unless you've named the root cause and are deliberately choosing graceful degradation.
- If you cannot find a root cause, say so. Don't fabricate one.
