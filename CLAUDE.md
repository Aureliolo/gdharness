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

Assert the invariant, not the reading. A case that writes down what was measured, or what somebody
concluded, keeps that conclusion in force after the evidence for it is gone, and overruling it takes
a deliberate act where correcting a sentence would have taken none. A report that the cure for a
stale type was a change to the declaring script went into three sentences and into a case requiring
all three; when the project that made the report retracted it, correcting the sentences failed the
suite and correcting the note beside them did not, so the note was corrected twice and the sentences
stayed wrong through two releases. The wording survived because fixing it cost more, not because
nobody looked, which says where the next one is: wherever a case asserts a reading rather than the
thing the reading was evidence for. The rewrite holds what does not depend on which remedy wins,
that nothing sends a caller to edit source that is already correct.

Check the output, not the ingredients. Three cases here read the inputs to a thing and reported
nothing wrong with what the thing produced, and all three looked exhaustive. A case comparing
generated tool names against the schemas passed on two renderings of one sentence, one of which
escaped every backtick, because the names matched in both and the markup sits between the names. A
case reading `src/server.ts` for the sentences offering a remedy could not see the one that matters
at all, because it is assembled from parts and no line of the file contains it, so it reported
nothing wrong about a note that said nothing. Nothing in either check's own text says it is reading
the wrong artefact, which is why moving the thing is what finds them: render it, call it, and assert
what comes back.

The trigger for that is a branch of the output no reproduction produces, because the rule above does
not fire on its own. The note telling a caller which script to reload was written, reviewed, gated
and tagged saying to pass two paths comma-separated to an argument that takes one string, and it was
found by rendering the two-type case for no reason except that the value can be plural. Reading the
code shows nothing: it is the same join either way and the singular and plural differ by a word. An
argument that can be plural, a list that can be empty, a second entry in one answer: render the case
nothing has hit and read it. The branches a reproduction covers are the ones already right.

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

There is one shape where the assertion is the answer, and it is not weakness. The assertion can ask
about the wrong property of the right object, so it cannot separate the broken version from the
working one however far either is broken. A check for a doubled word in a sentence was written as a
search for the same word twice in a row, and the fault was `the addon from before versions were
reported addon`, where the two are nineteen words apart: the assertion asked about adjacency and the
fault was about count, and the disarm passed on a sentence carrying the very fault it was written
for. Strengthening that costs nothing and fixes nothing, because the question is wrong rather than
quiet. Before reaching for the setup, read the assertion once and ask which property of the answer
it is actually reading, and whether the broken version and the working one differ in that property
at all.

The third way is the input, and it arrives looking like diligence. A report names the case somebody
hit, which is not always the case that breaks, so a fixture built from the reproduction tests the
shape that survived. The `@abstract` report came with a script declaring `class_name` behind an
annotation and `extends` on the line below, the file-writing path was fixed, the fixture was written
around that exact script, and the disarm passed: two header lines means the second is found whether
or not the annotations come off, and it sets the insertion point on its own, so the first is never
read. What breaks is the neighbour, a script whose whole header is the annotated line, which nobody
reported because nobody had edited one. Take the report for the fault and then ask which other
shapes reach the same line, and write the one where the line has nothing else to fall back on.

The fourth way is a second guard covering the one you broke, and the wrong conclusion it invites is
that the line you disarmed was doing nothing. Two fixes landed together on where a parameter list
ends: the trailing comment comes off the whole line before anything reads it, and the closing
bracket is found by counting depth rather than by taking the last one on the line. Against
`func noted(a: int) -> void:  # a comment with a bracket )` those overlap exactly, because removing
the comment puts the last bracket back where it belongs, so disarming the depth count passed and the
reading on offer was that it could be deleted. It cannot: `func noted(a: int) -> void: print(a, ")")`
is legal, the bracket is in a body rather than in a comment, and no amount of comment stripping moves
it. Disarm one line at a time, and when one passes, look for the input only the disarmed line
handles before concluding it handles nothing. Breaking two together can only tell you that at least
one of them mattered, which is the thing you already believed.

The same care applies to saying which case catches what. A sentence naming the case that holds a
line reads exactly like a finding and is usually a guess: checking it costs one more disarm, and the
guard often turns out to stand on cases you had not credited.

