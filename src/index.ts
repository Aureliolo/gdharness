#!/usr/bin/env bun

/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection as createTcpConnection } from 'node:net';
import { tmpdir } from 'node:os';
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
import { godotCandidates, resolveHomeDirectory } from './detection.js';
import { dictionary, emptyRecord } from './dictionary.js';
import { errorMessage } from './errors.js';
import { type GodotBridge, getDefaultBridge } from './godot-bridge.js';
import { envValue, resolveHeadless, runArguments } from './launch.js';
import { GodotLSPClient, handleLSPTool } from './lsp_client.js';
import { resolveWithinProject } from './paths.js';
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
  readNumber,
  readNumberLike,
  readParams,
  readPositiveNumber,
  readString,
  readStringArray,
  readStringEither,
} from './tool-args.js';
import { buildToolDefinitions, TOOL_SPECS, type ToolSpec, toolSpec } from './tool-definitions.js';

// execFile, not exec: no shell means no quoting, and no quoting means no way to escape out
// of it. Every argument below is an array element, so a path full of backslashes, spaces or
// quotes is just a path.
const run = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** What to tell a caller whose file, scene, script or resource path landed outside the project. */
const PATH_SOLUTIONS = [
  'Give the path relative to the project, such as "scenes/main.tscn" or "res://scenes/main.tscn"',
  'Point projectPath at the project the file belongs to',
];

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
  // Registration goes through the protocol object rather than McpServer's registerTool: the
  // schemas are authored as data in tool-definitions.ts and validated against the same data
  // before dispatch, which is the "advanced use case" McpServer's own docs point at `.server` for.
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
  private readonly tools: MCPToolDefinition[] = buildToolDefinitions();

  /**
   * Parameter name mappings between snake_case and camelCase
   * This allows the server to accept both formats
   */
  private parameterMappings: Record<string, string> = dictionary({
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
  });

  /**
   * Reverse mapping from camelCase to snake_case
   * Generated from parameterMappings for quick lookups
   */
  private reverseParameterMappings: Record<string, string> = emptyRecord();

  constructor(config?: GodotServerConfig) {
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
          tools: {},
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

    const osPlatform = process.platform;
    this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

    for (const candidate of godotCandidates(osPlatform, resolveHomeDirectory())) {
      const normalizedPath = normalize(candidate);
      if (await this.isValidGodotPath(normalizedPath)) {
        this.godotPath = normalizedPath;
        this.logDebug(`Found Godot at: ${normalizedPath}`);
        return;
      }
    }

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

  private jsonTextResponse(payload: unknown): ToolResponse {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
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
      return {
        ok: false,
        response: this.createErrorResponse(`${where} needs ${missing.join(', ')}.`),
      };
    }

    return { ok: true, op };
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
    // The keys are the `arguments` member of a tools/call, straight off the wire. JSON.parse
    // makes `__proto__` an own enumerable property, so it survives the hasOwn guard below and
    // the write would re-parent this object onto caller-supplied data rather than store a key.
    const result: OperationParams = emptyRecord();

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
    const result: OperationParams = emptyRecord();

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

      let stdout: string;
      let stderr: string;
      try {
        ({ stdout, stderr } = await run(this.godotPath, args));
      } finally {
        rmSync(paramsDir, { recursive: true, force: true });
      }

      // Every operation prints its result as one JSON object. Whatever else came back is not an
      // answer, and handing it on as one is how an engine that never ran reads as a tool that
      // succeeded with nothing to say.
      if (!/\{[\s\S]*\}/.test(stdout)) {
        const detail = this.sanitizeGodotStderr(stderr).trim() || stdout.trim() || 'no output at all';
        throw new Error(`${operation} produced no result from ${this.godotPath}: ${detail}`);
      }
      return { stdout, stderr: this.sanitizeGodotStderr(stderr) };
    } catch (error) {
      // A non-zero exit carries stdout and stderr on the thrown error, and the reason the
      // engine gave is the message worth passing on.
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string; code?: number | string };
        const detail = this.sanitizeGodotStderr(execError.stderr).trim() || execError.stdout.trim();
        throw new Error(
          `${operation} failed (exit ${execError.code ?? 'unknown'}): ${detail || execError.message}`,
        );
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

      const args = this.normalizeParameters(request.params.arguments);
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
   * One tool call to the code that does it. The handlers below were written one per engine
   * call and keep their own argument names, so an op that renamed an argument hands it over
   * under the old name here; the editor addon and the runtime addon keep their command names.
   * `op` is empty for a tool that has none.
   */
  private async dispatch(tool: string, op: string, args: OperationParams): Promise<ToolResponse> {
    const { op: _op, ...arguments_ } = args;
    const bridge = async (command: string, extra: OperationParams = {}): Promise<ToolResponse> => {
      const contained = this.containBridgePaths({ ...arguments_, ...extra });
      return contained.ok ? await this.handleViaBridge(command, contained.args) : contained.response;
    };

    switch (tool) {
      case 'project_list':
        return this.handleListProjects(args);
      case 'project_info':
        return await this.handleProjectInfo(args);
      case 'project_settings':
        switch (op) {
          case 'get':
            return await this.handleGetProjectSetting(args);
          case 'set':
            return await this.handleSetProjectSetting(args);
          case 'add_autoload':
            return await this.handleAddAutoload(args);
          case 'remove_autoload':
            return await this.handleRemoveAutoload(args);
          case 'set_main_scene':
            return await this.handleSetMainScene(args);
          case 'add_input_action':
            return await this.handleAddInputAction(args);
          case 'enable_plugin':
            return await this.handleEnablePlugin(args);
          case 'disable_plugin':
            return await this.handleDisablePlugin(args);
          case 'add_audio_bus':
            return await this.handleCreateAudioBus(args);
          case 'set_audio_bus_effect':
            return await this.handleSetAudioBusEffect(args);
          default:
            return await this.handleSetAudioBusVolume(args);
        }
      case 'project_search':
        return this.handleSearchProject(args);
      case 'project_dependencies':
        return args['direction'] === 'reverse'
          ? await this.handleFindResourceUsages(args)
          : await this.handleGetDependencies(args);
      case 'project_import':
        switch (op) {
          case 'status':
            return await this.handleGetImportStatus(args);
          case 'options':
            return await this.handleGetImportOptions(args);
          case 'set_options':
            return await this.handleSetImportOptions(args);
          case 'reimport':
            return await this.handleReimportResource(args);
          case 'uid':
            return await this.handleGetUid({ ...args, filePath: args['resourcePath'] });
          default:
            return await this.handleUpdateProjectUids(args);
        }
      case 'project_export':
        return op === 'list'
          ? await this.handleListExportPresets(args)
          : await this.handleExportProject(args);

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

      case 'script_edit':
        return op === 'create' ? await this.handleCreateScript(args) : await this.handleModifyScript(args);
      case 'script_info':
        switch (op) {
          case 'structure':
            return await this.handleGetScriptInfo(args);
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
        return await this.handleLaunchEditor(args);
      case 'editor_run':
        return await this.handleRunProject(args);
      case 'editor_stop':
        return this.handleStopProject();
      case 'editor_output':
        return this.handleGetDebugOutput();
      case 'editor_status':
        return await this.handleEditorStatus();
      case 'editor_rescan':
        return await this.handleRescanFilesystem(args);
      case 'editor_classes':
        switch (op) {
          case 'query':
            return await this.handleQueryClasses(args);
          case 'info':
            return await this.handleQueryClassInfo(args);
          default:
            return await this.handleInspectInheritance(args);
        }

      case 'runtime_inspect':
        return op === 'tree'
          ? await this.handleInspectRuntimeTree(args)
          : await this.handleGetRuntimeMetrics(args);
      case 'runtime_invoke':
        return op === 'set'
          ? await this.handleSetRuntimeProperty(args)
          : await this.handleCallRuntimeMethod(args);
      case 'runtime_capture':
        return await this.handleRuntimeCommand(
          op === 'screenshot' ? 'capture_screenshot' : 'capture_viewport',
          args,
        );
      case 'runtime_input':
        return await this.handleRuntimeCommand(`inject_${op}`, args);

      case 'debug_breakpoint':
        return await this.handleDAP(op === 'set' ? 'dap_set_breakpoint' : 'dap_remove_breakpoint', args);
      case 'debug_control':
        return await this.handleDAP(`dap_${op}`, args);
      case 'debug_state':
        return await this.handleDAP(op === 'stack' ? 'dap_get_stack_trace' : 'dap_get_output', args);

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${tool}`);
    }
  }

  /**
   * project_info: the project's own metadata, then whichever sections were asked for. Each
   * section is the answer the matching reader gives on its own, under its own heading, so a
   * section that fails says so without hiding the rest.
   */
  private async handleProjectInfo(args: OperationParams): Promise<ToolResponse> {
    const detailed = args['detail'] === 'full';
    const sections: Record<string, () => Promise<ToolResponse>> = dictionary({
      autoloads: () => this.handleListAutoloads(args),
      plugins: () => this.handleListPlugins(args),
      export_presets: () => this.handleListExportPresets({ ...args, includeTemplateStatus: detailed }),
      audio_buses: () => this.handleGetAudioBuses(args),
      health: () => this.handleGetProjectHealth({ ...args, includeDetails: detailed }),
      validation: () => this.handleValidateProject({ ...args, includeSuggestions: detailed }),
    });

    const include = readStringArray(args, 'include') ?? [];
    const unknown = include.filter((name) => sections[name] === undefined);
    if (unknown.length > 0) {
      return this.createErrorResponse(
        `project_info cannot include ${unknown.join(', ')}. Sections: ${Object.keys(sections).join(', ')}.`,
      );
    }

    const info = await this.handleGetProjectInfo(args);
    if (info.isError || include.length === 0) {
      return info;
    }

    const content = [...info.content];
    for (const name of include) {
      const answer = await sections[name]?.();
      if (answer) {
        content.push({ type: 'text', text: `## ${name}` }, ...answer.content);
      }
    }
    return { content };
  }

  /** script_diagnostics: what the language server reports, and the verdict that follows. */
  private async handleScriptDiagnostics(args: OperationParams): Promise<ToolResponse> {
    const answer = await this.handleLSP('lsp_get_diagnostics', args);
    const payload = asParams(JSON.parse(answer.content[0]?.text ?? '{}'));
    if (payload['error'] !== undefined) {
      const reason = payload['error'];
      return this.createErrorResponse(
        `Diagnostics unavailable: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`,
        ['Ensure the Godot editor is running with the language server enabled on port 6005'],
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

  /** editor_status: the three things an agent asks before doing anything else, in one answer. */
  private async handleEditorStatus(): Promise<ToolResponse> {
    const version = await this.handleGetGodotVersion();
    const runtime = await this.handleRuntimeCommand('ping', {});
    let runtimePayload: OperationParams | null = null;
    try {
      runtimePayload = asParams(JSON.parse(runtime.content[0]?.text ?? ''));
    } catch {
      runtimePayload = null;
    }
    const runtimeConnected = runtimePayload !== null && readString(runtimePayload, 'type') === 'pong';

    return this.jsonTextResponse({
      editor: this.getEditorStatusPayload(),
      godot: {
        path: this.godotPath,
        version: version.isError ? null : (version.content[0]?.text ?? null),
      },
      game: {
        processActive: this.activeProcess !== null,
        runtimeConnected,
        runtime: runtimeConnected ? runtimePayload : null,
      },
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
          'Use project_list to find valid Godot projects',
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

    // Before the engine is looked for, so that a scene the server will not run is refused as
    // such rather than as a missing Godot.
    const sceneToRun = scene ? resolveWithinProject(projectPath, scene) : null;
    if (sceneToRun && !sceneToRun.ok) {
      return this.createErrorResponse(sceneToRun.reason, PATH_SOLUTIONS);
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
          'Use project_list to find valid Godot projects',
        ]);
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.activeProcess.process.kill();
      }

      const cmdArgs = runArguments({
        projectPath,
        headless: resolveHeadless(args['headless'], { platform: process.platform, variables: process.env }),
        scene: sceneToRun?.ok ? sceneToRun.relativePath : null,
      });

      this.logDebug(`Running Godot project: ${this.godotPath} ${cmdArgs.join(' ')}`);
      const child = spawn(this.godotPath, cmdArgs, { stdio: 'pipe' });
      const output: string[] = [];
      const errors: string[] = [];

      child.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
        });
      });

      child.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        errors.push(...lines);
        lines.forEach((line: string) => {
          if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
        });
      });

      child.on('exit', (code: number | null) => {
        this.logDebug(`Godot process exited with code ${code ?? 'none'}`);
        if (this.activeProcess?.process === child) {
          this.activeProcess = null;
        }
      });

      child.on('error', (err: Error) => {
        console.error('Failed to start Godot process:', err);
        if (this.activeProcess?.process === child) {
          this.activeProcess = null;
        }
      });

      this.activeProcess = { process: child, output, errors };

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use editor_output to see output.`,
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

  /** The arguments of an editor-side tool that name files, each read as a path inside the project. */
  private static readonly BRIDGE_PATH_ARGUMENTS = [
    'scenePath',
    'newPath',
    'texturePath',
    'resourcePath',
    'script',
  ];

  /**
   * Every file argument judged before the editor sees it, and handed over as the `res://` path
   * the project knows it by. The editor addon prefixes `res://` to whatever it receives, which
   * reads `../outside.tscn` as a scene to write and an absolute path as a project file; the
   * boundary belongs on this side, where it is the same check every other tool makes.
   */
  private containBridgePaths(
    args: OperationParams,
  ): { ok: true; args: OperationParams } | { ok: false; response: ToolResponse } {
    const projectPath = readString(args, 'projectPath');
    if (!projectPath) {
      return { ok: true, args };
    }

    const contained: OperationParams = { ...args };
    for (const key of GodotServer.BRIDGE_PATH_ARGUMENTS) {
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
    return { ok: true, args: contained };
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
                  'Use editor_launch to open the Godot Editor, then enable the plugin in Project > Project Settings > Plugins.',
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
      const result = await this.godotBridge.invokeTool(toolName, this.normalizeParameters(args));
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
        'Use editor_run to start a Godot project first',
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
        'Use editor_run to start a Godot project first',
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
          'Use project_list to find valid Godot projects',
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

    const file = resolveWithinProject(projectPath, filePath);
    if (!file.ok) {
      return this.createErrorResponse(file.reason, PATH_SOLUTIONS);
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
          'Use project_list to find valid Godot projects',
        ]);
      }

      // Check if the file exists
      if (!existsSync(file.absolutePath)) {
        return this.createErrorResponse(`File does not exist: ${filePath}`, [
          'Ensure the file path is correct',
        ]);
      }

      // The contained path rather than the text that arrived, so that the file the engine
      // opens is the one this handler checked.
      const params = {
        filePath: file.relativePath,
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
          'Use project_list to find valid Godot projects',
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

    const resource = resourcePath ? resolveWithinProject(projectPath, resourcePath) : null;
    if (resource && !resource.ok) {
      return this.createErrorResponse(resource.reason, PATH_SOLUTIONS);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resource?.ok ? resource.relativePath : '',
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

    const resource = resolveWithinProject(projectPath, resourcePath);
    if (!resource.ok) {
      return this.createErrorResponse(resource.reason, PATH_SOLUTIONS);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      if (!existsSync(resource.absolutePath)) {
        return this.createErrorResponse(`Resource file does not exist: ${resourcePath}`, [
          'Ensure the resource path is correct',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resource.relativePath,
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

    const resource = resolveWithinProject(projectPath, resourcePath);
    if (!resource.ok) {
      return this.createErrorResponse(resource.reason, PATH_SOLUTIONS);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      if (!existsSync(resource.absolutePath)) {
        return this.createErrorResponse(`Resource file does not exist: ${resourcePath}`, [
          'Ensure the resource path is correct',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resource.relativePath,
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

    const resource = resourcePath ? resolveWithinProject(projectPath, resourcePath) : null;
    if (resource && !resource.ok) {
      return this.createErrorResponse(resource.reason, PATH_SOLUTIONS);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      if (resource?.ok && !existsSync(resource.absolutePath)) {
        return this.createErrorResponse(`Resource file does not exist: ${resourcePath}`, [
          'Ensure the resource path is correct',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resource?.ok ? resource.relativePath : '',
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

    // The engine writes whatever this names, and it is documented as a destination inside the
    // project, so it is contained like every other project-relative argument.
    const output = resolveWithinProject(projectPath, outputPath);
    if (!output.ok) {
      return this.createErrorResponse(output.reason, PATH_SOLUTIONS);
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
        output.absolutePath,
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

    const resource = resolveWithinProject(projectPath, resourcePath);
    if (!resource.ok) {
      return this.createErrorResponse(resource.reason, PATH_SOLUTIONS);
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
        resourcePath: resource.relativePath,
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

    const resource = resolveWithinProject(projectPath, resourcePath);
    if (!resource.ok) {
      return this.createErrorResponse(resource.reason, PATH_SOLUTIONS);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      const params: OperationParams = {
        resourcePath: resource.relativePath,
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

    const autoload = resolveWithinProject(projectPath, path);
    if (!autoload.ok) {
      return this.createErrorResponse(autoload.reason, PATH_SOLUTIONS);
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
        path: autoload.relativePath,
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

    const scene = resolveWithinProject(projectPath, scenePath);
    if (!scene.ok) {
      return this.createErrorResponse(scene.reason, PATH_SOLUTIONS);
    }

    try {
      const projectFile = join(projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
          'Ensure the path points to a directory containing a project.godot file',
        ]);
      }

      if (!existsSync(scene.absolutePath)) {
        return this.createErrorResponse(`Scene file does not exist: ${scenePath}`, [
          'Ensure the scene path is correct',
        ]);
      }

      const params: OperationParams = {
        scenePath: scene.relativePath,
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
   * Handle the inspect_runtime_tree tool
   */
  private async handleInspectRuntimeTree(rawArgs: unknown) {
    const args = this.normalizeParameters(rawArgs);
    const nodePath = readNonEmptyString(args, 'nodePath');
    const depth = readPositiveNumber(args, 'depth');
    const includeProperties = readBoolean(args, 'includeProperties') ?? false;

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
    const nodePath = readNonEmptyString(args, 'nodePath');
    const property = readString(args, 'property');

    if (!nodePath || !property || args['value'] === undefined) {
      return this.createErrorResponse('Missing required parameters', [
        'Provide nodePath, property, and value',
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
    const nodePath = readNonEmptyString(args, 'nodePath');
    const method = readString(args, 'method');

    if (!nodePath || !method) {
      return this.createErrorResponse('Missing required parameters', ['Provide nodePath and method']);
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
    const metrics = readArray(args, 'metrics');

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

    const script = resolveWithinProject(projectPath, scriptPath);
    if (!script.ok) {
      return this.createErrorResponse(script.reason, PATH_SOLUTIONS);
    }

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
        'Ensure the path points to a directory containing a project.godot file',
      ]);
    }

    try {
      const params = {
        script_path: script.relativePath,
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

    const script = resolveWithinProject(projectPath, scriptPath);
    if (!script.ok) {
      return this.createErrorResponse(script.reason, PATH_SOLUTIONS);
    }

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
        'Ensure the path points to a directory containing a project.godot file',
      ]);
    }

    try {
      const params = {
        script_path: script.relativePath,
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

    const script = resolveWithinProject(projectPath, scriptPath);
    if (!script.ok) {
      return this.createErrorResponse(script.reason, PATH_SOLUTIONS);
    }

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return this.createErrorResponse(`Not a valid Godot project: ${projectPath}`, [
        'Ensure the path points to a directory containing a project.godot file',
      ]);
    }

    try {
      const params = {
        script_path: script.relativePath,
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

    // The operation script reads the name as res://addons/<name>/plugin.cfg, so the name is a
    // directory in the project and is contained as one.
    const plugin = resolveWithinProject(projectPath, `addons/${pluginName}/plugin.cfg`);
    if (!plugin.ok) {
      return this.createErrorResponse(plugin.reason, [
        'Give the plugin directory name as it appears under addons/, such as "my_plugin"',
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

    const plugin = resolveWithinProject(projectPath, `addons/${pluginName}/plugin.cfg`);
    if (!plugin.ok) {
      return this.createErrorResponse(plugin.reason, [
        'Give the plugin directory name as it appears under addons/, such as "my_plugin"',
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
