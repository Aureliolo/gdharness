# Releases

## What a human does

Run **Prepare release** from the Actions tab and pick `patch`, `minor` or `major`, or type an
exact version. It raises the version in `package.json`, `server.json` and the README on a
`release/vX.Y.Z` branch, with a signed commit, and prints the `gh pr create` line to open the
pull request with.

Open that pull request and merge it. Everything after it is automatic. The pull request is
yours to open rather than the workflow's because one opened with the job token starts no
workflow: nothing would check it and the merge would stay blocked.

Nobody types a version twice and nobody creates a tag by hand, which is the release step that
cannot be checked afterwards and the one most likely to be done from the wrong branch.

## What happens on the merge

`release-tag.yml` sees a new version on `main` with no matching tag, creates `vX.Y.Z`, and
dispatches `release.yml` on it, since a tag it makes with the job token would otherwise start
nothing. `release.yml` runs four jobs in order:

1. **build_test** refuses to go on unless the tag matches `package.json` and `server.json`, the
   release commit is reachable from `main`, and that commit carries a valid signature. Then it
   builds, typechecks, runs the tests, audits production dependencies, checks the working tree
   is still clean, and packs the archive and its SHA-256.
2. **sbom** builds an SPDX SBOM of the archive: every file in it with its SHA-256, and every
   production package the bundle was built from, read from the lockfile at the tag, since a
   bundle names nothing on its own. The job then checks the SBOM against the archive's members
   and `package.json`, because an SBOM that lists nothing looks exactly like a passing step
   (`.github/syft.yaml` says what syft reads).
3. **attest** signs the archive, its checksum and the SBOM through Sigstore, and attests the
   SBOM against the archive. It is a separate reusable workflow on purpose: see below.
4. **publish** rechecks the checksum and creates the GitHub Release with all three files.

## What a release carries

- The archive, dependency-free: installing it contacts no registry.
- A SHA-256 checksum.
- An SPDX SBOM of the archive.
- A Sigstore build-provenance attestation over all three, and an SBOM attestation tying the
  SBOM to the archive. Both are keyless: there is no signing key anywhere, including in CI.

Releases are immutable, so a published one cannot be edited or replaced.

## Verifying a release

```bash
VERSION=X.Y.Z
gh release download "v${VERSION}" --repo Aureliolo/gdharness
sha256sum -c "gdharness-${VERSION}.tgz.sha256"
gh attestation verify "gdharness-${VERSION}.tgz" --repo Aureliolo/gdharness
```

The checksum proves the bytes match what the release lists. The attestation proves GitHub
Actions built those bytes from this repository, which the checksum alone cannot: a checksum
generated alongside a tampered archive agrees with it perfectly.

## SLSA

The attestation runs in `attest.yml`, a reusable workflow the release calls, rather than inline
in the release job. That separation is the difference between SLSA Build Level 2 and Level 3:
signing happens where the build cannot reach it, so the identity in the certificate names that
workflow. A verifier can then require the provenance to have come from it, which is a claim
worth something; "some job in this repository signed it" is not.

## When a release job fails

- **Tag does not match package version**: the tag was created outside `release-tag.yml`. Delete
  the tag and go through Prepare release.
- **Release commit is not reachable from main**: the tag points at a commit that never landed.
- **Release commit carries no valid signature**: `main` requires signed commits, so this only
  fires if that ruleset was bypassed or removed. That is exactly when you want to hear about it.
- **Tests or build steps modified the checked-out release source**: something in the build
  writes into the tree, which would mean the archive does not match the tagged commit.
- **The SBOM's files are not the archive's members**, or **The SBOM does not list X**: syft
  read something other than the unpacked archive and the lockfile, or a syft upgrade changed
  what its catalogers see. The SBOM is wrong, not the archive; fix the sbom job and rerun the
  workflow on the tag.
