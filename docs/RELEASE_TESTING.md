# Tierkit release testing

This document captures the manual smoke procedures that must pass before
publishing a new vsix. Automated CI covers regression for code we own; this
covers integrations and platforms we don't yet run in CI.

## Windows smoke (Windows 10+ / Node 20+)

Required before publishing any release that touches subprocess spawning,
the MCP Bridge, or the agent's tool layer.

### Setup

1. Fresh Windows VM or PC. Install Node 20+ (LTS).
2. `npm i -g @anthropic-ai/claude-code` (or whatever package name Claude Code
   ships under). Run `claude login` and complete browser-based auth.
3. Build Tierkit on macOS/Linux per usual, then transfer the `tierkit-vscode-<version>.vsix`
   to the Windows machine.
4. In VS Code on the Windows machine: `code --install-extension tierkit-vscode-<version>.vsix`.
5. Open a non-trivial TypeScript project in VS Code (any small repo will do).

### Smoke checklist

- [ ] **Setup card shows green for claude CLI** — `tierkit doctor` or the sidebar's
      Setup section reports the claude CLI is found and runnable.
- [ ] **Routing flow Quick Test** — click the Quick Test button in the Setup card.
      Result is not "no viable candidate"; a candidate chain shows with at least
      one viable entry.
- [ ] **MCP card snippet button** — in the Connect Claude Code (MCP) card,
      click "Show config snippet". The snippet pre-element populates with the
      JSON config (NOT "Error: TypeError: Failed to fetch").
- [ ] **End-to-end agent loop** — open the Tierkit chat sidebar, ensure
      claudeCode is the routed model, run the prompt "list the top 3 source
      files in this project and summarize them". The loop completes in ≤ 3
      turns without re-reading the same file twice.
- [ ] **Activity log** — `.tierkit/runtime/usage.jsonl` contains entries
      for the tools that were used. No `cli-timeout` entries unless the
      prompt was genuinely large.

### v0.17 additions

- [ ] **claudeCode appears in the activity panel after a streaming chat.**
      Send any prompt through the GUI chat sidebar (which uses streaming).
      The Recent activity card shows a row with `profileId=claudeCode`.
      Pre-v0.17 this row was missing entirely (the streaming path skipped
      usage logging).
- [ ] **Savings card shows non-`—` values.** With at least one local-device
      LLM call today, the "Today (routing)" card shows non-zero "Cloud input
      tokens saved" / "Estimated cost saved" / "Cloud calls avoided".
      Baseline line shows the resolved profile (default `claudeCode`).
      When `routingBaseline` is unset and `claudeCode` is missing or
      uncosted, the hint row appears below.
- [ ] **Per-tool envelope rendering.** Drive a tool call from the chat
      sidebar (e.g. ask the agent to read a file) and confirm the activity
      panel shows the per-tool view — line-numbered code for `read_file`,
      file/dir tree for `list_files`, etc. — NOT raw JSON.
- [ ] **`[Copy cursor]` works** on a truncated `read_file` result. Click
      it; clipboard contains the opaque cursor string.
- [ ] **MCP `initialize` advertises `0.17.0`.** Run `tierkit mcp serve` and
      connect from an MCP client; `serverInfo.version` should read `0.17.0`,
      not the v0.15.0 literal.
- [ ] **`tierkit doctor` flags subprocess command paths with spaces.**
      Set `transport.command` to a path containing whitespace in
      `tierkit.config.json`; `tierkit doctor` emits a `subprocess-command-space-<id>` warn check.

### Failure protocol

If any item fails, STOP and surface the failure. Do not publish the vsix.
Open an issue with the specific item and reproduction details.

## macOS / Linux smoke (catch-up after Windows)

After Windows passes, run the same checklist on the maintainer's regular
dev machine. macOS-specific concerns:
- `/tmp` is a symlink to `/private/tmp` — the workspaceBoundary helper resolves
  this via realpath. If a tool returns paths with `/tmp/...` instead of
  `/private/tmp/...`, that's a regression.
