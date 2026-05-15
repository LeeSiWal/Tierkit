# Rule: plan before multi-file

When a task will touch more than ~3 files OR modify configuration / migrations / authentication / billing code:

1. Switch to **Planner** mode and produce a written plan first.
2. Surface the plan to the user. Wait for an explicit nod.
3. Only then begin implementing — and stop short of "done" until the diff has been reviewed.

This rule is enforced by Tierkit's session gate when this plugin is active and `freedom: balanced`. Multi-file `route run --mode execute` will be refused unless a session is in state `implementing`. Run:

```sh
tierkit session start "<task>"
# … run --mode plan, share with the user …
tierkit session advance implementing
# … run --mode execute …
tierkit session advance reviewing
# … run --mode review …
tierkit session advance done
```
