/**
 * The Windows process table, read from the kernel by C# loaded into the one PowerShell this process
 * asks Windows through (see `windows-ask.ts`).
 *
 * Read from NtQuerySystemInformation rather than WMI. Every Win32_Process query is answered by the
 * WMI provider host, which walks every process and formats every property it was asked for, and a
 * machine running several servers, benches and a gate kept a whole core busy in wmiprvse for
 * listings nobody was waiting on. The kernel hands the same table over in one call, with the parent
 * links, start times and processor times in it; only a command line takes a handle to its process.
 */

import { tmpdir } from 'node:os';
import { CompiledHelper, HELPER_COMPILE_MS } from './compiled-helper.js';
import { askWindows } from './windows-ask.js';

// C# 5, since Add-Type in Windows PowerShell compiles with the .NET Framework's compiler.
const SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class GdhProcessTable
{
    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int infoClass, IntPtr info, int length, out int needed);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int needed);

    [DllImport("kernel32.dll")]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr process, out int code);

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll")]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    private const int SystemProcessInformation = 5;
    private const int ProcessCommandLineInformation = 60;
    private const int QueryLimitedInformation = 0x1000;
    private const int Synchronize = 0x100000;
    private const int InfoLengthMismatch = unchecked((int)0xC0000004);
    private const int BufferTooSmall = unchecked((int)0xC0000023);
    private const int BufferOverflow = unchecked((int)0x80000005);
    private const long UnixEpoch = 116444736000000000L;

    private struct Entry
    {
        public int Pid;
        public int Parent;
        public long Created;
        public long Processor;
    }

    private static readonly Dictionary<int, IntPtr> held = new Dictionary<int, IntPtr>();

    // The offsets of SYSTEM_PROCESS_INFORMATION's fields, which move with the pointer size after
    // ImageName, a UNICODE_STRING.
    private static List<Entry> Snapshot()
    {
        int pidAt = IntPtr.Size == 8 ? 80 : 68;
        int parentAt = IntPtr.Size == 8 ? 88 : 72;
        int length = 1 << 20;
        while (true)
        {
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                int needed;
                int status = NtQuerySystemInformation(SystemProcessInformation, buffer, length, out needed);
                if (status == InfoLengthMismatch)
                {
                    // Room for the processes started between this call and the next.
                    length = Math.Max(length * 2, needed + (1 << 16));
                    continue;
                }
                if (status != 0)
                {
                    throw new InvalidOperationException("NtQuerySystemInformation answered 0x" + status.ToString("X8", CultureInfo.InvariantCulture));
                }
                List<Entry> entries = new List<Entry>();
                long offset = 0;
                while (true)
                {
                    IntPtr at = new IntPtr(buffer.ToInt64() + offset);
                    Entry entry = new Entry();
                    entry.Created = Marshal.ReadInt64(at, 32);
                    entry.Processor = Marshal.ReadInt64(at, 40) + Marshal.ReadInt64(at, 48);
                    entry.Pid = (int)Marshal.ReadIntPtr(at, pidAt).ToInt64();
                    entry.Parent = (int)Marshal.ReadIntPtr(at, parentAt).ToInt64();
                    entries.Add(entry);
                    int next = Marshal.ReadInt32(at, 0);
                    if (next == 0)
                    {
                        return entries;
                    }
                    offset += next;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    // Zero for the few processes the kernel does not date, the idle process and System among them.
    private static string Milliseconds(long created)
    {
        long milliseconds = created > UnixEpoch ? (created - UnixEpoch) / 10000 : 0;
        return milliseconds.ToString(CultureInfo.InvariantCulture);
    }

    private static string Number(int value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }

    // The handle is to the listed process only if it started when the listing says, since a number
    // can be handed on between the listing and the open.
    private static IntPtr Open(Entry entry, int access)
    {
        IntPtr handle = OpenProcess(access, false, entry.Pid);
        if (handle == IntPtr.Zero)
        {
            return handle;
        }
        long created;
        long exited;
        long kernel;
        long user;
        if (!GetProcessTimes(handle, out created, out exited, out kernel, out user) || created != entry.Created)
        {
            CloseHandle(handle);
            return IntPtr.Zero;
        }
        return handle;
    }

    // Empty where the process will not be opened, which for another user's process is the usual
    // answer. On one line, so that a line break in it cannot pass for a process; a few system
    // processes carry a NUL in theirs.
    private static string CommandLineOf(IntPtr process)
    {
        int length = 4096;
        for (int tries = 0; tries < 4; tries++)
        {
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                int needed;
                int status = NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, length, out needed);
                if (status == InfoLengthMismatch || status == BufferTooSmall || status == BufferOverflow)
                {
                    length = Math.Max(needed, length * 2);
                    continue;
                }
                if (status != 0)
                {
                    return "";
                }
                int bytes = Marshal.ReadInt16(buffer, 0) & 0xFFFF;
                IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
                if (bytes == 0 || text == IntPtr.Zero)
                {
                    return "";
                }
                return Marshal.PtrToStringUni(text, bytes / 2).Replace('\r', ' ').Replace('\n', ' ').Replace('\0', ' ');
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        return "";
    }

    private static string CommandLineOf(Entry entry)
    {
        IntPtr handle = Open(entry, QueryLimitedInformation);
        if (handle == IntPtr.Zero)
        {
            return "";
        }
        try
        {
            return CommandLineOf(handle);
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    private static HashSet<int> Pids(string listed)
    {
        HashSet<int> pids = new HashSet<int>();
        foreach (string one in listed.Split(','))
        {
            int pid;
            if (int.TryParse(one.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out pid))
            {
                pids.Add(pid);
            }
        }
        return pids;
    }

    /// <summary>Every process as "pid parent started command", one a line.</summary>
    public static string Table()
    {
        StringBuilder said = new StringBuilder();
        foreach (Entry entry in Snapshot())
        {
            if (entry.Pid <= 0)
            {
                continue;
            }
            said.Append(Number(entry.Pid)).Append(' ').Append(Number(entry.Parent)).Append(' ')
                .Append(Milliseconds(entry.Created)).Append(' ').Append(CommandLineOf(entry)).Append('\n');
        }
        return said.ToString();
    }

    /// <summary>"pid started" for each of the comma-separated pids the kernel dates.</summary>
    public static string Starts(string pids)
    {
        HashSet<int> wanted = Pids(pids);
        StringBuilder said = new StringBuilder();
        foreach (Entry entry in Snapshot())
        {
            if (wanted.Contains(entry.Pid) && entry.Created > UnixEpoch)
            {
                said.Append(Number(entry.Pid)).Append(' ').Append(Milliseconds(entry.Created)).Append('\n');
            }
        }
        return said.ToString();
    }

    /// <summary>When the pid started and, on the next line, its command line; empty when it is not running.</summary>
    public static string One(int pid)
    {
        foreach (Entry entry in Snapshot())
        {
            if (entry.Pid == pid)
            {
                return Milliseconds(entry.Created) + "\n" + CommandLineOf(entry);
            }
        }
        return "";
    }

    /// <summary>The processor seconds the pid has used; empty when it is not running.</summary>
    public static string ProcessorSeconds(int pid)
    {
        foreach (Entry entry in Snapshot())
        {
            if (entry.Pid == pid)
            {
                return (entry.Processor / 1e7).ToString("R", CultureInfo.InvariantCulture);
            }
        }
        return "";
    }

    /// <summary>"pid seconds" on a line for each running one of the comma-separated pids, from one snapshot.</summary>
    public static string ProcessorSecondsOf(string pids)
    {
        HashSet<int> wanted = new HashSet<int>();
        foreach (string one in pids.Split(','))
        {
            int pid;
            if (int.TryParse(one, NumberStyles.Integer, CultureInfo.InvariantCulture, out pid))
            {
                wanted.Add(pid);
            }
        }
        StringBuilder said = new StringBuilder();
        foreach (Entry entry in Snapshot())
        {
            if (wanted.Contains(entry.Pid))
            {
                said.Append(Number(entry.Pid)).Append(' ')
                    .Append((entry.Processor / 1e7).ToString("R", CultureInfo.InvariantCulture)).Append('\n');
            }
        }
        return said.ToString();
    }

    /// <summary>How many more bytes Windows will commit.</summary>
    public static string CommitLeft()
    {
        MemoryStatus status = new MemoryStatus();
        status.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
        if (!GlobalMemoryStatusEx(ref status))
        {
            throw new InvalidOperationException("GlobalMemoryStatusEx failed with " + Number(Marshal.GetLastWin32Error()));
        }
        return status.AvailPageFile.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// "pid started command" for each dated child of the pid, holding a handle to each: Windows tells
    /// a process's exit code only to whoever holds a handle to it, and the handle keeps its number
    /// from going to anything else.
    /// </summary>
    public static string HoldChildren(int parent)
    {
        StringBuilder said = new StringBuilder();
        foreach (Entry entry in Snapshot())
        {
            if (entry.Parent != parent || entry.Pid <= 0 || entry.Created <= UnixEpoch || held.ContainsKey(entry.Pid))
            {
                continue;
            }
            IntPtr handle = Open(entry, QueryLimitedInformation | Synchronize);
            if (handle == IntPtr.Zero)
            {
                continue;
            }
            held[entry.Pid] = handle;
            said.Append(Number(entry.Pid)).Append(' ').Append(Milliseconds(entry.Created)).Append(' ')
                .Append(CommandLineOf(handle)).Append('\n');
        }
        return said.ToString();
    }

    /// <summary>"exit code" once a child held by HoldChildren has ended; empty for one not held.</summary>
    public static string WaitFor(int pid)
    {
        IntPtr handle;
        if (!held.TryGetValue(pid, out handle))
        {
            return "";
        }
        WaitForSingleObject(handle, 0xFFFFFFFF);
        int code;
        return GetExitCodeProcess(handle, out code) ? "exit " + Number(code) : "";
    }
}
`;

const TABLE = new CompiledHelper('process table', 'gdharness-processes', SOURCE);

/** The process table could not be compiled, which is why Windows was not asked. */
export class ProcessTableUnbuilt extends Error {}

/** Compiles the table unless it is there; a server starting up passes [param wait] false. */
export function ensureProcessTable(directory = tmpdir(), wait = true): Promise<string | null> {
  return TABLE.ensure(directory, HELPER_COMPILE_MS, wait);
}

/**
 * The PowerShell that loads the compiled table, for a script to call it after. Fails with why when
 * the table could not be compiled.
 */
export async function loadingTheTable(): Promise<string> {
  const failed = await ensureProcessTable();
  if (failed !== null) {
    throw new ProcessTableUnbuilt(failed);
  }
  return `$null = [Reflection.Assembly]::LoadFrom('${TABLE.assembly().replaceAll("'", "''")}')`;
}

/**
 * What [param call], a static method of `GdhProcessTable` with its arguments, answers, asked in the
 * shared PowerShell within [param withinMs].
 */
export async function askProcessTable(call: string, withinMs: number): Promise<string> {
  return await askWindows(`${await loadingTheTable()}; [GdhProcessTable]::${call}`, withinMs);
}
