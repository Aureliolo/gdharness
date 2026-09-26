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

/** The desktop every process started this way shares. */
export const HIDDEN_DESKTOP = 'gdharness';

const SOURCE = `using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class GdharnessDesktop {
  const uint GenericAll = 0x10000000;
  const int UseStdHandles = 0x100;
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

  // Starts the command line on the named desktop, both of its streams on this process's output,
  // writes its pid, and waits for it: the answer is its exit code. The desktop's handle is held until then, since a
  // desktop goes when the last handle to it does.
  public static int Run(string desktop, string commandLine, string pidFile) {
    IntPtr held = CreateDesktopW(desktop, IntPtr.Zero, IntPtr.Zero, 0, GenericAll, IntPtr.Zero);
    if (held == IntPtr.Zero) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktopW " + desktop);
    }
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.desktop = desktop;
    startup.flags = UseStdHandles;
    startup.input = GetStdHandle(-10);
    startup.output = GetStdHandle(-11);
    startup.error = startup.output;
    Started started;
    if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, DetachedProcess, IntPtr.Zero, null, ref startup, out started)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW " + commandLine);
    }
    File.WriteAllText(pidFile, started.processId.ToString());
    WaitForSingleObject(started.process, Infinite);
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

/**
 * The Windows PowerShell invocation that starts [param command] on [param desktop], writes its pid
 * to [param pidFile], waits for it and exits with its code. What stops it before the pid is written
 * goes to [param errorFile], since its own streams are the ones the process inherits.
 */
export function onDesktop(
  desktop: string,
  command: string,
  args: readonly string[],
  pidFile: string,
  errorFile: string,
): { command: string; args: string[] } {
  const spec = {
    desktop,
    commandLine: windowsCommandLine(command, args),
    pidFile,
    errorFile,
    source: SOURCE,
    digest: createHash('sha256').update(SOURCE).digest('hex').slice(0, 16),
  };
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json`,
    'try {',
    "  $assembly = Join-Path ([IO.Path]::GetTempPath()) ('gdharness-desktop-' + $spec.digest + '.dll')",
    '  if (-not (Test-Path -LiteralPath $assembly)) {',
    '    $partial = "$assembly.$PID"',
    '    Add-Type -TypeDefinition $spec.source -OutputAssembly $partial',
    '    try { Move-Item -LiteralPath $partial -Destination $assembly } catch { Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue }',
    '  }',
    '  Add-Type -LiteralPath $assembly',
    '  $code = [GdharnessDesktop]::Run($spec.desktop, $spec.commandLine, $spec.pidFile)',
    '} catch {',
    '  [IO.File]::WriteAllText($spec.errorFile, $_.Exception.Message)',
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
