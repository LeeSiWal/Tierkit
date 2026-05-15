# /brainstorm

Use this command **before** writing implementation code for a new feature, refactor, or non-trivial change.

## Goal

Clarify what the user actually wants, surface unknowns, and propose 1–3 implementation approaches with trade-offs. Do not start coding yet.

## Output shape

1. **Restate the task** in your own words. One paragraph.
2. **What's known.** Constraints, existing code, prior decisions.
3. **What's unknown / assumed.** List explicit assumptions you're making. If any block progress, ask the user.
4. **Approaches.** 1–3 options. For each: rough design, files affected, risk, effort.
5. **Recommended next step.** A single concrete action — usually "ask user to pick approach" or "produce a plan for approach N."

## Guardrails

- Don't propose more than 3 approaches; if the space is huge, narrow the scope with the user first.
- Don't sketch code beyond a handful of lines per approach.
- Don't claim "this is simple" without naming the unknowns.
