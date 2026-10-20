/**
 * Starting a process on a Windows desktop of its own, where its windows can neither show nor take
 * the keyboard from the desktop somebody is working on.
 *
 * Downstream, every windowed run put the game on the developer's screen and took the focus from
 * whatever they were typing in, and the owner ruled that development never does that. A window
 * started hidden was measured staying invisible and still taking the focus. A desktop is the
 * boundary Windows keeps focus inside, and an engine on another one still renders: suites there
 * asserted on drawn pixels and passed. Whatever the process starts lands on the same desktop, so an
 * editor started here plays its games here too.
 *
 * Node cannot name a desktop when it starts a process, and the package ships no native code, so the
 * one call that can, CreateProcessW with a desktop in its startup information, is made from C#
 * compiled by the Windows PowerShell every Windows machine has. The compiled assembly is kept in the
 * temporary directory under a name taken from its source, so it is compiled once per machine and
 * version, by the first server to start there.
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

/** The desktop every process started this way shares. */
export const HIDDEN_DESKTOP = 'gdharness';

/**
 * Names the desktop to a process started on one, and to everything it starts: an editor there plays
 * its games there too. Kept in step with `DESKTOP_VARIABLE` in the runtime autoload, which says what
 * a desktop with no pointer does to a game's own reading of the mouse.
 */
export const DESKTOP_VARIABLE = 'GDHARNESS_DESKTOP';

const SOURCE = `using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdharnessDesktop {
  const uint GenericAll = 0x10000000;
  const int UseStdHandles = 0x100;
  const int UseShowWindow = 0x1;
  const short ShowNoActivate = 4;
  // No console at all, rather than a hidden one: a console's host would sit on the desktop too.
  const uint DetachedProcess = 0x00000008;
  const uint Infinite = 0xFFFFFFFF;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb;
    public string reserved;
    public string desktop;
    public string title;
    public int x, y, xSize, ySize, xCount, yCount, fill, flags;
    public short show, reservedSize;
    public IntPtr reservedBytes, input, output, error;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Started {
    public IntPtr process, thread;
    public int processId, threadId;
  }

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr attributes);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out Started started);

  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  const uint FailCriticalErrors = 0x1;
  const uint NoOpenFileErrorBox = 0x8000;

  delegate bool EachWindow(IntPtr window, IntPtr unused);
  [DllImport("user32.dll")] static extern bool EnumWindows(EachWindow each, IntPtr unused);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool LockSetForegroundWindow(uint code);
  const uint LockForeground = 1;
  const uint UnlockForeground = 2;
  const uint TimedOut = 0x102;

  static bool ShowsAWindow(int processId) {
    bool shown = false;
    EnumWindows(delegate(IntPtr window, IntPtr unused) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == (uint)processId && IsWindowVisible(window)) {
        shown = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return shown;
  }

  // Keeps the foreground where it is while the process starts: its own call to take it fails while
  // the foreground is locked, and the user's own Alt+Tab or click still moves it. Released once its
  // window has been showing for a while, since a program takes the foreground as it shows its window
  // and not afterwards, or when it exits, or after two minutes whatever happens.
  static void HoldTheForeground(Started started) {
    DateTime until = DateTime.UtcNow.AddMinutes(2);
    DateTime? shownAt = null;
    while (DateTime.UtcNow < until) {
      if (WaitForSingleObject(started.process, 100) != TimedOut) {
        return;
      }
      if (shownAt == null && ShowsAWindow(started.processId)) {
        shownAt = DateTime.UtcNow;
      }
      if (shownAt != null && DateTime.UtcNow - shownAt.Value > TimeSpan.FromSeconds(10)) {
        return;
      }
    }
  }

  // Starts the command line, both of its streams on this process's output, writes its pid, and
  // waits for it: the answer is its exit code. On the named desktop when there is one, whose handle
  // is held until then, since a desktop goes when the last handle to it does, and on this process's
  // own otherwise. With noActivate its first window is shown without being activated, which is
  // what a program's first ShowWindow does whatever it asks for when the start names a show state,
  // and the foreground is held while it starts, since Godot also asks for it outright. The process
  // is ended through the handle held here once stopFile appears, which is how a keeper ends a game
  // it did not start itself: a handle names one process, where a pid can name the next one too. The
  // process starts in directory rather than in this one's, which is a temporary directory: Windows
  // PowerShell saves its module cache relative to where it runs when the profile does not resolve.
  public static int Run(string desktop, string commandLine, string pidFile, bool noActivate, string stopFile, string directory) {
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    if (desktop.Length > 0) {
      IntPtr held = CreateDesktopW(desktop, IntPtr.Zero, IntPtr.Zero, 0, GenericAll, IntPtr.Zero);
      if (held == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktopW " + desktop);
      }
      startup.desktop = desktop;
    }
    startup.flags = UseStdHandles;
    if (noActivate) {
      startup.flags |= UseShowWindow;
      startup.show = ShowNoActivate;
    }
    startup.input = GetStdHandle(-10);
    startup.output = GetStdHandle(-11);
    startup.error = startup.output;
    Started started;
    // Inherited by what it starts: without SEM_NOGPFAULTERRORBOX, Windows Error Reporting runs when
    // the target crashes and writes its dump, and with the other two no hard-error box can open.
    // Set outright rather than cleared from this process's own: Windows PowerShell changes the mode
    // it inherited as it starts, and was seen reading 0x1 here, without the open-file bit.
    SetErrorMode(FailCriticalErrors | NoOpenFileErrorBox);
    if (noActivate) {
      LockSetForegroundWindow(LockForeground);
    }
    try {
    if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, DetachedProcess, IntPtr.Zero, directory, ref startup, out started)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW " + commandLine);
    }
    File.WriteAllText(pidFile, started.processId.ToString());
    if (noActivate) {
      HoldTheForeground(started);
    }
    } finally {
      if (noActivate) {
        LockSetForegroundWindow(UnlockForeground);
      }
    }
    if (stopFile.Length == 0) {
      WaitForSingleObject(started.process, Infinite);
    } else {
      bool stopped = false;
      while (WaitForSingleObject(started.process, 100) == TimedOut) {
        if (!stopped && File.Exists(stopFile)) {
          TerminateProcess(started.process, 1);
          stopped = true;
        }
      }
    }
    uint code;
    GetExitCodeProcess(started.process, out code);
    CloseHandle(started.thread);
    CloseHandle(started.process);
    return unchecked((int)code);
  }
}
`;

