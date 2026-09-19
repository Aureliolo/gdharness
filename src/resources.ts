import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { emptyRecord } from './dictionary.js';
import { Refusal } from './errors.js';
import { resolveWithinProject } from './paths.js';

const STATIC_RESOURCES = [
  {
    uri: 'godot://project/info',
    name: 'Project Info',
    description: 'Parsed Godot project.godot metadata as JSON.',
    mimeType: 'application/json',
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'godot://scene/{path}',
    name: 'Scene File',
    description: 'Read a Godot scene (.tscn) file from the current project.',
    mimeType: 'text/plain',
  },
  {
    uriTemplate: 'godot://script/{path}',
    name: 'GDScript File',
    description: 'Read a GDScript (.gd) file from the current project.',
    mimeType: 'text/x-gdscript',
  },
  {
    uriTemplate: 'godot://resource/{path}',
    name: 'Resource File',
    description: 'Read a project resource file (.tres, .tscn, .gd).',
    mimeType: 'text/plain',
  },
];

/**
 * How many `godot://` resources there are, counted rather than remembered.
 *
 * The README states this number about itself and nothing generates the README, so a resource
 * added or dropped would leave it quietly wrong.
 */
export const RESOURCE_COUNT = STATIC_RESOURCES.length + RESOURCE_TEMPLATES.length;

type ParsedGodotUri =
  | { kind: 'project-info' }
  | { kind: 'scene' | 'script' | 'resource'; resourcePath: string };

function ensureProjectPath(getProjectPath: () => string | null): string {
  const projectPath = getProjectPath();
  if (!projectPath) {
    throw new Refusal('Project path is not set. Set a Godot project path first.');
  }

  return resolve(projectPath);
}

/**
 * A URI pathname as a path inside the project.
 *
 * Only the shape of the thing is settled here, because where it lands is `resolveWithinProject`'s
 * question: a Windows client writes separators the other way round, and the pathname of
 * `godot://scene/scenes/main.tscn` arrives with the leading slash `URL` puts there.
 *
 * That slash is stripped here and nowhere else. This is the only place that knows the string came
 * out of a URL rather than off a caller's keyboard, and `resolveWithinProject` refuses anything
 * absolute so that it gives the same answer on every platform.
 */
function uriPathToProjectPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/').trim();
  if (normalized.replace(/\//g, '') === '') {
    throw new Refusal('Resource path is empty.');
  }

  return normalized.replace(/^\/+/, '');
}

function resolveProjectFile(projectPath: string, resourcePath: string): string {
  const contained = resolveWithinProject(projectPath, resourcePath);
  if (!contained.ok) {
    throw new Refusal(contained.reason);
  }

  return contained.absolutePath;
}

function parseGodotUri(uri: string): ParsedGodotUri {
  if (uri === 'godot://project/info') {
    return { kind: 'project-info' };
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Refusal(`Invalid URI: ${uri}`);
  }

  if (parsed.protocol !== 'godot:') {
    throw new Refusal(`Unsupported URI scheme: ${parsed.protocol}`);
  }

  const host = parsed.hostname;
  if (host !== 'scene' && host !== 'script' && host !== 'resource') {
    throw new Refusal(`Unsupported Godot resource type: ${host}`);
  }

  const resourcePath = uriPathToProjectPath(decodeURIComponent(parsed.pathname));

  return { kind: host, resourcePath };
}

function ensureAllowedExtension(kind: 'scene' | 'script' | 'resource', filePath: string): void {
  const extension = extname(filePath).toLowerCase();

  if (kind === 'scene' && extension !== '.tscn') {
    throw new Refusal('Scene resources must use .tscn extension.');
  }

  if (kind === 'script' && extension !== '.gd') {
    throw new Refusal('Script resources must use .gd extension.');
  }

  if (kind === 'resource' && !['.tres', '.tscn', '.gd'].includes(extension)) {
    throw new Refusal('Resource URIs support only .tres, .tscn, and .gd files.');
  }
}

