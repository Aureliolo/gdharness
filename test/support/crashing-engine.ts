import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompiledHelper } from '../../src/compiled-helper.js';

/** The first line Godot prints, as the stand-in prints it. */
export const ENGINE_BANNER_LINE = 'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org';

/**
 * C# rather than a Bun program, since Bun keeps only the low byte of an exit code and the status of
 * the race is a whole one. The one start it makes passes `CreateNoWindow`.
 */
const SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
public static class CrashingEngine {
  static string Env(string name) { return Environment.GetEnvironmentVariable(name) ?? ""; }
  static string Quoted(string[] args) {
    StringBuilder line = new StringBuilder();
    foreach (string arg in args) {
      if (line.Length > 0) { line.Append(" "); }
      bool plain = arg.Length > 0 && arg.IndexOf(' ') < 0 && arg.IndexOf('"') < 0;
      line.Append(plain ? arg : "\\"" + arg.Replace("\\"", "\\\\\\"") + "\\"");
    }
    return line.ToString();
  }
  static int Real(string[] args) {
    ProcessStartInfo info = new ProcessStartInfo(Env("GDH_REAL_ENGINE"), Quoted(args));
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.RedirectStandardOutput = true;
    info.RedirectStandardError = true;
    using (Process engine = Process.Start(info)) {
      engine.OutputDataReceived += delegate (object sender, DataReceivedEventArgs line) { if (line.Data != null) { Console.Out.WriteLine(line.Data); Console.Out.Flush(); } };
      engine.ErrorDataReceived += delegate (object sender, DataReceivedEventArgs line) { if (line.Data != null) { Console.Error.WriteLine(line.Data); Console.Error.Flush(); } };
      engine.BeginOutputReadLine();
      engine.BeginErrorReadLine();
      engine.WaitForExit();
      return engine.ExitCode;
    }
  }
  static string Arg(string[] args, string name) {
    int at = Array.IndexOf(args, name);
    return at >= 0 && at + 1 < args.Length ? args[at + 1] : "";
  }
  static System.Net.Sockets.TcpClient peer;
  static void Dial(string marker, string address) {
    string[] parts = address.Split(':');
    try {
      peer = new System.Net.Sockets.TcpClient(parts[0], int.Parse(parts[1]));
      File.AppendAllText(marker + ".debug", "connected\\n");
    } catch (Exception) {
      File.AppendAllText(marker + ".debug", "refused\\n");
    }
  }
  static void Banner(string[] args, string banner) {
    string said = Env("GDH_BLANK") != "" ? "" : banner;
    Console.Out.Write(said + "\\n");
    Console.Out.Flush();
    string log = Arg(args, "--log-file");
    if (log != "") { File.AppendAllText(log, said + "\\n"); }
    if (Env("GDH_CHATTY") != "") {
      Console.Out.Write("ready\\n");
      Console.Out.Flush();
      if (log != "") { File.AppendAllText(log, "ready\\n"); }
    }
  }
  public static int Main(string[] args) {
    string banner = ${JSON.stringify(ENGINE_BANNER_LINE)};
    string marker = Env("GDH_CRASH_MARKER");
    if (Array.IndexOf(args, "--version") >= 0) {
      if (Env("GDH_REAL_ENGINE") != "") { return Real(args); }
      Console.Out.Write("4.7.2.stable.official.ed1daf0bf\\n");
      return 0;
    }
    string asked = string.Join(" ", args);
    if (marker != "") { File.AppendAllText(marker + ".log", asked + "\\n"); }
    string debug = Arg(args, "--remote-debug");
    if (marker != "" && debug.StartsWith("tcp://") && Env("GDH_REAL_ENGINE") == "") { Dial(marker, debug.Substring(6)); }
    if (marker != "" && asked.Contains(Env("GDH_CRASH_WHEN")) && !File.Exists(marker)) {
      File.WriteAllText(marker, "");
      Banner(args, banner);
      return unchecked((int)UInt32.Parse(Env("GDH_CRASH_STATUS") == "" ? "3228369023" : Env("GDH_CRASH_STATUS")));
    }
    if (Env("GDH_REAL_ENGINE") != "") { return Real(args); }
    Banner(args, banner);
    // Only a start that asked to be held, so the engine runs the editor makes for itself end at once.
    if (Env("GDH_HOLD") != "" && asked.Contains(Env("GDH_CRASH_WHEN"))) { Thread.Sleep(120000); }
    return 0;
  }
}
`;

/** The source the check of hidden starts reads. */
export const CRASHING_ENGINE_SOURCE = SOURCE;

let built: string | null = null;

/**
 * A program standing in for the engine, started in place of it. The first start whose arguments
 * hold GDH_CRASH_WHEN prints the banner and exits with GDH_CRASH_STATUS, which defaults to
 * 0xC06D007F. Every start is noted in GDH_CRASH_MARKER's log. Any other start hands its arguments to
 * GDH_REAL_ENGINE where that is set, or prints the banner and ends, or with GDH_HOLD stays up. With
 * GDH_CHATTY it prints a line past the banner.
 * `--version` is the real engine's answer, or a Godot version.
 */
export async function crashingEngine(): Promise<string> {
  if (built !== null) {
    return built;
  }
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-crashing-engine-'));
  const helper = new CompiledHelper('crashing engine', 'godot-crashing', SOURCE, true);
  const failed = await helper.ensure(directory);
  if (failed !== null) {
    throw new Error(`the crashing engine is not compiled: ${failed}`);
  }
  process.once('exit', () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A stand-in still running holds its file, so the folder is left for the temp sweep.
    }
  });
  built = helper.assembly(directory);
  return built;
}
