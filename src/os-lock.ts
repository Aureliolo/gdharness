/**
 * Exclusive locks held by the operating system, which frees one when its process ends, however it
 * ends. The lock is LockFileEx on byte 0 with length 1 on Windows, an open file description lock
 * (fcntl F_OFD_SETLK, which flock does not exclude) on Linux and flock on macOS, taken through the prebuilt addon of fs-native-extensions
 * that the build copies beside the bundle (see `docs/test-runs.md` for how another program locks
 * the same file).
 */

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

function binding(): Binding {
  if (loaded === undefined) {
    const holder = { exports: {} as Binding };
    process.dlopen(holder, addonPath());
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
    const code = (error as { code?: unknown }).code;
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
