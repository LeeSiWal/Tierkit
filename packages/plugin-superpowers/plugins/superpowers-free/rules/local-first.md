# Rule: local-first

Tierkit defaults to local-device models. This rule keeps that default honest.

## What this rule says

1. **Start every task on `local-device`.** Do not pre-emptively reach for a stronger tier.
2. **Escalate only with reason.** Use `/escalate` and state the risk class. Routine work stays local even if it's slow.
3. **`public-cloud` is review-only by default.** A public-cloud model may suggest changes; only a local or private-remote model may apply them, after the user has reviewed.
4. **Redact before remote.** Before sending context to `private-remote` or `public-cloud`, strip secrets, production URLs, and customer data.
5. **No secret access on `public-cloud`.** Tasks that require `accessSecrets` may not escalate to public-cloud at all.

## Why

Local-first protects three things: cost, privacy, and offline reliability. Every escalation has a price; the default should make the price visible, not hide it.