const DIGEST = createHash('sha256').update(SOURCE).digest('hex').slice(0, 16);

/**
 * How long compiling the helper is given. A few seconds as a rule, and over a minute on a loaded CI
 * runner, which is why it is not part of a start's own budget.
 */
const HELPER_COMPILE_MS = 180_000;

/** Where the compiled helper is kept, named after its source, so a changed source compiles anew. */
export function helperAssembly(directory = tmpdir()): string {
  return join(directory, `gdharness-desktop-${DIGEST}.dll`);
}

/**
 * Compiles the helper into [param directory] unless it is there, and answers null once it is, or
 * why it is not. One process compiles at a time: the rest wait for its assembly, or with
 * [param wait] false go on without it, which is what a server starting up does.
 *
 * Apart from any start, because it used to happen inside the first one. The first start on a fresh
 * Windows CI runner compiled for longer than the start was given, the keeper ended the helper with
 * the compile half done, and the next start paid for it again: 35 seconds to a game's announcement
 * where the start after it took five.
 */
export async function ensureHelperCompiled(
  directory = tmpdir(),
  budgetMs = HELPER_COMPILE_MS,
  wait = true,
): Promise<string | null> {
  const assembly = helperAssembly(directory);
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
        return await compileHelper(directory, assembly, until - Date.now());
      } finally {
        rmSync(lock, { force: true });
      }
    }
    // A lock whose process has gone, or older than a whole compile, is one nothing will take down: a
    // server ended mid-compile takes its compiler with it, and its lock would hold every later start
    // for the whole budget.
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
  return `the desktop helper was not compiled within ${String(budgetMs)} ms`;
}

async function compileHelper(directory: string, assembly: string, budgetMs: number): Promise<string | null> {
  const scratch = mkdtempSync(join(directory, 'gdharness-desktop-source-'));
  const source = join(scratch, 'helper.cs');
  writeFileSync(source, SOURCE, 'utf8');
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
            : `Windows PowerShell could not compile it${code === null ? ' in time' : ''}: ${complained.trim() || `exit code ${String(code)}`}`,
        );
      });
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * One argument as the Microsoft C runtime reads it back out of a command line: quoted when it is
 * empty or holds a space, a tab or a quote, with every quote escaped and every run of backslashes
 * before a quote, the closing one included, doubled.
 */
function quoted(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) {
    return argument;
  }
  let text = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    text +=
      character === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${text}${'\\'.repeat(backslashes * 2)}"`;
}

/** The command line CreateProcessW is handed for [param command] and [param args]. */
export function windowsCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoted).join(' ');
}

/** The files a helper is handed and writes, all in a directory of the caller's own. */
export interface HelperFiles {
  /** What to start, read by the helper as it starts. */
  readonly spec: string;
  readonly pid: string;
  readonly error: string;
  /** Empty for a start nothing will be asked to end. */
  readonly stop: string;
}

/**
 * The Windows PowerShell invocation that starts [param command] on [param how]'s desktop, or on the
 * one in use when it names none, shown without activation when it says so; writes its pid to the
 * pid file, waits for it and exits with its code, ending it first if the stop file appears. What
 * stops it before the pid is written goes to the error file, since its own streams are the ones the
 * process inherits. The process starts in [param how]'s directory, which the helper is not run in.
 *
 * The spec goes in a file rather than on the command line. A long command line in base64 of the JSON
 * inside base64 of the script passed Windows' limit of 32767 characters on a command line: a keeper
 * starting a long command on a desktop of its own failed with ENAMETOOLONG before anything started.
 *
 * [param assembly] is the compiled helper, which {@link ensureHelperCompiled} makes first: loading
 * it is all this does, so the start's own time is spent on the start.
 */
export function throughHelper(
  how: { readonly desktop?: string; readonly noActivate?: boolean; readonly directory: string },
  command: string,
  args: readonly string[],
  files: HelperFiles,
  assembly = helperAssembly(),
): { command: string; args: string[] } {
  const spec = {
    desktop: how.desktop ?? '',
    noActivate: how.noActivate === true,
    commandLine: windowsCommandLine(command, args),
    pidFile: files.pid,
    stopFile: files.stop,
    directory: how.directory,
    assembly,
  };
  writeFileSync(files.spec, JSON.stringify(spec), 'utf8');
  const literal = (path: string): string => `'${path.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $spec = [IO.File]::ReadAllText(${literal(files.spec)}, [Text.Encoding]::UTF8) | ConvertFrom-Json`,
    '  Add-Type -LiteralPath $spec.assembly',
    '  $code = [GdharnessDesktop]::Run($spec.desktop, $spec.commandLine, $spec.pidFile, [bool]$spec.noActivate, $spec.stopFile, $spec.directory)',
    '} catch {',
    `  [IO.File]::WriteAllText(${literal(files.error)}, $_.Exception.Message)`,
    '  exit 1',
    '}',
    'exit $code',
  ].join('\n');
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
  };
}
