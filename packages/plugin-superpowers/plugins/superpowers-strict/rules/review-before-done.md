# Rule: review before done

In strict mode, `state=done` is reached only after a deliberate review pass:

1. Move to `state=reviewing` with `tierkit session advance reviewing`.
2. Run `tierkit route run "<task>" --mode review` to produce a structured review (blocker/warning/nit + a single-line verdict).
3. Address any **blocker** items by returning to `state=implementing` and looping.
4. Only declare `state=done` when the review verdict is `ship it`.

This avoids the most common production-defect path: an agent that declares completion based on "my code looks right" without an explicit review checkpoint.
