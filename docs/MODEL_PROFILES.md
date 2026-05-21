# Tierkit model profiles

> See also [docs/SPEC.md](SPEC.md) for the canonical ModelProfile schema.

## Subscription CLI timeouts

Profiles with `provider: "claude-code"` (or other `subscription-cli` providers)
spawn a child process for each tool call. The default timeout is set high
enough for most queries but can fail on slower systems — common offenders:

- **Windows.** Subprocess startup is slower than macOS/Linux, especially when
  routed through `cmd.exe` for `.cmd` shim resolution.
- **First-call cold start.** Some CLIs (e.g. `claude`) authenticate against
  the cloud on the first call of a session, adding seconds.
- **Network latency.** A poor connection to the model provider's API extends
  per-call time.

### Bundled defaults

| Profile      | `transport.timeoutMs` | Notes |
|--------------|-----------------------|-------|
| `claudeCode` | `300_000` (5 min)     | Bumped from 180_000 in v0.16 after Windows users hit mid-flow timeouts. |

### Per-profile override

Edit `tierkit.config.json` in the workspace root (or the user-scoped
`~/.config/tierkit/config.json`):

```json
{
  "modelProfiles": {
    "claudeCode": {
      "transport": {
        "timeoutMs": 600000
      }
    }
  }
}
```

This shallow-overrides the bundled profile. Other transport fields
(`command`, `args`, `healthCheckArgs`) are inherited unless you also set them.

### How to know if you need a higher timeout

Run `tierkit doctor`. v0.16 surfaces a hint when `.tierkit/runtime/usage.jsonl`
contains recent `cli-timeout` entries:

```
WARNING: 3 cli-timeout result(s) in the last 7 days of 142 entries. Consider
raising transport.timeoutMs on the affected profile. See
docs/MODEL_PROFILES.md for per-profile tuning.
```
