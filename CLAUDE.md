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

Code that only runs when something is wrong is never exercised by a run that goes well. A passing
suite, a careful reading and a successful session all leave it equally unchecked, so "everything is
green" says nothing about it either way. The case here was the refusal for a game announcing a
protocol this server cannot read. The sweep that refusal consults drops those announcements, so it
fell through to advice that would end the very run it was denying. A function twenty lines away had
been written for that exact state and says in its own doc that "no game is running" is certainly
false there, but nothing called it, and the sweep reads as complete. It was found by making the two
halves disagree for an unrelated reason: bumping a protocol constant to check whether a fixture
hard-coding it would drift. So when a branch depends on a version mismatch, a fault, a timeout or any
other disagreement, put the system into that state deliberately and look at what comes out. Waiting
to meet it in normal use does not work, because normal use is the case that avoids it.

Reaching that state once is not the same as holding it, and what holds it is taking the disagreeing
thing as an argument. A fixture for the port reservation asked the real kernel for forty ports and
found them all different. It passed, and it passed again with the deduplication removed, because
this machine's kernel did not happen to repeat a port: forty different numbers is a reading with no
other side to it. Rewritten to supply the pool, the way `judgeRun` is given the operating system's
answer, the disarm fails on the assertion it aims at. A case that waits to meet a disagreement is
green on every host that does not produce one, which is the same green as no case at all.

The other half of that is a case coupled to something incidental, which fails when the thing it
checks gets better. A check elsewhere split a document on a marker that only appeared while a notice
was printed above it; the notice stopped being needed, the marker went, and the case failed as
though the thing had regressed. Those are one fault from two sides: the case was never about the
kernel repeating, and it was never about the notice. Name the thing being checked in terms that
survive it improving, and take everything else as an argument.

A number stated twice is worse than a number stated once, if only one of them is held. Correcting it
fixes the checked sentence and leaves the other saying what used to be true, so the file disagrees
with itself while the check reports clean. `docs/architecture.md` says how many harnesses read their
own skills directory, then says the same count again one line down about the copies written for
them; only the first was in the table. When a count is worth holding, hold every statement of it, or
the unheld one is licensed by the held one standing beside it.

The same goes for the set a check runs over. A check that names the files it reads is one the next
file escapes by sitting somewhere nobody listed, and the escape is silent because the check is about
the files it did read. The gate on tool names in prose named three documents when there were five,
took one of the skill's two files, and did not read the addon's GDScript at all; the file it skipped
in the skill was the generated reference, which is the half a rename actually rewrites. Walk the
directory instead, so a file is covered by being a file.

Deriving that set stops it going stale and does not stop it being wrong, and derivation is the more
dangerous of the two because it looks after itself. The same gate took its vocabulary of words that
are shaped like a tool and are not from the `.gd` filenames, rather than listing them, so a module
added later would be known at once. Two of those modules are named after the tools they implement, so
the derivation excused `runtime_capture` and `runtime_input` everywhere and the gate stopped checking
two of the things it exists for while every assertion stayed green. A list that long invites somebody
to read it; a one-line derivation invites nobody. Derive the set, then ask what the derivation
subtracts from the thing being checked.

What caught it was arithmetic rather than a failure: the mention count fell from 427 to 422 after a
change that only added sources. A number that moves the wrong way is the instrument reporting on
itself, and it is worth more than the assertions beside it, because an assertion can only speak about
what the check still looks at. So when a count is kept for a floor, read it on every change and ask
which direction it should have gone.

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

A check that decides identity by comparing a list of properties needs a test for the closest thing
that is not the target, not just for things that are obviously different. The check standing between
a recycled pid and `process.kill` compared the engine's basename and the project path. Every case
written for it was something unrelated: another project, another binary, a pid nobody holds. Each of
those differs in one of the compared properties, so the set looked exhaustive once there was nothing
unrelated left to add. The case that broke it differs in none of them. The editor for that project is
the same binary started with the same `--path`, so the check confirmed it, and the caller that acts
on a confirmation is the one that kills. It is also the process most likely to be holding the reused
pid, because ending the game frees the number and opening an editor is what happens next. So ask what
else on this machine satisfies every property on the list. The answer is usually right next to the
thing being identified.

