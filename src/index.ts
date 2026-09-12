#!/usr/bin/env bun

/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection as createTcpConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { GodotDAPClient, handleDAPTool } from './dap_client.js';
import { errorMessage } from './errors.js';
import { type GodotBridge, getDefaultBridge } from './godot-bridge.js';
import { GodotLSPClient, handleLSPTool } from './lsp_client.js';
import { getPrompt, listPrompts } from './prompts.js';
import { setupResourceHandlers } from './resources.js';
import type {
  GodotProcess,
  GodotServerConfig,
  MCPToolDefinition,
  OperationParams,
  ProjectStructure,
  ToolResponse,
} from './server-types.js';
import { DEBUG_MODE, GODOT_DEBUG_MODE_DEFAULT, SERVER_VERSION } from './server-version.js';
import {
  asParams,
  readArray,
  readBoolean,
  readBooleanEither,
  readNonEmptyString,
  readNonEmptyStringEither,
  readNumber,
  readNumberLike,
  readParams,
  readPositiveNumber,
  readString,
  readStringArray,
  readStringEither,
} from './tool-args.js';
import { buildToolDefinitions as buildToolDefinitionsForServer } from './tool-definitions.js';
import { CORE_TOOL_GROUPS, TOOL_GROUPS } from './tool-groups.js';
import { sanitizeExportedToolName } from './tool-names.js';

// execFile, not exec: no shell means no quoting, and no quoting means no way to escape out
// of it. Every argument below is an array element, so a path full of backslashes, spaces or
// quotes is just a path.
const run = promisify(execFile);

/**
 * Scan a directory for Godot executable binaries.
 *
 * Godot release downloads use versioned filenames such as
 * `Godot_v4.4.1-stable_win64.exe` or `Godot_v4.3-stable_linux.x86_64`,
 * which the hard-coded candidate list cannot match. This helper globs a
 * single install directory for any `Godot*.exe` / `godot*` binary and
 * returns candidates sorted newest-first by modification time so the
 * auto-detection picks the most recently installed build.
 *
 * Exported for unit testing.
 * @param directory Directory to scan
 * @param platform Current OS platform (controls the executable pattern)
 * @returns Array of absolute candidate paths, newest first
 */
export function scanDirectoryForGodotBinaries(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!directory || !existsSync(directory)) {
    return [];
  }

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const pattern = platform === 'win32' ? /^godot.*\.exe$/i : /^godot/i;

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
      // ignore unreadable entries
    }
  }

  matches.sort((a, b) => b.mtime - a.mtime);
  return matches.map((m) => join(directory, m.name));
}

/**
 * An environment variable's value, treating the empty string as unset.
 *
 * A variable exported with nothing in it is how a shell says "not configured", and reading it
 * as a configured empty value picks a tool profile of "" or a page size that will not parse.
 */
function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The user's home directory, or an empty string when there is not one.
 *
 * `homedir()` reads HOME or USERPROFILE and falls back to the OS user database, so it answers
 * in cases a bare environment read does not. It can still come back empty, and every caller
 * has to treat that as "skip the home-relative candidates" rather than build a path from it.
 */
