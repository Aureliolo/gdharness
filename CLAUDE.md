# gdharness

## Releasing

Work the tracker to empty, then ship. When issues are open, fix all of them, then cut a release
carrying the fixes rather than leaving them sitting on `main` unreleased. A fix nobody can install
is not delivered.

Pick the bump between **patch** and **minor** without asking: patch when nothing a caller relies
on has changed, minor when behaviour a caller can see changes, or a tool, an argument or a field
is added.

**Never raise the major version without asking Aurelio first.** `major` on the "Prepare release"
workflow, and `1.0.0` above all, is his call alone: ask, and wait for the answer before touching
it. This holds however obviously ready the project looks.

Cut releases through the button rather than by hand: run the "Prepare release" workflow with the
bump, merge the pull request it opens, and `release-tag.yml` tags whatever version lands on
`main`.
