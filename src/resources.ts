import { readFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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

type ParsedGodotUri =
  | { kind: 'project-info' }
  | { kind: 'scene' | 'script' | 'resource'; resourcePath: string };

function ensureProjectPath(getProjectPath: () => string | null): string {
  const projectPath = getProjectPath();
  if (!projectPath) {
    throw new Error('Project path is not set. Set a Godot project path first.');
  }

  return resolve(projectPath);
}

function validateRelativePath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized) {
    throw new Error('Resource path is empty.');
  }

  if (normalized.includes('..')) {
    throw new Error('Invalid resource path: directory traversal is not allowed.');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Invalid resource path.');
  }

  return normalized;
}

function resolveProjectFile(projectPath: string, resourcePath: string): string {
  const fullPath = resolve(projectPath, resourcePath);
  const relativePath = relative(projectPath, fullPath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Resolved file path escapes project directory.');
  }

  return fullPath;
}

function parseGodotUri(uri: string): ParsedGodotUri {
  if (uri === 'godot://project/info') {
    return { kind: 'project-info' };
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid URI: ${uri}`);
  }

  if (parsed.protocol !== 'godot:') {
    throw new Error(`Unsupported URI scheme: ${parsed.protocol}`);
  }

  const host = parsed.hostname;
  if (host !== 'scene' && host !== 'script' && host !== 'resource') {
    throw new Error(`Unsupported Godot resource type: ${host}`);
  }

  const resourcePath = validateRelativePath(decodeURIComponent(parsed.pathname));

  return { kind: host, resourcePath };
}

function ensureAllowedExtension(kind: 'scene' | 'script' | 'resource', filePath: string): void {
  const extension = extname(filePath).toLowerCase();

  if (kind === 'scene' && extension !== '.tscn') {
    throw new Error('Scene resources must use .tscn extension.');
  }

  if (kind === 'script' && extension !== '.gd') {
    throw new Error('Script resources must use .gd extension.');
  }

  if (kind === 'resource' && !['.tres', '.tscn', '.gd'].includes(extension)) {
    throw new Error('Resource URIs support only .tres, .tscn, and .gd files.');
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
 * A dictionary safe to index with a name out of a file.
 *
 * Both the section names and the keys in project.godot are attacker-controlled text used
 * directly as object keys. On an ordinary object literal `[constructor]` resolves to the
 * Object function and `[__proto__]` to Object.prototype, so the parser would then write the
 * file's keys onto one of those instead of into its own result. Without a prototype there is
 * nothing behind the object for a name to reach.
 */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
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

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  if (/^-?\d*\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
        throw new Error(`Failed to read resource '${uri}': ${error.message}`, { cause: error });
      }

      throw new Error(`Failed to read resource '${uri}'.`, { cause: error });
    }
  });
}
