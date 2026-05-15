# Tierkit — Security Stance

> Status: v0.6. Sensitive-file blocklist + dangerous-command classifier + extended secret redaction shipped. Auto-redaction at remote-call sites and budget enforcement land with the v1.0 runtime alpha.

## Principles

1. **Plugins have no command execution permission by default.** `runCommands` is opt-in per plugin and surfaced at install time.
2. **MCP server registration always requires user approval.** Tierkit never auto-registers MCP servers, even if a plugin manifest declares them.
3. **Public-cloud output is review-only.** Schema rejects `public-cloud` profiles with `requiresApproval: false`; routing policy defaults the mode to `review-only`.
4. **Hooks are declarative-only in v0.x.** Arbitrary shell hooks are deferred to v1.0+ and disabled by default.
5. **Adapters never downgrade a high-risk permission** when translating to a target-specific config.
6. **Sensitive paths are blocked at both ingress and egress** (plugin loader refuses to load them; export refuses to write them) — opt-out via explicit `allowSensitive=true`.
7. **Risky permission combinations are surfaced by `tierkit doctor`** even if individually allowed.

## v0.1–v0.6 enforcement matrix

| Check | Where | Since |
|---|---|---|
| Path traversal in plugin file paths             | [`fs/safePath.ts`](../packages/core/src/fs/safePath.ts) applied in `PluginLoader`, `installPlugin`, `exportTarget` outputs | v0.1 |
| Manifest schema (zod)                           | [`plugin/PluginValidator.ts`](../packages/core/src/plugin/PluginValidator.ts)                                              | v0.1 |
| `public-cloud` profile requires approval        | `ModelProfileSchema.superRefine`                                                                                            | v0.1 |
| `public-cloud` default mode is `review-only`    | `RoutingPolicySchema` default                                                                                               | v0.1 |
| Validator warnings on risky combinations        | `PluginValidator.collectWarnings`                                                                                           | v0.1 |
| Secret redaction (initial rules)                | [`security/SecretRedactor.ts`](../packages/core/src/security/SecretRedactor.ts)                                             | v0.1 |
| **Sensitive-file blocklist** (input + output)   | [`security/sensitiveFiles.ts`](../packages/core/src/security/sensitiveFiles.ts) + PluginLoader + exportTarget               | **v0.6** |
| **Dangerous-command classifier**                 | [`security/dangerousCommands.ts`](../packages/core/src/security/dangerousCommands.ts) — `block` / `warn` / `ok`              | **v0.6** |
| **Extended secret patterns**                     | GCP/PEM private key, Slack, Stripe, Google `AIza…`, Azure base64, basic-auth URLs, JWT shape — [`security/redactionRules.ts`](../packages/core/src/security/redactionRules.ts) | **v0.6** |
| **Doctor: risky permission combos**             | `tierkit doctor` warns on `accessSecrets + usePublicCloudModel`, `runCommands + usePublicCloudModel`, `registerMcp + freedom=free` | **v0.6** |
| **Doctor: weakened security policy**            | warns when `redactSecretsForRemote`, `blockSecretFiles`, or `dangerousCommandsRequireApproval` are disabled in config        | **v0.6** |

## High-risk permissions

Listed by `listHighRiskGranted()`. Install consent should display them prominently:

- `runCommands`
- `registerMcp`
- `accessSecrets`
- `modifyAgentSettings`
- `installDependencies`
- `usePublicCloudModel`

## v0.6 CLI surface

```sh
# Run secret redaction over a file
tierkit check redact ./scratch.txt              # exit 1 if anything matched
tierkit check redact ./scratch.txt --print      # also dump redacted body

# Classify a shell command
tierkit check command "rm -rf /"                # exit 2  (block)
tierkit check command "git reset --hard"        # exit 1  (warn)
tierkit check command "ls -la"                  # exit 0  (ok)

# Check a path against the sensitive blocklist
tierkit check path .env                         # exit 1, "Sensitive: YES"
tierkit check path README.md                    # exit 0
```

### `tierkit check` exit codes (stable for scripting)

| Command | exit 0 | exit 1 | exit 2 |
|---|---|---|---|
| `check redact <file>`  | file is clean      | secrets found        | — |
| `check command "<c>"`  | command is ok      | command is `warn`    | command is `block` |
| `check path <p>`       | path is not sensitive | path matches blocklist | — |

## Sensitive-file blocklist

Default patterns (from [`DEFAULT_SENSITIVE_PATTERNS`](../packages/core/src/security/sensitiveFiles.ts)):

```
.env / .env.* / .envrc
*.pem / *.key / *.p12 / *.pfx / *.jks / *.keystore
id_rsa / id_dsa / id_ecdsa / id_ed25519 / *_rsa / *_dsa / …
credentials.json / credentials.yaml / service-account*.json
.npmrc / .pypirc / .netrc
**/secrets/** / **/.ssh/** / **/.aws/** / **/.gnupg/**
```

Enforced at:
- **Plugin load** — `PluginLoader` refuses any plugin whose manifest references a matching path. Override per-call with `loadPluginFromDirectory(dir, { allowSensitive: true })`.
- **Export** — `exportTarget` refuses to write any adapter-produced file whose path matches. Override with `exportTarget({ allowSensitive: true })` (CLI: not exposed in v0.6 — explicit code-level override only).

## Dangerous-command classifier

Severity levels:
- **`block`** — never run automatically. Always require explicit human approval. Examples: `rm -rf /`, `curl | sh`, `dd of=/dev/sda`, `mkfs`, `shutdown`, `kill -1`.
- **`warn`** — has hard-to-reverse side effects. Surface what will run before executing. Examples: `git reset --hard`, `git push --force`, `npm publish`, `chmod 777`, `DROP TABLE`.
- **`ok`** — no rule matched. Not a guarantee of safety; classifier is a safety net, not a substitute for human judgement.

## Still deferred to v1.0 (runtime alpha)

- **Auto-redact at the call site** — `SecretRedactor` is available as a library function, but provider clients in `model/providers/*` do not currently send user prompts (probes use no user content). Wiring redaction into the real outbound-message path lands with the v1.0 runtime adapter.
- **Budget enforcement** — `tierkit.config.json::budget` schema accepts limits; the call site that increments usage doesn't exist yet (no runtime).
- **Hook hard enforcement** — declarative hook schema is honored; runtime interception runs after v1.0.
- **Live dangerous-command blocking** — v0.6 ships the classifier (`tierkit check command`); the runtime that intercepts an agent's `runCommand` invocation lands with v1.0.
