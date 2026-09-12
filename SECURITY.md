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

Every release archive is built in CI on Linux, published with a SHA-256 sidecar, and carries
a build provenance attestation. Verify one with:

```bash
gh attestation verify gdharness-<version>.tgz --repo Aureliolo/gdharness
```
