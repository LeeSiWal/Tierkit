# Rule: think before act

Before any non-trivial change, surface what you intend to do and pause for the user.

- If a task touches more than ~3 files: produce a short plan first (file list, intent per file, risk).
- Before running shell commands with hard-to-reverse effects (`rm -rf`, `git reset --hard`, `git push --force`, `npm publish`, anything that writes to a database): show the command and ask.
- After a large diff: surface what changed and offer a self-review before declaring "done".

This rule does **not** block — it shapes the conversation. The user can still proceed without ceremony.
