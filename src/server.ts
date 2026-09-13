/**
 * The MCP server: one tool call in, one answer out.
 *
 * Every tool is answered by one of four things. A headless operation runs the engine on the
 * project with the operations script and answers with its JSON; the editor addon answers over
 * the bridge; a running game answers over the runtime socket; and a few are answered here, by
 * reading the project directory or driving a game process. Which is which is decided in
 * `dispatch`, and the arguments have been checked against the tool's spec before it is reached.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { GodotDAPClient, handleDAPTool } from './dap_client.js';
import { dictionary, emptyRecord } from './dictionary.js';
import { errorMessage } from './errors.js';
import { GameLog } from './game-log.js';
import { type GodotBridge, getDefaultBridge } from './godot-bridge.js';
import { GodotLocator } from './godot-path.js';
import { type HeadlessOutcome, runOperation } from './headless.js';
import { parseJUnit, type TestReport } from './junit.js';
import { editorArguments, envValue, resolveHeadless, runArguments } from './launch.js';
import { GodotLSPClient, handleLSPTool } from './lsp_client.js';
import { resolveWithinProject } from './paths.js';
import { findGodotProjects, projectStructure, searchProject } from './project-scan.js';
import { parseProjectGodot, setupResourceHandlers } from './resources.js';
import { chooseRuntime, discoverRuntimes, runtimeRequest } from './runtime-client.js';
import type {
  GodotProcess,
  MCPToolDefinition,
  OperationParams,
  SpawnedGame,
  ToolResponse,
} from './server-types.js';
import { DEBUG_MODE, GODOT_DEBUG_MODE_DEFAULT, SERVER_VERSION } from './server-version.js';
import {
  asParams,
  readArray,
  readBoolean,
  readNonEmptyString,
  readNumber,
  readPositiveNumber,
  readString,
  readStringArray,
} from './tool-args.js';
import { buildToolDefinitions, TOOL_SPECS, type ToolSpec, toolSpec } from './tool-definitions.js';

// execFile, not exec: no shell means no quoting, and no quoting means no way to escape out
// of it. Every argument below is an array element, so a path full of backslashes, spaces or
// quotes is just a path.
const run = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Long enough for an editor to save, close, start again and rescan a large project.
 *
 * Not longer: an editor that has not come back by now is stuck on something a person has to
 * look at, usually a dialog, and saying so beats holding the caller's call open in silence.
 */
const EDITOR_RESTART_TIMEOUT_MS = 90_000;

/** What to tell a caller whose file, scene, script or resource path landed outside the project. */
const PATH_SOLUTIONS = [
  'Give the path relative to the project, such as "scenes/main.tscn" or "res://scenes/main.tscn"',
  'Point projectPath at the project the file belongs to',
];

/**
 * The arguments that name a file inside the project, on every tool that has them. Each is
 * judged before the engine or the editor sees it and handed over as the `res://` path the
 * project knows it by: both read `../outside.tscn` as a file to open and an absolute path as a
 * project file, so the boundary belongs on this side.
 */
const PROJECT_FILE_ARGUMENTS = [
  'scenePath',
  'scriptPath',
  'resourcePath',
  'texturePath',
  'newPath',
  'path',
  'script',
];

/** The headless operation behind each tool and op that needs neither the editor nor a game. */
export const HEADLESS_OPERATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = dictionary({
  project_settings: dictionary({
    get: 'get_project_setting',
    set: 'set_project_setting',
    add_autoload: 'add_autoload',
    remove_autoload: 'remove_autoload',
    set_main_scene: 'set_main_scene',
    add_input_action: 'add_input_action',
    enable_plugin: 'enable_plugin',
    disable_plugin: 'disable_plugin',
    add_audio_bus: 'create_audio_bus',
    set_audio_bus_effect: 'set_audio_bus_effect',
    set_audio_bus_volume: 'set_audio_bus_volume',
  }),
  project_import: dictionary({
    status: 'get_import_status',
    options: 'get_import_options',
    set_options: 'set_import_options',
    reimport: 'reimport_resource',
    uid: 'get_uid',
    refresh_uids: 'resave_resources',
    refresh_classes: 'refresh_class_cache',
  }),
  project_export: dictionary({ list: 'list_export_presets' }),
  script_edit: dictionary({ create: 'create_script', modify: 'modify_script' }),
  script_info: dictionary({ structure: 'get_script_info' }),
  editor_classes: dictionary({
    query: 'query_classes',
    info: 'query_class_info',
    inheritance: 'inspect_inheritance',
  }),
});

/** The sections project_info can add, each a headless operation, with what it is asked. */
const PROJECT_INFO_SECTIONS: Readonly<
  Record<string, { operation: string; params: (args: OperationParams, detailed: boolean) => OperationParams }>
> = dictionary({
  autoloads: { operation: 'list_autoloads', params: () => ({}) },
  plugins: { operation: 'list_plugins', params: () => ({}) },
  export_presets: { operation: 'list_export_presets', params: () => ({}) },
  audio_buses: { operation: 'get_audio_buses', params: () => ({}) },
  health: { operation: 'get_project_health', params: () => ({}) },
  validation: {
    operation: 'validate_project',
    params: (args, detailed) => ({ preset: readString(args, 'preset') ?? '', includeSuggestions: detailed }),
  },
});

/** The path with every symlink on it resolved, or the path itself when there is nothing there. */
function realPathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Whether project.godot names a scene for the game to start in. */
function hasMainScene(projectFile: string): boolean {
  const scene = parseProjectGodot(readFileSync(projectFile, 'utf8'))['application']?.['run/main_scene'];
  return typeof scene === 'string' && scene !== '';
}

/**
 * Whether the editor would play this project without a window.
 *
 * The editor appends `editor/run/main_run_args` to the game it starts, so a project that carries
 * `--headless` there is one the editor plays headless. It is the only way a game the editor owns
 * can be known to open no window, and it is what lets a headless request still go through the
 * editor, which is the only route with a debugger attached.
 */
function editorPlaysHeadless(projectFile: string): boolean {
  const runArgs = parseProjectGodot(readFileSync(projectFile, 'utf8'))['editor']?.['run/main_run_args'];
  return typeof runArgs === 'string' && /(?:^|\s)--headless(?:\s|$)/.test(runArgs);
}

/**
 * Tool arguments with their keys in camelCase, whichever spelling the client used. Only the
 * arguments themselves: what they hold (node properties, import options, a setting value) is
 * the engine's own vocabulary, where `custom_minimum_size` has to stay as it is.
 */
function camelCased(params: unknown): OperationParams {
  // The keys are the `arguments` member of a tools/call, straight off the wire. JSON.parse
  // makes `__proto__` an own enumerable property, so it survives the hasOwn guard below and
  // a write to it would re-parent this object onto caller-supplied data rather than store a key.
  const result: OperationParams = emptyRecord();
  const source = asParams(params);
  for (const key of Object.keys(source)) {
    const name = key.startsWith('_')
      ? key
      : key.replace(/_([a-zA-Z0-9])/g, (_, letter: string) => letter.toUpperCase());
    result[name] = source[key];
  }
  return result;
}

type Checked<T> = { ok: true; value: T } | { ok: false; response: ToolResponse };

class GodotServer {
  // Registration goes through the protocol object rather than McpServer's registerTool: the
  // schemas are authored as data in tool-definitions.ts and validated against the same data
  // before dispatch, which is the "advanced use case" McpServer's own docs point at `.server` for.
  private readonly mcp: McpServer;
  private readonly locator = new GodotLocator();
  private readonly operationsScript = join(__dirname, 'godot', 'operations', 'godot_operations.gd');
  private readonly godotBridge: GodotBridge;
  private readonly tools: MCPToolDefinition[] = buildToolDefinitions();
  private activeProcess: GodotProcess | null = null;
  private lspClient: GodotLSPClient | null = null;
  private dapClient: GodotDAPClient | null = null;
  private bridgeStartupError: string | null = null;
  private lastProjectPath: string | null = null;
  private shutdownInitiated = false;