// Godot writes dictionaries, arrays and Object(...) values across several lines, so a
// value is only finished once its brackets balance outside of a string.
function isValueComplete(value: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === '{' || character === '[' || character === '(') {
      depth += 1;
    } else if (character === '}' || character === ']' || character === ')') {
      depth -= 1;
    }
  }

  return depth <= 0 && !inString;
}

type IniValue = string | number | boolean | null;

/**
 * Every `section/key` a project.godot names, for comparing one reading of it against another.
 *
 * Keys and not values, because what is being looked for is a line that has gone. Godot writes only
 * what differs from its own defaults, so a key a project names deliberately *at* its default value
 * is redundant to the editor and is dropped the next time the editor saves. A project names one
 * there to keep "set to this on purpose" and "not set" apart, and the engine then picks a level
 * nobody chose, with nothing anywhere saying the line went.
 */
export function settingKeys(content: string): Map<string, IniValue> {
  const named = new Map<string, IniValue>();
  for (const [section, entries] of Object.entries(parseProjectGodot(content))) {
    for (const [key, value] of Object.entries(entries)) {
      named.set(`${section}/${key}`, value);
    }
  }
  return named;
}

export function parseProjectGodot(content: string): Record<string, Record<string, IniValue>> {
  const result: Record<string, Record<string, IniValue>> = emptyRecord();
  // Held rather than looked up again per key, so the section a value lands in is the one the
  // header created and not whatever indexing the record a second time happens to return.
  let section: Record<string, IniValue> = emptyRecord();
  result['root'] = section;

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      section = result[name] ?? emptyRecord();
      result[name] = section;
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let rawValue = line.slice(eqIndex + 1).trim();

    while (index + 1 < lines.length && !isValueComplete(rawValue)) {
      index += 1;
      rawValue += `\n${(lines[index] ?? '').trim()}`;
    }

    section[key] = parseIniLikeValue(rawValue);
  }

  return result;
}

function parseIniLikeValue(value: string): IniValue {
  if (value === 'null') {
    return null;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  // Past 2^53, or past what a double holds at all, the number no longer says what was written
  // and the text is the only faithful copy.
  if (/^-?\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }

  if (/^-?\d*\.\d+$/.test(value)) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : value;
  }

  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readResourceText(
  uri: string,
  getProjectPath: () => string | null,
): { mimeType: string; text: string } {
  const projectPath = ensureProjectPath(getProjectPath);
  const parsedUri = parseGodotUri(uri);

  if (parsedUri.kind === 'project-info') {
    const projectFilePath = resolveProjectFile(projectPath, 'project.godot');
    const rawProject = readFileSync(projectFilePath, 'utf-8');
    const parsedProject = parseProjectGodot(rawProject);

    return {
      mimeType: 'application/json',
      text: JSON.stringify(parsedProject, null, 2),
    };
  }

  const filePath = resolveProjectFile(projectPath, parsedUri.resourcePath);
  ensureAllowedExtension(parsedUri.kind, filePath);
  const text = readFileSync(filePath, 'utf-8');

  return {
    mimeType: parsedUri.kind === 'script' ? 'text/x-gdscript' : 'text/plain',
    text,
  };
}

export function setupResourceHandlers(mcp: McpServer, getProjectPath: () => string | null): void {
  // Registered on the low-level protocol object rather than through registerResource: the
  // godot:// space is a handful of hand-rolled URI templates, not the static list the
  // high-level helper builds.
  const server = mcp.server;

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: STATIC_RESOURCES,
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const uri = request.params.uri;

    try {
      const { mimeType, text } = readResourceText(uri, getProjectPath);

      return {
        contents: [
          {
            uri,
            mimeType,
            text,
          },
        ],
      };
    } catch (error) {
      // The cause carries the errno and the stack: ENOENT, EACCES and a symlink loop are
      // otherwise the same sentence by the time they reach the client.
      if (error instanceof Error) {
        throw new Refusal(`Failed to read resource '${uri}': ${error.message}`, { cause: error });
      }

      throw new Refusal(`Failed to read resource '${uri}'.`, { cause: error });
    }
  });
}
