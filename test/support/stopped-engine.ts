/**
 * Runs a spinning stand-in engine past a timeout through `runEngine` and prints how it ended, as one
 * line of JSON, with an engine that exits 1 by itself beside it. Run under Node and under Bun, from
 * the built modules, which both can load.
 * Usage: stopped-engine.ts <build folder>
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Ran {
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

interface EngineRunModule {
  readonly howItEnded: (run: Ran) => string;
  readonly runEngine: (
    executable: string,
    args: readonly string[],
    options?: { readonly timeout?: { readonly ms: number; readonly said: string } },
  ) => Promise<Ran>;
}

const build = process.argv[2] ?? '';
const loaded: unknown = await import(pathToFileURL(join(build, 'engine-run.js')).href);

function isEngineRunModule(value: unknown): value is EngineRunModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'howItEnded') === 'function' &&
    typeof Reflect.get(value, 'runEngine') === 'function'
  );
}

if (!isEngineRunModule(loaded)) {
  throw new Error('build/engine-run.js has no runEngine');
}
const { howItEnded, runEngine } = loaded;
const spin = 'const end=Date.now()+60000;while(Date.now()<end){}';
const stopped = await runEngine(process.execPath, ['-e', spin], {
  timeout: { ms: 1500, said: '1.5 s timeout' },
});
const exits = await runEngine(process.execPath, ['-e', 'process.exit(1)']);
process.stdout.write(
  `${JSON.stringify({
    stopped: { exitCode: stopped.exitCode, exitSignal: stopped.exitSignal, said: howItEnded(stopped) },
    exits: { exitCode: exits.exitCode, exitSignal: exits.exitSignal },
  })}\n`,
);
process.exit(0);
