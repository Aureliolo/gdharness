---
paths:
  - '.github/workflows/**'
  - 'scripts/release*'
  - '.github/release-process.md'
---

# Release workflows

## Reports after an irreversible act

A report must not stand between an irreversible act and the work that depends on it. The release
takes three acts that cannot be taken back, such as the MCP registry entry a version gets only once.
For every step after one of them, ask whether it depends on the act or on the report of it. Give the
report its own job rather than a wider timeout. `served` in `release.yml` checks what npm serves
without holding back the registry entry or the install checks.

## Runs that can be run again

Ask of each act whether its run can be run again. An act that refuses something already done makes
a run that failed after the first publish impossible to re-run. A hand-dispatched tag workflow that
stops on an existing tag does nothing in exactly the state somebody presses that button in. Take
what is already done as done and carry on.
