# Rule: review after a big diff

After producing a diff larger than ~50 lines or touching more than ~3 files, do not declare the task "done" until you have:

1. Self-reviewed the diff with severity tags (`blocker`, `warning`, `nit`) and explicit verdict.
2. Run the project's tests (when present) and confirmed they pass.
3. Surfaced any leftover TODOs or assumptions.

In Tierkit's balanced workflow, the session state must move from `implementing` → `reviewing` before `done`. Use `tierkit session advance reviewing` then `tierkit session advance done`.
