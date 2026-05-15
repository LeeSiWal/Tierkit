# Rule: tests first

In strict mode, do not write production code until a failing test exists.

Workflow inside the `implementing` state:

1. Write the smallest test that captures the expected behavior.
2. Run it — confirm it fails for the **right** reason.
3. Write the minimum code to make it pass.
4. Re-run the test — confirm it passes.
5. Refactor if needed; tests must stay green.

When a change spans multiple test cases, repeat the loop one case at a time. Do not skip ahead to "write the whole thing, then write the tests." The point of strict is to keep your hypothesis honest; tests written after the fact tend to mirror the implementation's bugs.

This rule is not Tierkit-enforced at runtime — it's a conduct contract. Adopt it because you want the discipline, not because the tool will catch you.