The same question comes one step earlier for a measurement. Before asking what a reading means, ask
which result would have contradicted it, because a trial that could not have come out the other way
has told you nothing however careful it looked. Two lists both holding the new method is a reading
with no other side to it and cannot separate one cache from two, since two fresh caches and one
fresh cache look identical. What separates them is a moment where one is stale and the other is not,
and it has to be one moment: the note here said for three releases that a built copy had been seen
stale while the diagnostics on it read clean, and that was a stale copy read before a reload paired
with a clean diagnostic read after it. Taking both in the same window, between the change and any
remedy, is what turned it into evidence, and it came out as claimed. Neither trial was wrong. Both
were read as answering a question neither could reach.

A claim about a change you have just made is the least checked claim there is. It arrives with the
reasoning that produced it, which is the strongest case anybody will assemble for it, and the reader
it is told to has less to check it against than you do. The debug adapter disconnect in this
server's shutdown was ending an editor-played game on every reconnect, and the first fix for it,
`terminateDebuggee: false`, was reasoned from the protocol, was correct about what gdharness means,
and was told to the project that reported the loss as the answer. Godot's adapter ignores the field.
The fixture that was written next failed on the fix, and skipping the request entirely is what saved
the game. Nothing but running it would have said so: the reasoning was clean and the conclusion was
false, which is the combination that gets shipped. Run the thing and read what came out, especially
when the change is yours and the argument for it is good.

A fix changes which states the rest of the code meets, and can promote a rare wrong answer into a
common one. Nothing in the fixed code says so, because the fix is correct and the thing that got
worse is somewhere else. The shutdown used to end a game the editor was playing, so after a
reconnect "no game is running" was usually true and a refusal that could not see a played game was
a rare confusion. With the game surviving, the addon still takes half a minute to dial back in, so
there is now routinely a live game on screen that the new server cannot see, and the same refusal
fires every time. The bug was fixed and a wrong answer beside it went from uncommon to ordinary. So
after a fix, ask which answers elsewhere were true only because the fault was there, and reach for
the ones that were right by luck rather than by construction.

A fix can also create the state its own test needs, which means the case that catches what it left
behind was unwritable until it landed. A replacement server meeting a live editor-played run is
code that existed and had never run against a real editor, because while the shutdown killed those
runs on a reconnect there was never one to meet. Surviving is not the same as being usable, and the
half of the fixture that reads the run through a replacement could not have been written the day
before. So a fix that makes something survive is the moment to ask what now happens to it, and to
expect the answer to be in a path nothing has exercised.

A disarm that fails is only evidence when it fails on the assertion you aimed at. Read the failure
rather than the exit code: a disarm that fails somewhere else never reached the broken line either,
and it is the same empty result as one that passed, wearing the colour you were hoping for. The way
this happens here is that the disarm does not build. `bun run build` bundles without typechecking,
so a disarm that does not compile leaves the previous bundle in place and the suite runs against the
code you were trying to break: an edit calling `writeFileSync` where it was not imported built
clean, threw at run time, and failed the fixture on a missing field three assertions earlier than
the one under test. Typecheck before you believe a disarm, and check the message names the assertion
you disarmed.

Shorten as well as empty. A check whose reading comes back empty usually fails loudly, and the same
check reading one entry fewer usually does not: it looks at one thing less and passes. So a floor of
25 on a table of 31 is an anchor against a pattern that stopped matching altogether and no guard at
all against one that quietly stopped matching six of them, which is the case that leaves a command
nothing sends unnoticed. Set the floor to what the file holds today rather than to a comfortable
minimum, so that removing an entry means lowering it in the same change and somebody confirms the
removal was meant. Disarm it by reading one fewer, not none: dropping to seven trips a floor of 25
as well, and proves nothing about it.

The same holds for a check that loops over the list it is checking. Dropping an entry drops the
assertion with it, so the case passes having tested less, and a check that enumerates what it covers
says nothing about what it does not.

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

**Never raise the major version without asking first.** `major` on the "Prepare release" workflow,
and `1.0.0` above all, is the owner's call alone: ask them directly, and wait for the answer before
touching it. This holds however obviously ready the project looks.

Cut releases through the button rather than by hand: run the "Prepare release" workflow with the
bump, merge the pull request it opens, and `release-tag.yml` tags whatever version lands on
`main`.