function resolveHomeDirectory(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  // The tool surface here is built by hand: names are sanitised and aliased, the list changes
  // as groups activate, and pagination is ours. That is the "advanced use case" McpServer's
  // own docs point at its `.server` for, so registration goes through the protocol object.
  private mcp: McpServer;
  private activeProcess: GodotProcess | null = null;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths = new Map<string, boolean>();
  private strictPathValidation = false;
  private godotDebugMode: boolean = GODOT_DEBUG_MODE_DEFAULT;
  private lspClient: GodotLSPClient | null = null;
  private dapClient: GodotDAPClient | null = null;
  private bridgeStartupError: string | null = null;
  private lastProjectPath: string | null = null;
  private godotBridge: GodotBridge;
  private shutdownInitiated = false;
  private cachedToolDefinitions: MCPToolDefinition[] = [];
  private toolDefinitionFactory: (() => MCPToolDefinition[]) | null = null;
  private readonly toolExposureProfile: 'compact' | 'full' | 'legacy';
  private readonly toolsListPageSize: number;
  private activeGroups = new Set<string>();
  private readonly compactAliasToLegacy: Record<string, string> = {
    'tool.catalog': 'tool_catalog',
    'project.list': 'list_projects',
    'project.info': 'get_project_info',
    'project.search': 'search_project',
    'project.setting.get': 'get_project_setting',
    'project.setting.set': 'set_project_setting',
    'editor.launch': 'launch_editor',
    'editor.run': 'run_project',
    'editor.stop': 'stop_project',
    'editor.debug_output': 'get_debug_output',
    'editor.status': 'get_editor_status',
    'editor.version': 'get_godot_version',
    'scene.create': 'create_scene',
    'scene.save': 'save_scene',
    'scene.nodes': 'list_scene_nodes',
    'project.rescan': 'rescan_filesystem',
    'scene.node.add': 'add_node',
    'scene.node.properties': 'get_node_properties',
    'scene.node.set': 'set_node_properties',
    'scene.node.delete': 'delete_node',
    'script.create': 'create_script',
    'script.modify': 'modify_script',
    'script.info': 'get_script_info',
    'class.query': 'query_classes',
    'class.info': 'query_class_info',
    'signal.connect': 'connect_signal',
    'resource.dependencies': 'get_dependencies',
    'export.presets': 'list_export_presets',
    'export.run': 'export_project',
    'runtime.status': 'get_runtime_status',
    'lsp.diagnostics': 'lsp_get_diagnostics',
    'dap.output': 'dap_get_output',
    'tool.groups': 'manage_tool_groups',
  };

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = {
    project_path: 'projectPath',
    scene_path: 'scenePath',
    root_node_type: 'rootNodeType',
    root_type: 'rootNodeType',
    parent_node_path: 'parentNodePath',
    node_type: 'nodeType',
    node_name: 'nodeName',
    texture_path: 'texturePath',
    node_path: 'nodePath',
    output_path: 'outputPath',
    mesh_item_names: 'meshItemNames',
    new_path: 'newPath',
    file_path: 'filePath',
    directory: 'directory',
    recursive: 'recursive',
    scene: 'scene',
    source_node_path: 'sourceNodePath',
    signal_name: 'signalName',
    target_node_path: 'targetNodePath',
    method_name: 'methodName',
    player_node_path: 'playerNodePath',
    animation_name: 'animationName',
    loop_mode: 'loopMode',
    plugin_name: 'pluginName',
    action_name: 'actionName',
    file_types: 'fileTypes',
    case_sensitive: 'caseSensitive',
    max_results: 'maxResults',
    axis_value: 'axisValue',
    // 2D Tile tools
    tileset_path: 'tilesetPath',
    tile_size: 'tileSize',
    tilemap_node_path: 'tilemapNodePath',
    source_id: 'sourceId',
    atlas_coords: 'atlasCoords',
    alternative_tile: 'alternativeTile',
  };

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = {};

  constructor(config?: GodotServerConfig) {
    const rawProfile = (
      envValue('GDHARNESS_TOOL_PROFILE') ??
      envValue('MCP_TOOL_PROFILE') ??
      'compact'
    ).toLowerCase();
    if (rawProfile === 'full' || rawProfile === 'legacy' || rawProfile === 'compact') {
      this.toolExposureProfile = rawProfile;
    } else {
      this.toolExposureProfile = 'compact';
    }

    const rawToolsPageSize = parseInt(envValue('GDHARNESS_TOOLS_PAGE_SIZE') ?? '33', 10);
    this.toolsListPageSize =
      Number.isFinite(rawToolsPageSize) && rawToolsPageSize > 0 ? rawToolsPageSize : 33;

    // Initialize reverse parameter mappings
    for (const [snakeCase, camelCase] of Object.entries(this.parameterMappings)) {
      this.reverseParameterMappings[camelCase] = snakeCase;
    }
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    let godotDebugMode = GODOT_DEBUG_MODE_DEFAULT;

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.godotDebugMode !== undefined) {
        godotDebugMode = config.godotDebugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    this.godotDebugMode = godotDebugMode;

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'godot', 'operations', 'godot_operations.gd');

    // Initialize the Godot Editor Bridge (WebSocket server for editor plugin)
    this.godotBridge = getDefaultBridge();
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

    // Initialize the MCP server
    this.mcp = new McpServer(
      {
        name: 'gdharness',
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: { listChanged: true },
          prompts: {},
          resources: {},
        },
      },
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Set up resource handlers for godot:// URIs
    setupResourceHandlers(this.mcp, () => this.lastProjectPath);

    // Error handling
    this.mcp.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    this.setupShutdownHandlers();
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  /**
   * Create a standardized error response with possible solutions
   */
  private createErrorResponse(message: string, possibleSolutions: string[] = []): ToolResponse {
    // Log the error
    console.error(`[SERVER] Error response: ${message}`);
    if (possibleSolutions.length > 0) {
      console.error(`[SERVER] Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: ToolResponse = {
      content: [
        {
          type: 'text',
          text: message,
        },
      ],
      isError: true,
    };

    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: `Possible solutions:\n- ${possibleSolutions.join('\n- ')}`,
      });
    }

    return response;
  }

  /**
   * Validate a path to prevent path traversal attacks
   */
  private validatePath(path: string): boolean {
    // Basic validation to prevent path traversal
    if (!path || path.includes('..')) {
      return false;
    }

    // Add more validation as needed
    return true;
  }

  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    const cached = this.validatedPaths.get(path);
    if (cached !== undefined) {
      return cached;
    }

    try {
      this.logDebug(`Validating Godot path: ${path}`);

      // Check if the file exists (skip for 'godot' which might be in PATH)
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }

      await run(path, ['--version']);

      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${errorMessage(error)}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    // If godotPath is already set and valid, use it
    if (this.godotPath && (await this.isValidGodotPath(this.godotPath))) {
      this.logDebug(`Using existing Godot path: ${this.godotPath}`);
      return;
    }

    // Check environment variable next
    if (process.env['GODOT_PATH']) {
      const normalizedPath = normalize(process.env['GODOT_PATH']);
      this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
        return;
      } else {
        this.logDebug(`GODOT_PATH environment variable is invalid`);
      }
    }

    // Auto-detect based on platform
    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    // A home directory is not guaranteed: a service account, a container or a Windows session
    // started without a profile has none. Interpolating the miss produced candidates beginning
    // with the literal text "undefined", which the detector then stat'd and scanned, and the
    // only symptom was detection failing for no stated reason.
    const home = resolveHomeDirectory();

    const possiblePaths: string[] = [
      'godot', // Check if 'godot' is in PATH first
    ];

    // Add platform-specific paths
    if (osPlatform === 'darwin') {
      possiblePaths.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        '/Applications/Godot_4.app/Contents/MacOS/Godot',
      );
      if (home) {
        possiblePaths.push(
          `${home}/Applications/Godot.app/Contents/MacOS/Godot`,
          `${home}/Applications/Godot_4.app/Contents/MacOS/Godot`,
          `${home}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`,
        );
      }
    } else if (osPlatform === 'win32') {
      possiblePaths.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot_4\\Godot.exe',
        'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
      );
      if (home) {
        possiblePaths.push(`${home}\\Godot\\Godot.exe`);
      }
    } else if (osPlatform === 'linux') {
      possiblePaths.push('/usr/bin/godot', '/usr/local/bin/godot', '/snap/bin/godot');
      if (home) {
        possiblePaths.push(`${home}/.local/bin/godot`);
      }
    }

    // Try each possible path
    for (const path of possiblePaths) {
      const normalizedPath = normalize(path);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

    // Scan known Godot install directories for versioned binaries
    // (e.g. Godot_v4.4.1-stable_win64.exe) that the hard-coded candidate
    // list above cannot match. Candidates are sorted newest-first by mtime.
    const scanDirectories: string[] = [];
    if (osPlatform === 'win32') {
      scanDirectories.push(
        'C:\\Program Files\\Godot',
        'C:\\Program Files (x86)\\Godot',
        'C:\\Program Files\\Godot_4',
        'C:\\Program Files (x86)\\Godot_4',
      );
      if (home) {
        scanDirectories.push(`${home}\\Godot`, `${home}\\Downloads`, `${home}\\Desktop`);
      }
    } else if (osPlatform === 'darwin') {
      scanDirectories.push('/Applications');
      if (home) {
        scanDirectories.push(`${home}/Applications`);
      }
    } else if (osPlatform === 'linux') {
      scanDirectories.push('/usr/bin', '/usr/local/bin', '/snap/bin');
      if (home) {
        scanDirectories.push(`${home}/.local/bin`, `${home}/Downloads`, `${home}/Desktop`);
      }
    }

    for (const dir of scanDirectories) {
      const candidates = scanDirectoryForGodotBinaries(dir, osPlatform);
      for (const candidate of candidates) {
        const normalizedCandidate = normalize(candidate);
        if (await this.isValidGodotPath(normalizedCandidate)) {
          this.godotPath = normalizedCandidate;
          this.logDebug(`Found versioned Godot binary at: ${normalizedCandidate}`);
          return;
        }
      }
    }

    // If we get here, we couldn't find Godot
    this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
    console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
    console.error(
      `[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`,
    );

    if (this.strictPathValidation) {
      // In strict mode, throw an error
      throw new Error(
        `Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`,
      );
    } else {
      // Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
      if (osPlatform === 'win32') {
        this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
      } else if (osPlatform === 'darwin') {
        this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
      } else {
        this.godotPath = normalize('/usr/bin/godot');
      }

      this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
      console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
      console.error(
        `[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`,
      );
    }
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
    return false;
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');

    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.activeProcess.process.kill();
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
        this.activeProcess.process.kill();
      } catch (error) {
        console.error('[SERVER] Failed to kill the Godot process on exit:', errorMessage(error));
      }
      this.activeProcess = null;
    }
  }

  private async handleRuntimeCommand(
    command: string,
    args: unknown,
  ): Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[] }> {
    const params = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    const RUNTIME_PORT = 7777;
    const RUNTIME_HOST = '127.0.0.1';
    const timeoutOverride = Number.parseInt(envValue('GDHARNESS_RUNTIME_TIMEOUT_MS') ?? '', 10);
    const TIMEOUT_MS = Number.isInteger(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : 10000;
    const expectsScreenshot = command === 'capture_screenshot' || command === 'capture_viewport';
    const screenshotDir = expectsScreenshot
      ? mkdtempSync(join(tmpdir(), 'gdharness-runtime-screenshot-'))
      : null;
    const screenshotPath = screenshotDir ? join(screenshotDir, 'capture.png') : null;
    const runtimeParams = screenshotPath ? { ...params, output_path: screenshotPath } : params;
    const cleanupScreenshotDir = () => {
      if (screenshotDir) {
        rmSync(screenshotDir, { recursive: true, force: true });
      }
    };

    return new Promise((resolve) => {
      const socket = createTcpConnection({ port: RUNTIME_PORT, host: RUNTIME_HOST }, () => {
        const payload = JSON.stringify({ command, params: runtimeParams, id: Date.now() });
        socket.write(`${payload}\n`);
      });

      let responseBuffer = Buffer.alloc(0);
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        socket.destroy();
        cleanupScreenshotDir();
        resolve({
          content: [
            {
              type: 'text',
              text: `Runtime command '${command}' timed out after ${TIMEOUT_MS}ms. Ensure the Godot game is running with the MCP runtime addon enabled.`,
            },
          ],
        });
      }, TIMEOUT_MS);

      const resolveRuntimePayload = (parsed: OperationParams) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timer);
        socket.destroy();

        const payloadType = readString(parsed, 'type');
        const returnedPath = readString(parsed, 'path');
        const dimensions = `${readNumber(parsed, 'width') ?? 0}x${readNumber(parsed, 'height') ?? 0} ${
          readString(parsed, 'format') ?? 'unknown'
        }`;

        if (payloadType === 'screenshot_file' && returnedPath) {
          if (!screenshotPath || normalize(returnedPath) !== normalize(screenshotPath)) {
            cleanupScreenshotDir();
            resolve({
              content: [
                {
                  type: 'text',
                  text: `Rejected screenshot file path outside the managed capture path: '${returnedPath}'`,
                },
              ],
            });
            return;
          }
          try {
            const imageData = readFileSync(screenshotPath).toString('base64');
            cleanupScreenshotDir();
            resolve({
              content: [
                {
                  type: 'text',
                  text: `Screenshot captured: ${dimensions}`,
                },
                { type: 'image', data: imageData, mimeType: 'image/png' },
              ],
            });
          } catch (error) {
            cleanupScreenshotDir();
            const message = errorMessage(error);
            resolve({
              content: [
                { type: 'text', text: `Failed to read screenshot file '${screenshotPath}': ${message}` },
              ],
            });
          }
          return;
        }

        const inlineData = readString(parsed, 'data');
        if (payloadType === 'screenshot' && inlineData) {
          cleanupScreenshotDir();
          resolve({
            content: [
              {
                type: 'text',
                text: `Screenshot captured: ${dimensions}`,
              },
              { type: 'image', data: inlineData, mimeType: 'image/png' },
            ],
          });
          return;
        }

        cleanupScreenshotDir();
        resolve({
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        });
      };

      socket.on('data', (chunk: Buffer) => {
        responseBuffer = Buffer.concat([responseBuffer, Buffer.from(chunk)]);
        const parsedMessages: OperationParams[] = [];

        const parseCandidate = (candidate: string) => {
          const trimmed = candidate.trim();
          if (!trimmed) {
            return;
          }
          try {
            parsedMessages.push(asParams(JSON.parse(trimmed)));
          } catch {
            // Ignore malformed frame/line and keep scanning.
          }
        };

        // First, parse the framed payload format emitted by Godot's StreamPeerTCP.put_utf8_string().
        let offset = 0;
        while (offset + 4 <= responseBuffer.length) {
          const frameLength = responseBuffer.readUInt32LE(offset);
          if (frameLength <= 0 || offset + 4 + frameLength > responseBuffer.length) {
            break;
          }

          const frame = responseBuffer.subarray(offset + 4, offset + 4 + frameLength).toString('utf8');
          parseCandidate(frame);
          offset += 4 + frameLength;
        }
        if (offset > 0) {
          responseBuffer = responseBuffer.subarray(offset);
        }

        // Fallback for plain newline-delimited JSON payloads.
        let newlineIndex = responseBuffer.indexOf(0x0a);
        while (newlineIndex !== -1) {
          const line = responseBuffer.subarray(0, newlineIndex).toString('utf8');
          responseBuffer = responseBuffer.subarray(newlineIndex + 1);
          parseCandidate(line);
          newlineIndex = responseBuffer.indexOf(0x0a);
        }

        if (parsedMessages.length > 0) {
          const typeOf = (message: OperationParams) => readString(message, 'type');
          const candidate =
            parsedMessages.find((m) => typeOf(m) === 'screenshot_file' && m['path']) ??
            parsedMessages.find((m) => typeOf(m) === 'screenshot' && m['data']) ??
            parsedMessages.find((m) => typeOf(m) === 'pong') ??
            parsedMessages.find((m) => {
              const type = typeOf(m);
              return type !== undefined && type !== 'welcome';
            });

          if (candidate) {
            resolveRuntimePayload(candidate);
          }
        }
      });

      socket.on('end', () => {
        if (resolved) {
          return;
        }

        clearTimeout(timer);
        const responseData = responseBuffer.toString('utf8').trim();
        resolved = true;
        cleanupScreenshotDir();
        try {
          const parsed: unknown = JSON.parse(responseData);
          resolve({
            content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
          });
        } catch {
          resolve({
            content: [
              { type: 'text', text: responseData || 'Command sent successfully (no structured response).' },
            ],
          });
        }
      });

      socket.on('error', (error: Error) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timer);
        cleanupScreenshotDir();
        resolve({
          content: [
            {
              type: 'text',
              text: `Failed to connect to Godot runtime addon at ${RUNTIME_HOST}:${RUNTIME_PORT}: ${error.message}. Ensure the game is running with the MCP runtime autoload enabled.`,
            },
          ],
        });
      });
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
    this.dapClient ??= new GodotDAPClient();
    return handleDAPTool(this.dapClient, toolName, args);
  }

  private buildToolNameResolutionMap(allTools: MCPToolDefinition[]): Map<string, string> {
    const resolutionMap = new Map<string, string>();

    const register = (candidateName: string, resolvedName: string) => {
      const existing = resolutionMap.get(candidateName);
      if (existing && existing !== resolvedName) {
        throw new Error(
          `Sanitized tool name collision: "${candidateName}" maps to both "${existing}" and "${resolvedName}"`,
        );
      }
      resolutionMap.set(candidateName, resolvedName);
    };

    for (const tool of allTools) {
      register(tool.name, tool.name);
      register(sanitizeExportedToolName(tool.name), tool.name);
    }

    for (const [compactName, legacyName] of Object.entries(this.compactAliasToLegacy)) {
      register(compactName, legacyName);
      register(sanitizeExportedToolName(compactName), legacyName);
    }

    return resolutionMap;
  }

  private resolveToolAlias(requestedToolName: string): string {
    const allTools = this.getAllToolDefinitions();
    const resolutionMap = this.buildToolNameResolutionMap(allTools);
    return (
      resolutionMap.get(requestedToolName) ??
      resolutionMap.get(sanitizeExportedToolName(requestedToolName)) ??
      requestedToolName
    );
  }

  private buildCompactTools(allTools: MCPToolDefinition[]): MCPToolDefinition[] {
    const compactTools: MCPToolDefinition[] = [];

    for (const [compactName, legacyName] of Object.entries(this.compactAliasToLegacy)) {
      const source = allTools.find((tool) => tool.name === legacyName);
      if (!source) {
        continue;
      }

      compactTools.push({
        ...source,
        name: compactName,
        description: `[compact alias of ${legacyName}] ${source.description}`,
      });
    }

    return compactTools;
  }

  private jsonTextResponse(payload: unknown): { content: { type: string; text: string }[] } {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  private buildLegacyToCompactAliasMap(): Map<string, string> {
    return new Map(
      Object.entries(this.compactAliasToLegacy).map(([compactName, legacyName]) => [legacyName, compactName]),
    );
  }

  private buildToolGroupLookup(): Map<string, { group: string; type: 'core' | 'dynamic' }> {
    const toolToGroup = new Map<string, { group: string; type: 'core' | 'dynamic' }>();
    const registerGroups = (groups: Record<string, { tools: string[] }>, type: 'core' | 'dynamic') => {
      for (const [groupName, group] of Object.entries(groups)) {
        for (const toolName of group.tools) {
          toolToGroup.set(toolName, { group: groupName, type });
        }
      }
    };

    registerGroups(CORE_TOOL_GROUPS, 'core');
    registerGroups(TOOL_GROUPS, 'dynamic');

    return toolToGroup;
  }

  private getActivatedToolNames(): Set<string> {
    const activatedToolNames = new Set<string>();

    for (const groupName of this.activeGroups) {
      const group = TOOL_GROUPS[groupName];
      if (!group) {
        continue;
      }

      for (const toolName of group.tools) {
        activatedToolNames.add(toolName);
      }
    }

    return activatedToolNames;
  }

  private getAvailableDynamicGroups(): string[] {
    return Object.keys(TOOL_GROUPS);
  }

  private getUnknownDynamicGroupError(groupName: string): string {
    return `Unknown group '${groupName}'. Available dynamic groups: ${this.getAvailableDynamicGroups().join(', ')}`;
  }

  private notifyToolListChanged(): void {
    this.cachedToolDefinitions = [];
    this.mcp.server.sendToolListChanged().catch((error: unknown) => {
      // A client that has gone away cannot be told the list changed, and that is not a
      // failure of the call that changed it; it is still worth having in the log.
      this.logDebug(`Could not send the tool list change notification: ${errorMessage(error)}`);
    });
  }

  private autoActivateMatchingGroups(query: string): string[] {
    if (!query || this.toolExposureProfile !== 'compact') {
      return [];
    }

    const newlyActivated: string[] = [];
    for (const [groupName, group] of Object.entries(TOOL_GROUPS)) {
      if (this.activeGroups.has(groupName)) {
        continue;
      }

      const hasMatchingKeyword = group.keywords.some((kw) => query.includes(kw) || kw.includes(query));
      const hasMatchingToolName = group.tools.some((toolName) => toolName.toLowerCase().includes(query));
      if (hasMatchingKeyword || hasMatchingToolName) {
        this.activeGroups.add(groupName);
        newlyActivated.push(groupName);
      }
    }

    if (newlyActivated.length > 0) {
      this.notifyToolListChanged();
    }

    return newlyActivated;
  }

  private setDynamicGroupActivation(groupName: string, active: boolean): boolean {
    const wasActive = this.activeGroups.has(groupName);

    if (active) {
      this.activeGroups.add(groupName);
    } else {
      this.activeGroups.delete(groupName);
    }

    if (wasActive !== active) {
      this.notifyToolListChanged();
    }

    return wasActive;
  }

  private sanitizeToolsForList(tools: MCPToolDefinition[]): MCPToolDefinition[] {
    const seenNames = new Map<string, string>();

    return tools.map((tool) => {
      const sanitizedName = sanitizeExportedToolName(tool.name);
      const existing = seenNames.get(sanitizedName);
      if (existing && existing !== tool.name) {
        throw new Error(
          `Sanitized tool name collision in tools/list: "${sanitizedName}" from "${existing}" and "${tool.name}"`,
        );
      }

      seenNames.set(sanitizedName, tool.name);

      if (sanitizedName !== tool.name) {
        this.logDebug(`Exporting tool "${tool.name}" as "${sanitizedName}" for OpenAI-compatible clients`);
      }

      return sanitizedName === tool.name
        ? tool
        : {
            ...tool,
            name: sanitizedName,
          };
    });
  }

  private getExposedTools(allTools: MCPToolDefinition[]): MCPToolDefinition[] {
    if (this.toolExposureProfile === 'full' || this.toolExposureProfile === 'legacy') {
      return allTools;
    }

    // Start with compact profile tools
    const exposed = this.buildCompactTools(allTools);

    // Add dynamically activated group tools (using their legacy names)
    if (this.activeGroups.size > 0) {
      const activatedToolNames = this.getActivatedToolNames();

      for (const tool of allTools) {
        if (activatedToolNames.has(tool.name)) {
          exposed.push({
            ...tool,
            description: `[dynamic] ${tool.description}`,
          });
        }
      }
    }

    return exposed;
  }

  private parseToolsListCursor(cursor: unknown, total: number): number {
    if (typeof cursor !== 'string' || cursor.length === 0) {
      return 0;
    }

    const offset = Number.parseInt(cursor, 10);
    if (!Number.isInteger(offset) || offset < 0 || offset > total) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid tools/list cursor: ${cursor}`);
    }

    return offset;
  }

  private paginateToolsForList(
    tools: MCPToolDefinition[],
    cursor: unknown,
  ): { tools: MCPToolDefinition[]; nextCursor?: string } {
    const start = this.parseToolsListCursor(cursor, tools.length);
    const end = Math.min(start + this.toolsListPageSize, tools.length);
    const page = tools.slice(start, end);

    if (end < tools.length) {
      return {
        tools: page,
        nextCursor: String(end),
      };
    }

    return { tools: page };
  }

  private getAllToolDefinitions(): MCPToolDefinition[] {
    if (this.cachedToolDefinitions.length > 0) {
      return this.cachedToolDefinitions;
    }

    if (this.toolDefinitionFactory) {
      this.cachedToolDefinitions = this.toolDefinitionFactory();
    }

    return this.cachedToolDefinitions;
  }

  private getMissingRequiredArguments(toolName: string, args: Record<string, unknown>): string[] {
    const toolDefinition = this.getAllToolDefinitions().find((tool) => tool.name === toolName);
    const required = (toolDefinition?.inputSchema as { required?: unknown } | undefined)?.required;

    if (!Array.isArray(required) || required.length === 0) {
      return [];
    }

    return required
      .filter((field): field is string => typeof field === 'string')
      .filter((field) => {
        const value = args[field];
        return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
      });
  }

  private handleToolCatalog(args: unknown): { content: { type: string; text: string }[] } {
    const normalizedArgs = this.normalizeParameters(args);
    const query = (readString(normalizedArgs, 'query') ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(100, readNumber(normalizedArgs, 'limit') ?? 30));

    const tools = this.getAllToolDefinitions();
    const reverseAlias = this.buildLegacyToCompactAliasMap();
    const toolToGroup = this.buildToolGroupLookup();

    // Any term rather than the whole query as one substring. A caller describing what they want
    // types several words, and no single tool name or description contains all of them: "inject
    // mouse click viewport capture" returned nothing while "inject" returned four. Tools matching
    // more terms come first, and the whole query appearing as written still wins.
    const terms = query.split(/\s+/).filter((term) => term.length > 0);
    const scored = tools
      .map((tool) => {
        const haystack = `${tool.name} ${tool.description}`.toLowerCase();
        const hits = terms.filter((term) => haystack.includes(term)).length;
        const exact = hits > 0 && terms.length > 1 && haystack.includes(query) ? terms.length : 0;
        return { tool, score: terms.length === 0 ? 1 : hits + exact };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    const items = scored.slice(0, limit).map(({ tool }) => {
      const groupInfo = toolToGroup.get(tool.name) ?? null;
      const compactAlias = reverseAlias.get(tool.name) ?? null;
      return {
        tool: tool.name,
        compactAlias,
        // The name to actually pass to tools/call. A tool without a compact alias is not
        // uncallable: once its group is active it is exposed under its sanitized name,
        // where underscores are hyphens. Reporting only a null alias reads as "this tool
        // cannot be called", which is how it was read in #74.
        callAs: compactAlias ?? sanitizeExportedToolName(tool.name),
        requiresGroupActivation:
          !compactAlias && groupInfo?.type === 'dynamic' && !this.activeGroups.has(groupInfo.group),
        group: groupInfo?.group ?? null,
        groupType: groupInfo?.type ?? null,
        description: tool.description,
      };
    });

    // Auto-activate matching tool groups when query matches their keywords
    // or when the query directly matches a group's tool NAME (not description).
    // This prevents over-activation from incidental description matches.
    const newlyActivated = this.autoActivateMatchingGroups(query);

    return this.jsonTextResponse({
      profile: this.toolExposureProfile,
      totalTools: tools.length,
      query: query || null,
      returned: items.length,
      activeGroups: Array.from(this.activeGroups),
      newlyActivated: newlyActivated.length > 0 ? newlyActivated : undefined,
      tools: items,
    });
  }

  private handleManageToolGroups(args: unknown): { content: { type: string; text: string }[] } {
    const normalizedArgs = this.normalizeParameters(args);
    const action = (readString(normalizedArgs, 'action') ?? 'status').toLowerCase();
    const groupName = readString(normalizedArgs, 'group') ?? '';

    switch (action) {
      case 'list': {
        const coreGroups = Object.entries(CORE_TOOL_GROUPS).map(([name, group]) => ({
          name,
          type: 'core' as const,
          description: group.description,
          tools: group.tools,
          toolCount: group.tools.length,
          alwaysVisible: true,
        }));
        const dynamicGroups = Object.entries(TOOL_GROUPS).map(([name, group]) => ({
          name,
          type: 'dynamic' as const,
          description: group.description,
          tools: group.tools,
          toolCount: group.tools.length,
          active: this.activeGroups.has(name),
        }));
        const allGroups = [...coreGroups, ...dynamicGroups];
        const totalCoreTools = coreGroups.reduce((sum, g) => sum + g.toolCount, 0);
        const totalDynTools = dynamicGroups.reduce((sum, g) => sum + g.toolCount, 0);
        return this.jsonTextResponse({
          totalGroups: allGroups.length,
          coreGroups: coreGroups.length,
          dynamicGroups: dynamicGroups.length,
          coreTools: totalCoreTools,
          dynamicTools: totalDynTools,
          groups: allGroups,
        });
      }

      case 'activate': {
        if (groupName && CORE_TOOL_GROUPS[groupName]) {
          return this.jsonTextResponse({
            error: `'${groupName}' is a core group and always visible. No activation needed.`,
          });
        }
        if (!groupName || !TOOL_GROUPS[groupName]) {
          return this.jsonTextResponse({ error: this.getUnknownDynamicGroupError(groupName) });
        }
        const wasAlreadyActive = this.setDynamicGroupActivation(groupName, true);
        return this.jsonTextResponse({
          activated: groupName,
          tools: TOOL_GROUPS[groupName].tools,
          wasAlreadyActive,
          activeGroups: Array.from(this.activeGroups),
        });
      }

      case 'deactivate': {
        if (groupName && CORE_TOOL_GROUPS[groupName]) {
          return this.jsonTextResponse({
            error: `'${groupName}' is a core group and cannot be deactivated.`,
          });
        }
        if (!groupName || !TOOL_GROUPS[groupName]) {
          return this.jsonTextResponse({ error: this.getUnknownDynamicGroupError(groupName) });
        }
        const wasActive = this.setDynamicGroupActivation(groupName, false);
        return this.jsonTextResponse({
          deactivated: groupName,
          wasActive,
          activeGroups: Array.from(this.activeGroups),
        });
      }

      case 'reset': {
        const previouslyActive = Array.from(this.activeGroups);
        this.activeGroups.clear();
        if (previouslyActive.length > 0) {
          this.notifyToolListChanged();
        }
        return this.jsonTextResponse({
          reset: true,
          deactivated: previouslyActive,
          activeGroups: [],
        });
      }

      // 'status' lands here too: an unrecognised action reports the state rather than failing.
      default: {
        const coreGroupDetails = Object.entries(CORE_TOOL_GROUPS).map(([name, group]) => ({
          name,
          type: 'core' as const,
          description: group.description,
          tools: group.tools,
          alwaysVisible: true,
        }));
        const activeGroupDetails = Array.from(this.activeGroups).map((name) => ({
          name,
          type: 'dynamic' as const,
          description: TOOL_GROUPS[name]?.description,
          tools: TOOL_GROUPS[name]?.tools,
        }));
        const totalCoreTools = coreGroupDetails.reduce((sum, g) => sum + g.tools.length, 0);
        const totalDynamicTools = activeGroupDetails.reduce((sum, g) => sum + (g.tools?.length ?? 0), 0);
        return this.jsonTextResponse({
          coreGroups: { count: coreGroupDetails.length, tools: totalCoreTools, groups: coreGroupDetails },
          dynamicGroups: {
            activeCount: this.activeGroups.size,
            tools: totalDynamicTools,
            groups: activeGroupDetails,
          },
          availableDynamicGroups: this.getAvailableDynamicGroups(),
        });
      }
    }
  }

  /**
   * Normalize parameters to camelCase format.
   *
   * Takes `unknown` because that is what arrives: a `tools/call` with no `arguments` member
   * is legal MCP, and the SDK passes the absence straight through. Declaring the parameter
   * non-nullable meant a handler's first read threw a TypeError instead of returning the
   * "required argument" response written a few lines below it.
   *
   * @param params Object with either snake_case or camelCase keys, or nothing at all
   * @returns Object with all keys in camelCase format
   */
  private normalizeParameters(params: unknown): OperationParams {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return {};
    }

    const source = params as OperationParams;
    const result: OperationParams = {};

    for (const key in source) {
      if (Object.hasOwn(source, key)) {
        let normalizedKey = key;

        // Preserve sentinel keys like _type, but normalize regular snake_case keys.
        if (key.startsWith('_')) {
          normalizedKey = key;
        } else if (key.includes('_')) {
          normalizedKey =
            this.parameterMappings[key] ??
            key.replace(/_([a-zA-Z0-9])/g, (_, letter: string) => letter.toUpperCase());
        }

        const value = source[key];

        // Handle nested objects recursively
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          result[normalizedKey] = this.normalizeParameters(value);
        } else {
          result[normalizedKey] = value;
        }
      }
    }

    return result;
  }

  /**
   * Convert camelCase keys to snake_case
   * @param params Object with camelCase keys
   * @returns Object with snake_case keys
   */
  private convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};

    for (const key in params) {
      if (Object.hasOwn(params, key)) {
        // Convert camelCase to snake_case while preserving sentinel keys like _type.
        const snakeKey = key.startsWith('_')
          ? key
          : (this.reverseParameterMappings[key] ??
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));

        const value = params[key];

        // Handle nested objects recursively
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          result[snakeKey] = this.convertCamelToSnakeCase(value as OperationParams);
        } else {
          result[snakeKey] = value;
        }
      }
    }

    return result;
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string,
  ): Promise<{ stdout: string; stderr: string }> {
    this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

    // Convert camelCase parameters to snake_case for Godot script
    const snakeCaseParams = this.convertCamelToSnakeCase(params);
    this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);

    // Ensure godotPath is set
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) {
        throw new Error('Could not find a valid Godot executable path');
      }
    }

    try {
      // Parameters go via a temp file rather than the command line: a JSON blob on argv
      // runs into Windows command-line parsing of \t, \r and \" whatever the quoting.
      const paramsDir = mkdtempSync(join(tmpdir(), 'gdharness-params-'));
      const paramsFilePath = join(paramsDir, `${operation}.json`);
      writeFileSync(paramsFilePath, JSON.stringify(snakeCaseParams), 'utf8');

      const args = [
        '--headless',
        '--path',
        projectPath,
        '--script',
        this.operationsScriptPath,
        operation,
        `@file:${paramsFilePath}`,
        ...(this.godotDebugMode ? ['--debug-godot'] : []),
      ];

      this.logDebug(`Running: ${this.godotPath} ${args.join(' ')}`);

      try {
        const { stdout, stderr } = await run(this.godotPath, args);
        return { stdout, stderr: this.sanitizeGodotStderr(stderr) };
      } finally {
        rmSync(paramsDir, { recursive: true, force: true });
      }
    } catch (error) {
      // A non-zero exit still carries stdout and stderr on the thrown error
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return {
          stdout: execError.stdout,
          stderr: this.sanitizeGodotStderr(execError.stderr),
        };
      }

      throw error;
    }
  }

  private getEditorStatusPayload() {
    const status = this.godotBridge.getStatus();
    const isPortConflict = this.bridgeStartupError?.includes('EADDRINUSE') ?? false;

    return {
      ...status,
      bridgeAvailable: this.bridgeStartupError === null,
      startupError: this.bridgeStartupError,
      note: isPortConflict
        ? 'Bridge port is already in use. Another gdharness instance may own the editor bridge, so this server cannot report that editor connection.'
        : undefined,
      suggestion: isPortConflict
        ? 'Stop duplicate gdharness/MCP server instances or re-run the command from the same server process that owns the bridge port.'
        : undefined,
    };
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): { path: string; name: string }[] {
    const projects: { path: string; name: string }[] = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${errorMessage(error)}`);
    }

    return projects;
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    this.mcp.server.setRequestHandler(ListPromptsRequestSchema, (request) => {
      return listPrompts(request.params?.cursor);
    });

    this.mcp.server.setRequestHandler(GetPromptRequestSchema, (request) => {
      return getPrompt(request.params.name, request.params.arguments);
    });

    // Define available tools
    const buildToolDefinitions = (): MCPToolDefinition[] => buildToolDefinitionsForServer();

    this.toolDefinitionFactory = buildToolDefinitions;
    this.cachedToolDefinitions = buildToolDefinitions();

    this.mcp.server.setRequestHandler(ListToolsRequestSchema, (request) => {
      const allTools = buildToolDefinitions();
      this.cachedToolDefinitions = allTools;

      const exposedTools = this.sanitizeToolsForList(this.getExposedTools(allTools));
      return this.paginateToolsForList(exposedTools, request.params?.cursor);
    });

    // Handle tool calls
    this.mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      const rawArgs = request.params.arguments;
      const normalizedArgs = this.normalizeParameters(rawArgs);
      if (typeof normalizedArgs['projectPath'] === 'string') {
        this.lastProjectPath = normalizedArgs['projectPath'];
      }
      const resolvedToolName = this.resolveToolAlias(request.params.name);
      switch (resolvedToolName) {
        case 'launch_editor':
          return await this.handleLaunchEditor(request.params.arguments);
        case 'run_project':
          return await this.handleRunProject(request.params.arguments);
        case 'get_debug_output':
          return this.handleGetDebugOutput();
        case 'stop_project':
          return this.handleStopProject();
        case 'get_godot_version':
          return await this.handleGetGodotVersion();
        case 'list_projects':
          return this.handleListProjects(request.params.arguments);
        case 'get_project_info':
          return await this.handleGetProjectInfo(request.params.arguments);
        case 'validate_patch_with_lsp':
          return await this.handleValidatePatchWithLsp(request.params.arguments);
        case 'enforce_version_gate':
          return await this.handleEnforceVersionGate(request.params.arguments);
        case 'tool_catalog':
          return this.handleToolCatalog(request.params.arguments);
        case 'manage_tool_groups':
          return this.handleManageToolGroups(request.params.arguments);
        case 'create_scene':
          return await this.handleViaBridge('create_scene', normalizedArgs);
        case 'add_node':
          return await this.handleViaBridge('add_node', normalizedArgs);
        case 'load_sprite':
          return await this.handleViaBridge('load_sprite', normalizedArgs);
        case 'save_scene':
          return await this.handleViaBridge('save_scene', normalizedArgs);
        case 'get_uid':
          return await this.handleGetUid(request.params.arguments);
        case 'update_project_uids':
          return await this.handleUpdateProjectUids(request.params.arguments);
        case 'rescan_filesystem':
          return await this.handleRescanFilesystem(normalizedArgs);
        // Phase 1: Scene Operations handlers
        case 'list_scene_nodes':
          return await this.handleViaBridge('list_scene_nodes', normalizedArgs);
        case 'get_node_properties':
          return await this.handleViaBridge('get_node_properties', normalizedArgs);
        case 'set_node_properties':
          return await this.handleViaBridge('set_node_properties', normalizedArgs);
        case 'delete_node':
          return await this.handleViaBridge('delete_node', normalizedArgs);
        case 'duplicate_node':
          return await this.handleViaBridge('duplicate_node', normalizedArgs);
        case 'reparent_node':
          return await this.handleViaBridge('reparent_node', normalizedArgs);
        // Phase 2: Import/Export Pipeline handlers
        case 'get_import_status':
          return await this.handleGetImportStatus(request.params.arguments);
        case 'get_import_options':
          return await this.handleGetImportOptions(request.params.arguments);
        case 'set_import_options':
          return await this.handleSetImportOptions(request.params.arguments);
        case 'reimport_resource':
          return await this.handleReimportResource(request.params.arguments);
        case 'list_export_presets':
          return await this.handleListExportPresets(request.params.arguments);
        case 'export_project':
          return await this.handleExportProject(request.params.arguments);
        case 'validate_project':
          return await this.handleValidateProject(request.params.arguments);
        // Phase 3: DX Tools handlers
        case 'get_dependencies':
          return await this.handleGetDependencies(request.params.arguments);
        case 'find_resource_usages':
          return await this.handleFindResourceUsages(request.params.arguments);
        case 'parse_error_log':
          return await this.handleParseErrorLog(request.params.arguments);
        case 'get_project_health':
          return await this.handleGetProjectHealth(request.params.arguments);
        // Phase 3: Config Tools handlers
        case 'get_project_setting':
          return await this.handleGetProjectSetting(request.params.arguments);
        case 'set_project_setting':
          return await this.handleSetProjectSetting(request.params.arguments);
        case 'add_autoload':
          return await this.handleAddAutoload(request.params.arguments);
        case 'remove_autoload':
          return await this.handleRemoveAutoload(request.params.arguments);
        case 'list_autoloads':
          return await this.handleListAutoloads(request.params.arguments);
        case 'set_main_scene':
          return await this.handleSetMainScene(request.params.arguments);
        // Signal Management handlers
        case 'connect_signal':
          return await this.handleViaBridge('connect_signal', normalizedArgs);
        case 'disconnect_signal':
          return await this.handleViaBridge('disconnect_signal', normalizedArgs);
        case 'list_connections':
          return await this.handleViaBridge('list_connections', normalizedArgs);
        // Phase 4: Runtime Tools handlers
        case 'get_runtime_status':
          return await this.handleGetRuntimeStatus(request.params.arguments);
        case 'inspect_runtime_tree':
          return await this.handleInspectRuntimeTree(request.params.arguments);
        case 'set_runtime_property':
          return await this.handleSetRuntimeProperty(request.params.arguments);
        case 'call_runtime_method':
          return await this.handleCallRuntimeMethod(request.params.arguments);
        case 'get_runtime_metrics':
          return await this.handleGetRuntimeMetrics(request.params.arguments);
        // Resource Creation Tools handlers
        case 'create_resource':
          return await this.handleViaBridge('create_resource', normalizedArgs);
        case 'create_material':
          return await this.handleViaBridge('create_material', normalizedArgs);
        case 'create_shader':
          return await this.handleViaBridge('create_shader', normalizedArgs);
        // GDScript File Operations handlers
        case 'create_script':
          return await this.handleCreateScript(request.params.arguments);
        case 'modify_script':
          return await this.handleModifyScript(request.params.arguments);
        case 'get_script_info':
          return await this.handleGetScriptInfo(request.params.arguments);
        // Animation Tools handlers
        case 'create_animation':
          return await this.handleViaBridge('create_animation', normalizedArgs);
        case 'add_animation_track':
          return await this.handleViaBridge('add_animation_track', normalizedArgs);
        // Plugin Management handlers
        case 'list_plugins':
          return await this.handleListPlugins(request.params.arguments);
        case 'enable_plugin':
          return await this.handleEnablePlugin(request.params.arguments);
        case 'disable_plugin':
          return await this.handleDisablePlugin(request.params.arguments);
        // Input Action handlers
        case 'add_input_action':
          return await this.handleAddInputAction(request.params.arguments);
        // Project Search handlers
        case 'search_project':
          return this.handleSearchProject(request.params.arguments);
        // 2D Tile Tools handlers
        case 'create_tileset':
          return await this.handleViaBridge('create_tileset', normalizedArgs);
        case 'set_tilemap_cells':
          return await this.handleViaBridge('set_tilemap_cells', normalizedArgs);
        // Audio System Tools handlers
        case 'create_audio_bus':
          return await this.handleCreateAudioBus(request.params.arguments);
        case 'get_audio_buses':
          return await this.handleGetAudioBuses(request.params.arguments);
        case 'set_audio_bus_effect':
          return await this.handleSetAudioBusEffect(request.params.arguments);
        case 'set_audio_bus_volume':
          return await this.handleSetAudioBusVolume(request.params.arguments);
        // Networking Tools handlers
        // Physics Tools handlers
        // Navigation Tools handlers
        case 'create_navigation_region':
          return await this.handleViaBridge('create_navigation_region', normalizedArgs);
        case 'create_navigation_agent':
          return await this.handleViaBridge('create_navigation_agent', normalizedArgs);
        // Rendering Tools handlers
        // Animation Tree Tools handlers
        case 'create_animation_tree':
          return await this.handleViaBridge('create_animation_tree', normalizedArgs);
        case 'add_animation_state':
          return await this.handleViaBridge('add_animation_state', normalizedArgs);
        case 'connect_animation_states':
          return await this.handleViaBridge('connect_animation_states', normalizedArgs);
        // UI/Theme Tools handlers
        case 'set_theme_color':
          return await this.handleViaBridge('set_theme_color', normalizedArgs);
        case 'set_theme_font_size':
          return await this.handleViaBridge('set_theme_font_size', normalizedArgs);
        case 'apply_theme_shader':
          return await this.handleViaBridge('apply_theme_shader', normalizedArgs);
        // ClassDB Introspection Tools
        case 'query_classes':
          return await this.handleQueryClasses(request.params.arguments);
        case 'query_class_info':
          return await this.handleQueryClassInfo(request.params.arguments);
        case 'inspect_inheritance':
          return await this.handleInspectInheritance(request.params.arguments);
        // Resource Modification Tool
        case 'modify_resource':
          return await this.handleViaBridge('modify_resource', normalizedArgs);
        // Editor Plugin Bridge Status
        case 'get_editor_status':
          return {
            content: [{ type: 'text', text: JSON.stringify(this.getEditorStatusPayload(), null, 2) }],
          };
        case 'capture_screenshot':
          return await this.handleRuntimeCommand('capture_screenshot', request.params.arguments);
        case 'capture_viewport':
          return await this.handleRuntimeCommand('capture_viewport', request.params.arguments);
        case 'inject_action':
          return await this.handleRuntimeCommand('inject_action', request.params.arguments);
        case 'inject_key':
          return await this.handleRuntimeCommand('inject_key', request.params.arguments);
        case 'inject_mouse_click':
          return await this.handleRuntimeCommand('inject_mouse_click', request.params.arguments);
        case 'inject_mouse_motion':
          return await this.handleRuntimeCommand('inject_mouse_motion', request.params.arguments);
        case 'lsp_get_diagnostics':
        case 'lsp_get_completions':
        case 'lsp_get_hover':
        case 'lsp_get_symbols':
          return await this.handleLSP(resolvedToolName, request.params.arguments);
        case 'dap_get_output':
        case 'dap_set_breakpoint':
        case 'dap_remove_breakpoint':
        case 'dap_continue':
        case 'dap_pause':
        case 'dap_step_over':
        case 'dap_get_stack_trace':
          return await this.handleDAP(resolvedToolName, request.params.arguments);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(rawArgs: unknown) {
    // Normalize parameters to camelCase
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      this.logDebug(`Launching Godot editor for project: ${projectPath}`);
      const process = spawn(this.godotPath, ['-e', '--path', projectPath], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${projectPath}.`,
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to launch Godot editor: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Whether to launch the game without a window.
   *
   * A headless Godot renders nothing, so capture_screenshot, capture_viewport and the input
   * injection tools cannot work against a game started that way: they fail in the dummy
   * texture storage, and run_project is the only way to start a game over MCP.
   *
   * Left to itself this follows the environment. CI is both the place that needs headless
   * and the place with no display, so deciding on the display keeps every existing headless
   * run headless while letting the visual tools work on a desktop with no configuration.
   * An explicit true or false overrides it.
   */
  private resolveHeadless(requested: unknown): boolean {
    if (typeof requested === 'boolean') {
      return requested;
    }
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return false;
    }
    // Through envValue because a display variable exported empty means no display, the same as
    // one that was never exported: a bare `??` here would read `DISPLAY=""` as a desktop.
    return envValue('DISPLAY') === undefined && envValue('WAYLAND_DISPLAY') === undefined;
  }

  private async handleRunProject(rawArgs: unknown) {
    // Normalize parameters to camelCase
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const scene = readString(args, 'scene');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
      }

      const cmdArgs = this.resolveHeadless(args['headless'])
        ? ['--headless', '-d', '--path', projectPath]
        : ['-d', '--path', projectPath];
      if (scene && this.validatePath(scene)) {
        this.logDebug(`Adding scene parameter: ${scene}`);
        cmdArgs.push(scene);
      }

      this.logDebug(`Running Godot project: ${projectPath}`);
      const process = spawn(this.godotPath, cmdArgs, { stdio: 'pipe' });
      const output: string[] = [];
      const errors: string[] = [];

      process.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      process.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      process.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code ?? 'none'}`);
        if (this.activeProcess?.process === process) {
          this.activeProcess = null;
        }
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess?.process === process) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = { process, output, errors };

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output.`,
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to run Godot project: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Route a tool call through the Godot Editor Plugin bridge (WebSocket).
   * Returns an error response if the editor is not connected.
   */
  /**
   * Rescan the project filesystem, and wait for the scan to finish.
   *
   * The waiting is here rather than in the addon because the editor-side tool executor
   * takes a Dictionary back and not a coroutine, so the addon can only start the scan and
   * report whether one is running. A caller that has just written a script needs the scan
   * to have landed before the new class_name is resolvable, so this polls until it has.
   */
  private async handleRescanFilesystem(rawArgs: unknown): Promise<ToolResponse> {
    const args = this.normalizeParameters(rawArgs);
    const timeoutMs = readNumberLike(args, 'timeoutMs') ?? 10000;
    const started = Date.now();

    const first = await this.handleViaBridge('rescan_filesystem', args);
    if (first.isError) {
      return first;
    }

    let busy = true;
    while (busy && Date.now() - started < timeoutMs) {
      await new Promise((settle) => setTimeout(settle, 100));
      const status = (await this.godotBridge.invokeTool('rescan_filesystem', {
        ...args,
        statusOnly: true,
      })) as Record<string, unknown>;
      busy = Boolean(status['scanning']) || Boolean(status['importing']);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: !busy,
              stillWorking: busy,
              waitedMs: Date.now() - started,
              note: busy
                ? 'The editor was still scanning or importing when the wait ran out, so new files may not be visible yet.'
                : undefined,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleViaBridge(toolName: string, args: unknown): Promise<ToolResponse> {
    if (!this.godotBridge.isConnected()) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error:
                  'Godot Editor not connected. Launch Godot Editor and enable the "Godot MCP Editor" plugin to use this tool.',
                suggestion:
                  'Use the launch_editor tool to open the Godot Editor, then enable the plugin in Project > Project Settings > Plugins.',
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    try {
      const normalizedArgs = this.normalizeParameters(args);
      const missingRequiredArgs = this.getMissingRequiredArguments(toolName, normalizedArgs);
      if (missingRequiredArgs.length > 0) {
        return this.createErrorResponse(
          `Missing required arguments for ${toolName}: ${missingRequiredArgs.join(', ')}`,
          [`Provide required argument(s): ${missingRequiredArgs.join(', ')}`],
        );
      }
      const result = await this.godotBridge.invokeTool(toolName, normalizedArgs);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: errorMessage(error),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private handleGetDebugOutput(): ToolResponse {
    if (!this.activeProcess) {
      return this.createErrorResponse('No active Godot process.', [
        'Use run_project to start a Godot project first',
        'Check if the Godot process crashed unexpectedly',
      ]);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output,
              errors: this.activeProcess.errors,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private handleStopProject(): ToolResponse {
    if (!this.activeProcess) {
      return this.createErrorResponse('No active Godot process to stop.', [
        'Use run_project to start a Godot project first',
        'The process may have already terminated',
      ]);
    }

    this.logDebug('Stopping active Godot process');
    this.activeProcess.process.kill();
    const output = this.activeProcess.output;
    const errors = this.activeProcess.errors;
    this.activeProcess = null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await run(this.godotPath, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get Godot version: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
      ]);
    }
  }

  /**
   * Handle the list_projects tool
   */
  private handleListProjects(rawArgs: unknown): ToolResponse {
    // Normalize parameters to camelCase
    const args = this.normalizeParameters(rawArgs);
    const directory = readString(args, 'directory');

    if (!directory) {
      return this.createErrorResponse('Directory is required', [
        'Provide a valid directory path to search for Godot projects',
      ]);
    }

    if (!this.validatePath(directory)) {
      return this.createErrorResponse('Invalid directory path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${directory}`);
      if (!existsSync(directory)) {
        return this.createErrorResponse(`Directory does not exist: ${directory}`, [
          'Provide a valid directory path that exists on the system',
        ]);
      }

      const recursive = readBoolean(args, 'recursive') ?? false;
      const projects = this.findGodotProjects(directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to list projects: ${errorMessage(error)}`, [
        'Ensure the directory exists and is accessible',
        'Check if you have permission to read the directory',
      ]);
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
   */
  private getProjectStructureAsync(projectPath: string): Promise<ProjectStructure> {
    return new Promise((resolve) => {
      try {
        const structure: ProjectStructure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });

          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);

            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }

            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();

              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (
                ['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext ?? '')
              ) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };

        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${errorMessage(error)}`);
        resolve({
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */
  private async handleGetProjectInfo(rawArgs: unknown) {
    // Normalize parameters to camelCase
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      this.logDebug(`Getting project info for: ${projectPath}`);

      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await run(this.godotPath, ['--version'], execOptions);

      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(projectPath);

      // Extract project name from project.godot file
      let projectName = basename(projectPath);
      try {
        const projectFileContent = readFileSync(projectFile, 'utf8');
        const configNameMatch = /config\/name="([^"]+)"/.exec(projectFileContent);
        if (configNameMatch?.[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${errorMessage(error)}`);
        // Continue with default project name if extraction fails
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: projectPath,
                godotVersion: stdout.trim(),
                structure: projectStructure,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get project info: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  private compareMajorMinorVersions(actual: string, minimum: string): boolean {
    const parse = (value: string): [number, number] => {
      const m = /(\d+)\.(\d+)/.exec(value);
      if (!m?.[1] || !m[2]) return [0, 0];
      return [parseInt(m[1], 10), parseInt(m[2], 10)];
    };

    const [aMaj, aMin] = parse(actual);
    const [mMaj, mMin] = parse(minimum);

    if (aMaj > mMaj) return true;
    if (aMaj < mMaj) return false;
    return aMin >= mMin;
  }

  /**
   * Pre-apply LSP validation gate
   */
  private async handleValidatePatchWithLsp(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const scriptPath = readString(args, 'scriptPath');

    if (!projectPath || !scriptPath) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and scriptPath']);
    }

    try {
      const lspResult = await this.handleLSP('lsp_get_diagnostics', {
        projectPath,
        scriptPath,
      });

      const textPayload = lspResult.content[0]?.text ?? '{}';
      let diagnostics: unknown[] = [];
      try {
        const parsed = asParams(JSON.parse(textPayload));
        diagnostics = readArray(parsed, 'diagnostics') ?? [];
      } catch {
        diagnostics = [];
      }

      const hasBlocking = diagnostics.some((entry) => {
        const severity = asParams(entry)['severity'];
        return severity === 1 || severity === 'error' || severity === 'ERROR';
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                scriptPath,
                diagnosticsCount: diagnostics.length,
                blockOnError: hasBlocking,
                canApply: !hasBlocking,
                diagnostics,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed LSP validation: ${errorMessage(error)}`, [
        'Ensure Godot editor is running with LSP enabled (port 6005)',
      ]);
    }
  }

  /**
   * Version and protocol gate
   */
  private async handleEnforceVersionGate(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', ['Provide projectPath']);
    }

    const minGodotVersion = readNonEmptyString(args, 'minGodotVersion') ?? '4.2';
    const minProtocolVersion = readNonEmptyString(args, 'minProtocolVersion') ?? '1.0';

    try {
      const versionResult = await this.handleGetGodotVersion();
      const godotVersion = (versionResult.content[0]?.text ?? '').trim();
      const godotOk = this.compareMajorMinorVersions(godotVersion, minGodotVersion);

      let runtimeProtocol = 'unknown';
      let runtimeConnected = false;
      let protocolOk = false;
      let capabilityInfo: OperationParams = {};

      const runtime = await this.handleRuntimeCommand('ping', {});
      const runtimeText = runtime.content[0]?.text ?? '{}';
      try {
        const parsed = asParams(JSON.parse(runtimeText));
        runtimeConnected = !parsed['error'];
        runtimeProtocol = readNonEmptyStringEither(parsed, 'protocol_version', 'protocolVersion') ?? '1.0';
        capabilityInfo = {
          hasRuntime: runtimeConnected,
          responseType: readString(parsed, 'type') ?? null,
        };
      } catch {
        runtimeConnected = false;
      }

      protocolOk = this.compareMajorMinorVersions(runtimeProtocol, minProtocolVersion);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: godotOk && (runtimeConnected ? protocolOk : true),
                requirements: {
                  minGodotVersion,
                  minProtocolVersion,
                },
                actual: {
                  godotVersion,
                  runtimeConnected,
                  runtimeProtocol,
                },
                checks: {
                  godotOk,
                  protocolOk: runtimeConnected ? protocolOk : null,
                },
                capabilityInfo,
                recommendation: godotOk
                  ? runtimeConnected
                    ? protocolOk
                      ? 'Version gate passed.'
                      : 'Runtime protocol is below minimum. Update runtime addon.'
                    : 'Godot version is compatible. Runtime addon not connected; run project/addon for full protocol check.'
                  : 'Godot version below minimum requirement. Upgrade Godot.',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to enforce version gate: ${errorMessage(error)}`, [
        'Ensure Godot is installed and runtime addon is available',
      ]);
    }
  }

  private extractLastJsonLine(stdout: string): string | null {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines.reverse()) {
      if (!(line.startsWith('{') || line.startsWith('['))) {
        continue;
      }

      try {
        JSON.parse(line);
        return line;
      } catch {
        // Not the JSON payload: Godot writes warnings on the same stream, so keep scanning.
      }
    }

    return null;
  }

  private sanitizeGodotStderr(stderr: string): string {
    if (!stderr) {
      return stderr;
    }

    const ignoredPatterns = [
      /WARNING: ObjectDB instances leaked at exit/i,
      /at:\s+cleanup\s+\(core\/object\/object\.cpp:/i,
      /ERROR:\s+\d+\s+resources still in use at exit/i,
      /at:\s+clear\s+\(core\/io\/resource\.cpp:/i,
    ];

    const filteredLines = stderr.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      return !ignoredPatterns.some((pattern) => pattern.test(trimmed));
    });

    return filteredLines.join('\n').trim();
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(rawArgs: unknown) {
    // Normalize parameters to camelCase
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const filePath = readString(args, 'filePath');

    if (!projectPath || !filePath) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and filePath']);
    }

    if (!this.validatePath(projectPath) || !this.validatePath(filePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Check if the file exists
      const resolvedFilePath = join(projectPath, filePath);
      if (!existsSync(resolvedFilePath)) {
        return this.createErrorResponse(`File does not exist: ${filePath}`, [
          'Ensure the file path is correct',
        ]);
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, projectPath);

      if (stderr.includes('Failed to')) {
        return this.createErrorResponse(`Failed to get UID: ${stderr}`, [
          'Check if the file is a valid Godot resource',
          'Ensure the file path is correct',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get UID: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(rawArgs: unknown) {
    // Normalize parameters to camelCase
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable to specify the correct path',
          ]);
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
          'Use list_projects to find valid Godot projects',
        ]);
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, projectPath);

      if (stderr.includes('Failed to')) {
        return this.createErrorResponse(`Failed to update project UIDs: ${stderr}`, [
          'Check if the project is valid',
          'Ensure you have write permissions to the project directory',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to update project UIDs: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Check if the GODOT_PATH environment variable is set correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  // ============================================
  // Phase 1: Scene Operations Handlers
  // ============================================

  // ============================================
  // Phase 2: Import/Export Pipeline Handlers
  // ============================================

  /**
   * Handle the get_import_status tool
   */
  private async handleGetImportStatus(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const resourcePath = readString(args, 'resourcePath');
    const includeUpToDate = readBoolean(args, 'includeUpToDate') ?? false;

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resourcePath ?? '',
        includeUpToDate,
      };

      const { stdout, stderr } = await this.executeOperation('get_import_status', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to get import status: ${stderr}`, [
          'Verify the resource path if specified',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get import status: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the get_import_options tool
   */
  private async handleGetImportOptions(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const resourcePath = readString(args, 'resourcePath');

    if (!projectPath || !resourcePath) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath and resourcePath',
      ]);
    }

    if (!this.validatePath(projectPath) || !this.validatePath(resourcePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const resourceFile = join(projectPath, resourcePath);
      if (!existsSync(resourceFile)) {
        return this.createErrorResponse(`Resource file does not exist: ${resourcePath}`, [
          'Ensure the resource path is correct',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resourcePath,
      };

      const { stdout, stderr } = await this.executeOperation('get_import_options', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to get import options: ${stderr}`, [
          'Verify the resource is an importable file type',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get import options: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the set_import_options tool
   */
  private async handleSetImportOptions(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const resourcePath = readString(args, 'resourcePath');
    const options = readParams(args, 'options');
    const reimport = readBoolean(args, 'reimport') !== false;

    if (!projectPath || !resourcePath || !options) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, resourcePath, and options',
      ]);
    }

    if (!this.validatePath(projectPath) || !this.validatePath(resourcePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const resourceFile = join(projectPath, resourcePath);
      if (!existsSync(resourceFile)) {
        return this.createErrorResponse(`Resource file does not exist: ${resourcePath}`, [
          'Ensure the resource path is correct',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resourcePath,
        options: options,
        reimport,
      };

      const { stdout, stderr } = await this.executeOperation('set_import_options', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set import options: ${stderr}`, [
          'Verify the options are valid for this resource type',
        ]);
      }

      return {
        content: [{ type: 'text', text: `Import options updated successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to set import options: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the reimport_resource tool
   */
  private async handleReimportResource(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const resourcePath = readString(args, 'resourcePath');
    const force = readBoolean(args, 'force') ?? false;

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      if (resourcePath) {
        const resourceFile = join(projectPath, resourcePath);
        if (!existsSync(resourceFile)) {
          return this.createErrorResponse(`Resource file does not exist: ${resourcePath}`, [
            'Ensure the resource path is correct',
          ]);
        }
      }

      const params: OperationParams = {
        resourcePath: resourcePath ?? '',
        force,
      };

      const { stdout, stderr } = await this.executeOperation('reimport_resource', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to reimport resource: ${stderr}`, [
          'Verify the resource path if specified',
        ]);
      }

      return {
        content: [{ type: 'text', text: `Reimport completed.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to reimport resource: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the list_export_presets tool
   */
  private async handleListExportPresets(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const includeTemplateStatus = readBoolean(args, 'includeTemplateStatus') !== false;

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        includeTemplateStatus,
      };

      const { stdout, stderr } = await this.executeOperation('list_export_presets', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to list export presets: ${stderr}`, [
          'Check if export_presets.cfg exists in the project',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to list export presets: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the export_project tool
   */
  private async handleExportProject(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const preset = readNonEmptyString(args, 'preset');
    const outputPath = readString(args, 'outputPath');
    const debug = readBoolean(args, 'debug') ?? false;

    if (!projectPath || !preset || !outputPath) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, preset, and outputPath',
      ]);
    }

    if (!this.validatePath(projectPath) || !this.validatePath(outputPath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      // Export uses Godot's CLI directly, not our script
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return this.createErrorResponse('Could not find a valid Godot executable path', [
            'Ensure Godot is installed correctly',
            'Set GODOT_PATH environment variable',
          ]);
        }
      }

      const exportArgs = [
        '--headless',
        '--path',
        projectPath,
        debug ? '--export-debug' : '--export-release',
        preset,
        outputPath,
      ];

      this.logDebug(`Exporting: ${this.godotPath} ${exportArgs.join(' ')}`);

      // An export of a real project is slow, so it gets five minutes rather than the default.
      const { stdout, stderr } = await run(this.godotPath, exportArgs, { timeout: 300000 });

      if (stderr && (stderr.includes('ERROR') || stderr.includes('Invalid preset'))) {
        return this.createErrorResponse(`Failed to export project: ${stderr}`, [
          'Verify the preset name is correct',
          'Ensure export templates are installed',
        ]);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project exported successfully to: ${outputPath}\n\n${stdout}${stderr}`,
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to export project: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify export templates are installed',
        'Check the preset name is valid',
      ]);
    }
  }

  /**
   * Handle the validate_project tool
   */
  private async handleValidateProject(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const preset = readNonEmptyString(args, 'preset');
    const includeSuggestions = readBoolean(args, 'includeSuggestions') !== false;

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        preset: preset ?? '',
        includeSuggestions,
      };

      const { stdout, stderr } = await this.executeOperation('validate_project', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to validate project: ${stderr}`, [
          'Verify the project structure is valid',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to validate project: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  // ============================================
  // Phase 3: DX Tools Handlers
  // ============================================

  /**
   * Handle the get_dependencies tool
   */
  private async handleGetDependencies(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const resourcePath = readString(args, 'resourcePath');
    const depth = readNumberLike(args, 'depth');
    const includeBuiltin = readBoolean(args, 'includeBuiltin') ?? false;

    if (!projectPath || !resourcePath) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath and resourcePath',
      ]);
    }

    if (!this.validatePath(projectPath) || !this.validatePath(resourcePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      // The operation script reads `max_depth` and `include_built_in`. These were sent as
      // `depth` and `includeBuiltin`, which become `depth` and `include_builtin`, so
      // neither ever arrived: depth always fell back to the script's own 10, and built-ins
      // were skipped no matter what the caller asked for.
      //
      // A negative depth means unlimited in this tool's schema. The script has no notion of
      // that and compares `current_depth >= max_depth`, so passing -1 straight through
      // would return nothing at all.
      const requested = depth ?? -1;
      const params: OperationParams = {
        resourcePath,
        maxDepth: requested >= 0 ? requested : 100,
        includeBuiltIn: includeBuiltin,
      };

      const { stdout, stderr } = await this.executeOperation('get_dependencies', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to get dependencies: ${stderr}`, [
          'Verify the resource path is correct',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get dependencies: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the find_resource_usages tool
   */
  private async handleFindResourceUsages(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const resourcePath = readString(args, 'resourcePath');
    const fileTypes = readStringArray(args, 'fileTypes');

    if (!projectPath || !resourcePath) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath and resourcePath',
      ]);
    }

    if (!this.validatePath(projectPath) || !this.validatePath(resourcePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resourcePath,
        fileTypes: fileTypes ?? ['tscn', 'tres', 'gd'],
      };

      const { stdout, stderr } = await this.executeOperation('find_resource_usages', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to find resource usages: ${stderr}`, [
          'Verify the resource path is correct',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to find resource usages: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the parse_error_log tool
   */
  private async handleParseErrorLog(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const logContent = readString(args, 'logContent');
    const maxErrors = readPositiveNumber(args, 'maxErrors');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        logContent: logContent ?? '',
        maxErrors: maxErrors ?? 50,
      };

      const { stdout, stderr } = await this.executeOperation('parse_error_log', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to parse error log: ${stderr}`, [
          'Verify the log content or ensure godot.log exists',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to parse error log: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the get_project_health tool
   */
  private async handleGetProjectHealth(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const includeDetails = readBoolean(args, 'includeDetails') !== false;

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        includeDetails,
      };

      const { stdout, stderr } = await this.executeOperation('get_project_health', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to get project health: ${stderr}`, [
          'Verify the project structure',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get project health: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  // ============================================
  // Phase 3: Project Configuration Handlers
  // ============================================

  /**
   * Handle the get_project_setting tool
   */
  private async handleGetProjectSetting(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const setting = readString(args, 'setting');

    if (!projectPath || !setting) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and setting']);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        setting: setting,
      };

      const { stdout, stderr } = await this.executeOperation('get_project_setting', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to get project setting: ${stderr}`, [
          'Verify the setting path is correct',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get project setting: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the set_project_setting tool
   */
  private async handleSetProjectSetting(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const setting = readString(args, 'setting');

    if (!projectPath || !setting || args['value'] === undefined) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, setting, and value',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        setting: setting,
        value: args['value'],
      };

      const { stdout, stderr } = await this.executeOperation('set_project_setting', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set project setting: ${stderr}`, [
          'Verify the setting path and value',
        ]);
      }

      return {
        content: [{ type: 'text', text: `Setting updated successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to set project setting: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the add_autoload tool
   */
  private async handleAddAutoload(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const name = readString(args, 'name');
    const path = readString(args, 'path');
    const enabled = readBoolean(args, 'enabled') !== false;

    if (!projectPath || !name || !path) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath, name, and path']);
    }

    if (!this.validatePath(projectPath) || !this.validatePath(path)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        name: name,
        path: path,
        enabled,
      };

      const { stdout, stderr } = await this.executeOperation('add_autoload', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to add autoload: ${stderr}`, [
          'Verify the script/scene path exists',
        ]);
      }

      return {
        content: [{ type: 'text', text: `Autoload '${name}' added successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to add autoload: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the remove_autoload tool
   */
  private async handleRemoveAutoload(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const name = readString(args, 'name');

    if (!projectPath || !name) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and name']);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        name: name,
      };

      const { stdout, stderr } = await this.executeOperation('remove_autoload', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to remove autoload: ${stderr}`, [
          'Verify the autoload name exists',
        ]);
      }

      return {
        content: [{ type: 'text', text: `Autoload '${name}' removed successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to remove autoload: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the list_autoloads tool
   */
  private async handleListAutoloads(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const { stdout, stderr } = await this.executeOperation('list_autoloads', {}, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to list autoloads: ${stderr}`, [
          'Verify the project structure',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to list autoloads: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the set_main_scene tool
   */
  private async handleSetMainScene(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const scenePath = readString(args, 'scenePath');

    if (!projectPath || !scenePath) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and scenePath']);
    }

    if (!this.validatePath(projectPath) || !this.validatePath(scenePath)) {
      return this.createErrorResponse('Invalid path', [
        'Provide valid paths without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const sceneFile = join(projectPath, scenePath);
      if (!existsSync(sceneFile)) {
        return this.createErrorResponse(`Scene file does not exist: ${scenePath}`, [
          'Ensure the scene path is correct',
        ]);
      }

      const params: OperationParams = {
        scenePath: scenePath,
      };

      const { stdout, stderr } = await this.executeOperation('set_main_scene', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set main scene: ${stderr}`, [
          'Verify the scene path is correct',
        ]);
      }

      return {
        content: [{ type: 'text', text: `Main scene set to '${scenePath}'.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to set main scene: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  // ============================================
  // Signal Management Handlers
  // ============================================

  // ============================================
  // Phase 4: Runtime Tools Handlers
  // ============================================

  /**
   * Handle the get_runtime_status tool
   */
  private async handleGetRuntimeStatus(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    try {
      const runtime = await this.handleRuntimeCommand('ping', {});
      const runtimeText = runtime.content[0]?.text ?? '';

      let runtimePayload: OperationParams | null = null;
      try {
        runtimePayload = asParams(JSON.parse(runtimeText));
      } catch {
        runtimePayload = null;
      }

      const runtimeConnected = runtimePayload !== null && readString(runtimePayload, 'type') === 'pong';

      if (runtimeConnected) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  connected: true,
                  status: 'running',
                  processActive: Boolean(this.activeProcess),
                  runtimeAddon: 'connected',
                  note: 'Godot runtime addon responded to ping. Use inspect_runtime_tree to explore.',
                  runtimeResponse: runtimePayload,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (this.activeProcess) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  connected: false,
                  status: 'process_running_runtime_disconnected',
                  processActive: true,
                  runtimeAddon: 'unreachable',
                  note: 'A Godot process is active, but the runtime addon did not respond on port 7777.',
                  runtimeResponse: runtimeText,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                connected: false,
                status: 'not_running',
                processActive: false,
                runtimeAddon: 'unreachable',
                note: 'No active Godot process or runtime addon detected. Use run_project to start one.',
                runtimeResponse: runtimeText,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to get runtime status: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
      ]);
    }
  }

  /**
   * Handle the inspect_runtime_tree tool
   */
  private async handleInspectRuntimeTree(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const nodePath = readNonEmptyString(args, 'nodePath');
    const depth = readPositiveNumber(args, 'depth');
    const includeProperties = readBoolean(args, 'includeProperties') ?? false;

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    try {
      return await this.handleRuntimeCommand('get_tree', {
        root: nodePath ?? '/root',
        depth: depth ?? 3,
        include_properties: includeProperties,
      });
    } catch (error) {
      return this.createErrorResponse(`Failed to inspect runtime tree: ${errorMessage(error)}`, [
        'Ensure a Godot process is running with the runtime addon enabled',
      ]);
    }
  }

  /**
   * Handle the set_runtime_property tool
   */
  private async handleSetRuntimeProperty(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const nodePath = readNonEmptyString(args, 'nodePath');
    const property = readString(args, 'property');

    if (!projectPath || !nodePath || !property || args['value'] === undefined) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, nodePath, property, and value',
      ]);
    }

    try {
      return await this.handleRuntimeCommand('set_property', {
        path: nodePath,
        property: property,
        value: args['value'],
      });
    } catch (error) {
      return this.createErrorResponse(`Failed to set runtime property: ${errorMessage(error)}`, [
        'Ensure a Godot process is running with the runtime addon',
      ]);
    }
  }

  /**
   * Handle the call_runtime_method tool
   */
  private async handleCallRuntimeMethod(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const nodePath = readNonEmptyString(args, 'nodePath');
    const method = readString(args, 'method');

    if (!projectPath || !nodePath || !method) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, nodePath, and method',
      ]);
    }

    try {
      return await this.handleRuntimeCommand('call_method', {
        path: nodePath,
        method,
        args: readArray(args, 'args') ?? [],
      });
    } catch (error) {
      return this.createErrorResponse(`Failed to call runtime method: ${errorMessage(error)}`, [
        'Ensure a Godot process is running with the runtime addon',
      ]);
    }
  }

  /**
   * Handle the get_runtime_metrics tool
   */
  private async handleGetRuntimeMetrics(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const metrics = readArray(args, 'metrics');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    try {
      return await this.handleRuntimeCommand('get_metrics', {
        metrics: Array.isArray(metrics) ? metrics : [],
      });
    } catch (error) {
      return this.createErrorResponse(`Failed to get runtime metrics: ${errorMessage(error)}`, [
        'Ensure a Godot process is running',
      ]);
    }
  }

  // ============================================
  // GDScript File Operations Handlers
  // ============================================

  /**
   * Handle the create_script tool
   * Creates a new GDScript file with proper structure and optional templates
   */
  private async handleCreateScript(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const scriptPath = readString(args, 'scriptPath');
    const className = readString(args, 'className');
    const extendsClass = readNonEmptyString(args, 'extends');
    const content = readString(args, 'content');
    const template = readString(args, 'template');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!scriptPath) {
      return this.createErrorResponse('Script path is required', [
        'Provide a path for the new script file (e.g., "scripts/player.gd")',
      ]);
    }

    if (!scriptPath.endsWith('.gd')) {
      return this.createErrorResponse('Script path must end with .gd extension', [
        'Provide a valid GDScript path (e.g., "scripts/player.gd")',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
        'Ensure the path points to a directory containing a project.godot file',
      ]);
    }

    try {
      const params = {
        script_path: scriptPath,
        class_name: className ?? '',
        extends_class: extendsClass ?? 'Node',
        content: content ?? '',
        template: template ?? '',
      };

      const { stdout, stderr } = await this.executeOperation('create_script', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to create script: ${stderr}`, [
          'Check the script path and ensure parent directories exist',
        ]);
      }

      // Try to parse JSON result
      try {
        const jsonMatch = /\{[\s\S]*\}/.exec(stdout);
        if (jsonMatch) {
          const result: unknown = JSON.parse(jsonMatch[0]);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
      } catch {
        // Fall through to return raw output
      }

      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to create script: ${errorMessage(error)}`, [
        'Check that Godot is properly installed and accessible',
      ]);
    }
  }

  /**
   * Handle the modify_script tool
   * Modifies an existing GDScript file by adding functions, variables, or signals
   */
  private async handleModifyScript(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const scriptPath = readString(args, 'scriptPath');
    const modifications = readArray(args, 'modifications');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!scriptPath) {
      return this.createErrorResponse('Script path is required', [
        'Provide the path to an existing script file',
      ]);
    }

    if (!modifications || !Array.isArray(modifications) || modifications.length === 0) {
      return this.createErrorResponse('Modifications array is required', [
        'Provide an array of modifications with type and name properties',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
        'Ensure the path points to a directory containing a project.godot file',
      ]);
    }

    try {
      const params = {
        script_path: scriptPath,
        modifications: modifications,
      };

      const { stdout, stderr } = await this.executeOperation('modify_script', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to modify script: ${stderr}`, [
          'Check that the script file exists and is a valid GDScript',
        ]);
      }

      // Try to parse JSON result
      try {
        const jsonMatch = /\{[\s\S]*\}/.exec(stdout);
        if (jsonMatch) {
          const result: unknown = JSON.parse(jsonMatch[0]);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
      } catch {
        // Fall through to return raw output
      }

      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to modify script: ${errorMessage(error)}`, [
        'Check that Godot is properly installed and accessible',
      ]);
    }
  }

  /**
   * Handle the get_script_info tool
   * Analyzes a GDScript file and returns its structure
   */
  private async handleGetScriptInfo(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const scriptPath = readString(args, 'scriptPath');
    const includeInherited = readBoolean(args, 'includeInherited') ?? false;

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!scriptPath) {
      return this.createErrorResponse('Script path is required', [
        'Provide the path to a script file to analyze',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
        'Ensure the path points to a directory containing a project.godot file',
      ]);
    }

    try {
      const params = {
        script_path: scriptPath,
        include_inherited: includeInherited || false,
      };

      const { stdout, stderr } = await this.executeOperation('get_script_info', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to analyze script: ${stderr}`, [
          'Check that the script file exists and is a valid GDScript',
        ]);
      }

      // Try to parse JSON result
      try {
        const jsonMatch = /\{[\s\S]*\}/.exec(stdout);
        if (jsonMatch) {
          const result: unknown = JSON.parse(jsonMatch[0]);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
      } catch {
        // Fall through to return raw output
      }

      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to analyze script: ${errorMessage(error)}`, [
        'Check that Godot is properly installed and accessible',
      ]);
    }
  }

  // ============================================
  // Resource Creation Tools Handlers
  // ============================================

  // ============================================
  // Animation Tools Handlers
  // ============================================

  // ============================================
  // Plugin Management Handlers
  // ============================================

  /**
   * Handle the list_plugins tool
   */
  private async handleListPlugins(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');

    if (!projectPath) {
      return this.createErrorResponse('Project path is required', [
        'Provide a valid path to a Godot project directory',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const { stdout, stderr } = await this.executeOperation('list_plugins', {}, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to list plugins: ${stderr}`, [
          'Verify the project structure',
        ]);
      }

      return {
        content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to list plugins: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the enable_plugin tool
   */
  private async handleEnablePlugin(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const pluginName = readString(args, 'pluginName');

    if (!projectPath || !pluginName) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and pluginName']);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        pluginName: pluginName,
      };

      const { stdout, stderr } = await this.executeOperation('enable_plugin', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to enable plugin: ${stderr}`, [
          'Verify the plugin exists in the addons directory',
          'Check the plugin name is correct',
        ]);
      }

      return {
        content: [{ type: 'text', text: `Plugin '${pluginName}' enabled successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to enable plugin: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Handle the disable_plugin tool
   */
  private async handleDisablePlugin(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const pluginName = readString(args, 'pluginName');

    if (!projectPath || !pluginName) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and pluginName']);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        pluginName: pluginName,
      };

      const { stdout, stderr } = await this.executeOperation('disable_plugin', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to disable plugin: ${stderr}`, [
          'Verify the plugin is currently enabled',
          'Check the plugin name is correct',
        ]);
      }

      return {
        content: [
          { type: 'text', text: `Plugin '${pluginName}' disabled successfully.\n\n${stdout.trim()}` },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to disable plugin: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  // ============================================
  // Input Action Handlers
  // ============================================

  /**
   * Handle the add_input_action tool
   */
  private async handleAddInputAction(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const actionName = readString(args, 'actionName');
    const events = readArray(args, 'events');
    const deadzone = readNumberLike(args, 'deadzone');

    if (!projectPath || !actionName || !events) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, actionName, and events',
      ]);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    if (!Array.isArray(events) || events.length === 0) {
      return this.createErrorResponse('Events must be a non-empty array', [
        'Provide at least one input event',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        actionName: actionName,
        events: events,
        deadzone: deadzone ?? 0.5,
      };

      const { stdout, stderr } = await this.executeOperation('add_input_action', params, projectPath);

      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to add input action: ${stderr}`, [
          'Verify the event types and parameters are valid',
        ]);
      }

      return {
        content: [
          { type: 'text', text: `Input action '${actionName}' added successfully.\n\n${stdout.trim()}` },
        ],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to add input action: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  // ============================================
  // Project Search Handlers
  // ============================================

  private searchProjectNatively(
    projectPath: string,
    query: string,
    fileTypes: string[],
    useRegex: boolean,
    caseSensitive: boolean,
    maxResults: number,
  ): Record<string, unknown> {
    const normalizedExtensions = new Set(
      fileTypes.map((ext) => ext.replace(/^\./, '').toLowerCase()).filter(Boolean),
    );
    const result = {
      query,
      results: [] as {
        file: string;
        matches: { line: number; content: string; match: string }[];
      }[],
      summary: {
        files_searched: 0,
        files_with_matches: 0,
        total_matches: 0,
        truncated: false,
      },
    };

    const regex = useRegex ? new RegExp(query, caseSensitive ? '' : 'i') : null;
    const queryToCheck = caseSensitive ? query : query.toLowerCase();

    const visit = (dirPath: string) => {
      if (result.summary.total_matches >= maxResults) {
        result.summary.truncated = true;
        return;
      }

      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (result.summary.total_matches >= maxResults) {
          result.summary.truncated = true;
          return;
        }

        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.godot') {
          continue;
        }

        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = entry.name.includes('.') ? (entry.name.split('.').pop()?.toLowerCase() ?? '') : '';
        if (!normalizedExtensions.has(extension)) {
          continue;
        }

        result.summary.files_searched += 1;
        const content = readFileSync(entryPath, 'utf8');
        const lines = content.split('\n');
        const matches: { line: number; content: string; match: string }[] = [];

        for (const [index, line] of lines.entries()) {
          if (result.summary.total_matches >= maxResults) {
            result.summary.truncated = true;
            break;
          }

          const match = regex
            ? regex.exec(line)?.[0]
            : (caseSensitive ? line : line.toLowerCase()).includes(queryToCheck)
              ? query
              : '';

          if (match) {
            matches.push({
              line: index + 1,
              content: line.trim(),
              match,
            });
            result.summary.total_matches += 1;
          }
        }

        if (matches.length > 0) {
          const relativePath = entryPath.slice(projectPath.length + 1).replace(/\\/g, '/');
          result.results.push({
            file: `res://${relativePath}`,
            matches,
          });
          result.summary.files_with_matches += 1;
        }
      }
    };

    visit(projectPath);
    return result;
  }

  /**
   * Handle the search_project tool
   */
  private handleSearchProject(rawArgs: unknown): ToolResponse {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const query = readString(args, 'query');
    const fileTypes = readStringArray(args, 'fileTypes') ?? ['gd', 'tscn', 'tres'];
    const regex = readBoolean(args, 'regex') ?? false;
    const caseSensitive = readBoolean(args, 'caseSensitive') ?? false;
    const maxResults = readPositiveNumber(args, 'maxResults') ?? 100;

    if (!projectPath || !query) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and query']);
    }

    if (!this.validatePath(projectPath)) {
      return this.createErrorResponse('Invalid project path', [
        'Provide a valid path without ".." or other potentially unsafe characters',
      ]);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const result = this.searchProjectNatively(
        projectPath,
        query,
        fileTypes,
        regex,
        caseSensitive,
        maxResults,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to search project: ${errorMessage(error)}`, [
        'Ensure Godot is installed correctly',
        'Verify the project path is accessible',
      ]);
    }
  }

  /**
   * Run the MCP server
   */
  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error(
            '[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path',
          );
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error(
            '[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.',
          );
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.mcp.server.connect(transport);
      process.stdin.once('end', () => {
        void this.handleShutdown('stdin:end', 0);
      });
      console.error('Godot MCP server running on stdio');

      // Start the Godot Editor Bridge (WebSocket server for editor plugin).
      // Bridge startup issues should not take down the stdio MCP server.
      try {
        await this.godotBridge.start();
        this.bridgeStartupError = null;
        const bridgeStatus = this.godotBridge.getStatus();
        console.error(`[SERVER] Godot Editor Bridge started on ${bridgeStatus.host}:${bridgeStatus.port}`);
      } catch (bridgeError) {
        const bridgeCode =
          bridgeError instanceof Error && 'code' in bridgeError && typeof bridgeError.code === 'string'
            ? bridgeError.code
            : null;
        const bridgeReason = errorMessage(bridgeError);
        const bridgeMessage =
          bridgeCode && !bridgeReason.includes(bridgeCode) ? `${bridgeCode}: ${bridgeReason}` : bridgeReason;
        this.bridgeStartupError = bridgeMessage;
        console.error(`[SERVER] Warning: Godot Editor Bridge failed to start: ${bridgeMessage}`);
        console.error('[SERVER] Continuing without bridge-backed editor tools.');
      }
    } catch (error) {
      console.error('[SERVER] Failed to start:', errorMessage(error));
      process.exit(1);
    }
  }

  // ============================================
  // 2D Tile Tools Handlers
  // ============================================

  // ============================================
  // Audio System Handlers
  // ============================================

  private async handleCreateAudioBus(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const busName = readString(args, 'busName');
    const parentBusIndex = readNumberLike(args, 'parentBusIndex');
    if (!projectPath || !busName) {
      return this.createErrorResponse('Missing required parameters', ['Provide projectPath and busName']);
    }
    try {
      const params = {
        busName: busName,
        parentBusIndex: parentBusIndex ?? 0,
      };
      const { stdout, stderr } = await this.executeOperation('create_audio_bus', params, projectPath);
      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to create audio bus: ${stderr}`, []);
      }
      return {
        content: [{ type: 'text', text: `Audio bus '${busName}' created successfully.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to create audio bus: ${errorMessage(error)}`, []);
    }
  }

  private async handleGetAudioBuses(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    if (!projectPath) {
      return this.createErrorResponse('Project path is required', []);
    }
    try {
      const { stdout, stderr } = await this.executeOperation('get_audio_buses', {}, projectPath);
      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to get audio buses: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: stdout.trim() }] };
    } catch (error) {
      return this.createErrorResponse(`Failed to get audio buses: ${errorMessage(error)}`, []);
    }
  }

  private async handleSetAudioBusEffect(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const busIndex = readNumberLike(args, 'busIndex');
    const effectIndex = readNumberLike(args, 'effectIndex');
    const effectType = readString(args, 'effectType');
    const enabled = readBoolean(args, 'enabled') !== false;
    if (!projectPath || busIndex === undefined || effectIndex === undefined || !effectType) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, busIndex, effectIndex, and effectType',
      ]);
    }
    try {
      const params = {
        busIndex: busIndex,
        effectIndex: effectIndex,
        effectType: effectType,
        enabled,
      };
      const { stdout, stderr } = await this.executeOperation('set_audio_bus_effect', params, projectPath);
      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set audio bus effect: ${stderr}`, []);
      }
      return { content: [{ type: 'text', text: `Audio bus effect set successfully.\n\n${stdout.trim()}` }] };
    } catch (error) {
      return this.createErrorResponse(`Failed to set audio bus effect: ${errorMessage(error)}`, []);
    }
  }

  private async handleSetAudioBusVolume(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const projectPath = readString(args, 'projectPath');
    const busIndex = readNumberLike(args, 'busIndex');
    const volumeDb = readNumberLike(args, 'volumeDb');
    if (!projectPath || busIndex === undefined || volumeDb === undefined) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide projectPath, busIndex, and volumeDb',
      ]);
    }
    try {
      const params = { busIndex: busIndex, volumeDb: volumeDb };
      const { stdout, stderr } = await this.executeOperation('set_audio_bus_volume', params, projectPath);
      if (stderr.includes('ERROR')) {
        return this.createErrorResponse(`Failed to set audio bus volume: ${stderr}`, []);
      }
      return {
        content: [{ type: 'text', text: `Audio bus volume set to ${volumeDb}dB.\n\n${stdout.trim()}` }],
      };
    } catch (error) {
      return this.createErrorResponse(`Failed to set audio bus volume: ${errorMessage(error)}`, []);
    }
  }

  // ============================================
  // Networking Handlers
  // ============================================

  // ============================================
  // Physics Handlers
  // ============================================

  // ============================================
  // Navigation Handlers
  // ============================================

  // ============================================
  // Rendering Handlers
  // ============================================

  // ============================================
  // Animation Tree Handlers
  // ============================================

  // ============================================
  // UI/Theme Handlers
  // ============================================

  /**
   * Handle the query_classes tool: ClassDB introspection
   */
  private async handleQueryClasses(rawArgs: unknown) {
    // These three take the caller's spelling as it arrives rather than normalising first, so
    // both snake_case and camelCase reach the operation script under the name it expects.
    const args = asParams(rawArgs);
    const projectPath = readStringEither(args, 'projectPath', 'project_path');
    if (!projectPath) {
      throw new McpError(ErrorCode.InvalidParams, 'projectPath is required');
    }
    const params: OperationParams = {};
    const filter = readString(args, 'filter');
    const category = readString(args, 'category');
    const instantiableOnly = readBooleanEither(args, 'instantiableOnly', 'instantiable_only');
    if (filter) params['filter'] = filter;
    if (category) params['category'] = category;
    if (instantiableOnly !== undefined) params['instantiable_only'] = instantiableOnly;

    const { stdout, stderr } = await this.executeOperation('query_classes', params, projectPath);
    if (stderr.trim()) {
      return this.createErrorResponse(`Failed to query classes: ${stderr.trim()}`, [
        'Check the project path and ensure project.godot exists',
        'Verify the category/filter arguments are valid',
      ]);
    }

    return {
      content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
    };
  }

  /**
   * Handle the query_class_info tool — ClassDB introspection
   */
  private async handleQueryClassInfo(rawArgs: unknown) {
    const args = asParams(rawArgs);
    const projectPath = readStringEither(args, 'projectPath', 'project_path');
    const className = readStringEither(args, 'className', 'class_name');
    if (!projectPath) {
      throw new McpError(ErrorCode.InvalidParams, 'projectPath is required');
    }
    if (!className) {
      throw new McpError(ErrorCode.InvalidParams, 'className is required');
    }
    const params: OperationParams = {
      class_name: className,
    };
    const includeInherited = readBooleanEither(args, 'includeInherited', 'include_inherited');
    if (includeInherited !== undefined) params['include_inherited'] = includeInherited;

    const { stdout, stderr } = await this.executeOperation('query_class_info', params, projectPath);
    if (stderr.trim()) {
      return this.createErrorResponse(`Failed to query class info: ${stderr.trim()}`, [
        'Check that the class name exists in the current Godot version',
        'Verify the project path and ClassDB availability',
      ]);
    }

    return {
      content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
    };
  }

  /**
   * Handle the inspect_inheritance tool — ClassDB introspection
   */
  private async handleInspectInheritance(rawArgs: unknown) {
    const args = asParams(rawArgs);
    const projectPath = readStringEither(args, 'projectPath', 'project_path');
    const className = readStringEither(args, 'className', 'class_name');
    if (!projectPath) {
      throw new McpError(ErrorCode.InvalidParams, 'projectPath is required');
    }
    if (!className) {
      throw new McpError(ErrorCode.InvalidParams, 'className is required');
    }
    const { stdout, stderr } = await this.executeOperation(
      'inspect_inheritance',
      {
        class_name: className,
      },
      projectPath,
    );
    if (stderr.trim()) {
      return this.createErrorResponse(`Failed to inspect inheritance: ${stderr.trim()}`, [
        'Check that the class name exists in the current Godot version',
      ]);
    }
    return {
      content: [{ type: 'text', text: this.extractLastJsonLine(stdout) ?? stdout.trim() }],
    };
  }
}

export async function runGodotServer(): Promise<void> {
  const server = new GodotServer();
  await server.run();
}
