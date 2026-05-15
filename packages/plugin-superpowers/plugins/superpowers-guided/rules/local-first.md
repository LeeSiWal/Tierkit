# Rule: local-first

Tierkit defaults to local-device models. Stay there unless you have a clear reason to escalate (see [[/escalate]]).

- Public-cloud output is review-only — it may suggest changes, but a local/private-remote model applies them after human review.
- Before sending context to private-remote or public-cloud, redact secrets, production URLs, customer data.
- Tasks that touch secrets must not escalate to public-cloud.
