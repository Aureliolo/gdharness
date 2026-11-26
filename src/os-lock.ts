/**
 * Exclusive locks held by the operating system, which frees one when its process ends, however it
 * ends. The lock is LockFileEx on byte 0 with length 1 on Windows, an open file description lock
 * (fcntl F_OFD_SETLK, over the whole file) on Linux and flock on macOS. Node and Bun on Windows take
 * them through the prebuilt addon of fs-native-extensions, which the build copies beside the
 * bundle. Bun on Linux and macOS calls libc through bun:ffi instead, because the addon's POSIX code
 * answers a held lock with a libuv call Bun panics on. See `docs/test-runs.md` for how another
 * program locks the same file.
 */

import type { Pointer } from 'bun:ffi';
import { closeSync, existsSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

interface Binding {
  tryLock(fd: number, offset: number, length: number, exclusive: boolean): void;
  unlock(fd: number, offset: number, length: number): void;
}

/** The folder of the bundle's prebuilt addons, one folder a platform and architecture. */
export const PREBUILDS_FOLDER = 'prebuilds';
/** The platforms the build ships an addon for, as `<platform>-<architecture>`. */
export const PREBUILT_PLATFORMS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
/** The addon's file name inside each platform's folder. */
export const ADDON_FILE = 'fs-native-extensions.node';

let loaded: Binding | undefined;

/** Where the addon for this platform is: beside the bundle, else in the installed package. */
function addonPath(): string {
  const platform = `${process.platform}-${process.arch}`;
  const beside = join(dirname(fileURLToPath(import.meta.url)), PREBUILDS_FOLDER, platform, ADDON_FILE);
  if (existsSync(beside)) {
    return beside;
  }
  try {
    const installed = dirname(createRequire(import.meta.url).resolve('fs-native-extensions/package.json'));
    const found = join(installed, PREBUILDS_FOLDER, platform, ADDON_FILE);
    if (existsSync(found)) {
      return found;
    }
  } catch {
    // Not installed: the error below names the platform.
  }
  throw new Error(`File locks are not available on ${platform}: no prebuilt addon for it.`);
}

function isBinding(value: unknown): value is Binding {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tryLock' in value &&
    typeof value.tryLock === 'function' &&
    'unlock' in value &&
    typeof value.unlock === 'function'
  );
}

const EACCES = 13;
const F_OFD_SETLK = 37;
const F_WRLCK = 1;
const F_UNLCK = 2;
const LOCK_EX_NB = 6;
const LOCK_UN = 8;

/** A lock that is held answers like the addon's error, so one reading of it serves both. */
function heldError(): Error {
  return Object.assign(new Error('The file is locked by another descriptor.'), { code: 'EAGAIN' });
}

/**
 * Locks through libc, for Bun on Linux and macOS. The struct flock of Linux is the same on x64 and
 * arm64: type and whence as shorts, then start, length, and the owner's pid, which an open file
 * description lock needs to be 0.
 */
function isFfi(value: unknown): value is typeof import('bun:ffi') {
  return (
    typeof value === 'object' && value !== null && 'dlopen' in value && typeof value.dlopen === 'function'
  );
}

function libcBinding(): Binding {
  const loadedFfi: unknown = createRequire(import.meta.url)('bun:ffi');
  if (!isFfi(loadedFfi)) {
    throw new Error('bun:ffi does not offer dlopen.');
  }
  const { dlopen, FFIType, ptr, read } = loadedFfi;
  if (process.platform === 'linux') {
    const { symbols } = dlopen('libc.so.6', {
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    const setLock = (fd: number, type: number): number => {
      const flock = Buffer.alloc(32);
      flock.writeInt16LE(type, 0);
      return symbols.fcntl(fd, F_OFD_SETLK, ptr(flock));
    };
    return {
      tryLock(fd) {
        if (setLock(fd, F_WRLCK) !== 0) {
          failed(symbols.__errno_location(), 11, read.i32);
        }
      },
      unlock(fd) {
        setLock(fd, F_UNLCK);
      },
    };
  }
  const { symbols } = dlopen('libSystem.B.dylib', {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  return {
    tryLock(fd) {
      if (symbols.flock(fd, LOCK_EX_NB) !== 0) {
        failed(symbols.__error(), 35, read.i32);
      }
    },
    unlock(fd) {
      symbols.flock(fd, LOCK_UN);
    },
  };
}

/** Throws the held error for EAGAIN or EACCES, which [param errnoAt] points at, else a plain one. */
function failed(errnoAt: Pointer | bigint | null, eagain: number, readInt: (at: Pointer) => number): never {
  // Bun types a returned pointer as a bigint as well, which it is only when asked for one.
  const code = errnoAt === null || typeof errnoAt === 'bigint' ? 0 : readInt(errnoAt);
  if (code === eagain || code === EACCES) {
    throw heldError();
  }
  throw new Error(`The file lock failed with errno ${code}.`);
}

function binding(): Binding {
  if (loaded === undefined && 'bun' in process.versions && process.platform !== 'win32') {
    loaded = libcBinding();
  }
  if (loaded === undefined) {
    const holder: { exports: unknown } = { exports: {} };
    process.dlopen(holder, addonPath());
    if (!isBinding(holder.exports)) {
      throw new Error('The file lock addon does not offer tryLock and unlock.');
    }
    loaded = holder.exports;
  }
  return loaded;
}

/** A lock held on an open file, given up by {@link OsLock.release} or by the process ending. */
export interface OsLock {
  readonly path: string;
  release(): void;
}

/** The codes a lock held by another descriptor or process answers with, by platform. */
const HELD_CODES = new Set(['EAGAIN', 'EBUSY', 'EACCES', 'EWOULDBLOCK']);

/**
 * Takes an exclusive lock on the file at [param path], making it empty where it is
 * not there, and answers it, or null while another descriptor or process holds it. Nothing is
 * written to the file.
 */
export function tryOsLock(path: string): OsLock | null {
  const api = binding();
  const fd = openSync(path, 'a+');
  try {
    api.tryLock(fd, 0, process.platform === 'win32' ? 1 : 0, true);
  } catch (error) {
    closeSync(fd);
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && HELD_CODES.has(code)) {
      return null;
    }
    throw error;
  }
  let released = false;
  return {
    path,
    release() {
      if (released) {
        return;
      }
      released = true;
      try {
        api.unlock(fd, 0, process.platform === 'win32' ? 1 : 0);
      } catch {
        // Closing the descriptor frees the lock as well.
      }
      closeSync(fd);
    },
  };
}
