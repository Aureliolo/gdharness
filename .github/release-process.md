# Releases

## What a human does

Run **Prepare release** from the Actions tab with `patch`, the bump of every release from 1.0.0 on
([what a bump means](CONTRIBUTING.md#versions)). `minor` is for a release the owner has marked as
one. `major` and the exact-version field exist for the workflow's own completeness. The workflow
raises the version in `package.json`, `server.json` and the README on a `release/vX.Y.Z` branch,
with a signed commit. It opens the pull request and links it in the run summary.

Nobody types a version twice and nobody creates a tag by hand. A hand-made tag is the release step
that cannot be checked afterwards. It is also the one most likely to come from the wrong branch.

## Approving the checks

That pull request's checks are held at the start. GitHub creates the runs for anything a workflow
opens with the job token but does not start them. The merge box then offers **Approve workflows to
run**. Click it, then merge once the checks are green. Everything after the merge is automatic.

## The release label

The pull request carries the `release` label, by which `scripts/release-notes.ts` keeps it out of
the next release's changelog. The label has to exist in the repository. Deleting it stops a release
being prepared rather than quietly putting the line back, because `gh` fails on a label it cannot
find.

## What the changelog says

`scripts/release-notes.ts` writes it from the files each pull request touched, not from its title.
Entries are split into what reaches an installed copy and what stays in this repository. Reaching an
installed copy means touching `src/`, `package.json`, `README.md`, `LICENSE` or the packer itself.
In one flat list a fixture and a change in the server's behaviour read alike, because a title
describes a change, not its reach.

Run it against any published tag to see what a release carried:

```bash
GITHUB_REPOSITORY=Aureliolo/gdharness GH_TOKEN="$(gh auth token)" bun scripts/release-notes.ts v0.12.5
```

It compares against the newest release below the tag. It therefore reads the same afterwards as it
did at the time.

## What happens on the merge

`release-tag.yml` sees a new version on `main` with no matching tag and creates `vX.Y.Z`. It then
dispatches `release.yml` on the tag, since a tag made with the job token would otherwise start
nothing. `release.yml` calls `release-build.yml` for the three build jobs, then publishes.

## The build jobs (`release-build.yml`)

1. **build_test** refuses to go on unless the tag matches `package.json` and `server.json`, the
   release commit is reachable from `main`, and that commit carries a valid signature. It then
   builds, typechecks, runs the tests, audits production dependencies, checks the working tree is
   still clean, and packs the archive and its SHA-256.
2. **sbom** lists every file in the archive with its SHA-256 in an SPDX SBOM, with the production
   packages from the lockfile at the tag. It checks the SBOM against the archive's members and
   `package.json`, because an SBOM that lists nothing looks exactly like a passing step.
3. **attest** signs the archive, its checksum and the SBOM through Sigstore. It attests the SBOM
   against the archive and gathers both attestations into one JSON Lines file.

Only the attest job has a token that can sign ([SLSA](#slsa) says why).

## What the SBOM reads

The SBOM takes its packages from the lockfile, because a bundle names nothing on its own.
`.github/syft.yaml` says what syft reads.

## The publish jobs (`release.yml`)

1. **publish** rechecks the checksum and verifies that file against every subject the way a user
   would, naming `release-build.yml` at the tag as the builder. It creates the GitHub Release with
   all four files.
2. **npm** publishes that same signed archive to npm, where every harness installs the server from.
   It needs no token, because npm's trusted publisher names this workflow and takes the job's OIDC
   token.

npm adds its own provenance on top. The npm job does nothing after publishing, which cannot be
undone. Every job after it either reports or depends on it.

## The jobs after npm

1. **npm serves what was signed** downloads what the registry hands out and fails unless those
   bytes hash to the signed archive. It only reports, since the release is already on npm.
2. **installs** installs the published version with `npx` on Linux, Windows and macOS and runs it,
   because publishing is not installing. It only reports, for the same reason.
3. **registry** publishes `server.json` to the official MCP registry, the entry that clients and
   every marketplace downstream of it read. It needs no token, because the registry grants the
   `io.github.Aureliolo/*` namespace to whatever this workflow's OIDC token proves it is.

The registry job runs last, because the registry checks that the npm package exists at this
version with a matching `mcpName`. It reads the published entry back before it passes.

## What a release carries

- The archive, dependency-free. Installing it contacts no registry.
- A SHA-256 checksum.
- An SPDX SBOM of the archive.
- A Sigstore build-provenance attestation over all three, and an SBOM attestation tying the SBOM
  to the archive. Both are keyless, with no signing key anywhere, CI included.

The attestations are stored on the repository and attached to the release as
`gdharness-X.Y.Z.intoto.jsonl`, the file OpenSSF Scorecard looks for. Releases are immutable. A
published one cannot be edited or replaced.

## Verifying a release

```bash
VERSION=X.Y.Z
gh release download "v${VERSION}" --repo Aureliolo/gdharness
sha256sum -c "gdharness-${VERSION}.tgz.sha256"
gh attestation verify "gdharness-${VERSION}.tgz" --repo Aureliolo/gdharness \
  --bundle "gdharness-${VERSION}.intoto.jsonl" \
  --signer-workflow Aureliolo/gdharness/.github/workflows/release-build.yml \
  --source-ref "refs/tags/v${VERSION}" \
  --deny-self-hosted-runners
```

The checksum proves the bytes match what the release lists. The attestation proves GitHub Actions
built those bytes from this repository, by the steps in `release-build.yml` at that tag, on a
GitHub-hosted runner. The checksum alone cannot prove that, because a checksum generated beside a
tampered archive agrees with it perfectly. Drop `--bundle` to read the same attestations from
GitHub's API instead.

## SLSA

SLSA Build Level 3 on GitHub Actions means the build runs inside a reusable workflow. The identity
in the Sigstore certificate then names the build steps rather than whatever workflow called them.
`release-build.yml` is that workflow. It checks out the tag, builds, tests, packs, writes the SBOM
and signs. `release.yml` only decides when that happens and publishes the result.

A verifier that passes `--signer-workflow .../release-build.yml` requires those exact steps at the
tag the provenance names. No caller can change them.

## Signing

Inside that workflow, the build and the signing are separate jobs. `id-token: write` puts the
signing token within reach of every step in the job holding it. The build runs `bun install`.
Only the attest job, which downloads the finished bytes and signs them, is given that permission.

Runners are GitHub-hosted and ephemeral. Signing is keyless, with no key anywhere to take.
The release build restores no Actions cache, the one way one run can reach into another on this
platform. Any job on any branch can write a cache entry, a pull request from a fork included.

## Versions that cannot be released

A version whose tag exists cannot be released again, whether or not a release is attached to that
tag. The ruleset on `v*` allows no deletion and no update by anyone. That is what makes a tag worth
verifying a build against. The cost is that the number is spent for good, since cutting it twice
would leave two different builds answering to one version. Prepare release refuses such a version,
naming it, before it writes a branch.

## When a release job fails

Re-running the release workflow on the tag is safe and the first thing to try. Each of the three
steps that publish something asks what is already there before acting. The release job passes when
the tag already carries exactly the four files. The npm job takes a version the registry already
holds as done. The MCP registry job publishes nothing it already serves correctly.

A re-run of a release whose jobs all went red therefore does only the parts that did not happen.
Running "Tag release" by hand also starts the release workflow again on a tag that already exists.

## Tag and commit failures

- `Tag does not match package version` means the tag was created outside `release-tag.yml`, at a
  commit whose `package.json` says something else. Leave the tag standing, since the ruleset refuses
  deleting a `v*` tag, then go through Prepare release for the version that should ship.
- `vX.Y.Z is tagged at another commit` means that version is already spent. Raise the version past
  it, since nothing can move the tag.
- `Release commit is not reachable from main` means the tag points at a commit that never landed.
- `Release commit carries no valid signature` fires only if the ruleset requiring signed commits on
  `main` was bypassed or removed. That is exactly when you want to hear about it.

## Build and release failures

- `Tests or build steps modified the checked-out release source` means something in the build
  writes into the tree. The archive would then not match the tagged commit.
- `The SBOM's files are not the archive's members` means syft read something besides the unpacked
  archive and the lockfile. Fix the sbom job, not the archive, then rerun the workflow on the tag.
- `The SBOM does not list X` can also mean a syft upgrade changed what its catalogers see. The fix
  is the same.
- `vX.Y.Z already has a release, and it carries ...` means the tag has a release with something
  other than the four files, after an upload failed part way. Look at what is attached before
  deciding anything, since a published release is not rewritten here.

## Registry refusals

- `Registry validation failed for package` means the registry could not find `mcpName` in the
  package npm serves, or it does not match the name in `server.json`. One of `test:metadata` and
  `test:packaging`, which both check that pair, was skipped, or the packing dropped the field.
- `You do not have permission to publish this server` means `server.json` names something outside
  `io.github.Aureliolo/*`, the only namespace a token from this repository is given.
- `The registry serves ...` followed by `Expected: ...` means the publish will be refused, because
  another entry for this version exists. Since a registry version is published only once, the
  version is spent there until the next release replaces it.

## Entries that have not appeared

- `X was accepted; the registry had not served it five minutes later` means the publish went
  through and the entry is not yet at
  `registry.modelcontextprotocol.io/v0.1/servers/io.github.Aureliolo%2Fgdharness/versions/latest`.
  A rerun, which reads what the registry serves first, confirms an arrived entry and never
  publishes twice.
- `gdharness@X is published; the registry had not served it twenty minutes later` means npm took
  the archive and has not served it back yet. Rerun that job once `npm view gdharness@X` answers,
  since only the comparison against the signed archive is outstanding.
