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
 * `compiled-helper.ts`). Every such start is `spawnOnDesktop`, which hands it to the one helper this
 * process keeps running (see `desktop-process.ts`).
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompiledHelper, HELPER_COMPILE_MS } from './compiled-helper.js';
import { HelpedChild, HelperRefused, helperFor, retireHelper, type StreamKind } from './desktop-process.js';
import type { LogEntry } from './game-log.js';
import { isRecord } from './records.js';
import type { ChildProcess, SpawnOptions } from './spawn.js';
import { mendBeforeStart } from './uid-cache.js';

/**
 * The name of the Windows job every engine this package starts runs in, for the engine with pid
 * [param pid]. The job holds the engine and everything it starts, so a reader opens it with
 * OpenJobObjectW and reads their processor time together. Kept in step with `JobNamePrefix` in the
 * helper's source.
 */
export function engineJobName(pid: number): string {
  return `gdharness-engine-${String(pid)}`;
}

/** The desktop every process started this way shares. */
export const HIDDEN_DESKTOP = 'gdharness';

/**
 * Names the desktop to a process started on one, and to everything it starts: an editor there plays
 * its games there too. Kept in step with `DESKTOP_VARIABLE` in the runtime autoload, which says what
 * a desktop with no pointer does to a game's own reading of the mouse.
 */
const DESKTOP_VARIABLE = 'GDHARNESS_DESKTOP';

