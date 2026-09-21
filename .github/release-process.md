# Releases

## What a human does

Run **Prepare release** from the Actions tab with `patch`, which is every release from 1.0.0 on
([what a bump means](CONTRIBUTING.md#versions)); `minor` is for a release the owner has marked as
one, and `major` and the exact-version field exist for the workflow's own completeness. It raises
the version in `package.json`, `server.json` and the README on a `release/vX.Y.Z` branch, with a
signed commit, opens the pull request, and links it in the run summary.

That pull request's checks are held at the start. GitHub creates the runs for anything a
workflow opens with the job token but does not start them, so the merge box carries a banner
offering **Approve workflows to run**. Click it, then merge once the checks are green.
Everything after the merge is automatic.

Nobody types a version twice and nobody creates a tag by hand, which is the release step that
cannot be checked afterwards and the one most likely to be done from the wrong branch.

That pull request is opened with the `release` label, which is how `scripts/release-notes.ts`
keeps it out of the next release's changelog. The label has to exist in the repository: `gh` fails
on one it cannot find, so deleting it stops a release being prepared rather than quietly putting
the line back.

## What the changelog says

`scripts/release-notes.ts` writes it, from the files each pull request touched rather than from
its title. Entries are split into what reaches an installed copy, meaning `src/`, `package.json`,
`README.md`, `LICENSE` or the packer itself, and what stays in this repository. A title describes
a change, not its reach: "A live foreign run is not ended" is a fixture and "A transcript answers
what was printed" is the server behaving differently, and in one flat list they read alike. Two
projects downstream chose which release to take from that list on the same day and both chose
wrong in the same direction.

Run it against any published tag to see what a release carried:

```bash
GITHUB_REPOSITORY=Aureliolo/gdharness GH_TOKEN="$(gh auth token)" bun scripts/release-notes.ts v0.12.5
```

It picks the newest release below the tag, so it reads the same afterwards as it did at the time.
An earlier version took the newest release that was not the tag, which is the same thing only at
the moment of release and compares backwards on anything older.

## What happens on the merge

`release-tag.yml` sees a new version on `main` with no matching tag, creates `vX.Y.Z`, and
dispatches `release.yml` on it, since a tag it makes with the job token would otherwise start
nothing. `release.yml` calls `release-build.yml`, which runs the first three jobs, then publishes:

1. **build_test** refuses to go on unless the tag matches `package.json` and `server.json`, the
   release commit is reachable from `main`, and that commit carries a valid signature. Then it
   builds, typechecks, runs the tests, audits production dependencies, checks the working tree
   is still clean, and packs the archive and its SHA-256.
2. **sbom** builds an SPDX SBOM of the archive: every file in it with its SHA-256, and every
   production package the bundle was built from, read from the lockfile at the tag, since a
   bundle names nothing on its own. The job then checks the SBOM against the archive's members
   and `package.json`, because an SBOM that lists nothing looks exactly like a passing step
   (`.github/syft.yaml` says what syft reads).
3. **attest** signs the archive, its checksum and the SBOM through Sigstore, attests the SBOM
   against the archive, and gathers both signed attestations into one JSON Lines file. It is the
   only job with a token that can sign: see below.
4. **publish**, in `release.yml`, rechecks the checksum, verifies that file against every
   subject the way a user would (from the file, naming `release-build.yml` at the tag as the
   builder), and creates the GitHub Release with all four files.
5. **npm**, in `release.yml`, publishes that same signed archive to npm, which is how every
   harness actually installs the server. Tokenless: npm's trusted publisher for the package
   names this workflow and the job's OIDC token is the whole credential, so npm adds its own
   provenance on top. It then downloads what npm serves and fails unless those bytes hash to
   the archive that was signed.
6. **registry**, in `release.yml`, publishes `server.json` to the official MCP registry, the
   entry that clients and every marketplace downstream of it read. Tokenless again: the
   registry has no accounts, and grants the `io.github.Aureliolo/*` namespace to whatever this
   workflow's OIDC token proves it is. It runs last because the registry checks that the npm
   package exists at this version and carries a matching `mcpName`, and it reads the published
   entry back before the job passes.

## What a release carries

- The archive, dependency-free: installing it contacts no registry.
- A SHA-256 checksum.
- An SPDX SBOM of the archive.
- A Sigstore build-provenance attestation over all three, and an SBOM attestation tying the
  SBOM to the archive. Both are keyless: there is no signing key anywhere, including in CI.
  They are stored on the repository and attached to the release as
  `gdharness-X.Y.Z.intoto.jsonl`, which is also the file OpenSSF Scorecard looks for.

Releases are immutable, so a published one cannot be edited or replaced.

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

The checksum proves the bytes match what the release lists. The attestation proves GitHub
Actions built those bytes from this repository, by the steps in `release-build.yml` at that
tag, on a GitHub-hosted runner, which the checksum alone cannot: a checksum generated
alongside a tampered archive agrees with it perfectly. Drop `--bundle` to read the same
attestations from GitHub's API instead.

## SLSA

SLSA Build Level 3 on GitHub Actions means the build runs inside a reusable workflow, so the
identity in the Sigstore certificate names the build steps rather than whatever workflow
called them. `release-build.yml` is that workflow: it checks out the tag, builds, tests, packs,
writes the SBOM and signs, and `release.yml` only decides when that happens and publishes the
result. A verifier that passes `--signer-workflow .../release-build.yml` is requiring those
exact steps, at the tag the provenance names, and no caller can change them.

Inside it, the build and the signing are separate jobs. `id-token: write` puts the signing
token within reach of every step in the job that holds it, and the build runs `bun install`,
so only the attest job, which downloads the finished bytes and signs them, is given that
permission. Runners are GitHub-hosted and ephemeral, and signing is keyless: there is no key
anywhere to take. The release build restores no Actions cache, which is the one way one run can
reach into another on this platform: a cache entry can be written by any job on any branch,
including a pull request from a fork.

## Versions that cannot be released

A version whose tag exists cannot be released again, whether or not a release is attached to
that tag. The ruleset on `v*` allows no deletion and no update by anyone, which is what makes a
tag worth verifying a build against, and the cost is that the number is spent for good: cutting
one twice would leave two different builds answering to one version. Prepare release refuses
such a version, naming it, before it writes a branch.

## When a release job fails

- **Tag does not match package version**: the tag was created outside `release-tag.yml`, at a
  commit whose `package.json` says something else. It cannot be taken back, because a push that
  deletes a `v*` tag is refused by the ruleset. Go through Prepare release for the version that
  should ship and leave the tag standing; like the case below, that number is spent.
- **vX.Y.Z is tagged at another commit**: that version is already spent. Nothing can move the
  tag, so raise the version past it; see above.
- **Release commit is not reachable from main**: the tag points at a commit that never landed.
- **Release commit carries no valid signature**: `main` requires signed commits, so this only
  fires if that ruleset was bypassed or removed. That is exactly when you want to hear about it.
- **Tests or build steps modified the checked-out release source**: something in the build
  writes into the tree, which would mean the archive does not match the tagged commit.
- **The SBOM's files are not the archive's members**, or **The SBOM does not list X**: syft
  read something other than the unpacked archive and the lockfile, or a syft upgrade changed
  what its catalogers see. The SBOM is wrong, not the archive; fix the sbom job and rerun the
  workflow on the tag.
- **Registry validation failed for package**: the registry could not find `mcpName` in the
  package npm serves, or it does not match the name in `server.json`. `test:metadata` and
  `test:packaging` both check that pair, so this means one of them was skipped or the packing
  dropped the field.
- **You do not have permission to publish this server**: `server.json` names something outside
  `io.github.Aureliolo/*`, which is the only namespace a token from this repository is given.
- **The registry never served X**, or **The registry serves ...**: the publish was accepted and
  what came back a minute later is missing or not this version. The release and npm are
  unaffected. Do not rerun the job: a registry version is published once and cannot be
  republished or edited, so a rerun fails at the publish step instead. Read the entry yourself
  at `registry.modelcontextprotocol.io/v0.1/servers/io.github.Aureliolo%2Fgdharness/versions/latest`,
  and if it really is wrong, that version is spent there and the next release replaces it.
