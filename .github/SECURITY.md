# Security

## Reporting

Report a vulnerability privately through
[GitHub's advisory form](https://github.com/Aureliolo/gdharness/security/advisories/new).
Please do not open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. A minimal reproduction is worth
more than a description.

## What is in scope

gdharness runs on a developer's machine and drives a Godot editor and a running game. The
things worth reporting:

- The runtime bridge or the editor bridge reachable from outside the machine, or from a
  release build rather than a debug one.
- A tool executing something the caller did not ask for: path traversal out of the project
  directory, argument injection into the Godot command line, a file written outside the
  project.
- Anything that makes the release archive differ from what was built and attested.
- Secrets or tokens read, logged or transmitted by the server.

## What is not

- The bridge being reachable from the same machine. It binds loopback and refuses to serve a
  release build; a local process is inside the trust boundary by design.
- An MCP client sending hostile arguments. The client is the operator here.

## Releases

Every release is built in CI on Linux from a signed commit on `main`, with a frozen
lockfile. Each one ships the archive, a SHA-256 sidecar and an SPDX SBOM, and carries two
Sigstore attestations: build provenance, and the SBOM bound to the archive. From 0.2.4 the
attestations are also attached to the release as `gdharness-<version>.intoto.jsonl`, so they
verify without GitHub's API. Releases are immutable and the `v*` tags cannot be moved.

```bash
gh attestation verify gdharness-<version>.tgz --repo Aureliolo/gdharness
gh attestation verify gdharness-<version>.tgz --repo Aureliolo/gdharness --predicate-type https://spdx.dev/Document
gh attestation verify gdharness-<version>.tgz --repo Aureliolo/gdharness --bundle gdharness-<version>.intoto.jsonl
sha256sum --check gdharness-<version>.tgz.sha256
```

## OpenSSF Scorecard

The [published score](https://scorecard.dev/viewer/?uri=github.com/Aureliolo/gdharness) has
three checks that cannot reach 10 while gdharness has one maintainer. They stay low on
purpose rather than being satisfied by an account that approves without reading:

- **Code-Review** counts changesets approved by someone other than their author.
- **Branch-Protection** scores in tiers, and every tier past the first needs required
  approvals. Everything a single maintainer can enforce on `main` is on: pull requests, the
  required checks, up-to-date branches, last-push approval, stale reviews dismissed, no force
  pushes, no deletion, and administrators bound by all of it.
- **Contributors** counts the organisations behind recent committers.

**Maintained** reads 0 until the repository is 90 days old, and **Packaging** is not scored
until releases are published to a package registry.
