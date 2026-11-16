import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncHidden } from '../../src/spawn.js';

/** The variable naming the engine the stand-in hands every start that needs no window to. */
export const REAL_ENGINE_VARIABLE = 'GDHARNESS_REAL_ENGINE';

/** The title and lines Godot 4.7.2 gives a machine whose drivers make no renderer. */
const NO_RENDERER_TITLE = 'Unable to initialize video driver';
const NO_RENDERER_LINES = [
  'WARNING: Your video card drivers seem not to support the required OpenGL 3.3 version, switching to ANGLE.',
  "ERROR: Can't initialize an EGL display.",
  'ERROR: Failed to create ANGLE OpenGL window.',
];

/** The arguments of a start that needs no window, which the stand-in hands to the real engine. */
const NEEDS_NO_WINDOW = ['--headless', '--version', '--import', '--quit', '--check-only'];

const SOURCE = `import { dlopen, FFIType, ptr } from 'bun:ffi';
const args = process.argv.slice(2);
const real = process.env['${REAL_ENGINE_VARIABLE}'];
if (args.some((arg) => ${JSON.stringify(NEEDS_NO_WINDOW)}.includes(arg))) {
  if (real === undefined) {
    process.exit(1);
  }
  const ran = Bun.spawnSync([real, ...args], { stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
  process.exit(ran.exitCode ?? 1);
}
process.stderr.write(${JSON.stringify(`${NO_RENDERER_LINES.join('\n')}\n`)});
const user32 = dlopen('user32.dll', {
  MessageBoxW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
});
const wide = (text: string) => ptr(Buffer.from(text + '\\0', 'utf16le'));
const taskModal = 0x2030;
user32.symbols.MessageBoxW(null, wide('Your video card drivers seem not to support the required OpenGL 3.3 version or Direct3D 11.'), wide(${JSON.stringify(NO_RENDERER_TITLE)}), taskModal);
`;

let built: string | null = null;

/**
 * A Windows program standing in for Godot on a machine whose GPU is lost. A start that needs no
 * window goes to the engine named by `GDHARNESS_REAL_ENGINE`, so an import and a version read work.
 * A windowed start prints what Godot prints when it cannot create a renderer, and opens the box it
 * opens then, which waits for a press nobody can give on the hidden desktop.
 */
export function rendererLessEngine(): string {
  if (built !== null && existsSync(built)) {
    return built;
  }
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-no-renderer-'));
  const source = join(directory, 'no-renderer.ts');
  const program = join(directory, 'godot-no-renderer.exe');
  writeFileSync(source, SOURCE);
  const compiled = spawnSyncHidden(process.execPath, ['build', '--compile', source, '--outfile', program], {
    encoding: 'utf8',
  });
  if (compiled.status !== 0) {
    throw new Error(`the renderer-less engine did not compile: ${compiled.stdout}${compiled.stderr}`);
  }
  process.once('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A stand-in still running holds its file, so the folder is left for the temp sweep.
    }
  });
  built = program;
  return program;
}
