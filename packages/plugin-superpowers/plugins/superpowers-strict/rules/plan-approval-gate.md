# Rule: plan-approval gate

Strict workflow refuses `mode=execute` until the user has explicitly approved a plan.

Required flow:

```sh
tierkit session start "<task>"          # state = planning
tierkit route run "<task>" --mode plan  # produce the plan
# … user reads the plan, decides whether to proceed …
tierkit session approve-plan            # required
tierkit session advance implementing    # state = implementing
tierkit route run "<task>" --mode execute  # now allowed
tierkit session advance reviewing       # state = reviewing
tierkit route run "<task>" --mode review
tierkit session advance done            # done
```

Skipping `approve-plan` is the most common mistake — `mode=execute` will be refused with code `plan-not-approved` until the user runs it.