  constructor() {
    this.godotBridge = getDefaultBridge();
    this.mcp = new McpServer(
      { name: 'gdharness', version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } },
    );
    this.setupToolHandlers();
    setupResourceHandlers(this.mcp, () => this.lastProjectPath);
    this.mcp.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };
    this.setupShutdownHandlers();
  }

  /** Debug lines go to stderr, since stdout is the JSON-RPC stream. */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  private createErrorResponse(message: string, possibleSolutions: string[] = []): ToolResponse {
    console.error(`[SERVER] Error response: ${message}`);
    const response: ToolResponse = { content: [{ type: 'text', text: message }], isError: true };
    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: `Possible solutions:\n- ${possibleSolutions.join('\n- ')}`,
      });
    }
    return response;
  }

  private jsonTextResponse(payload: unknown): ToolResponse {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  async run(): Promise<void> {
    const godotPath = await this.locator.find();
    if (godotPath === null) {
      console.error(
        '[SERVER] No Godot found. Set GODOT_PATH; until then every tool that runs the engine will say so.',
      );
    } else {
      console.error(`[SERVER] Using Godot at: ${godotPath}`);
    }

    const transport = new StdioServerTransport();
    await this.mcp.server.connect(transport);
    process.stdin.once('end', () => {
      void this.handleShutdown('stdin:end', 0);
    });
    console.error('gdharness running on stdio');

    // A bridge that cannot bind must not take the stdio server down with it: the tools that
    // need no editor still work, and editor_status says what happened.
    try {
      await this.godotBridge.start();
      this.bridgeStartupError = null;
      const bridgeStatus = this.godotBridge.getStatus();
      console.error(`[SERVER] Godot Editor Bridge started on ${bridgeStatus.host}:${bridgeStatus.port}`);
    } catch (bridgeError) {
      const code =
        bridgeError instanceof Error && 'code' in bridgeError && typeof bridgeError.code === 'string'
          ? bridgeError.code
          : null;
      const reason = errorMessage(bridgeError);
      this.bridgeStartupError = code && !reason.includes(code) ? `${code}: ${reason}` : reason;
      console.error(`[SERVER] Warning: Godot Editor Bridge failed to start: ${this.bridgeStartupError}`);
      console.error('[SERVER] Continuing without bridge-backed editor tools.');
    }
  }

  private async cleanup(): Promise<void> {
    this.logDebug('Cleaning up resources');
    if (this.activeProcess) {
      // Killed rather than stopped through the editor: a shutdown cannot wait on a round trip,
      // and a game the editor plays outlives this server anyway, which is the editor's to end.
      this.activeProcess.process?.kill();
      this.activeProcess = null;
    }
    // Each of these is allowed to fail without stopping the rest of the shutdown, but a
    // failure has to leave a trace: a stop that did not release the language server port is
    // indistinguishable from one that did until the next run cannot bind.
    if (this.lspClient) {
      try {
        await this.lspClient.disconnect();
      } catch (error) {
        this.logDebug(`LSP client did not disconnect cleanly: ${errorMessage(error)}`);
      }
      this.lspClient = null;
    }
    if (this.dapClient) {
      try {
        await this.dapClient.disconnect();
      } catch (error) {
        this.logDebug(`DAP client did not disconnect cleanly: ${errorMessage(error)}`);
      }
      this.dapClient = null;
    }
    try {
      await this.godotBridge.stop();
    } catch (error) {
      this.logDebug(`Godot bridge did not stop cleanly: ${errorMessage(error)}`);
    }
    await this.mcp.server.close();
  }

  private setupShutdownHandlers(): void {
    const requestShutdown = (source: string, exitCode?: number): void => {
      void this.handleShutdown(source, exitCode);
    };
    process.once('SIGINT', () => {
      requestShutdown('SIGINT', 0);
    });
    process.once('SIGTERM', () => {
      requestShutdown('SIGTERM', 0);
    });
    process.once('SIGHUP', () => {
      requestShutdown('SIGHUP', 0);
    });
    process.once('beforeExit', (code: number) => {
      requestShutdown(`beforeExit:${code}`);
    });
    process.once('exit', () => {
      this.forceCleanupOnExit();
    });
  }

  private async handleShutdown(source: string, exitCode?: number): Promise<void> {
    if (this.shutdownInitiated) {
      return;
    }
    this.shutdownInitiated = true;
    this.logDebug(`Shutting down server via ${source}`);
    try {
      await this.cleanup();
    } catch (error) {
      console.error(`[SERVER] Shutdown cleanup failed (${source}):`, error);
    } finally {
      if (typeof exitCode === 'number') {
        process.exit(exitCode);
      }
    }
  }

  private forceCleanupOnExit(): void {
    if (this.shutdownInitiated) {
      return;
    }
    this.shutdownInitiated = true;
    // 'exit' runs synchronously and the process is gone the moment this returns, so the child
    // kill is the only thing that can still happen here. The bridge's close is a promise that
    // would never settle, and the sockets go with the process anyway; the paths that can
    // await it are SIGINT, SIGTERM, SIGHUP and beforeExit, which all go through cleanup().
    if (this.activeProcess) {
      try {
        this.activeProcess.process?.kill();
      } catch (error) {
        console.error('[SERVER] Failed to kill the Godot process on exit:', errorMessage(error));
      }
      this.activeProcess = null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------------

  private setupToolHandlers(): void {
    this.mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.tools }));
    this.mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      const spec = toolSpec(request.params.name);
      if (!spec) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}. Tools: ${TOOL_SPECS.map((tool) => tool.name).join(', ')}`,
        );
      }

      const args = camelCased(request.params.arguments);
      const checked = this.validateArguments(spec, args);
      if (!checked.ok) {
        return checked.response;
      }
      if (typeof args['projectPath'] === 'string') {
        this.lastProjectPath = args['projectPath'];
      }
      return await this.dispatch(spec.name, checked.op ?? '', args);
    });
  }

  /**
   * The arguments of a call checked against the tool's spec: nothing the schema does not name,
   * an op from the enum, and every argument the tool and its op require. Returns the op to
   * dispatch on, or the refusal to send back. Own properties only: a required argument
   * satisfied by something inherited from Object.prototype is not supplied.
   */
  private validateArguments(
    spec: ToolSpec,
    args: OperationParams,
  ): { ok: true; op: string | null } | { ok: false; response: ToolResponse } {
    const known = new Set([...Object.keys(spec.parameters), ...(spec.operations ? ['op'] : [])]);
    const unknown = Object.keys(args).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        response: this.createErrorResponse(
          `${spec.name} does not take ${unknown.join(', ')}. It takes: ${[...known].join(', ')}.`,
        ),
      };
    }

    let op: string | null = null;
    if (spec.operations) {
      const valid = Object.keys(spec.operations);
      const requested = args['op'];
      if (requested === undefined) {
        if (!spec.defaultOperation) {
          return {
            ok: false,
            response: this.createErrorResponse(`${spec.name} needs op, one of: ${valid.join(', ')}.`),
          };
        }
        op = spec.defaultOperation;
      } else if (typeof requested === 'string' && Object.hasOwn(spec.operations, requested)) {
        op = requested;
      } else {
        return {
          ok: false,
          response: this.createErrorResponse(
            `${spec.name} has no op ${JSON.stringify(requested)}. Valid ops: ${valid.join(', ')}.`,
          ),
        };
      }
    }

    const required = [...spec.requires, ...(op !== null ? (spec.operations?.[op]?.requires ?? []) : [])];
    const missing = required.filter((field) => {
      const value = Object.hasOwn(args, field) ? args[field] : undefined;
      return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    });
    if (missing.length > 0) {
      const where = op !== null ? `${spec.name} ${op}` : spec.name;
      return { ok: false, response: this.createErrorResponse(`${where} needs ${missing.join(', ')}.`) };
    }
    return { ok: true, op };
  }

  /**
   * One tool call to the code that does it. The editor addon and the runtime addon keep their
   * command names, so an op that renamed an argument hands it over under the old name here.
   * `op` is empty for a tool that has none.
   */
  private async dispatch(tool: string, op: string, args: OperationParams): Promise<ToolResponse> {
    const headless = HEADLESS_OPERATIONS[tool]?.[op];
    if (headless !== undefined) {
      return await this.headless(headless, args);
    }

    const { op: _op, ...arguments_ } = args;
    const bridge = async (command: string, extra: OperationParams = {}): Promise<ToolResponse> => {
      const contained = this.containProjectFiles({ ...arguments_, ...extra });
      return contained.ok ? await this.handleViaBridge(command, contained.value) : contained.response;
    };

    switch (tool) {
      case 'project_list':
        return this.handleListProjects(args);
      case 'project_info':
        return await this.handleProjectInfo(args);
      case 'project_search':
        return this.handleSearchProject(args);
      case 'project_dependencies':
        return await this.headless(
          args['direction'] === 'reverse' ? 'find_resource_usages' : 'get_dependencies',
          args,
        );
      case 'project_export':
        return await this.handleExportProject(args);
      case 'project_test':
        return await this.handleRunTests(args);

      case 'scene_create':
        return op === 'create' ? await bridge('create_scene') : await bridge('save_scene');
      case 'scene_tree':
        return await bridge('list_scene_nodes');
      case 'scene_node':
        switch (op) {
          case 'add':
            return await bridge('add_node');
          case 'get':
            return await bridge('get_node_properties');
          case 'set':
            return await bridge('set_node_properties');
          case 'duplicate':
            return await bridge('duplicate_node', { parentPath: args['parentNodePath'] });
          case 'reparent':
            return await bridge('reparent_node');
          case 'delete':
            return await bridge('delete_node');
          case 'load_sprite':
            return await bridge('load_sprite');
          default:
            return await bridge('set_tilemap_cells', { tilemapNodePath: args['nodePath'] });
        }
      case 'scene_signal':
        switch (op) {
          case 'connect':
            return await bridge('connect_signal');
          case 'disconnect':
            return await bridge('disconnect_signal');
          default:
            return await bridge('list_connections');
        }
      case 'scene_animation':
        switch (op) {
          case 'create':
            return await bridge('create_animation');
          case 'add_track':
            return await bridge('add_animation_track');
          case 'add_state':
            return await bridge('add_animation_state');
          default:
            return await bridge('connect_animation_states');
        }

      case 'script_info':
        switch (op) {
          case 'symbols':
            return await this.handleLSP('lsp_get_symbols', args);
          case 'completion':
            return await this.handleLSP('lsp_get_completions', args);
          default:
            return await this.handleLSP('lsp_get_hover', args);
        }
      case 'script_diagnostics':
        return await this.handleScriptDiagnostics(args);

      case 'resource_edit':
        switch (op) {
          case 'create':
            return await bridge('create_resource');
          case 'modify':
            return await bridge('modify_resource');
          case 'create_shader':
            return await bridge('create_shader', { shaderPath: args['resourcePath'] });
          case 'create_tileset':
            return await bridge('create_tileset', { tilesetPath: args['resourcePath'] });
          case 'set_theme_color':
            return await bridge('set_theme_color', { themePath: args['resourcePath'] });
          default:
            return await bridge('set_theme_font_size', { themePath: args['resourcePath'] });
        }

      case 'editor_launch':
        return op === 'restart' ? await this.handleRestartEditor() : await this.handleLaunchEditor(args);
      case 'editor_run':
        return await this.handleRunProject(args, op);
      case 'editor_stop':
        return await this.handleStopProject();
      case 'editor_output':
        return this.handleGetDebugOutput(args);
      case 'editor_status':
        return await this.handleEditorStatus();
      case 'editor_rescan':
        return await this.handleRescanFilesystem(args);

      case 'runtime_inspect':
        switch (op) {
          case 'tree':
            return await this.handleRuntimeCommand('get_tree', {
              projectPath: args['projectPath'],
              root: readNonEmptyString(args, 'nodePath') ?? '/root',
              depth: readPositiveNumber(args, 'depth') ?? 3,
              include_properties: readBoolean(args, 'includeProperties') ?? false,
            });
          case 'find':
            return await this.handleFindRuntimeNodes(args);
          case 'rect':
            return await this.handleRuntimeCommand('get_rect', {
              projectPath: args['projectPath'],
              path: readNonEmptyString(args, 'nodePath') ?? '',
            });
          default:
            return await this.handleRuntimeCommand('get_metrics', {
              projectPath: args['projectPath'],
              metrics: readArray(args, 'metrics') ?? [],
            });
        }
      case 'runtime_invoke':
        // The value and the arguments are fitted to the property's or the method's own types
        // on the game's side.
        return op === 'set'
          ? await this.handleRuntimeCommand('set_property', {
              projectPath: args['projectPath'],
              path: readNonEmptyString(args, 'nodePath') ?? '',
              property: readString(args, 'property') ?? '',
              value: args['value'],
            })
          : await this.handleRuntimeCommand('call_method', {
              projectPath: args['projectPath'],
              path: readNonEmptyString(args, 'nodePath') ?? '',
              method: readString(args, 'method') ?? '',
              args: readArray(args, 'args') ?? [],
            });
      case 'runtime_capture':
        return await this.handleRuntimeCommand(
          op === 'screenshot' ? 'capture_screenshot' : 'capture_viewport',
          args,
        );
      case 'runtime_input':
        return op === 'click'
          ? await this.handleRuntimeCommand('click', {
              projectPath: args['projectPath'],
              path: readNonEmptyString(args, 'nodePath') ?? '',
              button: readString(args, 'button') ?? 'left',
              double: readBoolean(args, 'doubleClick') ?? false,
            })
          : await this.handleRuntimeCommand(`inject_${op}`, args);
      case 'runtime_wait':
        return await this.handleRuntimeWait(op, args);

      case 'debug_breakpoint': {
        // The adapter names the file the way this machine spells it, not the way the project
        // does, so the projectPath every other tool takes is what turns `res://main.gd` into one.
        const project = this.project(args);
        if (!project.ok) {
          return project.response;
        }
        const located = resolveWithinProject(project.value.path, readString(args, 'scriptPath') ?? '');
        if (!located.ok) {
          return this.createErrorResponse(located.reason, PATH_SOLUTIONS);
        }
        // Resolved, because the adapter refuses a path that does not start with the project as
        // it holds it, and a symlink on the way makes two spellings of the same file: on macOS
        // every /var/folders path is really /private/var/folders.
        return await this.handleDAP(op === 'set' ? 'dap_set_breakpoint' : 'dap_remove_breakpoint', {
          ...args,
          scriptPath: realPathOr(located.absolutePath),
        });
      }
      case 'debug_control':
        return await this.handleDAP(`dap_${op}`, args);
      case 'debug_state':
        return await this.handleDAP(op === 'stack' ? 'dap_get_stack_trace' : 'dap_get_output', args);

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${tool}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // What every engine-backed tool checks first
  // -------------------------------------------------------------------------------------------

  /** The engine, or the refusal to send when there is none. */
  private async engine(): Promise<Checked<string>> {
    const godotPath = await this.locator.find();
    if (godotPath === null) {
      return {
        ok: false,
        response: this.createErrorResponse('No Godot executable found.', GodotLocator.ADVICE),
      };
    }
    return { ok: true, value: godotPath };
  }

  /** The project the call names, checked to be one. */
  private project(args: OperationParams): Checked<{ path: string; file: string }> {
    const path = readNonEmptyString(args, 'projectPath');
    if (path === undefined) {
      return { ok: false, response: this.createErrorResponse('projectPath is required.') };
    }
    const file = join(path, 'project.godot');
    if (!existsSync(file)) {
      return {
        ok: false,
        response: this.createErrorResponse(`Not a Godot project: ${path}`, [
          'Point projectPath at the directory holding project.godot',
          'project_list finds the projects under a directory',
        ]),
      };
    }
    return { ok: true, value: { path, file } };
  }

  /**
   * Every file argument judged against the project and rewritten as its `res://` path, and a
   * plugin name judged as the directory under addons/ it names.
   */
  private containProjectFiles(args: OperationParams): Checked<OperationParams> {
    const projectPath = readString(args, 'projectPath');
    if (!projectPath) {
      return { ok: true, value: args };
    }
    const contained: OperationParams = { ...args };
    for (const key of PROJECT_FILE_ARGUMENTS) {
      const value = readNonEmptyString(args, key);
      if (value === undefined) {
        continue;
      }
      const location = resolveWithinProject(projectPath, value);
      if (!location.ok) {
        return { ok: false, response: this.createErrorResponse(location.reason, PATH_SOLUTIONS) };
      }
      contained[key] = `res://${location.relativePath}`;
    }
    const pluginName = readNonEmptyString(args, 'pluginName');
    if (pluginName !== undefined) {
      const plugin = resolveWithinProject(projectPath, `addons/${pluginName}/plugin.cfg`);
      if (!plugin.ok) {
        return {
          ok: false,
          response: this.createErrorResponse(plugin.reason, [
            'Give the plugin directory name as it appears under addons/, such as "my_plugin"',
          ]),
        };
      }
    }
    return { ok: true, value: contained };
  }

  /**
   * A tool answered by the operations script: the project checked, the file arguments
   * contained, the engine found, and the script's answer handed on as it is. Whatever the
   * engine said on stderr along the way comes back with it under `engine_messages`.
   */
  private async headless(operation: string, args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    // Before the engine is looked for, so that a path the server will not open is refused as
    // such rather than as a missing Godot.
    const contained = this.containProjectFiles(args);
    if (!contained.ok) {
      return contained.response;
    }
    const { op: _op, projectPath: _projectPath, ...params } = contained.value;
    return this.answer(await this.operation(operation, params, project.value.path));
  }

  private async operation(
    operation: string,
    params: OperationParams,
    projectPath: string,
  ): Promise<HeadlessOutcome> {
    const engine = await this.engine();
    if (!engine.ok) {
      return { ok: false, message: 'No Godot executable found.', messages: [] };
    }
    this.logDebug(`Running ${operation} in ${projectPath}: ${JSON.stringify(params)}`);
    return await runOperation(
      { godotPath: engine.value, script: this.operationsScript, debug: GODOT_DEBUG_MODE_DEFAULT },
      operation,
      params,
      projectPath,
    );
  }

  private answer(outcome: HeadlessOutcome): ToolResponse {
    if (!outcome.ok) {
      const response = this.createErrorResponse(outcome.message);
      if (outcome.messages.length > 0) {
        response.content.push({
          type: 'text',
          text: JSON.stringify({ engine_messages: outcome.messages }, null, 2),
        });
      }
      return response;
    }
    return this.jsonTextResponse(
      outcome.messages.length > 0
        ? { ...outcome.payload, engine_messages: outcome.messages }
        : outcome.payload,
    );
  }

  // -------------------------------------------------------------------------------------------
  // project
  // -------------------------------------------------------------------------------------------

  private handleListProjects(args: OperationParams): ToolResponse {
    const directory = readNonEmptyString(args, 'directory') ?? '';
    if (!existsSync(directory)) {
      return this.createErrorResponse(`Directory does not exist: ${directory}`);
    }
    try {
      return this.jsonTextResponse(findGodotProjects(directory, readBoolean(args, 'recursive') ?? false));
    } catch (error) {
      return this.createErrorResponse(`Could not read ${directory}: ${errorMessage(error)}`);
    }
  }

  /**
   * project_info: the project's own metadata, then whichever sections were asked for, each the
   * answer the matching operation gives on its own, so a section that fails says so without
   * hiding the rest.
   */
  private async handleProjectInfo(args: OperationParams): Promise<ToolResponse> {
    const include = readStringArray(args, 'include') ?? [];
    const unknown = include.filter((name) => PROJECT_INFO_SECTIONS[name] === undefined);
    if (unknown.length > 0) {
      return this.createErrorResponse(
        `project_info cannot include ${unknown.join(', ')}. Sections: ${Object.keys(PROJECT_INFO_SECTIONS).join(', ')}.`,
      );
    }
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }

    const application = parseProjectGodot(readFileSync(project.value.file, 'utf8'))['application'] ?? {};
    const name = application['config/name'];
    const mainScene = application['run/main_scene'];
    const info: Record<string, unknown> = {
      name: typeof name === 'string' && name !== '' ? name : basename(project.value.path),
      path: project.value.path,
      mainScene: typeof mainScene === 'string' && mainScene !== '' ? mainScene : null,
      godotVersion: await this.godotVersion(engine.value),
      structure: projectStructure(project.value.path),
    };

    const detailed = args['detail'] === 'full';
    for (const section of include) {
      const spec = PROJECT_INFO_SECTIONS[section];
      if (spec === undefined) {
        continue;
      }
      const outcome = await this.operation(spec.operation, spec.params(args, detailed), project.value.path);
      info[section] = outcome.ok
        ? outcome.messages.length > 0
          ? { ...outcome.payload, engine_messages: outcome.messages }
          : outcome.payload
        : { error: outcome.message, engine_messages: outcome.messages };
    }
    return this.jsonTextResponse(info);
  }

  private handleSearchProject(args: OperationParams): ToolResponse {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    try {
      return this.jsonTextResponse(
        searchProject(project.value.path, {
          query: readString(args, 'query') ?? '',
          fileTypes: readStringArray(args, 'fileTypes') ?? [
            'gd',
            'tscn',
            'tres',
            'gdshader',
            'cfg',
            'md',
            'txt',
            'json',
          ],
          regex: readBoolean(args, 'regex') ?? false,
          caseSensitive: readBoolean(args, 'caseSensitive') ?? false,
          maxResults: readPositiveNumber(args, 'maxResults') ?? 100,
        }),
      );
    } catch (error) {
      return this.createErrorResponse(`Search failed: ${errorMessage(error)}`);
    }
  }

  /**
   * project_export run: the engine's own export, which is not an operation of the script. The
   * destination is documented as inside the project and is contained like every other path.
   */
  private async handleExportProject(args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    const preset = readNonEmptyString(args, 'preset') ?? '';
    const output = resolveWithinProject(project.value.path, readString(args, 'outputPath') ?? '');
    if (!output.ok) {
      return this.createErrorResponse(output.reason, PATH_SOLUTIONS);
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }

    const debug = readBoolean(args, 'debug') ?? false;
    const exportArgs = [
      '--headless',
      '--path',
      project.value.path,
      debug ? '--export-debug' : '--export-release',
      preset,
      output.absolutePath,
    ];
    this.logDebug(`Exporting: ${engine.value} ${exportArgs.join(' ')}`);

    const log = new GameLog();
    let exitCode = 0;
    try {
      // An export of a real project is slow, so it gets five minutes rather than the default.
      const { stdout, stderr } = await run(engine.value, exportArgs, { timeout: 300000 });
      log.append('stdout', stdout);
      log.append('stderr', stderr);
    } catch (error) {
      if (!(error instanceof Error && 'stdout' in error && 'stderr' in error)) {
        return this.createErrorResponse(`Export could not be run: ${errorMessage(error)}`);
      }
      const failed = error as Error & { stdout: string; stderr: string; code?: number | string };
      log.append('stdout', failed.stdout);
      log.append('stderr', failed.stderr);
      exitCode = typeof failed.code === 'number' ? failed.code : -1;
    }
    log.finish();

    const problems = log.select({ severity: 'warning', sinceLastCall: false, limit: 200 });
    const verdict = {
      exported: exitCode === 0 && log.count('error') === 0 && existsSync(output.absolutePath),
      preset,
      outputPath: output.relativePath,
      debug,
      exitCode,
      errors: log.count('error'),
      warnings: log.count('warning'),
      entries: problems.entries,
    };
    if (!verdict.exported) {
      return {
        content: [
          { type: 'text', text: `Export with preset '${preset}' did not produce ${output.relativePath}.` },
          { type: 'text', text: JSON.stringify(verdict, null, 2) },
        ],
        isError: true,
      };
    }
    return this.jsonTextResponse(verdict);
  }

  /**
   * project_test: gdUnit4's command line runner, driven the way its own runtest script does
   * and read through the JUnit report it writes rather than its console. The class list is
   * rebuilt first because the runner is itself a set of class_names the engine has to resolve,
   * and so is any suite written since the editor last scanned.
   */
  private async handleRunTests(args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    const contained = this.containProjectFiles({ ...args, path: readNonEmptyString(args, 'path') ?? 'test' });
    if (!contained.ok) {
      return contained.response;
    }
    const runner = 'addons/gdUnit4/bin/GdUnitCmdTool.gd';
    if (!existsSync(join(project.value.path, runner))) {
      return this.createErrorResponse(`gdUnit4 is not installed in this project: no ${runner}.`, [
        'Install gdUnit4 under addons/gdUnit4, from https://github.com/godot-gdunit-labs/gdUnit4',
      ]);
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }

    const classes = await this.operation('refresh_class_cache', {}, project.value.path);
    if (!classes.ok) {
      return this.answer(classes);
    }

    const reports = 'res://.godot/gdharness-reports';
    const ignored = readStringArray(args, 'ignore') ?? [];
    const cmdArgs = [
      '--headless',
      '--path',
      project.value.path,
      '-s',
      `res://${runner}`,
      '--ignoreHeadlessMode',
      ...(readBoolean(args, 'failFast') === true ? [] : ['-c']),
      '-a',
      readString(contained.value, 'path') ?? 'res://test',
      ...ignored.flatMap((entry) => ['-i', entry]),
      '-rd',
      reports,
      '-rc',
      '1',
    ];
    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 600000;
    this.logDebug(`Running tests: ${engine.value} ${cmdArgs.join(' ')}`);
    const run = this.spawnGame(engine.value, cmdArgs);
    const hung = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        run.process.kill();
        resolve(true);
      }, timeoutMs);
      run.process.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
      run.process.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    const reportsDir = join(project.value.path, '.godot', 'gdharness-reports');
    let report: TestReport | null = null;
    let reportProblem: string | null = null;
    try {
      const written = existsSync(reportsDir)
        ? readdirSync(reportsDir)
            .filter((name) => name.startsWith('report_'))
            .sort((a, b) => Number(a.slice('report_'.length)) - Number(b.slice('report_'.length)))
        : [];
      const newest = written.at(-1);
      if (newest !== undefined) {
        report = parseJUnit(readFileSync(join(reportsDir, newest, 'results.xml'), 'utf8'));
      }
    } catch (error) {
      reportProblem = errorMessage(error);
    } finally {
      rmSync(reportsDir, { recursive: true, force: true });
    }

    const engineEntries = run.log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries;
    const verdicts: Readonly<Record<number, string>> = {
      0: 'passed',
      100: 'failures',
      101: 'warnings',
      103: 'headless not supported by this gdUnit4',
      104: 'Godot version not supported by this gdUnit4',
      105: 'script errors',
    };
    const exitCode = run.exitCode;
    const verdict = hung
      ? `hung: killed after ${timeoutMs} ms`
      : (verdicts[exitCode ?? -1] ?? `exit ${exitCode ?? 'unknown'}`);

    if (report === null) {
      return {
        content: [
          {
            type: 'text',
            text: `The test run wrote no report (${verdict}${reportProblem ? `; ${reportProblem}` : ''}).`,
          },
          {
            type: 'text',
            text: JSON.stringify(
              {
                exitCode,
                hung,
                arguments: cmdArgs,
                entries: run.log.select({ severity: 'info', sinceLastCall: false, limit: 60 }).entries,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const failed = report.suites.flatMap((suite) =>
      suite.cases
        .filter((entry) => entry.status === 'failed' || entry.status === 'error')
        .map((entry) => ({ ...entry, path: suite.path })),
    );
    return this.jsonTextResponse({
      passed: !hung && exitCode === 0 && report.failures === 0 && report.errors === 0,
      verdict,
      exitCode,
      tests: report.tests,
      failures: report.failures,
      errors: report.errors,
      skipped: report.skipped,
      time: report.time,
      failed,
      suites: report.suites.map((suite) => ({
        name: suite.name,
        path: suite.path,
        tests: suite.tests,
        failures: suite.failures,
        errors: suite.errors,
        skipped: suite.skipped,
        time: suite.time,
      })),
      engineErrors: run.log.count('error'),
      engineWarnings: run.log.count('warning'),
      engineEntries,
      classes: classes.payload,
    });
  }

  private async godotVersion(godotPath: string): Promise<string | null> {
    try {
      const { stdout } = await run(godotPath, ['--version'], { timeout: 10000 });
      return stdout.trim();
    } catch (error) {
      this.logDebug(`Godot did not answer --version: ${errorMessage(error)}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // script
  // -------------------------------------------------------------------------------------------

  /** script_diagnostics: what the language server reports, and the verdict that follows. */
  private async handleScriptDiagnostics(args: OperationParams): Promise<ToolResponse> {
    const answer = await this.handleLSP('lsp_get_diagnostics', args);
    const payload = asParams(JSON.parse(answer.content[0]?.text ?? '{}'));
    if (payload['error'] !== undefined) {
      const reason = payload['error'];
      return this.createErrorResponse(
        `Diagnostics unavailable: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`,
        [
          'Ensure the Godot editor is running with its language server enabled, on port 6005 or on the port GDHARNESS_LSP_PORT names',
        ],
      );
    }

    const diagnostics = readArray(payload, 'diagnostics') ?? [];
    const errors = diagnostics.filter((entry) => {
      const severity = asParams(entry)['severity'];
      return severity === 1 || severity === 'error' || severity === 'ERROR';
    }).length;
    return this.jsonTextResponse({
      scriptPath: readString(args, 'scriptPath'),
      clean: errors === 0,
      errors,
      warnings: diagnostics.length - errors,
      diagnostics,
    });
  }

  private async handleLSP(
    toolName: string,
    args: unknown,
  ): Promise<{ content: { type: string; text: string }[] }> {
    this.lspClient ??= new GodotLSPClient();
    return handleLSPTool(this.lspClient, toolName, args);
  }

  private async handleDAP(
    toolName: string,
    args: unknown,
  ): Promise<{ content: { type: string; text: string }[] }> {
    return handleDAPTool(this.dap(), toolName, args);
  }

  /** The one debug adapter client, which the debug tools and an editor-played game share. */
  private dap(): GodotDAPClient {
    this.dapClient ??= new GodotDAPClient();
    return this.dapClient;
  }

  // -------------------------------------------------------------------------------------------
  // editor
  // -------------------------------------------------------------------------------------------

  private getEditorStatusPayload() {
    const status = this.godotBridge.getStatus();
    const isPortConflict = this.bridgeStartupError?.includes('EADDRINUSE') ?? false;
    // The addon an editor loaded at startup, against the one this server ships. An install
    // replaces the files under a running editor without changing what it is serving, and until
    // now the only sign of that was a tool answering as the old version did.
    const stale = status.connected && status.addonVersion !== SERVER_VERSION;
    return {
      ...status,
      serverVersion: SERVER_VERSION,
      addonIsStale: status.connected ? stale : undefined,
      bridgeAvailable: this.bridgeStartupError === null,
      startupError: this.bridgeStartupError,
      staleNote: stale
        ? `The editor is running the ${status.addonVersion === '' ? 'addon from before versions were reported' : status.addonVersion} addon while this server ships ${SERVER_VERSION}. Restart it with editor_launch restart to pick the new one up.`
        : undefined,
      note: isPortConflict
        ? 'Bridge port is already in use. Another gdharness instance may own the editor bridge, so this server cannot report that editor connection.'
        : undefined,
      suggestion: isPortConflict
        ? 'Stop duplicate gdharness/MCP server instances or re-run the command from the same server process that owns the bridge port.'
        : undefined,
    };
  }

  /**
   * What the editor is playing, which is the half this server cannot see for itself.
   *
   * A game started from the editor's own play button belongs to no process here, so without
   * asking, editor_status reports nothing running while a game is on screen. Answered only by
   * an editor holding this version's addon: an older one has no such command, and the staleness
   * in the same payload is what says why the answer is missing.
   */
  private async editorPlayingState(): Promise<{ playing: boolean; scene: string } | null> {
    const status = this.godotBridge.getStatus();
    if (!status.connected || status.addonVersion !== SERVER_VERSION) {
      return null;
    }
    try {
      const answer = await this.godotBridge.invokeTool('playing_status', {});
      return {
        playing: readBoolean(asParams(answer), 'playing') ?? false,
        scene: readString(asParams(answer), 'scenePath') ?? '',
      };
    } catch {
      // The editor is there but did not answer this one, which the connection fields already
      // describe; a status call is not the place to fail over its own extra question.
      return null;
    }
  }

  /** editor_status: the three things an agent asks before doing anything else, in one answer. */
  private async handleEditorStatus(): Promise<ToolResponse> {
    const godotPath = await this.locator.find();

    // Every announced game is pinged, so a game that announced and then hung is reported as
    // such rather than counted as reachable on the strength of its announcement.
    const games = await Promise.all(
      discoverRuntimes().map(async (endpoint) => {
        const reply = await runtimeRequest(endpoint, 'ping', {}, this.runtimeTimeoutMs());
        return {
          pid: endpoint.pid,
          port: endpoint.port,
          project: endpoint.project,
          reachable: reply.ok,
          problem: reply.ok ? null : reply.message,
        };
      }),
    );

    return this.jsonTextResponse({
      editor: this.getEditorStatusPayload(),
      godot: {
        path: godotPath,
        version: godotPath === null ? null : await this.godotVersion(godotPath),
      },
      game: {
        processActive: this.activeProcess !== null,
        playingInEditor: await this.editorPlayingState(),
        runtimeConnected: games.some((game) => game.reachable),
        runtimes: games,
      },
    });
  }

  /**
   * editor_launch restart: the editor restarts itself, and this waits to see it come back.
   *
   * Installing over a running editor leaves it serving the code it read at startup, so an
   * upgrade is not in effect until somebody restarts it, and the only sign is a tool behaving
   * like the old version. The answer is the version that reconnected rather than the one that
   * was asked for: what matters is which addon the editor is holding now.
   */
  private async handleRestartEditor(): Promise<ToolResponse> {
    const before = this.godotBridge.getStatus();
    if (!before.connected) {
      return this.createErrorResponse('No editor is connected, so there is nothing to restart.', [
        'editor_launch opens one on a project',
        'editor_status says whether the bridge is up and what has reached it',
      ]);
    }

    const asked = await this.handleViaBridge('restart_editor', {});
    if (asked.isError === true) {
      return asked;
    }

    // A connection newer than the one that was there, rather than one that is merely up: the
    // editor that answered is on its way out, and an editor that ignored the request looks
    // exactly like one that came straight back.
    const startedAt = before.connectedAt?.getTime() ?? 0;
    const began = Date.now();
    const back = await this.waitForBridge(() => {
      const status = this.godotBridge.getStatus();
      return status.connected && (status.connectedAt?.getTime() ?? 0) > startedAt;
    }, began + EDITOR_RESTART_TIMEOUT_MS);

    if (!back) {
      return this.createErrorResponse(
        `The editor was asked to restart and has not come back within ${EDITOR_RESTART_TIMEOUT_MS / 1000}s.`,
        [
          'It may be asking what to do about an unsaved scene: look at the editor window',
          'An addon that no longer parses stops the editor reaching this server',
          'editor_status says whether anything has reached the bridge since',
        ],
      );
    }

    const now = this.godotBridge.getStatus();
    return this.jsonTextResponse({
      restarted: true,
      editorPid: now.editorPid,
      addonVersion: now.addonVersion,
      serverVersion: SERVER_VERSION,
      addonIsStale: now.addonVersion !== SERVER_VERSION,
      tookMs: Date.now() - began,
    });
  }

  /** Polls until the bridge is in the state asked for, or until the deadline passes. */
  private async waitForBridge(reached: () => boolean, deadline: number): Promise<boolean> {
    for (;;) {
      if (reached()) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(250);
    }
  }

  /**
   * editor_launch: the editor as its own process, detached and with its output dropped. A pipe
   * nobody reads fills up and blocks the editor at the first 64KB it prints, and the editor is
   * meant to outlive this server.
   */
  private async handleLaunchEditor(args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }
    this.logDebug(`Launching Godot editor for project: ${project.value.path}`);
    const editor = spawn(engine.value, editorArguments(project.value.path), {
      stdio: 'ignore',
      detached: true,
    });
    const started = await new Promise<string | null>((resolve) => {
      editor.once('spawn', () => {
        resolve(null);
      });
      editor.once('error', (error: Error) => {
        resolve(error.message);
      });
    });
    if (started !== null) {
      return this.createErrorResponse(`Could not start the editor: ${started}`);
    }
    editor.unref();
    return this.jsonTextResponse({
      launched: true,
      pid: editor.pid ?? null,
      projectPath: project.value.path,
    });
  }

  private async handleRunProject(args: OperationParams, op: string): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    // Before the engine is looked for, so that a scene the server will not run is refused as
    // such rather than as a missing Godot.
    const scene = readNonEmptyString(args, 'scene');
    const sceneToRun = scene !== undefined ? resolveWithinProject(project.value.path, scene) : null;
    if (sceneToRun && !sceneToRun.ok) {
      return this.createErrorResponse(sceneToRun.reason, PATH_SOLUTIONS);
    }
    // Asked to run a project with no main scene, the engine puts up a modal box and waits for
    // a click, even headless on Windows: a process on a pipe that never exits.
    if (!sceneToRun && !hasMainScene(project.value.file)) {
      return this.createErrorResponse('The project sets no main scene, so there is nothing to run.', [
        'Pass scene to run one scene',
        'Choose the main scene with project_settings set_main_scene',
      ]);
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }

    const sceneArgument = sceneToRun?.ok ? sceneToRun.relativePath : null;
    if (op === 'check') {
      return await this.checkBoot(engine.value, project.value.path, sceneArgument, args);
    }

    if (this.activeProcess) {
      this.logDebug('Ending the running game before starting another');
      await this.endActiveGame();
    }

    // The editor when it is there: a game it plays is a game its debugger is holding, and that
    // session is the only thing the debug tools can reach. A game started here as its own
    // process is invisible to them, whatever port they are pointed at.
    //
    // A headless run goes through the editor only when the project's own run arguments say the
    // editor would play it headless too. Otherwise it is spawned: answering a request for no
    // window with a window would be answering a different question.
    const headless = resolveHeadless(args['headless'], {
      platform: process.platform,
      variables: process.env,
    });
    if (this.godotBridge.isConnected() && (!headless || editorPlaysHeadless(project.value.file))) {
      return await this.playThroughEditor(sceneArgument);
    }

    const cmdArgs = runArguments({
      projectPath: project.value.path,
      headless,
      scene: sceneArgument,
    });
    this.logDebug(`Running Godot project: ${engine.value} ${cmdArgs.join(' ')}`);
    const started = this.spawnGame(engine.value, cmdArgs);
    this.activeProcess = started;
    started.process.on('exit', () => {
      if (this.activeProcess === started) {
        this.activeProcess = null;
      }
    });
    return this.jsonTextResponse({
      started: true,
      through: 'gdharness',
      pid: started.process.pid ?? null,
      arguments: cmdArgs,
      message: 'Use editor_output for what it prints and editor_stop to end it.',
    });
  }

  /**
   * The editor plays the game, and the debug adapter is connected first so nothing is missed.
   *
   * The adapter is where an editor-played game's console comes from: there is no pipe to read,
   * and the editor's own Output dock is not something a server can see. Connecting before the
   * game starts is what puts its first lines in the log rather than losing them, and the
   * breakpoints a caller set earlier are already registered by then.
   */
  private async playThroughEditor(scene: string | null): Promise<ToolResponse> {
    const log = new GameLog();
    try {
      await this.dap().connect();
    } catch (error) {
      return this.createErrorResponse(
        `The editor is connected but its debug adapter is not: ${errorMessage(error)}`,
        [
          'Godot serves the debug adapter on 6006 unless --dap-port says otherwise',
          'GDHARNESS_DAP_PORT points this server at another one',
        ],
      );
    }

    const answer = await this.handleViaBridge(
      'play_scene',
      scene === null ? {} : { scenePath: `res://${scene}` },
    );
    if (answer.isError === true) {
      return answer;
    }

    const played: GodotProcess = {
      process: null,
      log,
      startedAt: Date.now(),
      exitCode: null,
      throughEditor: true,
    };
    this.activeProcess = played;

    return this.jsonTextResponse({
      started: true,
      through: 'editor',
      scene: scene === null ? 'the main scene' : `res://${scene}`,
      message:
        'The editor is playing it, so its debugger holds it: the debug_* tools can reach it, ' +
        'editor_output reads its console through the debug adapter, and editor_stop ends it.',
    });
  }

  /**
   * Moves what the debug adapter has heard into the game's log.
   *
   * Pulled when somebody asks rather than pushed as it arrives, so the one buffer the adapter
   * keeps is read in order and nothing is counted twice. A game this server spawned has a pipe
   * instead and nothing to drain.
   */
  private drainEditorOutput(game: GodotProcess): void {
    if (!game.throughEditor || !this.dapClient) {
      return;
    }
    for (const line of this.dapClient.getOutput(true)) {
      game.log.append('stdout', line.endsWith('\n') ? line : `${line}\n`);
    }
  }

  /** Ends whatever is running, whichever way it was started. */
  private async endActiveGame(): Promise<void> {
    const running = this.activeProcess;
    this.activeProcess = null;
    if (!running) {
      return;
    }
    if (running.throughEditor) {
      await this.handleViaBridge('stop_playing', {});
      return;
    }
    running.process?.kill();
  }

  /** The engine as a child process, with everything it prints read into a log as it comes. */
  private spawnGame(godotPath: string, cmdArgs: string[]): SpawnedGame {
    const child = spawn(godotPath, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = new GameLog();
    const started: SpawnedGame = {
      process: child,
      log,
      startedAt: Date.now(),
      exitCode: null,
      throughEditor: false,
    };
    child.stdout.on('data', (data: Buffer) => {
      log.append('stdout', data);
    });
    child.stderr.on('data', (data: Buffer) => {
      log.append('stderr', data);
    });
    child.on('exit', (code: number | null) => {
      this.logDebug(`Godot process exited with code ${code ?? 'none'}`);
      log.finish();
      started.exitCode = code ?? -1;
    });
    child.on('error', (err: Error) => {
      console.error('Failed to start Godot process:', err);
      log.append('stderr', `${err.message}\n`);
      started.exitCode = -1;
    });
    return started;
  }

  /**
   * editor_run check: the project booted headless and left to quit after a few frames, which
   * is what a commit gate does by hand. A project that will not quit is killed and reported as
   * hung rather than waited on forever.
   */
  private async checkBoot(
    godotPath: string,
    projectPath: string,
    scene: string | null,
    args: OperationParams,
  ): Promise<ToolResponse> {
    const frames = readPositiveNumber(args, 'frames') ?? 3;
    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 60000;
    const cmdArgs = runArguments({ projectPath, headless: true, scene, quitAfter: frames });
    const boot = this.spawnGame(godotPath, cmdArgs);

    const hung = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        boot.process.kill();
        resolve(true);
      }, timeoutMs);
      boot.process.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
      boot.process.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    const errors = boot.log.count('error');
    const warnings = boot.log.count('warning');
    return this.jsonTextResponse({
      booted: !hung && boot.exitCode === 0 && errors === 0,
      hung,
      exitCode: boot.exitCode,
      durationMs: Date.now() - boot.startedAt,
      frames,
      errors,
      warnings,
      entries: boot.log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries,
    });
  }

  /** editor_output: the log as entries, filtered the way the caller asked. */
  private handleGetDebugOutput(args: OperationParams): ToolResponse {
    if (!this.activeProcess) {
      return this.createErrorResponse('No game is running. Start one with editor_run.');
    }
    this.drainEditorOutput(this.activeProcess);
    const severity = readString(args, 'severity');
    const selected = this.activeProcess.log.select({
      severity: severity === 'error' || severity === 'warning' ? severity : 'info',
      sinceLastCall: readBoolean(args, 'sinceLastCall') ?? false,
      contains: readNonEmptyString(args, 'contains'),
      limit: readPositiveNumber(args, 'limit') ?? 200,
    });
    return this.jsonTextResponse({
      running: this.activeProcess.exitCode === null,
      exitCode: this.activeProcess.exitCode,
      through: this.activeProcess.throughEditor ? 'editor' : 'gdharness',
      pid: this.activeProcess.process?.pid ?? null,
      errors: this.activeProcess.log.count('error'),
      warnings: this.activeProcess.log.count('warning'),
      clean: this.activeProcess.log.count('error') === 0,
      omitted: selected.omitted,
      entries: selected.entries,
    });
  }

  /** editor_stop: the game is ended and its verdict answered, the errors and warnings kept. */
  private async handleStopProject(): Promise<ToolResponse> {
    if (!this.activeProcess) {
      return this.createErrorResponse('No game is running. Start one with editor_run.');
    }
    const stopped = this.activeProcess;
    this.drainEditorOutput(stopped);
    this.logDebug('Stopping the running game');
    await this.endActiveGame();
    return this.jsonTextResponse({
      stopped: true,
      through: stopped.throughEditor ? 'editor' : 'gdharness',
      exitedBeforeStop: stopped.exitCode !== null,
      exitCode: stopped.exitCode,
      errors: stopped.log.count('error'),
      warnings: stopped.log.count('warning'),
      clean: stopped.log.count('error') === 0,
      entries: stopped.log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries,
    });
  }

  /**
   * editor_rescan: the scan started, then waited for. The waiting is here rather than in the
   * addon because the editor-side tool executor takes a Dictionary back and not a coroutine,
   * so the addon can only start the scan and report whether one is running. A caller that has
   * just written a script needs the scan to have landed before the new class_name resolves.
   */
  private async handleRescanFilesystem(args: OperationParams): Promise<ToolResponse> {
    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 30000;
    const started = Date.now();

    const first = await this.handleViaBridge('rescan_filesystem', args);
    if (first.isError) {
      return first;
    }

    let busy = true;
    while (busy && Date.now() - started < timeoutMs) {
      await new Promise((settle) => setTimeout(settle, 100));
      const status = asParams(
        await this.godotBridge.invokeTool('rescan_filesystem', { ...args, statusOnly: true }),
      );
      busy = Boolean(status['scanning']) || Boolean(status['importing']);
    }

    return this.jsonTextResponse({
      ok: !busy,
      stillWorking: busy,
      waitedMs: Date.now() - started,
      note: busy
        ? 'The editor was still scanning or importing when the wait ran out, so new files may not be visible yet.'
        : undefined,
    });
  }

  private async handleViaBridge(toolName: string, args: OperationParams): Promise<ToolResponse> {
    if (!this.godotBridge.isConnected()) {
      return this.createErrorResponse(
        'Editor not connected: no Godot editor with the gdharness editor addon has reached this server.',
        [
          'Open the project in the editor with editor_launch, or by hand',
          'Enable the addon under Project > Project Settings > Plugins',
          'editor_status says whether the bridge is up and what it is listening on',
        ],
      );
    }
    try {
      return this.jsonTextResponse(await this.godotBridge.invokeTool(toolName, args));
    } catch (error) {
      return this.createErrorResponse(
        `The editor answered ${toolName} with an error: ${errorMessage(error)}`,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // runtime
  // -------------------------------------------------------------------------------------------

  /** How long one runtime request may take. Ten seconds, unless the environment says otherwise. */
  private runtimeTimeoutMs(): number {
    const override = Number.parseInt(envValue('GDHARNESS_RUNTIME_TIMEOUT_MS') ?? '', 10);
    return Number.isInteger(override) && override > 0 ? override : 10000;
  }

  /**
   * One command to the running game, and its answer as a tool result.
   *
   * `op` and `projectPath` are the server's business and stay here: the first chose the
   * command, the second chooses the game when more than one is running. A capture is answered
   * through a file the server names, so a game cannot point the reader at a path of its own
   * choosing, and the file is gone again before the image is returned.
   */
  private async handleRuntimeCommand(
    command: string,
    args: unknown,
    timeoutMs: number = this.runtimeTimeoutMs(),
  ): Promise<ToolResponse> {
    const { op: _op, projectPath, ...params } = asParams(args);
    const choice = chooseRuntime(
      discoverRuntimes(),
      typeof projectPath === 'string' ? projectPath : undefined,
    );
    if ('problem' in choice) {
      return this.createErrorResponse(choice.problem);
    }

    const expectsScreenshot = command === 'capture_screenshot' || command === 'capture_viewport';
    const screenshotDir = expectsScreenshot
      ? mkdtempSync(join(tmpdir(), 'gdharness-runtime-screenshot-'))
      : null;
    const screenshotPath = screenshotDir ? join(screenshotDir, 'capture.png') : null;
    try {
      const reply = await runtimeRequest(
        choice.endpoint,
        command,
        screenshotPath ? { ...params, output_path: screenshotPath } : params,
        timeoutMs,
      );
      if (!reply.ok) {
        return this.createErrorResponse(reply.message);
      }

      const { id: _id, ...payload } = reply.payload;
      if (!expectsScreenshot) {
        return this.jsonTextResponse(payload);
      }

      const returnedPath = readString(payload, 'path');
      if (readString(payload, 'type') !== 'screenshot_file' || !returnedPath || !screenshotPath) {
        return this.createErrorResponse(`The game answered a capture with ${JSON.stringify(payload)}`);
      }
      if (normalize(returnedPath) !== normalize(screenshotPath)) {
        return this.createErrorResponse(
          `Rejected screenshot file path outside the managed capture path: '${returnedPath}'`,
        );
      }
      const dimensions = `${readNumber(payload, 'width') ?? 0}x${readNumber(payload, 'height') ?? 0} ${
        readString(payload, 'format') ?? 'unknown'
      }`;
      return {
        content: [
          { type: 'text', text: `Screenshot captured: ${dimensions}` },
          { type: 'image', data: readFileSync(screenshotPath).toString('base64'), mimeType: 'image/png' },
        ],
      };
    } finally {
      if (screenshotDir) {
        rmSync(screenshotDir, { recursive: true, force: true });
      }
    }
  }

  /** runtime_inspect find: only the filters that were given are sent, so the game decides. */
  private async handleFindRuntimeNodes(args: OperationParams): Promise<ToolResponse> {
    const filters: Record<string, unknown> = {};
    const className = readNonEmptyString(args, 'className');
    const script = readNonEmptyString(args, 'script');
    const namePattern = readNonEmptyString(args, 'namePattern');
    const group = readNonEmptyString(args, 'group');
    if (className !== undefined) filters['class'] = className;
    if (script !== undefined) filters['script'] = script;
    if (namePattern !== undefined) filters['name'] = namePattern;
    if (group !== undefined) filters['group'] = group;
    if (Object.keys(filters).length === 0) {
      return this.createErrorResponse(
        'runtime_inspect find needs at least one of className, script, namePattern, group.',
      );
    }
    return await this.handleRuntimeCommand('find_nodes', {
      ...filters,
      projectPath: args['projectPath'],
      root: readNonEmptyString(args, 'nodePath') ?? '/root',
      limit: readPositiveNumber(args, 'limit') ?? 100,
    });
  }

  /**
   * runtime_wait: the game is given as long as the wait asks for, and a little longer for the
   * answer to travel, before it is called busy.
   */
  private async handleRuntimeWait(op: string, args: OperationParams): Promise<ToolResponse> {
    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 5000;
    const nodePath = readNonEmptyString(args, 'nodePath') ?? '';
    const patience = Math.max(this.runtimeTimeoutMs(), timeoutMs + 5000);
    switch (op) {
      case 'frames':
        return await this.handleRuntimeCommand(
          'wait_frames',
          { projectPath: args['projectPath'], frames: readPositiveNumber(args, 'frames') ?? 1 },
          patience,
        );
      case 'signal':
        return await this.handleRuntimeCommand(
          'wait_signal',
          {
            projectPath: args['projectPath'],
            path: nodePath,
            signal: readString(args, 'signal') ?? '',
            timeout_ms: timeoutMs,
          },
          patience,
        );
      default:
        return await this.handleRuntimeCommand(
          'wait_until',
          {
            projectPath: args['projectPath'],
            path: nodePath,
            property: readString(args, 'property') ?? '',
            value: args['value'],
            timeout_ms: timeoutMs,
          },
          patience,
        );
    }
  }
}

export async function runGodotServer(): Promise<void> {
  const server = new GodotServer();
  await server.run();
}
