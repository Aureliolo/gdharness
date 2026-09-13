/**
 * Where a Godot executable might be when nothing names one.
 *
 * The list is ordered: the conventional install paths first, then whatever a scan of the
 * directories a release download lands in turns up, newest first. It is a pure function of the
 * platform and the home directory so that the order can be asserted without a machine laid out
 * a particular way; the caller runs each candidate and takes the first that answers --version.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The user's home directory, or an empty string when there is not one.
 *
 * `homedir()` reads HOME or USERPROFILE and falls back to the OS user database, so it answers
 * in cases a bare environment read does not. It can still come back empty, and every caller
 * has to treat that as "skip the home-relative candidates" rather than build a path from it.
 * Interpolating the miss once produced candidates beginning with the literal text "undefined",
 * which the detector then stat'd and scanned, and the only symptom was detection failing for
 * no stated reason.
 */
export function resolveHomeDirectory(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}

/**
 * Every Godot binary in one directory, newest first.
 *
 * Release downloads are named `Godot_v4.4.1-stable_win64.exe` or `Godot_v4.3-stable_linux.x86_64`,
 * which no fixed list of paths can name, so the directory is read for anything that starts with
 * the engine's name. Newest first so that the most recently installed build is the one tried.
 */
export function scanDirectoryForGodotBinaries(directory: string, platform: NodeJS.Platform): string[] {
  if (!directory || !existsSync(directory)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  // A download directory also holds the archive the binary came out of, and on a shared drive
  // the other platform's build; neither answers --version, so neither is worth the spawn.
  const pattern = platform === 'win32' ? /^godot.*\.exe$/i : /^godot(?!.*\.(?:exe|zip)$)/i;

  const matches: { name: string; mtime: number }[] = [];
  for (const name of entries) {
    if (!pattern.test(name)) {
      continue;
    }
    const fullPath = join(directory, name);
    try {
      const stat = statSync(fullPath);
      if (stat.isFile()) {
        matches.push({ name, mtime: stat.mtimeMs });
      }
    } catch {
      // An entry that cannot be stat'd is not a binary this can run.
    }
  }

  matches.sort((a, b) => b.mtime - a.mtime);
  return matches.map((m) => join(directory, m.name));
}

/** The install paths worth trying by name, before any directory is read. */
function conventionalPaths(platform: NodeJS.Platform, home: string): string[] {
  const paths = ['godot'];

  if (platform === 'darwin') {
    paths.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      '/Applications/Godot_4.app/Contents/MacOS/Godot',
    );
    if (home) {
      paths.push(
        `${home}/Applications/Godot.app/Contents/MacOS/Godot`,
        `${home}/Applications/Godot_4.app/Contents/MacOS/Godot`,
        `${home}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`,
      );
    }
  } else if (platform === 'win32') {
    paths.push(
      'C:\\Program Files\\Godot\\Godot.exe',
      'C:\\Program Files (x86)\\Godot\\Godot.exe',
      'C:\\Program Files\\Godot_4\\Godot.exe',
      'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
    );
    if (home) {
      paths.push(`${home}\\Godot\\Godot.exe`);
    }
  } else if (platform === 'linux') {
    paths.push('/usr/bin/godot', '/usr/local/bin/godot', '/snap/bin/godot');
    if (home) {
      paths.push(`${home}/.local/bin/godot`);
    }
  }

  return paths;
}

/** The directories a release download is likely to have been left in. */
function downloadDirectories(platform: NodeJS.Platform, home: string): string[] {
  const directories: string[] = [];

  if (platform === 'win32') {
    directories.push(
      'C:\\Program Files\\Godot',
      'C:\\Program Files (x86)\\Godot',
      'C:\\Program Files\\Godot_4',
      'C:\\Program Files (x86)\\Godot_4',
    );
    if (home) {
      directories.push(`${home}\\Godot`, `${home}\\Downloads`, `${home}\\Desktop`);
    }
  } else if (platform === 'darwin') {
    directories.push('/Applications');
    if (home) {
      directories.push(`${home}/Applications`);
    }
  } else if (platform === 'linux') {
    directories.push('/usr/bin', '/usr/local/bin', '/snap/bin');
    if (home) {
      directories.push(`${home}/.local/bin`, `${home}/Downloads`, `${home}/Desktop`);
    }
  }

  return directories;
}

/** Every path worth asking for --version, in the order to ask. */
export function godotCandidates(platform: NodeJS.Platform, home: string): string[] {
  return [
    ...conventionalPaths(platform, home),
    ...downloadDirectories(platform, home).flatMap((directory) =>
      scanDirectoryForGodotBinaries(directory, platform),
    ),
  ];
}
