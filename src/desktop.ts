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
 * The desktop is made in the logon session's non-interactive window station rather than in the one
 * the user works in. A desktop keeps the focus to itself but shares its window station's cursor: a
 * game run on a desktop of the user's station held the user's real pointer to one monitor while it
 * ran, because ClipCursor confines the station's one cursor whatever desktop asks. Windows refuses
 * ClipCursor, SetCursorPos and GetCursorPos to a process in a non-interactive station, so nothing a
 * game, its add-ons or a driver loaded into it calls can reach the user's pointer, and engines still
 * render there. A non-admin user cannot make a named station, but asking for one with no name opens
 * the session's own, which every such request in the session shares.
 *
 * Node cannot name a desktop when it starts a process, and the package ships no native code, so the
 * one call that can, CreateProcessW with a desktop in its startup information, is made from C# (see
 * `compiled-helper.ts`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CompiledHelper, HELPER_COMPILE_MS } from './compiled-helper.js';
import { mendBeforeStart } from './uid-cache.js';

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
  static extern IntPtr CreateDesktopExW(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr attributes, uint heapKilobytes, IntPtr reserved);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, IntPtr attributes);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessWindowStation(IntPtr station);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder into, int size, out int needed);
  const uint WindowStationAllAccess = 0x37F;
  const int ObjectName = 2;
  // What Windows gives an interactive desktop. A non-interactive station's desktops get a small
  // fraction of that by default, and one desktop here holds every engine a run starts.
  const uint DesktopHeapKilobytes = 20480;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out Started started);

  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessAffinityMask(IntPtr process, UIntPtr mask);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  const uint CreateSuspended = 0x4;
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
  // The spec is one field a line, each base64 of its UTF-8, read with no PowerShell cmdlet: a cmdlet
  // has PowerShell prepare its modules first, on every start.
  public static int RunSpec(string specFile) {
    string[] lines = File.ReadAllLines(specFile);
    Func<int, string> field = delegate(int index) { return Encoding.UTF8.GetString(Convert.FromBase64String(lines[index])); };
    string affinity = lines.Length > 7 ? field(7) : "";
    return Run(field(0), field(1), field(2), field(3) == "1", field(4), field(5), field(6), affinity.Length == 0 ? 0UL : ulong.Parse(affinity));
  }

  static void Step(string stepFile, string step) {
    if (stepFile.Length > 0) {
      File.WriteAllText(stepFile, step);
    }
  }

  // With an affinity, the process starts suspended and is held to those processors before its
  // first thread runs, so every thread it starts afterwards is held to them as well.
  public static int Run(string desktop, string commandLine, string pidFile, bool noActivate, string stopFile, string directory, string stepFile, ulong affinity) {
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    if (desktop.Length > 0) {
      Step(stepFile, "opening the session's own window station");
      IntPtr station = CreateWindowStationW(null, 0, WindowStationAllAccess, IntPtr.Zero);
      if (station == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateWindowStationW");
      }
      StringBuilder stationName = new StringBuilder(256);
      int needed;
      if (!GetUserObjectInformationW(station, ObjectName, stationName, stationName.Capacity * 2, out needed)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "GetUserObjectInformationW");
      }
      // A desktop is made in the calling process's station, so this one is the caller's while it is.
      IntPtr own = GetProcessWindowStation();
      if (!SetProcessWindowStation(station)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "SetProcessWindowStation");
      }
      IntPtr held;
      int made;
      try {
        Step(stepFile, "creating the " + desktop + " desktop");
        held = CreateDesktopExW(desktop, IntPtr.Zero, IntPtr.Zero, 0, GenericAll, IntPtr.Zero, DesktopHeapKilobytes, IntPtr.Zero);
        made = Marshal.GetLastWin32Error();
      } finally {
        SetProcessWindowStation(own);
      }
      if (held == IntPtr.Zero) {
        throw new Win32Exception(made, "CreateDesktopExW " + stationName + "\\\\" + desktop);
      }
      startup.desktop = stationName + "\\\\" + desktop;
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
    Step(stepFile, "starting the process");
    uint creation = DetachedProcess | (affinity == 0 ? 0u : CreateSuspended);
    if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, creation, IntPtr.Zero, directory, ref startup, out started)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW " + commandLine);
    }
    if (affinity != 0) {
      Step(stepFile, "holding the process to its processors");
      if (!SetProcessAffinityMask(started.process, new UIntPtr(affinity))) {
        int error = Marshal.GetLastWin32Error();
        TerminateProcess(started.process, 1);
        throw new Win32Exception(error, "SetProcessAffinityMask " + affinity);
      }
      ResumeThread(started.thread);
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

const HELPER = new CompiledHelper('desktop helper', 'gdharness-desktop', SOURCE);

/** Where the compiled desktop helper is kept, named after its source. */
export function helperAssembly(directory = tmpdir()): string {
  return HELPER.assembly(directory);
}

/** Compiles the desktop helper unless it is there; see [method CompiledHelper.ensure]. */
export function ensureHelperCompiled(
  directory = tmpdir(),
  budgetMs = HELPER_COMPILE_MS,
  wait = true,
): Promise<string | null> {
  return HELPER.ensure(directory, budgetMs, wait);
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

/** What the helper wrote to [param file] on failing, or null when it wrote nothing there. */
export function helperFailure(file: string): string | null {
  try {
    const said = readFileSync(file, 'utf8').trim();
    return said === '' ? null : said;
  } catch {
    return null;
  }
}

/** The files a helper is handed and writes, all in a directory of the caller's own. */
export interface HelperFiles {
  /** What to start, read by the helper as it starts. */
  readonly spec: string;
  readonly pid: string;
  readonly error: string;
  /** Empty for a start nothing will be asked to end. */
  readonly stop: string;
  /** The step the helper last reached, which a start that waited in vain reads with `helperStep`. */
  readonly step: string;
}

/**
 * Where the helper behind [param stepFile] stood, as a clause: a start waiting for its pid in vain
 * otherwise said only that it waited, and a Windows CI runner's one such minute left nothing behind
 * to say which step took it.
 */
export function helperStep(stepFile: string): string {
  let step: string | null = null;
  try {
    step = readFileSync(stepFile, 'utf8').trim();
  } catch {
    // Never written: the helper's script had not begun.
  }
  return step === null || step === ''
    ? 'Windows PowerShell had not begun running the helper'
    : `the helper was ${step}`;
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
 *
 * The script calls no cmdlet. ConvertFrom-Json and Add-Type had Windows PowerShell prepare its
 * modules on every start, measured at 60 to 200 ms on a machine with few of them, and a start on a
 * Windows CI runner, whose module path is large, waited a minute for a pid that never came.
 */
export function throughHelper(
  how: {
    readonly desktop?: string;
    readonly noActivate?: boolean;
    readonly directory: string;
    /** The processors the process is held to, one bit each, or none for every processor. */
    readonly affinity?: bigint;
  },
  command: string,
  args: readonly string[],
  files: HelperFiles,
  assembly = helperAssembly(),
): { command: string; args: string[] } {
  // The helper is what is spawned, with the engine's command line in a file it reads.
  mendBeforeStart(args, how.directory);
  const fields = [
    how.desktop ?? '',
    windowsCommandLine(command, args),
    files.pid,
    how.noActivate === true ? '1' : '0',
    files.stop,
    how.directory,
    files.step,
    how.affinity === undefined ? '' : how.affinity.toString(),
  ];
  writeFileSync(
    files.spec,
    fields.map((field) => Buffer.from(field, 'utf8').toString('base64')).join('\n'),
    'utf8',
  );
  const literal = (path: string): string => `'${path.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  [IO.File]::WriteAllText(${literal(files.step)}, 'loading its assembly')`,
    `  $null = [Reflection.Assembly]::LoadFrom(${literal(assembly)})`,
    `  $code = [GdharnessDesktop]::RunSpec(${literal(files.spec)})`,
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
