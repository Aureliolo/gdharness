# Security

## Reporting

Report a vulnerability privately through
[GitHub's advisory form](https://github.com/Aureliolo/gdharness/security/advisories/new).
Do not open a public issue for anything exploitable.

Include what you did, what happened and what you expected. A minimal reproduction is worth
more than a description.

## What is in scope

gdharness runs on a developer's machine and drives a Godot editor and a running game. The
things worth reporting:

- The runtime bridge or the editor bridge reachable from outside the machine, or from a
  release build rather than a debug one.
- A tool doing something the caller did not ask for. Path traversal out of the project directory,
  argument injection into the Godot command line and a file written outside the project all count.
- Anything that makes the release archive differ from what was built and attested.
- Secrets or tokens read, logged or transmitted by the server.

## What is not

- The bridge being reachable from the same machine. It binds loopback and refuses to serve a
  release build, since a local process is inside the trust boundary by design.
- An MCP client sending hostile arguments. The client is the operator here.

## Releases

Every release is built in CI on Linux by `release-build.yml`, from a signed commit on `main` with a
frozen lockfile. Each one ships the archive, a SHA-256 sidecar and an SPDX SBOM. It carries two
Sigstore attestations, for build provenance and for the SBOM bound to the archive. Running the build
and the signing in that one reusable workflow meets SLSA Build Level 3.

The attestations are attached to the release as `gdharness-<version>.intoto.jsonl` and stored on
the repository. They verify from the file alone. Releases are immutable and the `v*` tags cannot
be moved.

```bash
signer=Aureliolo/gdharness/.github/workflows/release-build.yml
gh attestation verify gdharness-<version>.tgz --repo Aureliolo/gdharness --signer-workflow "$signer"
gh attestation verify gdharness-<version>.tgz --repo Aureliolo/gdharness --signer-workflow "$signer" --predicate-type https://spdx.dev/Document
gh attestation verify gdharness-<version>.tgz --repo Aureliolo/gdharness --signer-workflow "$signer" --bundle gdharness-<version>.intoto.jsonl
sha256sum --check gdharness-<version>.tgz.sha256
```

## OpenSSF Scorecard

The [published score](https://scorecard.dev/viewer/?uri=github.com/Aureliolo/gdharness) has
checks that cannot reach 10 while gdharness has one maintainer. They stay low on
purpose rather than being satisfied by an account that approves without reading:

- **Code-Review** counts changesets approved by someone other than their author.
- **Branch-Protection** scores in tiers. Every tier past the first needs required approvals.
- **Contributors** counts the organisations behind recent committers.

Everything else a single maintainer can enforce on `main` is on. It covers pull requests, the
required checks, up-to-date branches and dismissing stale reviews. Force pushes and deletion are
refused, with administrators bound by all of it. Last-push approval is off, because it blocks a
merge nobody else has approved even when no approvals are required.

**Maintained** reads 0 until the repository is 90 days old. **Packaging** is not scored until
releases are published to a package registry.