Having found one such neighbour, do not stop: the answer to that question is a set. The editor was
the near thing visible from here, and the fix for it separated an editor from a game. What it did not
reach was reported from a project whose bench opens thirty-one worker engines at once, each with the
same executable, the same `--path` and no editor flag, on a machine recycling pids for twenty minutes.
Every one of them passed. The reason the first fix felt sufficient is worth naming, because it will
feel sufficient again: it was built from the case somebody had hit, and the neighbours nobody has hit
yet are the same distance away.

When every property being compared is shared across a family, no combination of them will separate
one member from another, and adding more of the same kind reads as progress. The record here carries
the engine, the project and the arguments, and a worker of that project matches all three: its
command line is a superset, so requiring each recorded argument to appear in it confirms the worker
too. What was needed was a property of a different kind, one no sibling can share, and the process's
start time is it: a number cannot be handed out again until the process holding it has gone. So when
a discriminator keeps failing, stop refining it and ask which property the impostors cannot have.

That argument check is a disarm that passes, one level up: it agrees with the worker by
construction, so it could not have come out the other way, and it would have been written, reviewed
and believed. The same question works on a check as on a fixture. Before trusting one, ask what it
would take for it to fail on the thing it is meant to catch, and if the answer is nothing, it is
measuring its own shape rather than the world.

A note that reports on the thing it is part of has to be written after that thing is done. A line
saying what a kill was about to do sat before the signal, so for every run already over by the time
it was signalled, which is the ordinary way a run ends, it announced an act that did not happen. The
same shape elsewhere reported a size before adding the paragraph doing the reporting. Neither is
visible in the code, because the code is correct about the moment it runs at; both are visible in the
output. So when something describes its own work, read the output and ask whether the work had
happened yet.

And a property the platform has to supply is a dependency to assert rather than assume, whenever its
absence is silent. The start time is read three different ways on three platforms and every case that
judges it hands it in, so all of them would have passed on a platform that never produced one, and
the guard would have been quietly Windows-only while every other machine went on signalling workers.
A case asks a real process for its start time and requires an answer. A platform that cannot give one
is a thing to find out about, not to degrade into.

That is for an absence that is silent. A reading the code takes best effort on purpose, and says so
when it cannot, is different: processor time is a PowerShell start with a two second budget, and a
loaded Windows runner holds it past that. A case requiring the number fails there for a reason that
is not the fault it guards, and the first run of the cpu case on the Windows leg did exactly that.
Hold that the question was put to the right process, which is the number or the note saying the
platform would not answer about it, and hold which process by a field the platform has no part in.

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

A cached reading carries the time it was taken, and that time is usually what decides whether to
take another one, so a wrong reading suppresses the check that would have corrected it. Nothing
about the state looks broken: the file parses, the value is a real version, and the code declining
to ask is doing exactly what it was written to do. It gets worse when the cache is shared, because
then the question is about this process and the answer was given by a different one. The update
check here stood for four hours in one file per user, so a server starting at 19:00 read 0.13.34
taken at 17:07, found it no newer than the version it was running, said nothing, and asked nobody,
while 0.13.35 and 0.13.36 sat on npm. So for anything held with a timestamp, ask how long the window
is against how often the thing behind it changes, and ask separately whether a process that has just
started should inherit the decision not to look. A fixture keeping its own copy of that window stops
testing the boundary the moment the window moves, and goes on passing.

An act that is two steps by one process, where the process can be replaced between them, leaves the
world in a state only that process knew how to read. The restart here quits the editor and then
starts it again, and a harness reconnect ends the server in the gap; the successor found nothing
connected and answered, correctly for what it could see, that an editor might still dial in. Nothing
was coming. The tell is a successor answering from its own age or its own defaults where the thing it
would need to know was in the memory of a process that is gone. So when the second step is what
makes the first one safe, write the intent down somewhere the next process reads before taking the
first step, and have whatever completes the act, or makes it moot, take the note down. The user's
reconnect is the usual replacement, and it arrives for the same reason the act was started.

A replacement process also loses what the old one observed, and the source may not repeat it. The
editor's debug adapter reports a stop to the sessions connected at the time. A session that
connects afterwards and asks for the stack gets a thread and no frames, while the game is still
sitting at its breakpoint. The code read "no frames" as "running". This was found by being wrong
twice: the first fixture asserted the replacement would see the stack, the second asserted the
game had been released, and a runtime call that timed out with "accepted the connection but did
not answer" contradicted both. When a state is learned from an event, ask what a process that
missed the event is told when it asks. If the answer is nothing, that is a third state, not the
default, and something else has to tell it apart from the default. Here the runtime did that, and
`editor_status` was already using it on the same game.

