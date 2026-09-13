#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const SERVER_JSON_PATH = path.join(ROOT, 'server.json');
const VERSION_REFERENCE_PATHS = ['README.md'];
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const SEMVER_SOURCE = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?`;

const usage = `Usage:\n  bun scripts/bump-version.ts <version|major|minor|patch> [--dry-run]\n\nExamples:\n  bun scripts/bump-version.ts patch\n  bun scripts/bump-version.ts 2.3.0 --dry-run`;

interface VersionedManifest {
  name: string;
  version: string;
  [key: string]: unknown;
}

function assertVersion(version: string): void {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
}

function bumpVersion(currentVersion: string, bumpType: 'major' | 'minor' | 'patch'): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(currentVersion);
  if (!match) {
    throw new Error(`Current version is not a simple semver (x.y.z): ${currentVersion}`);
  }

  const [major = 0, minor = 0, patch = 0] = match.slice(1).map(Number);
  if (bumpType === 'major') return `${major + 1}.0.0`;
  if (bumpType === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function replaceReleaseVersionReferences(content: string, nextVersion: string, packageName: string): string {
  return (
    content
      .replace(
        new RegExp(`(releases/download/v)${SEMVER_SOURCE}(/${packageName}-)${SEMVER_SOURCE}(\\.tgz)`, 'g'),
        `$1${nextVersion}$2${nextVersion}$3`,
      )
      .replace(
        new RegExp(`(${packageName}-)${SEMVER_SOURCE}(\\.tgz(?:\\.sha256)?)`, 'g'),
        `$1${nextVersion}$2`,
      )
      // The install line, which is the one a reader copies: `npx -y gdharness@0.3.1 setup .`.
      // Left out of here it stays on the last release forever, pinning every new project to a
      // version older than the one the page it sits on describes.
      .replace(new RegExp(`(${packageName}@)${SEMVER_SOURCE}`, 'g'), `$1${nextVersion}`)
  );
}

async function readManifest(filePath: string): Promise<VersionedManifest> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { version?: unknown }).version !== 'string' ||
    typeof (parsed as { name?: unknown }).name !== 'string'
  ) {
    throw new Error(`${filePath} has no string name and version.`);
  }
  return parsed as VersionedManifest;
}

async function writeText(filePath: string, content: string, dryRun: boolean): Promise<void> {
  if (!dryRun) {
    await fs.writeFile(filePath, content, 'utf8');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const target = args.find((arg) => !arg.startsWith('-'));

  if (!target) {
    console.error(usage);
    process.exit(1);
  }

  const pkg = await readManifest(PACKAGE_JSON_PATH);
  const currentVersion = pkg.version;
  let nextVersion: string;

  if (target === 'major' || target === 'minor' || target === 'patch') {
    nextVersion = bumpVersion(currentVersion, target);
  } else {
    assertVersion(target);
    nextVersion = target;
  }

  assertVersion(nextVersion);

  if (nextVersion === currentVersion) {
    console.log(`No changes needed. Version is already ${nextVersion}.`);
    return;
  }

  const changed: string[] = [];

  pkg.version = nextVersion;
  await writeText(PACKAGE_JSON_PATH, `${JSON.stringify(pkg, null, 2)}\n`, dryRun);
  changed.push('package.json');

  const server = await readManifest(SERVER_JSON_PATH);
  server.version = nextVersion;
  // The registry entry carries the npm version separately from the server's own, and a release
  // that moved one without the other would point the registry at a version nobody published.
  for (const entry of Array.isArray(server['packages']) ? server['packages'] : []) {
    if (typeof entry === 'object' && entry !== null) {
      (entry as { version?: string }).version = nextVersion;
    }
  }
  await writeText(SERVER_JSON_PATH, `${JSON.stringify(server, null, 2)}\n`, dryRun);
  changed.push('server.json');

  for (const relativePath of VERSION_REFERENCE_PATHS) {
    const filePath = path.join(ROOT, relativePath);
    const original = await fs.readFile(filePath, 'utf8');
    const updated = replaceReleaseVersionReferences(original, nextVersion, pkg.name);
    if (updated !== original) {
      await writeText(filePath, updated, dryRun);
      changed.push(relativePath);
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Version bump ${currentVersion} -> ${nextVersion}`);
  console.log(`Updated: ${changed.join(', ')}`);
  if (dryRun) {
    console.log('No files were written.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
