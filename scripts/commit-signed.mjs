#!/usr/bin/env bun
/**
 * Commits the given files to a branch through GitHub's GraphQL API.
 *
 * main requires signed commits, and a commit made with git on a runner is not signed: there is
 * no key there to sign it with, and putting one there would mean a signing key living in CI.
 * createCommitOnBranch is the way out, because GitHub signs what it commits on your behalf, so
 * the ruleset stays strict and nothing has to be excepted from it.
 *
 * Usage: bun scripts/commit-signed.mjs <branch> <message> <file>...
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

const [branch, message, ...files] = process.argv.slice(2);

if (!branch || !message || files.length === 0) {
  console.error('Usage: bun scripts/commit-signed.mjs <branch> <message> <file>...');
  process.exit(1);
}

const repository = process.env['GITHUB_REPOSITORY'];
const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
const expectedHeadOid = process.env['EXPECTED_HEAD_OID'];

if (!repository || !token || !expectedHeadOid) {
  console.error('GITHUB_REPOSITORY, GH_TOKEN and EXPECTED_HEAD_OID must all be set.');
  process.exit(1);
}

const [headline, ...rest] = message.split('\n\n');
const body = rest.join('\n\n');

const query = `
  mutation ($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit { oid url }
    }
  }
`;

const input = {
  branch: { repositoryNameWithOwner: repository, branchName: branch },
  expectedHeadOid,
  message: body ? { headline, body } : { headline },
  fileChanges: {
    additions: files.map((path) => ({
      path,
      contents: readFileSync(path).toString('base64'),
    })),
  },
};

const response = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: {
    authorization: `bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ query, variables: { input } }),
});

const payload = await response.json();

if (!response.ok || payload.errors) {
  console.error(JSON.stringify(payload.errors ?? payload, null, 2));
  process.exit(1);
}

const commit = payload.data.createCommitOnBranch.commit;
console.log(`${commit.oid} ${commit.url}`);