const SOURCE = `using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class GdharnessDesktop {
  const uint GenericAll = 0x10000000;
  const int UseStdHandles = 0x100;
  const int UseShowWindow = 0x1;
  const short ShowNoActivate = 4;
  const uint CreateNoWindow = 0x08000000;
  // Every engine runs below normal, so a machine running every core leaves other work its share.
  const uint BelowNormalPriorityClass = 0x00004000;

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

  // The startup information with an attribute list, which names the handles a process inherits. A
  // start that inherited every inheritable handle of this process would hand an engine the pipe
  // of another engine started at the same moment, and that pipe would then stay open until both ended.
  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfoEx {
    public StartupInfo startup;
    public IntPtr attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Security {
    public int length;
    public IntPtr descriptor;
    public bool inherit;
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
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out Started started);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, ref Security security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool WriteFile(IntPtr file, byte[] bytes, uint count, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  const uint GenericRead = 0x80000000;
  const uint GenericWrite = 0x40000000;
  const uint FileAppendData = 0x4;
  const uint ShareAll = 0x7;
  const uint OpenExisting = 3;
  const uint OpenAlways = 4;
  const uint ExtendedStartupInfoPresent = 0x00080000;
  const uint CreateUnicodeEnvironment = 0x00000400;
  const int HandleListAttribute = 0x20002;
  const int JobListAttribute = 0x2000D;
  const uint DuplicateSameAccess = 0x2;
  const uint DuplicateCloseSource = 0x1;
  const uint ProcessDuplicateHandle = 0x40;
  const uint Synchronize = 0x00100000;

  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool MoveFileExW(string from, string to, uint flags);
  const uint ReplaceExisting = 0x1;
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessAffinityMask(IntPtr process, UIntPtr mask);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  const uint CreateSuspended = 0x4;

  [StructLayout(LayoutKind.Sequential)]
  struct JobLimits {
    public long perProcessUserTime, perJobUserTime;
    public uint flags;
    public UIntPtr minimumWorkingSet, maximumWorkingSet;
    public uint activeProcesses;
    public UIntPtr affinity;
    public uint priorityClass, schedulingClass;
    public ulong reads, writes, others, readBytes, writtenBytes, otherBytes;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobLimits info, int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  const int ExtendedLimitInformation = 9;
  const uint KillOnJobClose = 0x2000;
  const int ErrorAlreadyExists = 183;
  const string JobNamePrefix = "gdharness-engine-";
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

  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop, EachWindow each, IntPtr unused);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EachWindow each, IntPtr unused);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder into, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window, StringBuilder into, int size);
  // The class every message box has.
  const string DialogClass = "#32770";
  const string BoxMarker = "[gdharness] desktop-box ";
  const uint BoxLooks = 2;

  static string TextOf(IntPtr window) {
    StringBuilder text = new StringBuilder(4096);
    GetWindowTextW(window, text, text.Capacity);
    return text.ToString();
  }

  static bool HasClass(IntPtr window, string wanted) {
    StringBuilder name = new StringBuilder(32);
    GetClassNameW(window, name, name.Capacity);
    return name.ToString() == wanted;
  }

  // A JSON string. Written without a backslash literal, which this source's template would eat.
  static string Quote(string text) {
    char slash = (char)92;
    char quote = (char)34;
    StringBuilder quoted = new StringBuilder();
    quoted.Append(quote);
    foreach (char c in text) {
      if (c == slash || c == quote) {
        quoted.Append(slash).Append(c);
      } else if (c < ' ') {
        quoted.Append(slash).Append('u').Append(((int)c).ToString("x4"));
      } else {
        quoted.Append(c);
      }
    }
    return quoted.Append(quote).ToString();
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessEntry {
    public uint size, usage, processId;
    public IntPtr heap;
    public uint module, threads, parentProcessId;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exeFile;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  const uint SnapshotProcesses = 0x2;
  const uint SnapshotThreads = 0x4;
  const uint ProcessTerminate = 0x1;
  const uint ProcessQueryLimited = 0x1000;
  const uint ProcessQueryInformation = 0x400;
  const uint ThreadQueryLimited = 0x800;
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernelbase.dll")] static extern bool CompareObjectHandles(IntPtr first, IntPtr second);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int needed);
  const uint JobQuery = 0x4;
  const int ProcessHandleInformation = 51;
  const int InfoLengthMismatch = unchecked((int)0xC0000004);
  const int BufferTooSmall = unchecked((int)0xC0000023);

  [StructLayout(LayoutKind.Sequential)]
  struct ThreadEntry {
    public uint size, usage, threadId, ownerProcessId;
    public int basePriority, deltaPriority;
    public uint flags;
  }
  [DllImport("kernel32.dll")] static extern bool Thread32First(IntPtr snapshot, ref ThreadEntry entry);
  [DllImport("kernel32.dll")] static extern bool Thread32Next(IntPtr snapshot, ref ThreadEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, uint threadId);
  [DllImport("kernel32.dll")] static extern bool GetThreadTimes(IntPtr thread, out long created, out long exited, out long kernel, out long user);

  // The thread the process began with, which is the one Godot runs its main loop on, or 0 where none
  // can be read. A message box blocks only the thread that opened it.
  static uint FirstThreadOf(uint processId) {
    uint first = 0;
    long earliest = long.MaxValue;
    IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotThreads, 0);
    if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) {
      return 0;
    }
    ThreadEntry entry = new ThreadEntry();
    entry.size = (uint)Marshal.SizeOf(typeof(ThreadEntry));
    for (bool more = Thread32First(snapshot, ref entry); more; more = Thread32Next(snapshot, ref entry)) {
      if (entry.ownerProcessId != processId) {
        continue;
      }
      IntPtr thread = OpenThread(ThreadQueryLimited, false, entry.threadId);
      if (thread == IntPtr.Zero) {
        continue;
      }
      long created, exited, kernel, user;
      if (GetThreadTimes(thread, out created, out exited, out kernel, out user) && created < earliest) {
        earliest = created;
        first = entry.threadId;
      }
      CloseHandle(thread);
    }
    CloseHandle(snapshot);
    return first;
  }

  // When the process began, or -1 where it cannot be read.
  static long CreatedAt(uint processId) {
    IntPtr handle = OpenProcess(ProcessQueryLimited, false, processId);
    if (handle == IntPtr.Zero) {
      return -1;
    }
    long created, exited, kernel, user;
    bool read = GetProcessTimes(handle, out created, out exited, out kernel, out user);
    CloseHandle(handle);
    return read ? created : -1;
  }

  // The process and everything it started that is still running. A parent is only a parent when it
  // began before its child, since Windows hands a pid to a later process once its owner has gone.
  static Dictionary<uint, ProcessEntry> Processes() {
    Dictionary<uint, ProcessEntry> all = new Dictionary<uint, ProcessEntry>();
    IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
    if (snapshot != IntPtr.Zero && snapshot != new IntPtr(-1)) {
      ProcessEntry entry = new ProcessEntry();
      entry.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
        all[entry.processId] = entry;
      }
      CloseHandle(snapshot);
    }
    return all;
  }

  static Dictionary<uint, long> FamilyOf(uint root, Dictionary<uint, ProcessEntry> processes) {
    Dictionary<uint, long> family = new Dictionary<uint, long>();
    family[root] = CreatedAt(root);
    bool grew = true;
    while (grew) {
      grew = false;
      foreach (KeyValuePair<uint, ProcessEntry> pair in processes) {
        long parentBegan;
        if (family.ContainsKey(pair.Key) || !family.TryGetValue(pair.Value.parentProcessId, out parentBegan)) {
          continue;
        }
        long began = CreatedAt(pair.Key);
        if (began >= 0 && parentBegan >= 0 && began >= parentBegan) {
          family[pair.Key] = began;
          grew = true;
        }
      }
    }
    return family;
  }

  // The engine's own process: the one the helper started, or the engine a console wrapper started
  // in its place, which is the wrapper's only child.
  static bool IsTheEngine(uint owner, uint root, Dictionary<uint, ProcessEntry> processes) {
    ProcessEntry rootEntry;
    ProcessEntry ownerEntry;
    if (owner == root) {
      return true;
    }
    return processes.TryGetValue(root, out rootEntry)
      && processes.TryGetValue(owner, out ownerEntry)
      && ownerEntry.parentProcessId == root
      && rootEntry.exeFile.EndsWith("_console.exe", StringComparison.OrdinalIgnoreCase);
  }

  // A message box the process, or one it started, opened on the desktop, as the marker line a run
  // reads, or null, with the pid of the process that owns it. Nobody can press it here, so a box on
  // its main thread stops the process for good. A box on another thread stops that thread only, as a
  // worker's alert or a file dialog does, and the process runs on. Only a box of this family counts,
  // since every engine a run starts shares the desktop. The processes are listed only once a dialog
  // is on the desktop, so a run with none costs next to nothing.
  static string BoxOf(IntPtr desktop, uint processId, out uint boxOwner) {
    string said = null;
    uint found = 0;
    List<IntPtr> dialogs = new List<IntPtr>();
    EnumDesktopWindows(desktop, delegate(IntPtr window, IntPtr unused) {
      if (HasClass(window, DialogClass)) {
        dialogs.Add(window);
      }
      return true;
    }, IntPtr.Zero);
    boxOwner = 0;
    if (dialogs.Count == 0) {
      return null;
    }
    Dictionary<uint, ProcessEntry> processes = Processes();
    Dictionary<uint, long> family = FamilyOf(processId, processes);
    foreach (IntPtr window in dialogs) {
      uint owner;
      uint thread = GetWindowThreadProcessId(window, out owner);
      // Not asked whether it is visible: a window of a non-interactive station never reads as shown.
      if (!family.ContainsKey(owner) || thread != FirstThreadOf(owner)) {
        continue;
      }
      found = owner;
      StringBuilder body = new StringBuilder();
      EnumChildWindows(window, delegate(IntPtr child, IntPtr also) {
        string text = TextOf(child);
        if (text.Length > 0 && HasClass(child, "Static")) {
          body.Append(body.Length > 0 ? " " : "").Append(text);
        }
        return true;
      }, IntPtr.Zero);
      said = BoxMarker + "{" + Quote("title") + ":" + Quote(TextOf(window)) + "," + Quote("text") + ":" + Quote(body.ToString()) + "," + Quote("engine") + ":" + (IsTheEngine(owner, processId, processes) ? "true" : "false") + "}";
      break;
    }
    boxOwner = found;
    return said;
  }

  // Written as UTF-8 whatever the console's code page is, which is how a run reads it.
  static void Say(IntPtr output, string line) {
    byte[] bytes = new UTF8Encoding(false).GetBytes(Environment.NewLine + line + Environment.NewLine);
    uint written;
    WriteFile(output, bytes, (uint)bytes.Length, out written, IntPtr.Zero);
  }

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

  // Either the spec, the error file and the step file of one start, by path, which is run and
  // answered with its exit code, or --serve and the pid of the process it serves, which answers
  // any number of starts. What stops a start before its pid is written goes to its error file,
  // since its own streams are the ones the process inherits.
  public static int Main(string[] args) {
    if (args.Length > 1 && args[0] == "--serve") {
      return Serve(int.Parse(args[1]));
    }
    return Serve1(args[0], args[1], args[2]);
  }

  static int Serve1(string spec, string error, string step) {
    try {
      Step(step, "reading its spec");
      return RunSpec(spec);
    } catch (Exception e) {
      File.WriteAllText(error, e.Message);
      return 1;
    }
  }

  // The process this one serves, which is asked to hold a copy of every job that ends its engine,
  // so that the engines do not end with this helper alone but only with whatever started it.
  static IntPtr served = IntPtr.Zero;
  static uint servedId = 0;
  static readonly object running = new object();
  static readonly Dictionary<string, IntPtr> processes = new Dictionary<string, IntPtr>();
  // The starts this process ended on request, so that an engine's own exit code 1 is not taken for it.
  static readonly HashSet<string> stopped = new HashSet<string>();

  static string Ending(string id, uint code) {
    lock (running) {
      return "ended " + id + " " + code + (stopped.Remove(id) ? " stopped" : "");
    }
  }
  static readonly object replying = new object();
  [ThreadStatic] static string requestId;

  static void Reply(string line) {
    lock (replying) {
      byte[] bytes = new UTF8Encoding(false).GetBytes(line + "\\n");
      uint written;
      WriteFile(GetStdHandle(-11), bytes, (uint)bytes.Length, out written, IntPtr.Zero);
    }
  }

  static string Decoded(string base64) {
    return Encoding.UTF8.GetString(Convert.FromBase64String(base64));
  }

  // One line a request, read until the served process closes its end or ends: "start id spec error
  // step" runs a start on a thread of its own and answers "made id pid began" once its process
  // exists, "started id pid job" once it runs and "ended id code" once it has ended. "kill id" ends
  // a start's process. "adopt id pid job" waits for a process a helper before this one started and
  // answers its end. "release pid began" ends the process of a start a helper before this one made
  // but never answered. The engines of starts still running end with this process when they are in
  // a job that ends them, and run on when they are not.
  static int Serve(int servedPid) {
    servedId = (uint)servedPid;
    served = OpenProcess(ProcessDuplicateHandle, false, servedId);
    if (served == IntPtr.Zero) {
      return 1;
    }
    StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    for (string line = Next(reader); line != null; line = Next(reader)) {
      string[] parts = line.Split(' ');
      if (parts[0] == "start" && parts.Length == 5) {
        string id = parts[1];
        string spec = Decoded(parts[2]);
        string error = Decoded(parts[3]);
        string step = Decoded(parts[4]);
        Thread start = new Thread(delegate() {
          requestId = id;
          int code = Serve1(spec, error, step);
          Reply(Ending(id, unchecked((uint)code)));
        });
        start.IsBackground = true;
        start.Start();
      } else if (parts[0] == "kill" && parts.Length == 2) {
        lock (running) {
          IntPtr process;
          if (processes.TryGetValue(parts[1], out process)) {
            stopped.Add(parts[1]);
            TerminateProcess(process, 1);
          }
        }
      } else if (parts[0] == "adopt" && parts.Length == 4) {
        string id = parts[1];
        uint pid = uint.Parse(parts[2]);
        IntPtr copy = new IntPtr(long.Parse(parts[3]));
        Thread adoption = new Thread(delegate() { Adopt(id, pid, copy); });
        adoption.IsBackground = true;
        adoption.Start();
      } else if (parts[0] == "release" && parts.Length == 3) {
        uint pid = uint.Parse(parts[1]);
        long began = long.Parse(parts[2]);
        // Counted as a start being made, so that the served process ending meanwhile does not end
        // this one before the engine is ended.
        lock (running) {
          creating++;
        }
        Thread release = new Thread(delegate() {
          try {
            Release(pid, began);
          } finally {
            lock (running) {
              creating--;
              ExitWhenIdle();
            }
          }
        });
        release.IsBackground = true;
        release.Start();
      }
    }
    Leave();
    Thread.Sleep(Timeout.Infinite);
    return 0;
  }

  // The process this one serves has gone. What was to end with it ends now, and this process ends
  // with it unless a start meant to outlive its starter still runs: the job of such a process is
  // named, and exists only while a handle to it is open, so this process keeps its handle until the
  // process has ended.
  static void Leave() {
    lock (running) {
      leaving = true;
      foreach (IntPtr job in jobs.Values) {
        TerminateJobObject(job, 1);
      }
      ExitWhenIdle();
    }
  }

  // Called with the lock held. This process ends once its starter has gone, no start meant to outlive
  // it runs and none is between creating its process and handing it over. Such a process is still in
  // the job it was made in, which would end it with this process.
  static void ExitWhenIdle() {
    if (leaving && kept == 0 && creating == 0) {
      Environment.Exit(0);
    }
  }

  static bool leaving = false;
  static int kept = 0;
  static int creating = 0;
  static readonly Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);

  // The next request, or null once the served process has closed its end, which reads as a broken
  // pipe when it was killed.
  static string Next(StreamReader reader) {
    try {
      return reader.ReadLine();
    } catch (IOException) {
      return null;
    }
  }

  // Waits for a process a helper before this one started, whose exit code only a handle opened
  // while it ran can read, and answers it as the start's end. Its job copy is closed after.
  static void Adopt(string id, uint pid, IntPtr copy) {
    uint code = 1;
    IntPtr process = OpenProcess(ProcessTerminate | ProcessQueryLimited | Synchronize, false, pid);
    if (process != IntPtr.Zero) {
      lock (running) {
        processes[id] = process;
      }
      WaitForSingleObject(process, 0xFFFFFFFF);
      GetExitCodeProcess(process, out code);
      lock (running) {
        processes.Remove(id);
      }
      CloseHandle(process);
    }
    ReleaseCopy(copy);
    Reply(Ending(id, code));
  }

  // Ends the process a helper before this one made for a start it never answered, as its job would
  // have once that helper ended, had the served process not held a copy. That copy is closed too,
  // wherever it is, since the served process was never told it. A pid is that process's only while
  // the process there began when the helper said it did.
  static void Release(uint pid, long began) {
    IntPtr process = OpenProcess(ProcessTerminate | ProcessQueryLimited, false, pid);
    if (process == IntPtr.Zero) {
      return;
    }
    long created, exited, kernel, user;
    if (GetProcessTimes(process, out created, out exited, out kernel, out user) && created == began) {
      IntPtr job = OpenJobObjectW(JobQuery, false, JobNamePrefix + pid);
      bool member = false;
      if (job != IntPtr.Zero && !IsProcessInJob(process, job, out member)) {
        member = false;
      }
      if (member) {
        CloseCopies(job);
      }
      TerminateProcess(process, 1);
      if (job != IntPtr.Zero) {
        CloseHandle(job);
      }
    }
    CloseHandle(process);
  }

  // Closes every handle the served process holds to job. A copy left there would keep the job's name
  // taken, and fail the start of a later engine given the same pid.
  static void CloseCopies(IntPtr job) {
    IntPtr owner = OpenProcess(ProcessQueryInformation | ProcessDuplicateHandle, false, servedId);
    if (owner == IntPtr.Zero) {
      return;
    }
    IntPtr table = IntPtr.Zero;
    try {
      int size = 1 << 16;
      int status;
      while (true) {
        table = Marshal.AllocHGlobal(size);
        int needed;
        status = NtQueryInformationProcess(owner, ProcessHandleInformation, table, size, out needed);
        if ((status != InfoLengthMismatch && status != BufferTooSmall) || size >= 1 << 26) {
          break;
        }
        Marshal.FreeHGlobal(table);
        table = IntPtr.Zero;
        size = Math.Max(size * 2, needed);
      }
      if (status != 0) {
        return;
      }
      // The table: a count and a reserved field, then one entry a handle, which begins with its value
      // and two counts, then four 32-bit fields.
      long count = Marshal.ReadIntPtr(table).ToInt64();
      int entry = IntPtr.Size * 3 + 16;
      for (long index = 0; index < count; index++) {
        IntPtr value = Marshal.ReadIntPtr(table, IntPtr.Size * 2 + (int)index * entry);
        IntPtr mine;
        if (!DuplicateHandle(owner, value, GetCurrentProcess(), out mine, 0, false, DuplicateSameAccess)) {
          continue;
        }
        bool same = CompareObjectHandles(mine, job);
        CloseHandle(mine);
        if (same) {
          IntPtr unused;
          DuplicateHandle(owner, value, IntPtr.Zero, out unused, 0, false, DuplicateCloseSource);
        }
      }
    } finally {
      if (table != IntPtr.Zero) {
        Marshal.FreeHGlobal(table);
      }
      CloseHandle(owner);
    }
  }

  // Closes the copy of a job held by the served process.
  static void ReleaseCopy(IntPtr copy) {
    IntPtr unused;
    if (copy != IntPtr.Zero) {
      DuplicateHandle(served, copy, IntPtr.Zero, out unused, 0, false, DuplicateCloseSource);
    }
  }

  // What a process is given for one of its standard streams: this process's own for an empty
  // target, the null device for "nul", the client end of a named pipe for "pipe:name", and a
  // file opened for appending for "file:path". Each is inheritable, and closed by the caller.
  sealed class Stdio {
    public IntPtr input, output, error;
    public readonly List<IntPtr> opened = new List<IntPtr>();

    public void Close() {
      foreach (IntPtr handle in opened) {
        CloseHandle(handle);
      }
      opened.Clear();
    }

    public IntPtr Open(string target, bool reading, int own) {
      if (target.Length == 0) {
        return GetStdHandle(own);
      }
      Security security = new Security();
      security.length = Marshal.SizeOf(typeof(Security));
      security.inherit = true;
      string path;
      uint access;
      uint disposition;
      if (target == "nul") {
        path = "NUL";
        access = reading ? GenericRead : GenericWrite;
        disposition = OpenExisting;
      } else if (target.StartsWith("pipe:")) {
        char slash = (char)92;
        path = "" + slash + slash + "." + slash + "pipe" + slash + target.Substring(5);
        access = GenericWrite;
        disposition = OpenExisting;
      } else {
        path = target.Substring(5);
        access = FileAppendData;
        disposition = OpenAlways;
      }
      IntPtr handle = CreateFileW(path, access, ShareAll, ref security, disposition, 0, IntPtr.Zero);
      if (handle == new IntPtr(-1)) {
        throw Failure(Marshal.GetLastWin32Error(), "CreateFileW " + path);
      }
      opened.Add(handle);
      return handle;
    }
  }

  // The windows stations and desktops this process has made, which it holds for as long as it runs:
  // a desktop goes when the last handle to it does, and every start on it shares the one handle.
  static readonly object desktops = new object();
  static readonly Dictionary<string, KeyValuePair<string, IntPtr>> madeDesktops = new Dictionary<string, KeyValuePair<string, IntPtr>>();

  // The desktop's full name, which starts a process on it, and the handle held for it.
  static KeyValuePair<string, IntPtr> DesktopOf(string desktop, string stepFile) {
    lock (desktops) {
      KeyValuePair<string, IntPtr> made;
      if (madeDesktops.TryGetValue(desktop, out made)) {
        return made;
      }
      Step(stepFile, "opening the session's own window station");
      IntPtr station = CreateWindowStationW(null, 0, WindowStationAllAccess, IntPtr.Zero);
      if (station == IntPtr.Zero) {
        throw Failure(Marshal.GetLastWin32Error(), "CreateWindowStationW");
      }
      StringBuilder stationName = new StringBuilder(256);
      int needed;
      if (!GetUserObjectInformationW(station, ObjectName, stationName, stationName.Capacity * 2, out needed)) {
        throw Failure(Marshal.GetLastWin32Error(), "GetUserObjectInformationW");
      }
      // A desktop is made in the calling process's station, so this one is the caller's while it is.
      IntPtr own = GetProcessWindowStation();
      if (!SetProcessWindowStation(station)) {
        throw Failure(Marshal.GetLastWin32Error(), "SetProcessWindowStation");
      }
      IntPtr held;
      int error;
      try {
        Step(stepFile, "creating the " + desktop + " desktop");
        held = CreateDesktopExW(desktop, IntPtr.Zero, IntPtr.Zero, 0, GenericAll, IntPtr.Zero, DesktopHeapKilobytes, IntPtr.Zero);
        error = Marshal.GetLastWin32Error();
      } finally {
        SetProcessWindowStation(own);
      }
      if (held == IntPtr.Zero) {
        throw Failure(error, "CreateDesktopExW " + stationName + "\\\\" + desktop);
      }
      made = new KeyValuePair<string, IntPtr>(stationName + "\\\\" + desktop, held);
      madeDesktops[desktop] = made;
      return made;
    }
  }

  // Starts the command line, both of its streams on this process's output, writes its pid, and
  // waits for it: the answer is its exit code, also written whole to exitFile, since Bun hands a
  // parent on Windows only the low byte of a code. On the named desktop when there is one, whose handle
  // is held until then, since a desktop goes when the last handle to it does, and on this process's
  // own otherwise. With noActivate its first window is shown without being activated, which is
  // what a program's first ShowWindow does whatever it asks for when the start names a show state,
  // and the foreground is held while it starts, since Godot also asks for it outright. The process
  // is ended through the handle held here once stopFile appears, which is how a keeper ends a game
  // it did not start itself: a handle names one process, where a pid can name the next one too. The
  // process starts in directory rather than in this one's, which is a temporary directory. The spec
  // is one field a line, each base64 of its UTF-8. A process that opens a message box on the desktop
  // is ended too, with the box said on this process's output as a marker line, since nobody can
  // press it there.
  public static int RunSpec(string specFile) {
    string[] lines = File.ReadAllLines(specFile);
    Func<int, string> field = delegate(int index) { return Encoding.UTF8.GetString(Convert.FromBase64String(lines[index])); };
    string affinity = field(7);
    string exitFile = field(8);
    bool endsWithThis = field(9) == "1";
    bool separateErrors = lines.Length > 10 && field(10) == "1";
    string laneFile = lines.Length > 12 ? field(11) : "";
    string lane = lines.Length > 12 ? field(12) : "";
    // A trailing empty field is no line of the file, so a field is there only when a later one is.
    bool described = lines.Length > 15;
    string environment = lines.Length > 16 ? field(16) : "";
    Stdio io = new Stdio();
    try {
      io.input = io.Open(described ? field(13) : "", true, -10);
      io.output = io.Open(described ? field(14) : "", false, -11);
      string errors = described ? field(15) : "";
      io.error = errors == "same" || (errors.Length == 0 && !separateErrors) ? io.output : io.Open(errors, false, -12);
      return Run(field(0), field(1), field(2), field(3) == "1", field(4), field(5), field(6), affinity.Length == 0 ? 0UL : ulong.Parse(affinity), exitFile, endsWithThis, io, environment, laneFile, lane);
    } finally {
      io.Close();
    }
  }

  // The call and what it was given, then the system's own reason for the code. The exception's
  // message is the given text alone, so the reason is added here. The system leaves the program's
  // name out of a reason that has a place for it (%1), so it is put there.
  static Exception Failure(int code, string what, string program) {
    return new Win32Exception(code, what + ": " + new Win32Exception(code).Message.Replace("%1", program));
  }

  static Exception Failure(int code, string what) {
    return Failure(code, what, "");
  }

  // The program a command line names: what is inside the first quotes, or up to the first space.
  static string ProgramOf(string commandLine) {
    if (commandLine.StartsWith("\\"")) {
      int end = commandLine.IndexOf('"', 1);
      return end < 0 ? commandLine.Substring(1) : commandLine.Substring(1, end - 1);
    }
    int space = commandLine.IndexOf(' ');
    return space < 0 ? commandLine : commandLine.Substring(0, space);
  }

  // Written under a temporary name and renamed, so a reader never sees half of it.
  static void WriteLane(string laneFile, string lane, int processId) {
    string temporary = laneFile + ".tmp";
    File.WriteAllText(temporary, "{\\"lane\\": " + lane + ", \\"pid\\": " + processId + "}\\n");
    if (!MoveFileExW(temporary, laneFile, ReplaceExisting)) {
      throw Failure(Marshal.GetLastWin32Error(), "MoveFileExW " + laneFile);
    }
  }

  static void Step(string stepFile, string step) {
    File.WriteAllText(stepFile, step);
  }

  // The process starts suspended, inside a job of its own that ends it once this process has gone.
  // So a failure or the end of this process, at any point before it is handed over, ends it unrun.
  // With an affinity it is held to those processors before its first thread runs, so every thread
  // it starts afterwards is held to them as well. It then joins a job named after its own pid, made
  // before it runs so that what it starts is counted in the job too, and a name already taken ends
  // it unrun. With endsWithThis that job ends it once this process has gone, however it went. A
  // runner's own job ends this helper with the runner, and the process breaks away from that job, so
  // an engine of a runner that was killed ran on with no parent and held its run's folder. Without
  // it the job only counts, so a process meant to outlive whatever started it keeps its lifetime.
  // Both jobs nest in whatever job this process is in. That needs Windows 8, and a job that forbids
  // it fails the start with the cause. Making a process in a job needs Windows 10.
  static int Run(string desktop, string commandLine, string pidFile, bool noActivate, string stopFile, string directory, string stepFile, ulong affinity, string exitFile, bool endsWithThis, Stdio io, string environment, string laneFile, string lane) {
    StartupInfoEx extended = new StartupInfoEx();
    extended.startup.cb = Marshal.SizeOf(typeof(StartupInfoEx));
    IntPtr desktopHandle = IntPtr.Zero;
    if (desktop.Length > 0) {
      KeyValuePair<string, IntPtr> made = DesktopOf(desktop, stepFile);
      desktopHandle = made.Value;
      extended.startup.desktop = made.Key;
    }
    extended.startup.flags = UseStdHandles;
    if (noActivate) {
      extended.startup.flags |= UseShowWindow;
      extended.startup.show = ShowNoActivate;
    }
    // Both streams on one handle keep their lines in order. A start whose reader tells the two apart
    // keeps its own error stream.
    extended.startup.input = io.input;
    extended.startup.output = io.output;
    extended.startup.error = io.error;
    Started started = new Started();
    // Inherited by what it starts: without SEM_NOGPFAULTERRORBOX, Windows Error Reporting runs when
    // the target crashes and writes its dump, and with the other two no hard-error box can open.
    // Set outright rather than cleared from this process's own, which is whatever started it chose:
    // a Windows PowerShell host was seen reading 0x1 here, without the open-file bit.
    SetErrorMode(FailCriticalErrors | NoOpenFileErrorBox);
    if (noActivate) {
      LockSetForegroundWindow(LockForeground);
    }
    IntPtr birth = IntPtr.Zero;
    IntPtr job = IntPtr.Zero;
    IntPtr copy = IntPtr.Zero;
    bool counted = false;
    bool creatingHeld = false;
    JobLimits limits = new JobLimits();
    try {
    try {
    Step(stepFile, "starting the process");
    birth = CreateJobObjectW(IntPtr.Zero, null);
    limits.flags = KillOnJobClose;
    if (birth == IntPtr.Zero || !SetInformationJobObject(birth, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JobLimits)))) {
      throw Failure(Marshal.GetLastWin32Error(), "a job to make the process in");
    }
    // The process gets a console that is never shown, so a console program it starts joins that one
    // and opens no window of its own. A process with no console at all gives each such child a new
    // console, which Windows Terminal shows on the desktop in use, whichever desktop the process is on.
    uint creation = CreateNoWindow | BelowNormalPriorityClass | CreateSuspended | ExtendedStartupInfoPresent;
    lock (running) {
      if (leaving && endsWithThis) {
        throw new Win32Exception(0, "the process that started this one has ended");
      }
      creating++;
      creatingHeld = true;
    }
    Create(commandLine, ref creation, directory, environment, io, birth, ref extended, out started);
    lock (running) {
      // A start that was in flight when the process it serves ended, which Leave could not see yet.
      if (leaving && endsWithThis) {
        throw new Win32Exception(0, "the process that started this one has ended");
      }
      if (requestId != null) {
        processes[requestId] = started.process;
      }
    }
    if (requestId != null) {
      // Said before the served process is handed a copy of the job, which it learns of only from the
      // answer. A helper that ends after the copy and before it answers leaves the next one the
      // engine to end and the copy to close. The time the process began tells it from a later one
      // given the same pid.
      long began, exited, kernel, user;
      GetProcessTimes(started.process, out began, out exited, out kernel, out user);
      Reply("made " + requestId + " " + started.processId + " " + began);
    }
    if (affinity != 0) {
      Step(stepFile, "holding the process to its processors");
      if (!SetProcessAffinityMask(started.process, new UIntPtr(affinity))) {
        throw Failure(Marshal.GetLastWin32Error(), "SetProcessAffinityMask " + affinity);
      }
    }
    Step(stepFile, "putting the process in its job");
    // With endsWithThis Windows ends the engine once the last handle to the job is closed. This
    // process holds one until the engine has ended, and the process it serves holds a copy, so the
    // engine outlives this process alone but not whatever started it.
    string jobName = JobNamePrefix + started.processId;
    job = CreateJobObjectW(IntPtr.Zero, jobName);
    int made = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero || made == ErrorAlreadyExists) {
      // A name already taken says it all itself: the system's text for that code speaks of a file.
      throw job == IntPtr.Zero
        ? Failure(made, "CreateJobObjectW " + jobName)
        : new Win32Exception(made, "the job " + jobName + " already exists");
    }
    limits.flags = endsWithThis ? KillOnJobClose : 0u;
    if ((endsWithThis && !SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JobLimits))))
        || !AssignProcessToJobObject(job, started.process)) {
      throw Failure(Marshal.GetLastWin32Error(), "a job for the process named " + jobName);
    }
    // From here the named job ends the process with this one, until the served process holds a copy.
    if (endsWithThis) {
      LetGo(ref birth, "the job the process was made in");
    }
    if (endsWithThis && served != IntPtr.Zero) {
      DuplicateHandle(GetCurrentProcess(), job, served, out copy, 0, false, DuplicateSameAccess);
    }
    lock (running) {
      if (!endsWithThis) {
        kept++;
      } else if (requestId != null) {
        jobs[requestId] = job;
        if (leaving) {
          TerminateJobObject(job, 1);
        }
      }
      creating--;
      creatingHeld = false;
    }
    counted = true;
    if (laneFile.Length > 0) {
      try {
        WriteLane(laneFile, lane, started.processId);
      } catch (Exception) {
        TerminateProcess(started.process, 1);
        throw;
      }
    }
    ResumeThread(started.thread);
    File.WriteAllText(pidFile, started.processId.ToString());
    // A process meant to outlive its starter is let go only now. A helper that ends before this
    // still ends it, and one that ends before the answer below leaves the next one to end it.
    if (birth != IntPtr.Zero) {
      LetGo(ref birth, "the job the process was made in");
    }
    if (requestId != null) {
      Reply("started " + requestId + " " + started.processId + " " + copy.ToInt64());
    }
    if (noActivate) {
      HoldTheForeground(started);
    }
    } finally {
      if (noActivate) {
        LockSetForegroundWindow(UnlockForeground);
      }
    }
    bool stopped = false;
    uint looks = 0;
    uint lastOwner = 0;
    DateTime lookAgain = DateTime.UtcNow;
    while (WaitForSingleObject(started.process, 100) == TimedOut) {
      if (!stopped && stopFile.Length > 0 && File.Exists(stopFile)) {
        TerminateProcess(started.process, 1);
        stopped = true;
      }
      if (!stopped && desktopHandle != IntPtr.Zero && DateTime.UtcNow >= lookAgain) {
        lookAgain = DateTime.UtcNow.AddMilliseconds(500);
        uint owner;
        string box = BoxOf(desktopHandle, (uint)started.processId, out owner);
        looks = box == null ? 0 : (owner == lastOwner ? looks + 1 : 1);
        lastOwner = box == null ? 0 : owner;
        if (looks >= BoxLooks) {
          Say(io.output, box);
          looks = 0;
          lastOwner = 0;
          // Only the owner of the box is ended: an editor stays up when a game it plays is stuck.
          if (owner == (uint)started.processId) {
            TerminateProcess(started.process, 1);
            stopped = true;
          } else {
            IntPtr child = OpenProcess(ProcessTerminate, false, owner);
            if (child != IntPtr.Zero) {
              TerminateProcess(child, 1);
              CloseHandle(child);
            }
          }
        }
      }
    }
    // The process has ended, so what it started is let run on, as without the job: only a helper
    // that was ended itself takes them with it.
    if (endsWithThis) {
      limits.flags = 0;
      SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JobLimits)));
    }
    uint code;
    GetExitCodeProcess(started.process, out code);
    if (exitFile.Length > 0) {
      // A file that cannot be written leaves the parent the code this exits with, which says less
      // but still says it.
      try {
        File.WriteAllText(exitFile, code.ToString());
      } catch (IOException) {
      } catch (UnauthorizedAccessException) {
      }
    }
    return unchecked((int)code);
    } finally {
      lock (running) {
        if (requestId != null) {
          processes.Remove(requestId);
          jobs.Remove(requestId);
        }
      }
      if (started.thread != IntPtr.Zero) {
        CloseHandle(started.thread);
      }
      if (started.process != IntPtr.Zero) {
        CloseHandle(started.process);
      }
      if (job != IntPtr.Zero) {
        CloseHandle(job);
      }
      if (birth != IntPtr.Zero) {
        CloseHandle(birth);
      }
      ReleaseCopy(copy);
      lock (running) {
        if (creatingHeld) {
          creating--;
        }
        if (counted && !endsWithThis) {
          kept--;
        }
        ExitWhenIdle();
      }
    }
  }

  // Lifts the limit of a job that ends its processes with this one, and closes it.
  static void LetGo(ref IntPtr job, string what) {
    JobLimits none = new JobLimits();
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref none, Marshal.SizeOf(typeof(JobLimits)))) {
      throw Failure(Marshal.GetLastWin32Error(), "letting go of " + what);
    }
    CloseHandle(job);
    job = IntPtr.Zero;
  }

  // Starts the process in job, with only the handles of io inherited, and with the environment when
  // there is one.
  static void Create(string commandLine, ref uint creation, string directory, string environment, Stdio io, IntPtr job, ref StartupInfoEx extended, out Started started) {
    List<IntPtr> inherited = new List<IntPtr>();
    foreach (IntPtr handle in new IntPtr[] { io.input, io.output, io.error }) {
      if (handle != IntPtr.Zero && handle != new IntPtr(-1) && !inherited.Contains(handle)) {
        inherited.Add(handle);
      }
    }
    IntPtr attributes = IntPtr.Zero;
    IntPtr table = IntPtr.Zero;
    IntPtr jobs = Marshal.AllocHGlobal(IntPtr.Size);
    IntPtr block = IntPtr.Zero;
    bool ready = false;
    try {
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      attributes = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) {
        throw Failure(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList");
      }
      ready = true;
      Marshal.WriteIntPtr(jobs, job);
      if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(JobListAttribute), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) {
        throw Failure(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute");
      }
      if (inherited.Count > 0) {
        table = Marshal.AllocHGlobal(IntPtr.Size * inherited.Count);
        for (int index = 0; index < inherited.Count; index++) {
          Marshal.WriteIntPtr(table, index * IntPtr.Size, inherited[index]);
        }
        if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(HandleListAttribute), table, new IntPtr(IntPtr.Size * inherited.Count), IntPtr.Zero, IntPtr.Zero)) {
          throw Failure(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute");
        }
      }
      extended.attributes = attributes;
      if (environment.Length > 0) {
        block = Marshal.StringToHGlobalUni(environment);
        creation |= CreateUnicodeEnvironment;
      }
      if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, inherited.Count > 0, creation, block, directory, ref extended, out started)) {
        throw Failure(Marshal.GetLastWin32Error(), "CreateProcessW " + commandLine, ProgramOf(commandLine));
      }
    } finally {
      if (ready) {
        DeleteProcThreadAttributeList(attributes);
      }
      if (attributes != IntPtr.Zero) {
        Marshal.FreeHGlobal(attributes);
      }
      if (table != IntPtr.Zero) {
        Marshal.FreeHGlobal(table);
      }
      Marshal.FreeHGlobal(jobs);
      if (block != IntPtr.Zero) {
        Marshal.FreeHGlobal(block);
      }
    }
  }
}
`;

