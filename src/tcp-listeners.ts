/**
 * The process listening on a TCP port, read from Windows' own TCP table.
 *
 * A Windows 11 preview build (10.0.26300) gives some listening sockets the state 0 in its TCP table,
 * which is no state at all. netstat leaves those rows out, and Get-NetTCPConnection shows them with
 * an empty state, so a port this very process listened on read as nobody's. The table is read here
 * through GetExtendedTcpTable, and a row counts as the listener when it is in the listening state, or
 * has the state 0 and no remote end. Bun reaches the table through bun:ffi. Node cannot call it, so
 * there this answers nothing and netstat is asked instead.
 */

import process from 'node:process';

const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_PID_ALL = 5;
const NO_ERROR = 0;
const LISTENING = 2;
/** What the preview build gives a listening socket. */
const NO_STATE = 0;

/** One row's fields, as numbers: its state, its local and remote ports, and its pid. */
interface Row {
  readonly state: number;
  readonly localPort: number;
  readonly remotePort: number;
  readonly pid: number;
}

/** A port as the table stores it: in network byte order, in the low two bytes of a DWORD. */
function portOf(stored: number): number {
  return ((stored & 0xff) << 8) | ((stored >>> 8) & 0xff);
}

/**
 * The rows of one table, given its DWORDs: the row count first, then [param width] DWORDs a row,
 * with each field at the index [param at] names.
 */
export function rowsOf(
  table: Uint32Array,
  width: number,
  at: {
    readonly state: number;
    readonly localPort: number;
    readonly remotePort: number;
    readonly pid: number;
  },
): Row[] {
  const count = table[0] ?? 0;
  const rows: Row[] = [];
  for (let row = 0; row < count && 1 + (row + 1) * width <= table.length; row += 1) {
    const base = 1 + row * width;
    rows.push({
      state: table[base + at.state] ?? 0,
      localPort: portOf(table[base + at.localPort] ?? 0),
      remotePort: portOf(table[base + at.remotePort] ?? 0),
      pid: table[base + at.pid] ?? 0,
    });
  }
  return rows;
}

/**
 * The pid listening on [param port] among [param rows], a listening row before a row with no state.
 * Null when the rows of the kind that counts name more than one process: a row carries no address,
 * so nothing here says which of two listeners on different addresses is the one asked about.
 */
export function listenerAmong(rows: readonly Row[], port: number): number | null {
  const onPort = rows.filter((row) => row.localPort === port);
  const listening = onPort.filter((row) => row.state === LISTENING);
  const holders = new Set(
    (listening.length > 0
      ? listening
      : onPort.filter((row) => row.state === NO_STATE && row.remotePort === 0)
    ).map((row) => row.pid),
  );
  const [only] = holders;
  return holders.size === 1 ? (only ?? null) : null;
}

/** IPv4 rows are six DWORDs, IPv6 rows fourteen, with the fields in these places. */
export const LAYOUTS = [
  { family: AF_INET, width: 6, at: { state: 0, localPort: 2, remotePort: 4, pid: 5 } },
  { family: AF_INET6, width: 14, at: { state: 12, localPort: 5, remotePort: 11, pid: 13 } },
] as const;

/**
 * The pid listening on [param port], read from the TCP table, or null where the table cannot be
 * read from here or names nobody.
 */
export async function tableListener(port: number): Promise<number | null> {
  if (process.platform !== 'win32' || !('bun' in process.versions)) {
    return null;
  }
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const iphlpapi = dlopen('iphlpapi.dll', {
      GetExtendedTcpTable: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.bool, FFIType.u32, FFIType.u32, FFIType.u32],
        returns: FFIType.u32,
      },
    });
    try {
      const rows: Row[] = [];
      for (const { family, width, at } of LAYOUTS) {
        const size = new Uint32Array(1);
        iphlpapi.symbols.GetExtendedTcpTable(null, ptr(size), false, family, TCP_TABLE_OWNER_PID_ALL, 0);
        // Room for the connections opened between asking the size and reading the table.
        const table = new Uint32Array(Math.ceil((size[0] ?? 0) / 4) + width * 64);
        size[0] = table.byteLength;
        const read = iphlpapi.symbols.GetExtendedTcpTable(
          ptr(table),
          ptr(size),
          false,
          family,
          TCP_TABLE_OWNER_PID_ALL,
          0,
        );
        if (read === NO_ERROR) {
          rows.push(...rowsOf(table, width, at));
        }
      }
      return listenerAmong(rows, port);
    } finally {
      iphlpapi.close();
    }
  } catch {
    return null;
  }
}