The finding above was right and one word in it was wrong, and the fix was built on the word. The
measurement used sessions that had attached, so the write-up said "the session attached when it
happened", and the fix counted the event only on an attached session. The property that mattered
was being connected. A server that plays a scene through the editor is connected and does not
attach until its first stack read, which is the ordinary case, so it was sent to the runtime for an
answer it already had, on all three platforms, caught by the oldest fixture about the field. When a
fix depends on a property named in a measurement, check whether the measurement distinguished
that property from its neighbours, or whether every trial happened to have both.

A comment saying a source never sends something shapes the code under it: there is no handler for
the event, so the event is ignored however often it arrives. The comment beside the adapter's event
handler said Godot sends no `continued`. It sends one to every connection whenever the game is let
go, so a session that had been told of a stop kept answering "held" about a game somebody else had
resumed. The same log showed `breakpoint` events with `reason: "removed"` that nothing had asked
for, which led to the finding that a breakpoint set through the adapter holds for one play only.
Neither was visible in the code, because the code only reads what it expects. Both were found by
writing every event the other side sent during one ordinary fixture run to a file and reading the
file. So when a comment describes a source as silent, or as saying exactly what the code reads, log
what it sends for one run and read the log. And when something is set and then consumed by a play,
a run or a request, set it once and use it twice before trusting the description, because the first
use is the one the description was written from.

Those removals were the engine clearing every breakpoint in the editor whenever a debug session
opens, which one editor setting turns off. The fix wrote the setting from the addon, the read-back
of the setting passed, and nothing changed: the adapter reads the setting again only on a
notification the settings dialog sends after Apply and `set_setting` does not send, so the value
was stored and the running adapter kept clearing. A value written into a live system is stored by
one part and read by another, and a successful write only says the first part has it. Test the
effect, not the stored value. The fixture that caught this opened a second session and read what
the adapter sent it; a read-back of the setting would have passed forever.

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

A tolerance has a blind side, and it is not always the side that feels risky. The window deciding
whether a process is the run a record describes was set to ninety seconds and written up as generous
against clock skew, which reads as the careful choice. It is blind to every run shorter than ninety
seconds: a number cannot be handed out again until the process holding it has gone, so the gap a
recycled pid leaves is the run's whole length, and a five-second run whose number is taken ten
seconds later clears the window entirely. The project that reported it runs thirty-one workers that
start, do one arm and exit inside a single bench, which is short runs and dense recycling together.
So for any tolerance, say what it is absorbing and size it to that, then ask what falls inside it
that should not. Wide was the dangerous direction here and it had been written down as the safe one.

Changing a case to fit the code is the thing not to do, with one exception, and it is worth being
able to tell them apart because the exception looks exactly like the fault. A case asserting a state
that cannot occur is not evidence of anything, so removing it removes nothing. A fixture here wrote
a record claiming its run began a minute before the process it had just spawned, and the record is
written by the call that spawns, so the two are the same moment. The narrower window above is what
made it fail. The test was corrected and its assertions left alone. Say in the change that a case was
altered and why the state was unreachable, because that sentence is the whole difference between this
and quietly deleting the case that caught you.

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

Merge nothing else while a release pull request is open. The ruleset on `main` requires branches to
be up to date, so every other merge puts the release branch behind and costs it all thirteen checks
again, three of them engine legs. On 2026-09-20 five pull requests went in while one release sat
open, and it took four rounds of updating and re-running to land. Cut the release last, let it
through, then carry on. It is a convention rather than a setting, and it costs nothing: the work is
already done by the time the release is cut.

Read that requirement from the rulesets rather than from branch protection. `gh api
repos/.../branches/main/protection` answers 404 here, which reads as "nothing is enforced" and is
wrong: the rules live in `gh api repos/.../rulesets`, and `strict` on the required checks is the
line that makes this matter.

Read a commit's subject back after writing it. Twelve of the nineteen commits between v0.13.36 and
v0.13.37 have the subject `@`, because the message was written as a PowerShell here-string,
`-m @'...'@`, through a POSIX shell, where `@'` is a literal `@` and a quote. Every one of those
commits succeeded, and the fault was found downstream by somebody reading `git log` to see what an
upgrade brought. The repository squashes with the pull request's title and body now, so a branch
subject cannot reach `main` again, but the branch commits are what a reviewer reads:
`-m "Subject" -m "Body"`, or a heredoc, and then `git log -1 --format=%s`.
