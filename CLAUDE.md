# gdharness

## Releasing

Work the tracker to empty. **Do not cut a release for each fix.** Fixes land on `main` and wait
there for a batch; unreleased work on `main` is the normal state, not a debt.

Cut one when there is a reason to, and the reason is a person rather than a tally: somebody is
blocked on a fix and cannot proceed without a tag, or Aurelio asks. A fix that only bites on
upgrade is never urgent, because the upgrade is the release. If nothing is blocked, say what `main`
is carrying and leave it.

Four tags in one afternoon is the failure this replaces. Every one costs each downstream project an
upgrade, and an upgrade restarts their editor and drops their MCP connection, so a tag per fix
spends their day rather than this one's, and leaves whoever is verifying aiming at a moving target.

When one is cut, pick the bump between **patch** and **minor** without asking, over everything the
batch carries: patch when nothing a caller relies on has changed, minor when behaviour a caller can
see changes, or a tool, an argument or a field is added.

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
