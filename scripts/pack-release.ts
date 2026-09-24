#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sourcePackage from '../package.json' with { type: 'json' };

const root = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.join(root, 'dist');
const archiveName = `${sourcePackage.name}-${sourcePackage.version}.tgz`;
const archivePath = path.join(outputDirectory, archiveName);
const checksumPath = `${archivePath}.sha256`;
const stagingRoot = await mkdtemp(path.join(os.tmpdir(), `${sourcePackage.name}-release-pack-`));

const releasePackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  mcpName: sourcePackage.mcpName,
  description: sourcePackage.description,
  type: sourcePackage.type,
  main: sourcePackage.main,
  bin: {
    gdharness: 'build/cli.js',
  },
  engines: sourcePackage.engines,
  license: sourcePackage.license,
  repository: sourcePackage.repository,
  homepage: sourcePackage.homepage,
  bugs: sourcePackage.bugs,
  author: sourcePackage.author,
  keywords: sourcePackage.keywords,
};

try {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(path.join(stagingRoot, 'build'), { recursive: true });

  await Promise.all([
    // keeper.js is started by index.js with Node rather than run as a bin, so it needs no mode, but
    // without it every editor and run the server starts would fail to start.
    ...['cli.js', 'index.js', 'keeper.js'].map((name) =>
      cp(path.join(root, 'build', name), path.join(stagingRoot, 'build', name)),
    ),
    cp(path.join(root, 'build', 'godot'), path.join(stagingRoot, 'build', 'godot'), { recursive: true }),
    cp(path.join(root, 'README.md'), path.join(stagingRoot, 'README.md')),
    cp(path.join(root, 'LICENSE'), path.join(stagingRoot, 'LICENSE')),
    writeFile(path.join(stagingRoot, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`, 'utf8'),
  ]);

  // bun pm pack records whatever mode the staged file carries, so the bins are chmodded
  // here rather than left to whatever cp produced. Windows cannot express a POSIX mode at
  // all and would ship a world-writable executable without saying so, so the release is
  // refused there instead: cut it where the modes are real.
  for (const executable of ['cli.js', 'index.js']) {
    const staged = path.join(stagingRoot, 'build', executable);
    await chmod(staged, 0o755);
    const mode = (await stat(staged)).mode & 0o777;
    if (mode !== 0o755) {
      throw new Error(
        `build/${executable} staged as ${mode.toString(8)} rather than 755. This platform ` +
          'cannot record POSIX modes, so the archive would ship a wrong one. Cut the release ' +
          'on Linux or macOS.',
      );
    }
  }

  const stagedArchive = path.join(stagingRoot, archiveName);
  const pack = Bun.spawnSync(
    [process.execPath, 'pm', 'pack', '--ignore-scripts', '--filename', stagedArchive, '--quiet'],
    {
      cwd: stagingRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (pack.exitCode !== 0) {
    throw new Error(`bun pm pack failed:\n${pack.stderr.toString().trim()}`);
  }

  await rename(stagedArchive, archivePath);
  const archive = await readFile(archivePath);
  const checksum = createHash('sha256').update(archive).digest('hex');
  await writeFile(checksumPath, `${checksum}  ${archiveName}\n`, 'utf8');
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

console.log(path.relative(root, archivePath));
console.log(path.relative(root, checksumPath));
