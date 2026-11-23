/**
 * C# compiled by the Windows PowerShell every Windows machine has, for the few Windows calls Node
 * cannot make and the package ships no native code for. The compiled assembly is kept under a name
 * taken from its source, so a changed source compiles anew. A helper the package ships is compiled
 * once per user and source, into the user's cache, and each directory that asks for it gets a copy.
 * A compile costs about 0.7 s of processor time, which a process given a temporary directory of its
 * own would otherwise pay again. Any other helper, and a shipped one whose cache cannot be used, is
 * compiled in the directory that asks.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { cacheHome } from './cache-home.js';
import { errorCode, errorMessage } from './errors.js';
import { spawnHidden } from './spawn.js';

/** The folder of the user's cache that holds each source's compiled assembly. */
const HELPER_STORE = 'helpers';

/**
 * The end of the name of the file beside a cached assembly that holds the assembly's SHA-256. A
 * cached assembly whose bytes do not match it, or that has none, is not used.
 */
const DIGEST_SUFFIX = '.sha256';

/** How a helper is compiled. */
export interface HelperKind {
  /** Compiled as a console program, run as itself, rather than a library a Windows PowerShell loads. */
  readonly program?: boolean;
  /** Kept in the user's cache, for a helper the package ships. A source built per run stays out. */
  readonly cached?: boolean;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Writes [param bytes] to [param path] whole: into a file of this process's beside it, then renamed
 * into place, so nothing reads a part of it.
 */
function writeWhole(path: string, bytes: Buffer | string): void {
  const dot = path.lastIndexOf('.');
  const partial = `${path.slice(0, dot)}.${String(process.pid)}.copy${path.slice(dot)}`;
  try {
    writeFileSync(partial, bytes);
    renameSync(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
}

/** The cached assembly at [param path], read once, or undefined unless its bytes match its digest. */
function wholeAssembly(path: string): Buffer | undefined {
  try {
    const bytes = readFileSync(path);
    return readFileSync(`${path}${DIGEST_SUFFIX}`, 'utf8').trim() === sha256(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replaces the cached assembly at [param stored] with the one compiled at [param compiled], and its
 * digest after it. Nothing runs or loads a cached assembly in place, and a rename either leaves a
 * process reading the old file with that file or is refused. Left as it is where that fails.
 */
function replaceStored(stored: string, compiled: string): void {
  try {
    const bytes = readFileSync(compiled);
    writeWhole(stored, bytes);
    writeWhole(`${stored}${DIGEST_SUFFIX}`, sha256(bytes));
  } catch {
    // The next process to ask finds it still bad and compiles in its own directory.
  }
}

/**
 * How long compiling is given. A few seconds as a rule, and over a minute on a loaded CI runner,
 * which is why it is not part of the budget of whatever needs it.
 */
export const HELPER_COMPILE_MS = 180_000;

/** Takes the compile lock at [param lock], or says who has it or why it cannot be taken. */
function claimLock(lock: string): 'mine' | 'taken' | { refused: string } {
  try {
    const held = openSync(lock, 'wx');
    writeSync(held, String(process.pid));
    closeSync(held);
    return 'mine';
  } catch (error) {
    // Only an existing lock means another process is compiling it. Anything else, such as a
    // folder that is not there, would otherwise wait out the whole budget with nothing tried.
    return errorCode(error) === 'EEXIST' ? 'taken' : { refused: errorMessage(error) };
  }
}

/**
 * Removes a lock whose process has gone, or older than a whole compile, and says whether it did.
 * Nothing else takes such a lock down: a process ended mid-compile takes its compiler with it, and
 * its lock would hold every later one for the whole budget.
 */
function removedDeadLock(lock: string, budgetMs: number): boolean {
  try {
    const holder = Number(readFileSync(lock, 'utf8').trim());
    const old = Date.now() - statSync(lock).mtimeMs > budgetMs;
    if (old || (Number.isInteger(holder) && holder > 0 && !alive(holder))) {
      rmSync(lock, { force: true });
      return true;
    }
  } catch {
    // Gone between the reads, which is the compile finishing.
  }
  return false;
}

/** One C# source compiled on demand, and where its assembly is kept. */
export class CompiledHelper {
  private readonly named: string;
  private readonly file: string;
  private readonly source: string;
  private readonly digest: string;
  private readonly program: boolean;
  private readonly cached: boolean;

  /** [param named] is how a failure names it, [param file] the start of its assembly's name. */
  constructor(named: string, file: string, source: string, kind: HelperKind = {}) {
    this.named = named;
    this.file = file;
    this.source = source;
    this.program = kind.program ?? false;
    this.cached = kind.cached ?? false;
    this.digest = sha256(source).slice(0, 16);
  }

  /** Where the compiled assembly is kept, named after its source, so a changed source compiles anew. */
  assembly(directory = tmpdir()): string {
    return join(directory, `${this.file}-${this.digest}.${this.program ? 'exe' : 'dll'}`);
  }

  /**
   * Puts the assembly into [param directory] unless it is there, from the user's cache or by
   * compiling, and answers null once it is, or why it is not. One process does so at a time: the
   * rest wait for its assembly, or with [param wait] false go on without it, which is what a server
   * starting up does.
   *
   * Apart from whatever needs it, because the desktop helper used to be compiled inside the first
   * start. The first start on a fresh Windows CI runner compiled for longer than the start was
   * given, the keeper ended the helper with the compile half done, and the next start paid for it
   * again: 35 seconds to a game's announcement where the start after it took five.
   */
  async ensure(directory = tmpdir(), budgetMs = HELPER_COMPILE_MS, wait = true): Promise<string | null> {
    if (!isAbsolute(directory)) {
      return `the ${this.named} cannot be compiled into ${directory}, which is not an absolute folder`;
    }
    const assembly = this.assembly(directory);
    const lock = `${assembly}.compiling`;
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      if (existsSync(assembly)) {
        return null;
      }
      const claim = claimLock(lock);
      if (claim === 'mine') {
        try {
          return await this.compile(directory, assembly, until - Date.now());
        } finally {
          rmSync(lock, { force: true });
        }
      }
      if (claim !== 'taken') {
        return `the ${this.named} cannot be compiled into ${directory}: ${claim.refused}`;
      }
      if (removedDeadLock(lock, budgetMs)) {
        continue;
      }
      if (!wait) {
        return null;
      }
      await delay(200);
    }
    return `the ${this.named} was not compiled within ${String(budgetMs)} ms`;
  }

  /**
   * Puts the assembly at [param assembly]. A cached helper gets a copy of the one the user's cache
   * keeps for this source, compiled there first if it is not. A copy, so a program run from
   * [param directory] is its own file. Where the cache cannot be used, or holds an assembly whose
   * bytes are not the ones compiled there, the assembly is compiled in [param directory], and a bad
   * one in the cache is replaced with it.
   */
  private async compile(directory: string, assembly: string, budgetMs: number): Promise<string | null> {
    const until = Date.now() + budgetMs;
    const store = join(cacheHome(), HELPER_STORE);
    if (!this.cached) {
      return await this.compileIn(directory, assembly, budgetMs);
    }
    if (directory === store) {
      const failed = await this.compileIn(directory, assembly, budgetMs);
      if (failed === null) {
        writeWhole(`${assembly}${DIGEST_SUFFIX}`, sha256(readFileSync(assembly)));
      }
      return failed;
    }
    let bad = false;
    try {
      mkdirSync(store, { recursive: true });
      if ((await this.ensure(store, budgetMs)) === null) {
        const stored = wholeAssembly(this.assembly(store));
        if (stored !== undefined) {
          writeWhole(assembly, stored);
          return null;
        }
        bad = true;
      }
    } catch {
      // A cache that cannot be written or read leaves the compile in the directory asked for.
    }
    const failed = await this.compileIn(directory, assembly, Math.max(until - Date.now(), 1));
    if (failed === null && bad) {
      replaceStored(this.assembly(store), assembly);
    }
    return failed;
  }

  private async compileIn(directory: string, assembly: string, budgetMs: number): Promise<string | null> {
    const scratch = mkdtempSync(join(directory, `${this.file}-source-`));
    const source = join(scratch, 'helper.cs');
    writeFileSync(source, this.source, 'utf8');
    const literal = (path: string): string => `'${path.replaceAll("'", "''")}'`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      // The extension kept last, since the compiler names a console program by its output path.
      `  $partial = ${literal(assembly.slice(0, -4))} + '.' + $PID + ${literal(assembly.slice(-4))}`,
      `  Add-Type -TypeDefinition ([IO.File]::ReadAllText(${literal(source)}, [Text.Encoding]::UTF8)) -OutputAssembly $partial${this.program ? ' -OutputType ConsoleApplication' : ''}`,
      `  Move-Item -LiteralPath $partial -Destination ${literal(assembly)}`,
      '} catch {',
      '  [Console]::Error.WriteLine($_.Exception.Message)',
      '  exit 1',
      '}',
    ].join('\n');
    try {
      return await new Promise<string | null>((resolve) => {
        const compiler = spawnHidden(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let complained = '';
        compiler.stderr.on('data', (chunk: Buffer) => {
          complained += chunk.toString();
        });
        const timer = setTimeout(() => {
          compiler.kill();
        }, budgetMs);
        compiler.once('error', (error: Error) => {
          clearTimeout(timer);
          resolve(`Windows PowerShell did not start: ${error.message}`);
        });
        compiler.once('close', (code) => {
          clearTimeout(timer);
          resolve(
            existsSync(assembly)
              ? null
              : `Windows PowerShell could not compile the ${this.named}${code === null ? ' in time' : ''}: ${complained.trim() || `exit code ${String(code)}`}`,
          );
        });
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