const HELPER = new CompiledHelper('desktop helper', 'gdharness-desktop', SOURCE, true);

/** The helper's C# source, which a test compiles with a change of its own to reach a case no real start can. */
export const HELPER_SOURCE = SOURCE;

/** Where the compiled desktop helper is kept, named after its source. */
export function helperAssembly(directory = tmpdir()): string {
  return HELPER.assembly(directory);
}

/** Compiles the desktop helper unless it is there. See [method CompiledHelper.ensure]. */
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

/** The pid the helper wrote to [param file] for the process it started, or undefined before it has. */
export function helperPid(file: string): number | undefined {
  try {
    const written = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(written) && written > 0 ? written : undefined;
  } catch {
    return undefined;
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
  /** The process's exit code as the helper read it, whole, which `helperExit` reads. */
  readonly exit: string;
}

/**
 * The exit code of the process the helper behind [param exitFile] started, where the helper's own
 * exit, [param told], says only part of it. Bun on Windows hands a parent the low byte of a child's
 * code alone, so an engine's access violation, 0xC0000005, read as an exit of 5 and was named a
 * quit(5) in the game's code. The code written there stands when its low byte is the one told, and
 * [param told] otherwise, such as when the helper itself failed or was ended before writing it.
 */
export function helperExit(exitFile: string, told: number | null): number | null {
  if (told === null) {
    return null;
  }
  let written: number;
  try {
    written = Number(readFileSync(exitFile, 'utf8').trim());
  } catch {
    return told;
  }
  if (!Number.isInteger(written) || written < 0 || written > 0xffffffff) {
    return told;
  }
  // Node hands the whole code and Bun its low byte, so only the low bytes are compared.
  return (written & 0xff) === (told & 0xff) ? written : told;
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
  return step === null || step === '' ? 'the helper had not begun' : `the helper was ${step}`;
}

/**
 * The helper invocation that starts [param command] on [param how]'s desktop, or on the one in use
 * when it names none, shown without activation when it says so. It writes its pid to the pid file,
 * waits for it and exits with its code, and ends it first if the stop file appears. What stops it
 * before the pid is written goes to the error file, since its own streams are the ones the process
 * inherits. The process starts in [param how]'s directory, which the helper is not run in.
 *
 * The spec goes in a file rather than on the command line. A long command line in base64 of the JSON
 * inside base64 of the script passed Windows' limit of 32767 characters on a command line: a keeper
 * starting a long command on a desktop of its own failed with ENAMETOOLONG before anything started.
 *
 * [param assembly] is the compiled helper, which {@link ensureHelperCompiled} makes first, and is
 * run as itself. A Windows PowerShell that loaded it for every engine cost each start an
 * interpreter and an antimalware scan of its script, which no path exclusion skips: thirty of them
 * alive at once kept Defender at about two cores.
 */
export function throughHelper(
  how: {
    readonly desktop?: string;
    readonly noActivate?: boolean;
    readonly directory: string;
    /** The processors the process is held to, one bit each, or none for every processor. */
    readonly affinity?: bigint;
    /** The process is ended once the helper has gone, as it goes with the process that spawned it. */
    readonly endsWithHelper?: boolean;
    /** The process's error stream is the helper's own, apart from its output, for a reader that tells them apart. */
    readonly separateErrors?: boolean;
    /** Where the helper writes the engine's lane and pid before it runs, and the lane's number. */
    readonly lane?: { readonly file: string; readonly number: number };
    /**
     * Where the engine's three streams go, as the helper reads them: `nul`, `pipe:<name>`,
     * `file:<path>` or `same` for the error stream on the output. Empty is the helper's own.
     */
    readonly streams?: readonly [string, string, string];
    /** The engine's environment as `NAME=value` entries each ended by a NUL, or empty for the helper's own. */
    readonly environment?: string;
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
    files.exit,
    how.endsWithHelper === true ? '1' : '0',
    how.separateErrors === true ? '1' : '0',
    how.lane?.file ?? '',
    how.lane === undefined ? '' : String(how.lane.number),
    ...(how.streams ?? ['', '', '']),
    how.environment ?? '',
  ];
  writeFileSync(
    files.spec,
    fields.map((field) => Buffer.from(field, 'utf8').toString('base64')).join('\n'),
    'utf8',
  );
  return { command: assembly, args: [files.spec, files.error, files.step] };
}

/** The line the helper prints where it ended a process on a message box. Kept in step with `BoxMarker` in its source. */
const BOX_MARKER = '[gdharness] desktop-box ';

/** The title Godot gives the box it opens when its display server cannot start, in `DisplayServerWindows::create_func`. */
const VIDEO_DRIVER_TITLE = 'Unable to initialize video driver';

/** How many of the engine's own error lines a verdict quotes. */
const QUOTED_ERRORS = 4;

/**
 * What the helper said of the message box it ended the process on, from [param printed], or null
 * when the lines hold no such word.
 */
function boxSaid(
  printed: readonly LogEntry[],
): { title: string; text: string; engine: boolean; before: readonly LogEntry[] } | null {
  const at = printed.findLastIndex((entry) => entry.text.startsWith(BOX_MARKER));
  if (at < 0) {
    return null;
  }
  let box: unknown;
  try {
    box = JSON.parse((printed[at]?.text ?? '').slice(BOX_MARKER.length));
  } catch {
    return null;
  }
  if (!isRecord(box)) {
    return null;
  }
  const { title, text, engine } = box;
  return typeof title === 'string' && typeof text === 'string'
    ? { title, text, engine: engine !== false, before: printed.slice(0, at) }
    : null;
}

/** Whether [param text] is a verdict or note this file wrote about a box, which is no line of the engine's own. */
export function isBoxVerdict(text: string): boolean {
  return (
    text.includes('on the hidden desktop, where nobody can press it') ||
    text.includes('on the hidden desktop, so it was ended')
  );
}

/**
 * The note for a run whose engine went on while the helper ended a process it started on a message
 * box, or null. The engine's own outcome stands, since the box was not its own.
 */
export function childBoxNote(printed: readonly LogEntry[]): string | null {
  const box = boxSaid(printed);
  return box === null || box.engine
    ? null
    : `a process the engine started opened a message box on the hidden desktop, where nobody can press it, so that process was ended: "${box.title}", ${box.text}`;
}

/**
 * Why the helper ended the process that printed [param printed], or null when it ended none on a
 * message box. A box on the hidden desktop is one nobody can press, so the process would wait on it
 * for the rest of the run. Godot opens one whenever it cannot create a renderer, and the helper's
 * marker line is the one signal that holds whichever driver failed: the engine's own lines differ
 * between ANGLE, Direct3D 12 and Vulkan. A box of a process the engine started ended that process
 * alone, which {@link childBoxNote} words. The engine's lines come from [param engineLines], which
 * is [param printed] unless the helper is an editor's, whose marker comes with the game's own lines
 * from elsewhere. The game an editor plays is that helper's child, so there a box of any process
 * is the game's.
 */
export function desktopBoxEnding(
  printed: readonly LogEntry[],
  engineLines?: readonly LogEntry[],
): string | null {
  const box = boxSaid(printed);
  if (box === null || (!box.engine && engineLines === undefined)) {
    return null;
  }
  if (box.title !== VIDEO_DRIVER_TITLE) {
    return `the engine opened a message box on the hidden desktop, where nobody can press it, so it was ended: "${box.title}", ${box.text}`;
  }
  const failures = [
    ...new Set(
      (engineLines ?? box.before)
        .filter((entry) => entry.severity !== 'info')
        .map((entry) => `${entry.severity === 'error' ? 'ERROR' : 'WARNING'}: ${entry.text}`),
    ),
  ].slice(-QUOTED_ERRORS);
  const after = failures.length === 0 ? '' : `, after printing ${failures.join(' | ')}`;
  return `the windowed engine could not create a renderer on the hidden desktop, so it was ended: it opened a box titled "${box.title}", which nobody can press there${after}. Run the suites headless, or check the machine's graphics driver, which a lost GPU needs a reboot to recover.`;
}

export { HelperRefused, retireHelper };

/** A process started on a desktop by `spawnOnDesktop`. */
export interface DesktopStart {
  /**
   * Stands for the process: it tells its exit with the whole code once the helper has, and its
   * streams are the engine's. Its pid is the helper's, which serves every start of this process.
   */
  readonly child: ChildProcess;
  readonly files: HelperFiles;
  /** Writes the stop file, or asks the helper to end the process where the start named none. */
  stop(): void;
  /** The process's own pid, undefined until the helper has written it. */
  pid(): number | undefined;
}

/**
 * Starts [param command] through the helper, with its files in [param how]'s scratch folder. The
 * stop and exit files are whole paths of the caller's, each named apart and in a folder that
 * outlives the process, since the scratch folder may be deleted once the pid is read. A start that
 * names neither hands the helper an empty name for it.
 *
 * The last start's files are removed first, so a start never reads another's pid, error or stop.
 */
export function spawnOnDesktop(
  how: {
    readonly desktop?: string;
    readonly noActivate?: boolean;
    readonly directory: string;
    readonly affinity?: bigint;
    readonly endsWithHelper?: boolean;
    readonly separateErrors?: boolean;
    readonly lane?: { readonly file: string; readonly number: number };
    readonly scratch: string;
    readonly stop?: string;
    readonly exit?: string;
    /** Where an output that is not piped is appended to, and the null device where there is none. */
    readonly outputFile?: string | undefined;
  },
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  assembly = helperAssembly(),
): DesktopStart {
  const files: HelperFiles = {
    spec: join(how.scratch, 'spec'),
    pid: join(how.scratch, 'pid'),
    error: join(how.scratch, 'error'),
    stop: how.stop ?? '',
    step: join(how.scratch, 'step'),
    exit: how.exit ?? '',
  };
  for (const file of [files.pid, files.error, files.step, files.stop, files.exit]) {
    if (file !== '') {
      rmSync(file, { force: true });
    }
  }
  const helper = helperFor(assembly);
  const piped = (stream: unknown): StreamKind => (stream === 'pipe' ? 'pipe' : 'ignore');
  const stdio = Array.isArray(options.stdio) ? options.stdio : [];
  const child = new HelpedChild(
    {
      kinds: [piped(stdio[0]), piped(stdio[1]), piped(stdio[2])],
      separateErrors: how.separateErrors === true,
      outputFile: how.outputFile,
    },
    options.signal,
  );
  child.errorFile = files.error;
  const environment = {
    ...(options.env ?? process.env),
    ...(how.desktop === undefined ? {} : { [DESKTOP_VARIABLE]: how.desktop }),
  };
  const wrapper = throughHelper(
    { ...how, streams: child.streams, environment: environmentBlock(environment) },
    command,
    args,
    files,
    assembly,
  );
  helper.give(child, requestFor(wrapper.args));
  return {
    child,
    files,
    stop: () => {
      if (files.stop === '') {
        child.kill();
      } else {
        writeFileSync(files.stop, '');
      }
    },
    pid: () => helperPid(files.pid),
  };
}

/** The environment as the helper hands it to the engine: each entry ended by a NUL, sorted as Windows asks. */
function environmentBlock(environment: NodeJS.ProcessEnv): string {
  return Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .toSorted(([one], [other]) => one.toUpperCase().localeCompare(other.toUpperCase()))
    .map(([name, value]) => `${name}=${value}\0`)
    .join('');
}

/** What the helper is sent for a start: its spec, error and step files, each as base64 of its UTF-8. */
function requestFor(files: readonly string[]): string {
  return files.map((file) => Buffer.from(file, 'utf8').toString('base64')).join(' ');
}
