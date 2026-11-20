import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CompiledHelper } from '../../src/compiled-helper.js';
import { errorMessage } from '../../src/errors.js';
import { spawnHidden } from '../../src/spawn.js';

/**
 * A console program that samples one thread's call stack, since Windows has no /proc to read a
 * thread's state from. Every interval it suspends the process's first thread, walks its stack with
 * dbghelp and appends one line: the time, the thread's user and kernel time so far in 100 ns
 * units, and its frames from the innermost out. A file named as the output plus `.ask` has it walk
 * every thread once into the output plus `.threads`.
 *
 * A frame in a system library is named by its export, which dbghelp reads without symbols. A frame
 * in the program itself is named by its offset from the image base, since the official engine
 * ships stripped and its debug symbols, where published, are DWARF that dbghelp cannot read.
 *
 * C# 5, since Add-Type in Windows PowerShell compiles with the .NET Framework's compiler.
 */
const SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class StackSampler {
  const uint ProcessAccess = 0x0400 | 0x0010;
  const uint ThreadAccess = 0x0008 | 0x0002 | 0x0040;
  const uint SnapThreads = 0x4;
  const int ContextFull = 0x10000B;
  const uint Amd64 = 0x8664;
  const int ContextSize = 1232;
  const int FrameSize = 264;
  const int MostFrames = 96;
  const uint StillActive = 259;

  [StructLayout(LayoutKind.Sequential)]
  struct ThreadEntry {
    public uint Size;
    public uint Usage;
    public uint ThreadId;
    public uint OwnerProcessId;
    public int BasePriority;
    public int DeltaPriority;
    public uint Flags;
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll")] static extern bool Thread32First(IntPtr snapshot, ref ThreadEntry entry);
  [DllImport("kernel32.dll")] static extern bool Thread32Next(IntPtr snapshot, ref ThreadEntry entry);
  [DllImport("kernel32.dll")] static extern uint SuspendThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool GetThreadContext(IntPtr thread, IntPtr context);
  [DllImport("kernel32.dll")] static extern bool GetThreadTimes(IntPtr thread, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetModuleBaseName(IntPtr process, IntPtr module, StringBuilder name, uint size);
  [DllImport("dbghelp.dll", SetLastError = true)] static extern bool SymInitialize(IntPtr process, string path, bool invade);
  [DllImport("dbghelp.dll")] static extern uint SymSetOptions(uint options);
  [DllImport("dbghelp.dll")] static extern bool SymRefreshModuleList(IntPtr process);
  [DllImport("dbghelp.dll")] static extern ulong SymGetModuleBase64(IntPtr process, ulong address);
  [DllImport("dbghelp.dll")] static extern bool SymFromAddr(IntPtr process, ulong address, out ulong displacement, IntPtr symbol);
  [DllImport("dbghelp.dll")] static extern bool StackWalk64(uint machine, IntPtr process, IntPtr thread, IntPtr frame, IntPtr context, IntPtr readMemory, IntPtr tableAccess, IntPtr moduleBase, IntPtr translate);

  static IntPtr process;
  static IntPtr tableAccess;
  static IntPtr moduleBase;
  static IntPtr symbol;
  static readonly Dictionary<ulong, string> modules = new Dictionary<ulong, string>();

  public static int Main(string[] args) {
    int pid = int.Parse(args[0]);
    string output = args[1];
    int interval = int.Parse(args[2]);
    using (StreamWriter writer = new StreamWriter(output, true)) {
      writer.AutoFlush = true;
      try {
        return Sample(pid, output, interval, writer);
      } catch (Exception failure) {
        writer.WriteLine("failed|" + failure.Message.Replace("|", "/").Replace("\n", " "));
        return 1;
      }
    }
  }

  static int Sample(int pid, string output, int interval, StreamWriter writer) {
    process = OpenProcess(ProcessAccess, false, pid);
    if (process == IntPtr.Zero) {
      writer.WriteLine("failed|OpenProcess " + Marshal.GetLastWin32Error());
      return 1;
    }
    // Undecorated names, no symbol files fetched and no dialog for one missing.
    SymSetOptions(0x2 | 0x4 | 0x200 | 0x80000);
    if (!SymInitialize(process, null, true)) {
      writer.WriteLine("failed|SymInitialize " + Marshal.GetLastWin32Error());
      return 1;
    }
    IntPtr help = GetModuleHandle("dbghelp.dll");
    tableAccess = GetProcAddress(help, "SymFunctionTableAccess64");
    moduleBase = GetProcAddress(help, "SymGetModuleBase64");
    symbol = Marshal.AllocHGlobal(88 + 1024);
    uint main = MainThread((uint)pid);
    IntPtr thread = OpenThread(ThreadAccess, false, main);
    if (thread == IntPtr.Zero) {
      writer.WriteLine("failed|OpenThread " + Marshal.GetLastWin32Error());
      return 1;
    }
    int count = 0;
    while (true) {
      uint code;
      if (!GetExitCodeProcess(process, out code) || code != StillActive) {
        return 0;
      }
      if (count % 20 == 0) {
        SymRefreshModuleList(process);
      }
      count += 1;
      string ask = output + ".ask";
      if (File.Exists(ask)) {
        AllThreads((uint)pid, output + ".threads");
        File.Delete(ask);
      }
      long created, exited, kernel, user;
      GetThreadTimes(thread, out created, out exited, out kernel, out user);
      List<ulong> frames = Walk(thread);
      long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
      writer.WriteLine(now + "|" + user + "|" + kernel + "|" + Names(frames));
      Thread.Sleep(interval);
    }
  }

  static List<uint> Threads(uint pid) {
    List<uint> found = new List<uint>();
    IntPtr snapshot = CreateToolhelp32Snapshot(SnapThreads, 0);
    ThreadEntry entry = new ThreadEntry();
    entry.Size = (uint)Marshal.SizeOf(typeof(ThreadEntry));
    for (bool more = Thread32First(snapshot, ref entry); more; more = Thread32Next(snapshot, ref entry)) {
      if (entry.OwnerProcessId == pid) {
        found.Add(entry.ThreadId);
      }
    }
    CloseHandle(snapshot);
    return found;
  }

  // The thread made first, which is the one the program's entry point ran on.
  static uint MainThread(uint pid) {
    uint first = 0;
    long earliest = long.MaxValue;
    foreach (uint id in Threads(pid)) {
      IntPtr handle = OpenThread(0x0040, false, id);
      long created, exited, kernel, user;
      if (handle != IntPtr.Zero && GetThreadTimes(handle, out created, out exited, out kernel, out user) && created < earliest) {
        earliest = created;
        first = id;
      }
      CloseHandle(handle);
    }
    return first;
  }

  static void AllThreads(uint pid, string path) {
    StringBuilder lines = new StringBuilder();
    foreach (uint id in Threads(pid)) {
      IntPtr handle = OpenThread(ThreadAccess, false, id);
      if (handle == IntPtr.Zero) {
        continue;
      }
      long created, exited, kernel, user;
      GetThreadTimes(handle, out created, out exited, out kernel, out user);
      lines.Append(id + "|" + user + "|" + kernel + "|" + Names(Walk(handle)) + "\n");
      CloseHandle(handle);
    }
    // Renamed into place, so a reader never takes half of it for the whole.
    File.WriteAllText(path + ".part", lines.ToString());
    if (File.Exists(path)) {
      File.Delete(path);
    }
    File.Move(path + ".part", path);
  }

  // The thread is held only while its stack is read, and named after it is let go.
  static List<ulong> Walk(IntPtr thread) {
    List<ulong> frames = new List<ulong>();
    IntPtr raw = Marshal.AllocHGlobal(ContextSize + 16);
    IntPtr frame = Marshal.AllocHGlobal(FrameSize);
    try {
      IntPtr context = new IntPtr((raw.ToInt64() + 15) & ~15L);
      Marshal.Copy(new byte[ContextSize], 0, context, ContextSize);
      Marshal.Copy(new byte[FrameSize], 0, frame, FrameSize);
      Marshal.WriteInt32(context, 0x30, ContextFull);
      if (SuspendThread(thread) == 0xFFFFFFFF) {
        return frames;
      }
      try {
        if (!GetThreadContext(thread, context)) {
          return frames;
        }
        Marshal.WriteInt64(frame, 0, Marshal.ReadInt64(context, 0xF8));
        Marshal.WriteInt32(frame, 12, 3);
        Marshal.WriteInt64(frame, 32, Marshal.ReadInt64(context, 0xA0));
        Marshal.WriteInt32(frame, 44, 3);
        Marshal.WriteInt64(frame, 48, Marshal.ReadInt64(context, 0x98));
        Marshal.WriteInt32(frame, 60, 3);
        for (int index = 0; index < MostFrames; index++) {
          if (!StackWalk64(Amd64, process, thread, frame, context, IntPtr.Zero, tableAccess, moduleBase, IntPtr.Zero)) {
            break;
          }
          ulong pc = (ulong)Marshal.ReadInt64(frame, 0);
          if (pc == 0) {
            break;
          }
          frames.Add(pc);
        }
      } finally {
        ResumeThread(thread);
      }
    } finally {
      Marshal.FreeHGlobal(raw);
      Marshal.FreeHGlobal(frame);
    }
    return frames;
  }

  static string Names(List<ulong> frames) {
    List<string> names = new List<string>();
    foreach (ulong pc in frames) {
      names.Add(Name(pc));
    }
    return string.Join("|", names.ToArray());
  }

  static string Name(ulong pc) {
    ulong module = SymGetModuleBase64(process, pc);
    if (module == 0) {
      return "0x" + pc.ToString("x");
    }
    string named;
    if (!modules.TryGetValue(module, out named)) {
      StringBuilder text = new StringBuilder(260);
      GetModuleBaseName(process, new IntPtr((long)module), text, 260);
      named = text.ToString();
      modules[module] = named;
    }
    if (!named.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) {
      Marshal.Copy(new byte[88], 0, symbol, 88);
      Marshal.WriteInt32(symbol, 0, 88);
      Marshal.WriteInt32(symbol, 80, 1024);
      ulong displacement;
      if (SymFromAddr(process, pc, out displacement, symbol)) {
        return named + "!" + Marshal.PtrToStringAnsi(new IntPtr(symbol.ToInt64() + 84)) + "+0x" + displacement.ToString("x");
      }
    }
    return named + "+0x" + (pc - module).ToString("x");
  }
}
`;

const HELPER = new CompiledHelper('stack sampler', 'gdharness-stack-sampler', SOURCE, true);

/** One walk of the sampled thread. */
export interface StackSample {
  /** Milliseconds since the epoch. */
  at: number;
  /** The thread's user and kernel time so far, in 100 ns units. */
  user: number;
  kernel: number;
  /** Innermost first. */
  frames: string[];
}

/** The samples in [param text], one a line, and the sampler's own failure if it wrote one. */
export function parseStackSamples(text: string): { samples: StackSample[]; failed: string | null } {
  const samples: StackSample[] = [];
  let failed: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const [at, user, kernel, ...frames] = line.split('|');
    if (at === 'failed') {
      failed = user ?? '';
    } else if (at !== undefined && /^\d+$/.test(at)) {
      samples.push({ at: Number(at), user: Number(user), kernel: Number(kernel), frames });
    }
  }
  return { samples, failed };
}

/**
 * One line per change of stack, innermost frame first and cut at [param depth] frames, with the
 * CPU time the thread used since the sample before. A run of samples on the same stack using no
 * CPU is folded into its first, which is how a thread blocked in one wait reads.
 */
export function describeStackSamples(samples: StackSample[], depth: number, since: number): string {
  const lines: string[] = [];
  let quiet = 0;
  let before: StackSample | undefined;
  let beforeStack = '';
  for (const sample of samples) {
    const stack = sample.frames.slice(0, depth).join(' < ');
    const used = before === undefined ? 0 : (sample.user - before.user + sample.kernel - before.kernel) / 10_000;
    if (before !== undefined && stack === beforeStack && used === 0) {
      quiet += 1;
      before = sample;
      continue;
    }
    if (quiet > 0) {
      lines.push(`  (the same for ${quiet} more)`);
      quiet = 0;
    }
    lines.push(`+${sample.at - since}ms cpu +${used.toFixed(0)}ms: ${stack}`);
    before = sample;
    beforeStack = stack;
  }
  if (quiet > 0) {
    lines.push(`  (the same for ${quiet} more)`);
  }
  return lines.join('\n');
}

/**
 * The call stack of a Windows process's main thread every [param intervalMs], for a case that
 * fails on an engine that stopped answering. The sampler is compiled and started in the background,
 * since the first compile on a CI runner takes longer than a fixture should wait to start.
 */
export function sampleStacks(
  pid: number,
  intervalMs: number,
): {
  samples: () => StackSample[];
  why: () => string | null;
  allThreads: (withinMs: number) => Promise<string>;
  stop: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), 'gdharness-stacks-'));
  const output = join(directory, 'samples.txt');
  let why: string | null = null;
  let stopped = false;
  let sampler: ReturnType<typeof spawnHidden> | null = null;
  void (async () => {
    const refused = await HELPER.ensure();
    if (refused !== null) {
      why = refused;
      return;
    }
    if (stopped) {
      return;
    }
    sampler = spawnHidden(HELPER.assembly(), [String(pid), output, String(intervalMs)], { stdio: 'ignore' });
    sampler.once('error', (error: Error) => {
      why = `the stack sampler did not start: ${error.message}`;
    });
  })().catch((error: unknown) => {
    why = errorMessage(error);
  });
  const read = (): { samples: StackSample[]; failed: string | null } =>
    existsSync(output) ? parseStackSamples(readFileSync(output, 'utf8')) : { samples: [], failed: null };
  return {
    samples: () => read().samples,
    why: () => why ?? read().failed,
    allThreads: async (withinMs: number) => {
      const answer = `${output}.threads`;
      rmSync(answer, { force: true });
      writeFileSync(`${output}.ask`, '');
      const until = Date.now() + withinMs;
      while (Date.now() < until && !existsSync(answer)) {
        await delay(100);
      }
      return existsSync(answer) ? readFileSync(answer, 'utf8') : '';
    },
    stop: () => {
      stopped = true;
      sampler?.kill();
      // The sampler may still hold its file for a moment after the kill, and a temporary folder
      // left behind costs nothing.
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Held.
      }
    },
  };
}
