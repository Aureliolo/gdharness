#!/usr/bin/env bun

import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(root, 'src');
const buildRoot = path.join(root, 'build');

async function buildBundledEntrypoint(sourceName: string, outputName: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.join(sourceRoot, sourceName)],
    outdir: buildRoot,
    naming: outputName,
    // Node, because `npx gdharness` is how every harness spawns a server and npx is Node. The
    // bundle runs under both: the embedded `ws` serves the editor socket on Node and on Bun,
    // which test/node-runtime.ts holds to, since an earlier Bun could not and the workaround for
    // that was targeting Bun and shipping something npx could not start.
    target: 'node',
    format: 'esm',
    packages: 'bundle',
    minify: false,
    sourcemap: 'none',
  });

  if (result.success) return;

  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error(`Bundling ${sourceName} failed`);
}

async function collectTypeScriptEntries(directory: string): Promise<string[]> {
  const entries: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name);
    if (item.isDirectory()) {
      entries.push(...(await collectTypeScriptEntries(itemPath)));
    } else if (item.isFile() && item.name.endsWith('.ts')) {
      entries.push(itemPath);
    }
  }
  return entries;
}

await rm(buildRoot, { recursive: true, force: true });
await mkdir(buildRoot, { recursive: true });

await buildBundledEntrypoint('cli.ts', 'cli.js');
await buildBundledEntrypoint('server-entry.ts', 'index.js');

for (const sourcePath of await collectTypeScriptEntries(sourceRoot)) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (relativePath === 'cli.ts' || relativePath === 'server-entry.ts') continue;

  const outputPath = path.join(buildRoot, relativePath.replace(/\.ts$/, '.js'));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = Bun.spawnSync(
    [
      process.execPath,
      'build',
      sourcePath,
      `--outfile=${outputPath}`,
      '--target=bun',
      '--format=esm',
      '--sourcemap=none',
      '--no-bundle',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Development module build failed for ${relativePath}:\n${result.stderr.toString().trim()}`,
    );
  }
}

await cp(path.join(sourceRoot, 'godot'), path.join(buildRoot, 'godot'), { recursive: true });

// node, though the bundles are built by Bun and neither of them touches a Bun-only API. The
// shebang is what a package runner hands the file to, and `npx -y gdharness@X`, which is the
// line on every page of the documentation, is Node: naming bun there asked a Node machine for a
// runtime it has no reason to own, and the line answered "bun: No such file or directory". The
// other direction costs nothing, measured rather than assumed: bunx runs a node-shebang bin
// under Bun's own runtime on a machine with no Node on it at all.
const SHEBANG = '#!/usr/bin/env node\n';

// Replaced rather than prepended. The bundler carries the entry file's own shebang into the
// bundle, so a prepend leaves two, and the second one wins nothing and reads as a mistake. What
// the published file starts with is a packaging decision either way, not the source's.
for (const executable of ['cli.js', 'index.js']) {
  const executablePath = path.join(buildRoot, executable);
  const contents = await readFile(executablePath, 'utf8');
  const body = contents.startsWith('#!') ? contents.slice(contents.indexOf('\n') + 1) : contents;
  await writeFile(executablePath, `${SHEBANG}${body}`, 'utf8');
  await chmod(executablePath, 0o755);
}

console.log(`Built dependency-free gdharness bundles with Bun ${Bun.version}`);
