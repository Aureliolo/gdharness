# gdharness

## Tests

Check a fixture by disarming what it guards: break the line on purpose, say which tests should
notice before running them, then run and compare. `bun test/regressions.ts` runs every regression
whether or not an earlier one failed and names the failures at the end, so one disarm shows every
test that caught it; arguments select tests by name, loosely matched, for working on one.

Never write an assertion that only says what did not happen. `doesNotMatch` against the one
complaint you have in mind is satisfied by a crash, a timeout and every other refusal there is.
Assert what the call reaches when it works.

When the finding itself is an absence, that nothing was written, nothing was killed, nothing
changed, pair it with a positive in the same fixture showing the thing under test ran at all. A
broken instrument reproduces a negative result perfectly: the guard that keeps a test server out
of the real runtime directory was checked by watching that directory not grow, which a suite that
had stopped starting servers satisfies exactly as well. Assert the record it did write, then that
it wrote it nowhere else.

A disarm that still passes is a statement about the setup before it is one about the check. The
fixture reached the assertion without walking the line that was broken, so the reading to reject
first is that the assertion is too weak: strengthening it only buys a fixture that fails for a
second reason it also never reaches. Ask instead which step stood between the setup and the broken
line. Two ways it happens here. The setup tidies away the state the fault needs, so the answer is
the same either way: a decoy run record written to the wrong runtime directory left the disarmed
server with nothing to pick up, so it said "No game is running" and the pass proved only that the
directory was empty. Or the setup hands over the state the deciding line would have computed, so
the line is never walked: three fixtures ahead of the console timing one each opened a session on
the debug adapter as a side effect, and a session stays open for the life of the server, so what
ran first decided what the timing case measured. Fix the setup and disarm again. Only a disarm that
fails has told you anything about the check.

A disarm that fails is only evidence when it fails on the assertion you aimed at. Read the failure
rather than the exit code: a disarm that fails somewhere else never reached the broken line either,
and it is the same empty result as one that passed, wearing the colour you were hoping for. The way
this happens here is that the disarm does not build. `bun run build` bundles without typechecking,
so a disarm that does not compile leaves the previous bundle in place and the suite runs against the
code you were trying to break: an edit calling `writeFileSync` where it was not imported built
clean, threw at run time, and failed the fixture on a missing field three assertions earlier than
the one under test. Typecheck before you believe a disarm, and check the message names the assertion
you disarmed.

Some disarms cannot be performed at all, and that is a finding rather than an obstacle. Deleting a
line can leave a parameter unused, a branch unreachable or an import dangling, and the gates refuse
it before a single case runs. Reach for a smaller break that the compiler accepts, and write down
that the line is held by the gates as well as by the test, because that is one more thing keeping it
honest and it will not be obvious to the next reader.

Disarming a containment guard is the one disarm that can escape while it is disarmed. Give the
disarmed run somewhere harmless to escape to before running it.

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
trade this project does not make. Only a rename or a removal is breaking.
`.github/CONTRIBUTING.md` states this publicly, so keep the two in step.

**Never raise the major version without asking Aurelio first.** `major` on the "Prepare release"
workflow, and `1.0.0` above all, is his call alone: ask, and wait for the answer before touching
it. This holds however obviously ready the project looks.

Cut releases through the button rather than by hand: run the "Prepare release" workflow with the
bump, merge the pull request it opens, and `release-tag.yml` tags whatever version lands on
`main`.
