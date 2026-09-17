# gdharness

## Tests

Check a fixture by disarming what it guards: break the line on purpose, say which tests should
notice before running them, then run and compare. `bun test/regressions.ts` runs every regression
whether or not an earlier one failed and names the failures at the end, so one disarm shows every
test that caught it; arguments select tests by name, loosely matched, for working on one.

Never write an assertion that only says what did not happen. `doesNotMatch` against the one
complaint you have in mind is satisfied by a crash, a timeout and every other refusal there is.
Assert what the call reaches when it works.

## Releasing

Work the tracker to empty, then ship. When issues are open, fix all of them, then cut a release
carrying the fixes rather than leaving them sitting on `main` unreleased. A fix nobody can install
is not delivered.

Pick the bump between **patch** and **minor** without asking, and **the answer is nearly always
patch**. A fix is a patch. So is an addition nothing has to adapt to: a new argument, a new field
in an answer, an argument that reaches further than it did. A caller who ignores all of it carries
on working, which is what makes it a patch.

**Minor** is for a new tool or a new op, meaning gdharness does something it could not do before.
That is rare, and two of them in one day was wrong: an index reaching into a list and a hidden
filter are the same tools answering better, not new ones.

A wrong answer corrected is a **patch**, even when the output changes shape. Never leave an answer
wrong to protect a caller who parsed it, and never let "that would be breaking" become a reason to
ship a tool that lies. The surface is worth less than the answers being right, and that is the one
trade this project does not make. Only a rename or a removal is breaking. `README.md` states this
publicly, so keep the two in step.

**Never raise the major version without asking Aurelio first.** `major` on the "Prepare release"
workflow, and `1.0.0` above all, is his call alone: ask, and wait for the answer before touching
it. This holds however obviously ready the project looks.

Cut releases through the button rather than by hand: run the "Prepare release" workflow with the
bump, merge the pull request it opens, and `release-tag.yml` tags whatever version lands on
`main`.
