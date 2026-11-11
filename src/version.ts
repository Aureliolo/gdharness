import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the installed version out of package.json.
 *
 * Two candidates because the bundle runs both from source (src/) and from the packed
 * release (build/), and package.json sits one level up in one case and two in the other.
 */
export function getLocalVersion(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const packageCandidates = [
    join(currentDirectory, '..', 'package.json'),
    join(currentDirectory, '..', '..', 'package.json'),
  ] as const;

  for (const packagePath of packageCandidates) {
    try {
      const value: unknown = JSON.parse(readFileSync(packagePath, 'utf-8'));
      if (
        typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        value.name === 'gdharness' &&
        'version' in value &&
        typeof value.version === 'string'
      ) {
        return value.version;
      }
    } catch {
      // Not a readable package.json at this candidate, so try the next one up.
    }
  }

  return '0.0.0';
}
