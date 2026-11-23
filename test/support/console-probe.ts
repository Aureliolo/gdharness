import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompiledHelper } from '../../src/compiled-helper.js';

/**
 * A console program that starts nothing. It writes JSON to the file its first argument names:
 * whether it has a console at all (GetConsoleProcessList counts a process in it) and whether that
 * console has a window (GetConsoleWindow). A process started without a console has none, and one
 * started with a console and no window has the first and not the second, so a start's flags are
 * read here without any window ever being opened.
 */
const SOURCE = `using System;
using System.IO;
using System.Runtime.InteropServices;
public static class ConsoleProbe {
  [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] list, uint count);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  public static int Main(string[] args) {
    uint[] list = new uint[16];
    uint count = GetConsoleProcessList(list, (uint)list.Length);
    bool window = GetConsoleWindow() != IntPtr.Zero;
    File.WriteAllText(args[0], "{\\"console\\": " + (count > 0 ? "true" : "false") + ", \\"window\\": " + (window ? "true" : "false") + "}");
    return 0;
  }
}
`;

let built: string | null = null;

/** The compiled probe's path. */
export async function consoleProbe(): Promise<string> {
  if (built !== null) {
    return built;
  }
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-console-probe-'));
  const helper = new CompiledHelper('console probe', 'gdharness-console-probe', SOURCE, { program: true });
  const failed = await helper.ensure(directory);
  if (failed !== null) {
    throw new Error(`the console probe is not compiled: ${failed}`);
  }
  process.once('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Left for the temp sweep.
    }
  });
  built = helper.assembly(directory);
  return built;
}
