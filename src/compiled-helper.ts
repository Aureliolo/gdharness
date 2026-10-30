/**
 * C# compiled by the Windows PowerShell every Windows machine has, for the few Windows calls Node
 * cannot make and the package ships no native code for. The compiled assembly is kept in the
 * temporary directory under a name taken from its source, so it is compiled once per machine and
 * version, by the first process to need it.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { spawnHidden } from './spawn.js';

/**
 * How long compiling is given. A few seconds as a rule, and over a minute on a loaded CI runner,
 * which is why it is not part of the budget of whatever needs it.
 */
export const HELPER_COMPILE_MS = 180_000;

/** One C# source compiled on demand, and where its assembly is kept. */
export class CompiledHelper {
  private readonly named: string;
  private readonly file: string;
  private readonly source: string;
  private readonly digest: string;

  /** [param named] is how a failure names it, [param file] the start of its assembly's name. */
  constructor(named: string, file: string, source: string) {
    this.named = named;
    this.file = file;
    this.source = source;
    this.digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  }

  /** Where the compiled assembly is kept, named after its source, so a changed source compiles anew. */
  assembly(directory = tmpdir()): string {
    return join(directory, `${this.file}-${this.digest}.dll`);
  }

  /**
   * Compiles the source into [param directory] unless it is there, and answers null once it is, or
   * why it is not. One process compiles at a time: the rest wait for its assembly, or with
   * [param wait] false go on without it, which is what a server starting up does.
   *
   * Apart from whatever needs it, because the desktop helper used to be compiled inside the first
   * start. The first start on a fresh Windows CI runner compiled for longer than the start was
   * given, the keeper ended the helper with the compile half done, and the next start paid for it
   * again: 35 seconds to a game's announcement where the start after it took five.
   */
  async ensure(directory = tmpdir(), budgetMs = HELPER_COMPILE_MS, wait = true): Promise<string | null> {
    const assembly = this.assembly(directory);
    const lock = `${assembly}.compiling`;
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      if (existsSync(assembly)) {
        return null;
      }
      let mine = false;
      try {
        const held = openSync(lock, 'wx');
        writeSync(held, String(process.pid));
        closeSync(held);
        mine = true;
      } catch {
        // Another process is compiling it.
      }
      if (mine) {
        try {
          return await this.compile(directory, assembly, until - Date.now());
        } finally {
          rmSync(lock, { force: true });
        }
      }
      // A lock whose process has gone, or older than a whole compile, is one nothing will take down:
      // a process ended mid-compile takes its compiler with it, and its lock would hold every later
      // one for the whole budget.
      try {
        const holder = Number(readFileSync(lock, 'utf8').trim());
        const old = Date.now() - statSync(lock).mtimeMs > budgetMs;
        if (old || (Number.isInteger(holder) && holder > 0 && !alive(holder))) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        // Gone between the reads, which is the compile finishing.
      }
      if (!wait) {
        return null;
      }
      await delay(200);
    }
    return `the ${this.named} was not compiled within ${String(budgetMs)} ms`;
  }

  private async compile(directory: string, assembly: string, budgetMs: number): Promise<string | null> {
    const scratch = mkdtempSync(join(directory, `${this.file}-source-`));
    const source = join(scratch, 'helper.cs');
    writeFileSync(source, this.source, 'utf8');
    const literal = (path: string): string => `'${path.replaceAll("'", "''")}'`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  $partial = ${literal(assembly)} + '.' + $PID`,
      `  Add-Type -TypeDefinition ([IO.File]::ReadAllText(${literal(source)}, [Text.Encoding]::UTF8)) -OutputAssembly $partial`,
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
