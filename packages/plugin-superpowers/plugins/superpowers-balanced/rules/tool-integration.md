# Rule: route model calls through Tierkit when a runtime is available

If the user has started a Tierkit runtime (`tierkit runtime start`), prefer it for every model call rather than calling the provider directly. The runtime applies routing, redaction, command-gating, budget, and workflow session enforcement uniformly across all the AI coding agents the user has set up.

## How to tell

- A pid file exists at `.tierkit/runtime/daemon.pid`.
- `GET http://127.0.0.1:4101/v1/health` returns `{ ok: true }`.
- The user's editor shows a Tierkit status bar item ("Tierkit <version>" in green).

## Continue users

The exported `.continue/config.yaml` already has the right model profiles. If you (the agent) need to make a model call that *isn't* a Continue chat/edit/autocomplete call — e.g. a side-channel embedding or a synthetic reasoning step — call the Tierkit daemon directly:

```ts
import { TierkitClient } from "@tierkit/client";
const client = new TierkitClient();
const r = await client.llmCall({
  profileId: "localFast",
  messages: [{ role: "user", content: yourTaskPrompt }],
});
```

This preserves the budget/usage accounting that Continue's main chat already participates in via its `models[]` config.

## Cline / Roo users

Same SDK, same daemon. The exported `.clinerules/` or `.roomodes` cover the rules-and-modes layer; the runtime covers the call-time layer.

This rule is advisory in the balanced tier — there is no automatic enforcement that the agent *must* use the daemon. But when the user has explicitly started one, ignoring it is a tell that the agent isn't paying attention to its environment.
