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
 * temporary directory under a name taken from its source, so a launch compiles only the first time.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

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
  // it did not start itself: a handle names one process, where a pid can name the next one too.
  public static int Run(string desktop, string commandLine, string pidFile, bool noActivate, string stopFile) {
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
    if (noActivate) {
      LockSetForegroundWindow(LockForeground);
    }
    try {
    if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, DetachedProcess, IntPtr.Zero, null, ref startup, out started)) {
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
  /** What to start and the helper's own source, read by the helper as it starts. */
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
 * process inherits.
 *
 * The spec goes in a file rather than on the command line. It carries the helper's C# source and the
 * command line to start, and base64 of the JSON inside base64 of the script passed Windows' limit
 * of 32767 characters on a command line: a keeper starting a long command on a desktop of its own
 * failed with ENAMETOOLONG before anything started.
 */
export function throughHelper(
  how: { readonly desktop?: string; readonly noActivate?: boolean },
  command: string,
  args: readonly string[],
  files: HelperFiles,
): { command: string; args: string[] } {
  const spec = {
    desktop: how.desktop ?? '',
    noActivate: how.noActivate === true,
    commandLine: windowsCommandLine(command, args),
    pidFile: files.pid,
    stopFile: files.stop,
    source: SOURCE,
    digest: createHash('sha256').update(SOURCE).digest('hex').slice(0, 16),
  };
  writeFileSync(files.spec, JSON.stringify(spec), 'utf8');
  const literal = (path: string): string => `'${path.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $spec = [IO.File]::ReadAllText(${literal(files.spec)}, [Text.Encoding]::UTF8) | ConvertFrom-Json`,
    "  $assembly = Join-Path ([IO.Path]::GetTempPath()) ('gdharness-desktop-' + $spec.digest + '.dll')",
    '  if (-not (Test-Path -LiteralPath $assembly)) {',
    '    $partial = "$assembly.$PID"',
    '    Add-Type -TypeDefinition $spec.source -OutputAssembly $partial',
    '    try { Move-Item -LiteralPath $partial -Destination $assembly } catch { Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue }',
    '  }',
    '  Add-Type -LiteralPath $assembly',
    '  $code = [GdharnessDesktop]::Run($spec.desktop, $spec.commandLine, $spec.pidFile, [bool]$spec.noActivate, $spec.stopFile)',
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
