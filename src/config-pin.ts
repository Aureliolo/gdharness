import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The gdharness version a project's own MCP config asks for.
 *
 * Three versions are in play around a project and only two of them were ever reported. The addon
 * installed in the project is one, and `installedAddonVersion` reads it. The server answering is
 * another, and it says so. The third is the version the config names, which is what the client
 * will fetch the next time it spawns a server, and nothing looked at it at all.
 *
 * That gap is not hypothetical. A downstream project moved its pin, ran its reconnect twice, and
 * got a 0.12.18 server both times, because the file that names the version to fetch was not the
 * file the pin lives in. Two sessions and a day went into working out which of the two was lying,
 * and neither was: nobody had compared them. One call saying "the config beside me names 0.12.18
 * and I am 0.12.18, while you believe you pinned 0.13.2" would have ended it immediately.
 *
 * Only `.mcp.json`, and only an exact version. A tag such as `gdharness@latest` names no version
 * to disagree with, and a config that pins nothing is a config with nothing to say.
 */
const PINNED = /\bgdharness@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g;

/**
 * Every exact gdharness version named anywhere in the project's `.mcp.json`.
 *
 * The whole file as text rather than a walk of the object it parses, because what names the
 * version differs by client and by how somebody wrote it: an `args` list, a `command` line, an
 * `env` entry. The version is in the text either way, and a regular expression over the text
 * cannot be wrong about a shape it has not been taught.
 *
 * Parsed first all the same, so a file that is not JSON is read as no answer rather than as
 * whatever its text happens to contain.
 */
function versionsNamedInConfig(projectPath: string): readonly string[] {
  const config = join(projectPath, '.mcp.json');
  if (!existsSync(config)) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(config, 'utf8');
    JSON.parse(text);
  } catch {
    return [];
  }
  return [...new Set([...text.matchAll(PINNED)].map((found) => found[1] ?? ''))].filter(
    (version) => version !== '',
  );
}

/**
 * What to say when the config names a version this server is not, or null when there is nothing
 * to say. Naming both, because which of the two is wrong is the user's to decide: a config left
 * behind after an upgrade, or a server still running from before the config changed.
 */
export function configDisagrees(projectPath: string, serverVersion: string): string | null {
  const named = versionsNamedInConfig(projectPath);
  const others = named.filter((version) => version !== serverVersion);
  if (others.length === 0) {
    return null;
  }
  return (
    `.mcp.json in this project names gdharness@${others.join(' and gdharness@')}, and this server ` +
    `is ${serverVersion}. Whichever is meant to be right, nothing will change version until the ` +
    'MCP server is reconnected, and a pin kept anywhere else does not reach this file.'
  );
}
