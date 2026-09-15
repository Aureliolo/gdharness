/**
 * The tool surface: a few dozen tools, each shaped like a task rather than an engine call.
 *
 * A tool that does several related things takes an `op`. Which arguments each op needs is
 * written once, in `operations`, and read twice: rendered into the description the client
 * sees, and enforced before dispatch, so the two cannot drift. Every schema refuses arguments
 * it does not name, and an unknown op is refused with the valid set spelled out, because a
 * silent default is how a wrong call reads as a working one.
 */

import { dictionary } from './dictionary.js';
import type { MCPToolDefinition } from './server-types.js';

type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * A parameter's schema, and which ops read it.
 *
 * `ops` is what makes an argument belong to some of a tool's ops rather than all of them. A tool
 * refuses an argument nothing names; without this it took one named for a different op and threw
 * it away, which is the same fault wearing the tool's own vocabulary: `runtime_inspect text` was
 * given a limit for a year and answered with every line on the screen.
 *
 * Absent means every op takes it, which is the honest answer for a tool that hands its arguments
 * on wholesale and for one whose parameters are all shared.
 *
 * `blank` says an empty string is a value here rather than an argument somebody forgot. It belongs
 * to the few parameters that carry content instead of naming something: clearing a field and
 * writing "" to a property are both things a caller means, and a required argument that is blank
 * is otherwise refused as missing. A name left blank stays a caller who meant to fill it in.
 */
type Parameter = JsonSchema & { readonly ops?: readonly string[]; readonly blank?: boolean };

interface OperationSpec {
  /** One line on what the op does, for the description. */
  readonly summary: string;
  /** Arguments the op needs on top of the tool's own. */
  readonly requires: readonly string[];
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, Parameter>>;
  /** Arguments every call needs, whatever the op. */
  readonly requires: readonly string[];
  readonly operations?: Readonly<Record<string, OperationSpec>>;
  /** The op assumed when none is given; absent means op is required. */
  readonly defaultOperation?: string;
}

/** Whether [op] reads [name] on [spec]. A parameter that names no ops is read by all of them. */
export function opTakes(spec: ToolSpec, op: string, name: string): boolean {
  const ops = spec.parameters[name]?.ops;
  return ops === undefined || ops.includes(op);
}

/** Every argument [op] takes, in the order the schema declares them. */
export function argumentsOf(spec: ToolSpec, op: string): string[] {
  return Object.keys(spec.parameters).filter((name) => opTakes(spec, op, name));
}

const PROJECT_PATH: JsonSchema = {
  type: 'string',
  description: 'Absolute path to the project directory, the one holding project.godot.',
};
const RUNNING_PROJECT_PATH: JsonSchema = {
  type: 'string',
  description:
    'Which game, when more than one is running: the project directory it was started from. Not needed with one game.',
};
const SCENE_PATH: JsonSchema = {
  type: 'string',
  description: 'Scene file inside the project, such as "scenes/main.tscn" or "res://scenes/main.tscn".',
};
const SCRIPT_PATH: JsonSchema = {
  type: 'string',
  description: 'Script file inside the project, such as "scripts/player.gd".',
};
const RESOURCE_PATH: JsonSchema = {
  type: 'string',
  description: 'File inside the project, such as "sprites/hero.png" or "materials/steel.tres".',
};
const NODE_PATH: JsonSchema = {
  type: 'string',
  description: 'Node path from the scene root, such as "Player/Sprite2D". "." is the root.',
};
const PROPERTIES: JsonSchema = {
  type: 'object',
  description:
    'Properties to set, keyed by Godot property name. Vectors, colours and the like may be written as {"x": 1, "y": 2} or tagged {"_type": "Vector2", "x": 1, "y": 2}.',
  additionalProperties: true,
};
const XY: JsonSchema = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
};

const ANIMATION_TRACK: JsonSchema = {
  type: 'object',
  description: 'The track to add.',
  properties: {
    type: { type: 'string', enum: ['property', 'method'] },
    nodePath: { type: 'string', description: 'Target node, relative to the AnimationPlayer root.' },
    property: { type: 'string', description: 'For property tracks: the property to animate.' },
    method: { type: 'string', description: 'For method tracks: the method to call.' },
    keyframes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time: { type: 'number', description: 'Seconds from the start.' },
          value: { description: 'For property tracks: the value at this time.' },
          args: { type: 'array', description: 'For method tracks: the arguments to call with.' },
        },
        required: ['time'],
        additionalProperties: false,
      },
    },
  },
  required: ['type', 'nodePath', 'keyframes'],
  additionalProperties: false,
};

const SCRIPT_MODIFICATIONS: JsonSchema = {
  type: 'array',
  description: 'Additions to make, in order.',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['add_function', 'add_variable', 'add_signal'] },
      name: { type: 'string' },
      params: { type: 'string', description: 'Functions and signals: the parameter list, "delta: float".' },
      returnType: { type: 'string', description: 'Functions: the return type.' },
      body: { type: 'string', description: 'Functions: the body.' },
      varType: { type: 'string', description: 'Variables: the type annotation.' },
      defaultValue: { type: 'string', description: 'Variables: the initial value, as written in GDScript.' },
      isExport: { type: 'boolean', description: 'Variables: add @export.' },
      exportHint: { type: 'string', description: 'Variables: the export hint, such as "range(0, 100)".' },
      isOnready: { type: 'boolean', description: 'Variables: add @onready.' },
      position: {
        type: 'string',
        enum: ['end', 'after_ready', 'after_init'],
        description: 'Functions: where to insert.',
      },
    },
    required: ['type', 'name'],
    additionalProperties: false,
  },
};

const INPUT_EVENTS: JsonSchema = {
  type: 'array',
  description: 'The events that trigger the action.',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['key', 'mouse_button', 'joypad_button', 'joypad_axis'] },
      keycode: { type: 'string', description: 'Keys: the key name, such as "Space" or "W".' },
      button: { type: 'number', description: 'Mouse: 1 left, 2 right, 3 middle. Joypad: the button index.' },
      axis: { type: 'number', description: 'Joypad axes: the axis index.' },
      axisValue: { type: 'number', description: 'Joypad axes: -1 or 1.' },
      ctrl: { type: 'boolean' },
      alt: { type: 'boolean' },
      shift: { type: 'boolean' },
    },
    required: ['type'],
    additionalProperties: false,
  },
};

const TILESET_SOURCES: JsonSchema = {
  type: 'array',
  description: 'Atlas sources, one per texture.',
  items: {
    type: 'object',
    properties: {
      texture: RESOURCE_PATH,
      tileSize: XY,
      separation: XY,
      offset: XY,
    },
    required: ['texture', 'tileSize'],
    additionalProperties: false,
  },
};

const TILEMAP_CELLS: JsonSchema = {
  type: 'array',
  description: 'Cells to place.',
  items: {
    type: 'object',
    properties: {
      coords: XY,
      sourceId: { type: 'number', description: 'TileSet source index.' },
      atlasCoords: XY,
      alternativeTile: { type: 'number' },
    },
    required: ['coords', 'sourceId', 'atlasCoords'],
    additionalProperties: false,
  },
};

const COLOUR: JsonSchema = {
  type: 'object',
  properties: { r: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' }, a: { type: 'number' } },
  required: ['r', 'g', 'b'],
  additionalProperties: false,
};

export const TOOL_SPECS: readonly ToolSpec[] = [
  // -------------------------------------------------------------------------------------------
  // project
  // -------------------------------------------------------------------------------------------
  {
    name: 'project_info',
    description:
      'What a project is: its name and main scene from project.godot, the Godot that answers, and how many scenes, scripts and assets it holds, with optional sections on top.',
    parameters: {
      projectPath: PROJECT_PATH,
      include: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['autoloads', 'plugins', 'export_presets', 'audio_buses', 'health', 'validation'],
        },
        description:
          'Extra sections: registered autoloads, addons and whether each is enabled, export presets, the audio bus layout, a health report, or export validation.',
      },
      preset: { type: 'string', description: 'For validation: the export preset to validate against.' },
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'full adds what to do about it to every validation finding. Default summary.',
      },
    },
    requires: ['projectPath'],
  },
  {
    name: 'project_settings',
    description:
      'Reads or writes project.godot: settings, autoloads, the main scene, input actions, plugins and audio buses.',
    parameters: {
      projectPath: PROJECT_PATH,
      setting: { type: 'string', description: 'Setting path, such as "display/window/size/viewport_width".' },
      value: {
        blank: true,
        description:
          'The value to write. Engine types may be tagged, {"_type": "Vector2", "x": 1, "y": 2}. "" writes an empty string.',
      },
      name: { type: 'string', description: 'Autoload name.' },
      path: { type: 'string', description: 'Autoload script or scene inside the project.' },
      enabled: { type: 'boolean', description: 'Autoloads: register enabled. Default true.' },
      scenePath: SCENE_PATH,
      actionName: { type: 'string', description: 'Input action name, such as "jump".' },
      events: INPUT_EVENTS,
      deadzone: { type: 'number', description: 'Input actions: analogue deadzone, 0 to 1. Default 0.5.' },
      pluginName: { type: 'string', description: 'Folder name under addons/.' },
      busName: { type: 'string', description: 'Audio bus name.' },
      parentBusIndex: { type: 'number', description: 'Audio buses: the bus to send to. Default 0, Master.' },
      busIndex: { type: 'number', description: 'Audio bus index.' },
      effectIndex: { type: 'number', description: 'Slot on the bus for the effect.' },
      effectType: { type: 'string', description: 'Effect class, such as "AudioEffectReverb".' },
      volumeDb: { type: 'number', description: 'Bus volume in decibels.' },
    },
    requires: ['projectPath'],
    operations: {
      get: { summary: 'read one setting', requires: ['setting'] },
      set: { summary: 'write one setting', requires: ['setting', 'value'] },
      add_autoload: { summary: 'register an autoload singleton', requires: ['name', 'path'] },
      remove_autoload: { summary: 'unregister an autoload', requires: ['name'] },
      set_main_scene: { summary: 'choose the scene the game starts in', requires: ['scenePath'] },
      add_input_action: {
        summary: 'register an input action and its events',
        requires: ['actionName', 'events'],
      },
      enable_plugin: { summary: 'enable an addon', requires: ['pluginName'] },
      disable_plugin: { summary: 'disable an addon', requires: ['pluginName'] },
      add_audio_bus: { summary: 'add an audio bus', requires: ['busName'] },
      set_audio_bus_effect: {
        summary: 'add or configure an effect on a bus',
        requires: ['busIndex', 'effectIndex', 'effectType'],
      },
      set_audio_bus_volume: { summary: 'set a bus volume', requires: ['busIndex', 'volumeDb'] },
    },
  },
  {
    name: 'project_search',
    description:
      'Searches text or a regular expression across project files and returns file paths with line numbers.',
    parameters: {
      projectPath: PROJECT_PATH,
      query: { type: 'string', description: 'The text or pattern to find.' },
      fileTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extensions to search, such as ["gd", "tscn"]. Default: every text file.',
      },
      regex: { type: 'boolean', description: 'Read the query as a regular expression. Default false.' },
      caseSensitive: { type: 'boolean', description: 'Default false.' },
      maxResults: { type: 'number', description: 'Default 100.' },
    },
    requires: ['projectPath', 'query'],
  },
  {
    name: 'project_dependencies',
    description: 'What a resource depends on, or what depends on it.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: RESOURCE_PATH,
      direction: {
        type: 'string',
        enum: ['forward', 'reverse'],
        description:
          'forward: what this resource loads, with cycles reported. reverse: every file that refers to it and how, a scene instancing it, a script extending, preloading or loading it, and for a script with a class_name every use of that name. Default forward.',
      },
      depth: { type: 'number', description: 'forward: how many levels to follow. Default unlimited.' },
      includeBuiltin: {
        type: 'boolean',
        description: "forward: include the engine's own res://. resources. Default false.",
      },
      fileTypes: { type: 'array', items: { type: 'string' }, description: 'reverse: extensions to look in.' },
    },
    requires: ['projectPath', 'resourcePath'],
  },
  {
    name: 'project_import',
    description:
      'The import pipeline: what needs importing, how a resource is imported, reimports, UIDs, and the global class list the editor and the engine read.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: RESOURCE_PATH,
      includeUpToDate: {
        type: 'boolean',
        description: 'status: list resources that are current as well. Default false.',
      },
      options: {
        type: 'object',
        description:
          'set_options: import options keyed as the .import file spells them, {"compress/mode": 1}.',
        additionalProperties: true,
      },
      reimport: { type: 'boolean', description: 'set_options: reimport afterwards. Default true.' },
      force: { type: 'boolean', description: 'reimport: reimport even what is current. Default false.' },
    },
    requires: ['projectPath'],
    operations: {
      status: {
        summary: 'which resources are outdated or failed, or one resource with resourcePath',
        requires: [],
      },
      options: { summary: 'the import options of one resource', requires: ['resourcePath'] },
      set_options: { summary: 'change import options', requires: ['resourcePath', 'options'] },
      reimport: {
        summary: 'reimport one resource, or everything modified without resourcePath',
        requires: [],
      },
      uid: { summary: 'the UID of one file', requires: ['resourcePath'] },
      refresh_uids: { summary: 'resave every resource so UID references are current', requires: [] },
      refresh_classes: {
        summary:
          'rewrite .godot/global_script_class_cache.cfg from the class_name declarations on disk, for an editor whose list has gone stale',
        requires: [],
      },
    },
  },
  {
    name: 'project_export',
    description: 'Export presets and exports.',
    parameters: {
      projectPath: PROJECT_PATH,
      preset: { type: 'string', description: 'Preset name from export_presets.cfg.' },
      outputPath: {
        type: 'string',
        description:
          'Where the export is written, inside the project. The directory is created if it is not there: Godot\'s command-line exporter refuses a missing one with "The given export path doesn\'t exist", which reads as a wrong path in the preset.',
      },
      debug: { type: 'boolean', description: 'run: a debug export. Default false.' },
    },
    requires: ['projectPath'],
    operations: {
      list: { summary: 'the presets in export_presets.cfg', requires: [] },
      run: { summary: 'export with a preset', requires: ['preset', 'outputPath'] },
    },
  },
  {
    name: 'project_test',
    description:
      "Runs the project's gdUnit4 tests headless and answers with every case that did not pass: where it is, and what the assertion said. Suites where everything passed are counted rather than listed, and an engine message keeps the frames above gdUnit4 rather than the twenty inside it, so a clean tier answers in a few lines. The class list is rebuilt first, so a suite written a moment ago is found. On Windows and Linux the run gets a user:// of its own, so a suite that saves a game writes nowhere near the saves of the copy somebody plays. A run that found nothing to run is never called a pass: gdUnit4 exits cleanly for one, so the answer says so and names the path it looked in. Needs gdUnit4 under addons/gdUnit4.",
    parameters: {
      projectPath: PROJECT_PATH,
      path: {
        type: 'string',
        description: 'A test directory or one suite file inside the project. Default test.',
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Suites or cases to leave out, as "suite_name" or "suite_name:test_name".',
      },
      failFast: {
        type: 'boolean',
        description: 'Stop at the first failure. Default false: the whole set runs.',
      },
      timeoutMs: {
        type: 'number',
        description: 'How long the run may take before it is killed. Default 600000.',
      },
    },
    requires: ['projectPath'],
  },

  // -------------------------------------------------------------------------------------------
  // scene
  // -------------------------------------------------------------------------------------------
  {
    name: 'scene_create',
    description:
      'Creates a scene file, saves one, or saves a copy under a new path. Needs the editor connected.',
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      rootNodeType: { type: 'string', description: 'create: the root node class. Default Node2D.' },
      newPath: { type: 'string', description: 'save_as: where the copy goes.' },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      create: { summary: 'a new scene with one root node', requires: [] },
      save: { summary: 'save the scene as it is in the editor', requires: [] },
      save_as: { summary: 'save a copy under newPath', requires: ['newPath'] },
    },
    defaultOperation: 'create',
  },
  {
    name: 'scene_tree',
    description:
      'The nodes of a scene file: names, classes and hierarchy, with properties when asked. Needs the editor connected.',
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      depth: { type: 'number', description: 'How many levels to descend. Default: all.' },
      includeProperties: { type: 'boolean', description: "Include each node's properties. Default false." },
    },
    requires: ['projectPath', 'scenePath'],
  },
  {
    name: 'scene_node',
    description:
      'One node in a scene file: add, read, set, duplicate, reparent or delete it, or paint TileMap cells. Any ClassDB node type can be added, so a NavigationRegion2D, an AnimationTree or a Camera3D is an add with that nodeType and its properties. A property holding a Resource takes the res:// path of one, so a texture, a material or a theme is a set like any other. Needs the editor connected.',
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      nodePath: NODE_PATH,
      parentNodePath: {
        type: 'string',
        description: 'add: where the node goes. Default the root. duplicate: where the copy goes.',
      },
      nodeType: { type: 'string', description: 'add: the node class, such as "CharacterBody2D".' },
      nodeName: { type: 'string', description: "add: the new node's name." },
      properties: PROPERTIES,
      newName: { type: 'string', description: "duplicate: the copy's name." },
      newParentPath: { type: 'string', description: 'reparent: the new parent.' },
      includeDefaults: {
        type: 'boolean',
        description: 'get: include properties still at their default. Default false.',
      },
      layer: { type: 'number', description: 'set_tilemap_cells: the TileMap layer. Default 0.' },
      cells: TILEMAP_CELLS,
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      add: { summary: 'add a node of any class', requires: ['nodeType', 'nodeName'] },
      get: { summary: "read a node's properties", requires: ['nodePath'] },
      set: { summary: 'set properties on a node', requires: ['nodePath', 'properties'] },
      duplicate: { summary: 'copy a node and its children', requires: ['nodePath', 'newName'] },
      reparent: { summary: 'move a node under another parent', requires: ['nodePath', 'newParentPath'] },
      delete: { summary: 'remove a node and its children', requires: ['nodePath'] },
      set_tilemap_cells: { summary: 'place tiles in a TileMap', requires: ['nodePath', 'cells'] },
    },
  },
  {
    name: 'scene_signal',
    description: 'Signal connections in a scene file. Needs the editor connected.',
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      sourceNodePath: { type: 'string', description: 'The node that emits.' },
      signalName: { type: 'string' },
      targetNodePath: { type: 'string', description: 'The node whose method is called.' },
      methodName: { type: 'string' },
      flags: { type: 'number', description: 'connect: Object.ConnectFlags, such as 1 for deferred.' },
      nodePath: { type: 'string', description: 'list: only connections involving this node.' },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      connect: {
        summary: 'connect a signal to a method',
        requires: ['sourceNodePath', 'signalName', 'targetNodePath', 'methodName'],
      },
      disconnect: {
        summary: 'remove a connection',
        requires: ['sourceNodePath', 'signalName', 'targetNodePath', 'methodName'],
      },
      list: { summary: 'every connection in the scene', requires: [] },
    },
  },
  {
    name: 'scene_animation',
    description:
      'Animations in an AnimationPlayer and states in an AnimationTree state machine. Needs the editor connected.',
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      playerNodePath: { type: 'string', description: 'The AnimationPlayer node.' },
      animationName: { type: 'string' },
      length: { type: 'number', description: 'create: seconds. Default 1.' },
      loopMode: {
        type: 'string',
        enum: ['none', 'linear', 'pingpong'],
        description: 'create: default none.',
      },
      step: { type: 'number', description: 'create: keyframe snap in seconds. Default 0.1.' },
      track: ANIMATION_TRACK,
      animTreePath: { type: 'string', description: 'The AnimationTree node.' },
      stateName: { type: 'string' },
      stateMachinePath: {
        type: 'string',
        description: 'add_state: a nested state machine. Default the root.',
      },
      fromState: { type: 'string' },
      toState: { type: 'string' },
      transitionType: {
        type: 'string',
        enum: ['immediate', 'sync', 'at_end'],
        description: 'connect_states: default immediate.',
      },
      advanceCondition: {
        type: 'string',
        description: 'connect_states: the condition parameter that advances.',
      },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      create: {
        summary: 'a new animation in an AnimationPlayer',
        requires: ['playerNodePath', 'animationName'],
      },
      add_track: {
        summary: 'a property or method track with keyframes',
        requires: ['playerNodePath', 'animationName', 'track'],
      },
      add_state: {
        summary: 'a state playing an animation, in an AnimationTree',
        requires: ['animTreePath', 'stateName', 'animationName'],
      },
      connect_states: {
        summary: 'a transition between two states',
        requires: ['animTreePath', 'fromState', 'toState'],
      },
    },
  },

  // -------------------------------------------------------------------------------------------
  // script
  // -------------------------------------------------------------------------------------------
  {
    name: 'script_edit',
    description:
      "Creates a GDScript file, or adds functions, variables and signals to one. Every declaration written carries a type. create loads what it wrote under the project's own warning settings and answers with parses; the engine's reasons for a refusal come back under engine_messages.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      className: { type: 'string', description: 'create: a class_name for the script.' },
      extends: { type: 'string', description: 'create: the base class. Default Node.' },
      content: { type: 'string', description: 'create: the whole file, instead of a template.' },
      template: {
        type: 'string',
        enum: ['singleton', 'state_machine', 'component', 'resource'],
        description: 'create: a starting shape.',
      },
      modifications: SCRIPT_MODIFICATIONS,
    },
    requires: ['projectPath', 'scriptPath'],
    operations: {
      create: { summary: 'a new script file', requires: [] },
      modify: { summary: 'add to an existing script', requires: ['modifications'] },
    },
  },
  {
    name: 'script_info',
    description:
      "What a script contains: its structure from the file, or symbols, completions and hover text from the editor's language server.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      includeInherited: {
        type: 'boolean',
        description: 'structure: include inherited members. Default false.',
      },
      line: { type: 'number', description: 'completion, hover: zero-based line.' },
      character: { type: 'number', description: 'completion, hover: zero-based column.' },
    },
    requires: ['projectPath', 'scriptPath'],
    operations: {
      structure: {
        summary: 'functions, variables, signals, class_name and extends, read from the file',
        requires: [],
      },
      symbols: { summary: 'document symbols from the language server', requires: [] },
      completion: { summary: 'completions at a position', requires: ['line', 'character'] },
      hover: { summary: 'hover text at a position', requires: ['line', 'character'] },
    },
    defaultOperation: 'structure',
  },
  {
    name: 'script_diagnostics',
    description:
      "Errors and warnings for a script from the editor's language server, and whether the script is clean. Needs the editor running.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
    },
    requires: ['projectPath', 'scriptPath'],
  },

  // -------------------------------------------------------------------------------------------
  // resource
  // -------------------------------------------------------------------------------------------
  {
    name: 'resource_edit',
    description:
      'Resource files: create any ClassDB resource as .tres, change one, write a shader, build a TileSet, or set a Theme colour or font size. A material is a create with resourceType StandardMaterial3D, ShaderMaterial or CanvasItemMaterial. Needs the editor connected.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: RESOURCE_PATH,
      resourceType: {
        type: 'string',
        description: 'create: the resource class, such as "PhysicsMaterial" or "StandardMaterial3D".',
      },
      properties: PROPERTIES,
      script: { type: 'string', description: 'create: a script to attach, for custom resources.' },
      shaderType: {
        type: 'string',
        enum: ['canvas_item', 'spatial', 'particles', 'sky', 'fog'],
        description: 'create_shader.',
      },
      code: {
        type: 'string',
        description: 'create_shader: the shader source. Default: a minimal shader of that type.',
      },
      sources: TILESET_SOURCES,
      controlType: { type: 'string', description: 'Theme ops: the Control class, such as "Button".' },
      colorName: { type: 'string', description: 'set_theme_color: such as "font_color".' },
      color: COLOUR,
      fontSizeName: { type: 'string', description: 'set_theme_font_size: such as "font_size".' },
      size: { type: 'number', description: 'set_theme_font_size: pixels.' },
    },
    requires: ['projectPath', 'resourcePath'],
    operations: {
      create: { summary: 'a new resource of any class', requires: ['resourceType'] },
      modify: { summary: 'set properties on an existing resource', requires: ['properties'] },
      create_shader: { summary: 'a .gdshader file', requires: ['shaderType'] },
      create_tileset: { summary: 'a TileSet from texture atlases', requires: ['sources'] },
      set_theme_color: { summary: 'a colour in a Theme', requires: ['controlType', 'colorName', 'color'] },
      set_theme_font_size: {
        summary: 'a font size in a Theme',
        requires: ['controlType', 'fontSizeName', 'size'],
      },
    },
  },

  // -------------------------------------------------------------------------------------------
  // editor
  // -------------------------------------------------------------------------------------------
  {
    name: 'editor_launch',
    description:
      'Opens the Godot editor on a project, in a window on this machine, or restarts the one already connected. An editor goes on serving the addon it read at startup, so restart is what puts a gdharness upgrade into effect; it saves open scenes on the way out and answers with the version that came back. Only an editor with a window can be restarted, because the engine hands back none of the arguments it was started with. editor_status says which editor is connected and whether it is holding an old addon.',
    parameters: { projectPath: PROJECT_PATH },
    requires: [],
    operations: {
      open: { summary: 'open the editor on a project', requires: ['projectPath'] },
      restart: { summary: 'restart the connected editor and wait for it', requires: [] },
    },
    defaultOperation: 'open',
  },
  {
    name: 'editor_run',
    description:
      'The run: starting the project, stopping it, or booting it once to see whether it comes up clean. start keeps it running and collecting output until it quits or is stopped, windowed where there is a display and headless where there is not, unless headless says otherwise; only runtime_capture needs the window. A run that quits on its own is kept, so a scene that prints an answer and quits is start, then editor_output until running is false. What runs is a scene: a SceneTree script is not an entry point here, so put the script on the root of a scene of its own and name that in scene. check boots it headless for a few frames, waits for it to quit, and answers with the verdict: whether it came up, and every error and warning it printed on the way.',
    parameters: {
      projectPath: PROJECT_PATH,
      scene: { type: 'string', description: 'A scene to run instead of the main scene.' },
      headless: { type: 'boolean', description: 'start: force a window or no window.' },
      frames: { type: 'number', description: 'check: frames to run before quitting. Default 3.' },
      timeoutMs: {
        type: 'number',
        description: 'check: how long to give the boot before it is called hung. Default 60000.',
      },
    },
    requires: ['projectPath'],
    operations: {
      start: { summary: 'run the project until it quits or is stopped', requires: [] },
      stop: { summary: 'end the run and answer with what it printed last', requires: [] },
      check: { summary: 'boot headless, quit after a few frames, and report the verdict', requires: [] },
    },
    defaultOperation: 'start',
  },
  {
    name: 'editor_output',
    description:
      'What the project started by editor_run has printed, as entries with a severity: the errors and warnings the engine reported, each with where it happened, and everything else as info. Answers with the counts and the verdict as well as the entries. A run that has quit still answers here, with running false and its exit code, until the next one starts.',
    parameters: {
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info'],
        description: 'The least severe entry to include. Default info, which is everything.',
      },
      sinceLastCall: {
        type: 'boolean',
        description: 'Only entries printed since the previous editor_output. Default false.',
      },
      contains: { type: 'string', description: 'Only entries mentioning this text.' },
      limit: { type: 'number', description: 'The most entries to answer with, newest kept. Default 200.' },
    },
    requires: [],
  },
  {
    name: 'editor_status',
    description:
      'Whether the editor addon is connected, which Godot answers, whether the editor is playing something, and whether a game with the runtime addon is reachable.',
    parameters: {},
    requires: [],
  },
  {
    name: 'editor_rescan',
    description:
      'Makes the running editor scan the project filesystem, so files written outside it, and any class_name they declare, become visible. Needs the editor connected.',
    parameters: {
      projectPath: PROJECT_PATH,
      timeoutMs: { type: 'number', description: 'How long to wait for the scan. Default 30000.' },
    },
    requires: ['projectPath'],
  },
  {
    name: 'editor_classes',
    description: "The engine's ClassDB: find classes, read one in full, or walk an inheritance tree.",
    parameters: {
      projectPath: PROJECT_PATH,
      filter: { type: 'string', description: 'query: a substring of the class name.' },
      category: {
        type: 'string',
        enum: [
          'node',
          'node2d',
          'node3d',
          'control',
          'resource',
          'physics',
          'physics2d',
          'physics3d',
          'audio',
          'animation',
          'ui',
        ],
        description: 'query: limit to one family.',
      },
      instantiableOnly: { type: 'boolean', description: 'query: leave out abstract classes. Default false.' },
      className: { type: 'string', description: 'info, inheritance: the class.' },
      includeInherited: { type: 'boolean', description: 'info: include inherited members. Default false.' },
    },
    requires: ['projectPath'],
    operations: {
      query: { summary: 'classes matching a filter or category', requires: [] },
      info: { summary: 'methods, properties, signals and enums of one class', requires: ['className'] },
      inheritance: { summary: 'ancestors and descendants of one class', requires: ['className'] },
    },
    defaultOperation: 'query',
  },

  // -------------------------------------------------------------------------------------------
  // runtime
  // -------------------------------------------------------------------------------------------
  {
    name: 'runtime_inspect',
    description:
      'Questions about the running game: what is written on the screen, the scene tree, the nodes matching a query, where one node is on screen, what one property reads, or the performance metrics. Needs the game running with the runtime addon.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      nodePath: {
        type: 'string',
        ops: ['tree', 'text', 'find', 'rect', 'property'],
        description:
          'tree, find, text: where to start, default /root. rect: the node to place. property: the node to read.',
      },
      property: {
        type: 'string',
        ops: ['property', 'find'],
        description:
          'property: which one to read. find: read this one off every node matched, so a panel of labels is one call rather than one per label. Colons read through the objects a node holds, "_game:clock:speed", which is where a game keeps what is worth asking about; a step that is not there is named.',
      },
      depth: { type: 'number', ops: ['tree'], description: 'tree: levels to descend. Default 3.' },
      includeProperties: {
        type: 'boolean',
        ops: ['tree'],
        description: "tree: include each node's properties. Default false.",
      },
      className: {
        type: 'string',
        ops: ['find'],
        description: 'find: a native class, matching its subclasses too, or a class_name.',
      },
      script: { type: 'string', ops: ['find'], description: 'find: the script file the node carries.' },
      namePattern: {
        type: 'string',
        ops: ['find'],
        description:
          'find: a case-insensitive glob on the node name, such as "Enemy*". Matched against the whole name, so a bare word finds only a node called exactly that; an answer of none says how many names contain it and what glob would have found them.',
      },
      group: { type: 'string', ops: ['find'], description: 'find: a group the node is in.' },
      says: {
        type: 'string',
        ops: ['find'],
        description:
          'find: part of what the node has written on it, case-insensitively, which is how a button is reached by the word on it rather than by a generated path. Its own text, so a row is found by the label in it, and hidden nodes match. A bare word is a contains; write a glob and it is one, matched against the whole of what the node says, the same as namePattern.',
      },
      limit: {
        type: 'number',
        ops: ['find', 'text'],
        description:
          'find: the most nodes to answer with, default 100. text: the most lines, default 500, with truncated saying whether there were more.',
      },
      includeHidden: {
        type: 'boolean',
        ops: ['text'],
        description:
          'text: read hidden nodes as well, for checking that something is not showing. Default false.',
      },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        ops: ['metrics'],
        description: 'metrics: which to read. Default all.',
      },
    },
    requires: [],
    operations: {
      tree: { summary: 'the live scene tree', requires: [] },
      text: {
        summary:
          'every line of text under nodePath, the values in its fields included, in the order somebody reads the screen, leaving out what is hidden and everything under it',
        requires: [],
      },
      find: {
        summary:
          'the paths of every node matching className, script, namePattern, group or says, with property read off each',
        requires: [],
      },
      rect: {
        summary:
          "one node's rectangle or position, in canvas and in window pixels. A 3D node answers with the point to aim at, which is the middle of what it draws rather than the origin it stands on, the rectangle it covers under covers, the camera that drew it, and behind_camera when it is not in front of one",
        requires: ['nodePath'],
      },
      property: {
        summary:
          'what one property reads on a node, or through the objects it holds, refusing a name nothing along the way has',
        requires: ['nodePath', 'property'],
      },
      metrics: { summary: 'frame time, memory, draw calls and the rest', requires: [] },
    },
    defaultOperation: 'tree',
  },
  {
    name: 'runtime_invoke',
    description:
      'Sets a property or calls a method on a node in the running game. Needs the game running with the runtime addon.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      nodePath: { type: 'string', description: 'Absolute node path, such as "/root/Main/Player".' },
      property: {
        type: 'string',
        ops: ['set'],
        description:
          'set: which one to write. Colons write through the objects a node holds, "_game:run:day", and the answer reads back off the same holder, so a write a typed container refused shows as an unchanged value.',
      },
      value: {
        ops: ['set'],
        blank: true,
        description: 'set: the value, fitted to the property\'s type. "" writes an empty string.',
      },
      method: {
        type: 'string',
        ops: ['call'],
        description:
          'call: which one to call. Colons call through the objects a node holds, "_game:run:advance", the same way a property is written through them.',
      },
      args: {
        type: 'array',
        ops: ['call'],
        description: "call: the arguments, fitted to the method's parameter types.",
      },
    },
    requires: ['nodePath'],
    operations: {
      set: {
        summary: 'set a property, on a node or on an object it holds',
        requires: ['property', 'value'],
      },
      call: {
        summary: 'call a method, on a node or on an object it holds, and return its result',
        requires: ['method'],
      },
    },
  },
  {
    name: 'runtime_capture',
    description:
      'A picture of the running game: the whole screen or one viewport, as an image. Needs the game running with a window.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      viewportPath: {
        type: 'string',
        ops: ['viewport'],
        description: 'viewport: the Viewport node. Default the root viewport.',
      },
      width: { type: 'number', description: 'Scale the image to this width.' },
      height: { type: 'number', description: 'Scale the image to this height.' },
    },
    requires: [],
    operations: {
      screenshot: { summary: 'the screen', requires: [] },
      viewport: { summary: "one viewport's texture", requires: [] },
    },
    defaultOperation: 'screenshot',
  },
  {
    name: 'runtime_input',
    description:
      'Input to the running game: a whole click on a Control or a 3D node named by path, an item chosen out of a menu, typing into whatever has the focus, or a raw action, key, mouse button or mouse motion. All of it works headless, where the window is 64 by 64 and the GUI only takes what is inside it.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      nodePath: {
        type: 'string',
        ops: ['click', 'choose'],
        description:
          'click: the Control to click, at its centre, or the 3D node to click, where it is drawn. choose: the PopupMenu, or the OptionButton or MenuButton in front of one.',
      },
      action: {
        type: 'string',
        ops: ['action'],
        description:
          'action: the InputMap action name. An engine dialog is not answered this way: AcceptDialog reads the Escape key itself and never asks the InputMap, so ui_cancel goes in and the question stays up. Dismiss one with key Escape, or click its button.',
      },
      pressed: {
        type: 'boolean',
        ops: ['action', 'key', 'mouse_click'],
        description:
          'action, key: leave it out and the press is a whole one, down and up a frame apart. true holds it down, false lets go of one being held. mouse_click is one raw event, so it is down unless you say false.',
      },
      strength: { type: 'number', ops: ['action'], description: 'action: 0 to 1. Default 1.' },
      keycode: {
        type: ['string', 'number'],
        ops: ['key'],
        description: 'key: the key name, such as "Space" or "A", or its Godot keycode.',
      },
      text: {
        type: 'string',
        ops: ['text', 'choose'],
        blank: true,
        description:
          'text: what to type. A newline is Enter and a tab is Tab, a space is a space, and "" with replace empties the field. choose: the item to take, by what it says.',
      },
      replace: {
        type: 'boolean',
        ops: ['text'],
        description:
          'text: true writes over what the field already says, which is what filling one in means. Default false types at the caret, so a field reading 2.1 typed "0.3" at reads 2.10.3. The answer says what the field holds afterwards either way.',
      },
      index: {
        type: 'number',
        ops: ['choose'],
        description: 'choose: the item to take, by where it is in the list, when text will not do.',
      },
      shift: { type: 'boolean', ops: ['key'] },
      ctrl: { type: 'boolean', ops: ['key'] },
      alt: { type: 'boolean', ops: ['key'] },
      x: {
        type: 'number',
        ops: ['mouse_click', 'mouse_motion'],
        description: 'mouse_click, mouse_motion: window pixels.',
      },
      y: {
        type: 'number',
        ops: ['mouse_click', 'mouse_motion'],
        description: 'mouse_click, mouse_motion: window pixels.',
      },
      button: {
        type: ['string', 'number'],
        ops: ['click', 'mouse_click'],
        description:
          'click, mouse_click: left, right, middle, wheel_up or wheel_down, or a button number. Default left.',
      },
      doubleClick: {
        type: 'boolean',
        ops: ['click', 'mouse_click'],
        description: 'click, mouse_click: default false.',
      },
      relativeX: {
        type: 'number',
        ops: ['mouse_motion'],
        description: 'mouse_motion: movement since the last event.',
      },
      relativeY: {
        type: 'number',
        ops: ['mouse_motion'],
        description: 'mouse_motion: movement since the last event.',
      },
    },
    requires: [],
    operations: {
      click: {
        summary:
          'press and release on a Control, a frame apart, and answer with what was under the pointer and what became of the control: in_tree, removed or freed. A control out of sight inside a ScrollContainer is scrolled to first, and scrolled_into_view says whether the view moved. A 3D node is clicked where it is drawn, and landed then says the interface did not swallow the press',
        requires: ['nodePath'],
      },
      choose: {
        summary:
          "take an item out of a menu, by what it says or by where it is in the list. A menu's items are drawn rather than built, so there is nothing to click: the item takes the focus and Enter presses it, which is the engine's own path and needs no window. Answers with what was chosen and what the button in front of it shows now",
        requires: ['nodePath'],
      },
      action: { summary: 'press an action, or hold it', requires: ['action'] },
      key: { summary: 'press a key, or hold it', requires: ['keycode'] },
      text: {
        summary:
          'type a string into the field being edited, a character at a time, and say what it landed in',
        requires: ['text'],
      },
      mouse_click: { summary: 'one mouse button event at a position', requires: ['x', 'y'] },
      mouse_motion: { summary: 'move the mouse to a position', requires: ['x', 'y'] },
    },
  },
  {
    name: 'runtime_wait',
    description:
      'Lets the running game get on with it and answers when something has happened: a number of frames, a signal, a property reaching a value, or words appearing on a screen. Needs the game running with the runtime addon.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      frames: {
        type: 'number',
        ops: ['frames'],
        description: 'frames: how many to let pass, 1 to 600. More than that is refused.',
      },
      nodePath: { type: 'string', ops: ['signal', 'until'], description: 'signal, until: the node.' },
      signal: { type: 'string', ops: ['signal'], description: 'signal: the signal name.' },
      property: { type: 'string', ops: ['until'], description: 'until: the property name.' },
      value: { ops: ['until'], description: "until: the value to wait for, fitted to the property's type." },
      says: {
        type: 'string',
        ops: ['until'],
        description:
          'until: wait for these words to appear anywhere under nodePath instead of for a property, which is how a panel that rebuilds its labels is waited on at all: the labels are named afresh each redraw and the panel is what stays put. Case-insensitive, part of a line, hidden nodes included.',
      },
      timeoutMs: {
        type: 'number',
        ops: ['signal', 'until'],
        description: 'signal, until: how long to wait before answering anyway, 1 to 120000. Default 5000.',
      },
    },
    requires: [],
    operations: {
      frames: { summary: 'let frames pass', requires: ['frames'] },
      signal: {
        summary: 'wait for a signal and answer with what it carried',
        requires: ['nodePath', 'signal'],
      },
      until: {
        summary:
          'wait for a property to read as a value, or for words to appear under a node, and answer with what it found',
        requires: ['nodePath'],
      },
    },
  },

  // -------------------------------------------------------------------------------------------
  // debug
  // -------------------------------------------------------------------------------------------
  {
    name: 'debug_breakpoint',
    description:
      "Sets or removes a breakpoint through the editor's debug adapter. Needs the editor, not a running game: set them first, then editor_run, and the game stops where you asked.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      line: { type: 'number', description: 'One-based line.' },
    },
    requires: ['projectPath', 'scriptPath', 'line'],
    operations: {
      set: { summary: 'set a breakpoint', requires: [] },
      remove: { summary: 'remove a breakpoint', requires: [] },
    },
  },
  {
    name: 'debug_control',
    description:
      "Continues or steps the debugged game through the editor's debug adapter, answering with the stack where it ended up. There is no pause and no step_out: Godot's adapter answers a pause by reporting the game stopped and leaving it running, and implements no stepOut at all, so hold the game where you want it with a breakpoint and step over or into from there.",
    parameters: {},
    requires: [],
    operations: {
      continue: { summary: 'resume after a breakpoint', requires: [] },
      step_over: { summary: 'run the current line', requires: [] },
      step_into: { summary: 'run the current line, stopping inside whatever it calls', requires: [] },
    },
  },
  {
    name: 'debug_state',
    description:
      "Where the debugged game is stopped: the stack trace, what is in scope at a frame with the values, or the debug adapter's console output so far.",
    parameters: {
      frameId: {
        type: 'number',
        ops: ['variables'],
        description: 'variables: which frame, from a stack answer. Default the innermost.',
      },
    },
    requires: [],
    operations: {
      stack: { summary: 'the stack trace', requires: [] },
      variables: { summary: 'locals, members and globals at a frame, with their values', requires: [] },
      output: { summary: 'console output captured through the debug adapter', requires: [] },
    },
    defaultOperation: 'stack',
  },
];

const SPECS_BY_NAME: Readonly<Record<string, ToolSpec>> = dictionary(
  Object.fromEntries(TOOL_SPECS.map((spec) => [spec.name, spec])),
);

export function toolSpec(name: string): ToolSpec | undefined {
  return SPECS_BY_NAME[name];
}

function describeOperations(spec: ToolSpec): string {
  if (!spec.operations) {
    return '';
  }
  const lines = Object.entries(spec.operations).map(([op, operation]) => {
    const needs = operation.requires.length > 0 ? ` (needs ${operation.requires.join(', ')})` : '';
    return `${op}${needs}: ${operation.summary}`;
  });
  const fallback = spec.defaultOperation ? ` Default ${spec.defaultOperation}.` : '';
  return ` Operations: ${lines.join('; ')}.${fallback}`;
}

/** The specs as the protocol carries them. */
export function buildToolDefinitions(): MCPToolDefinition[] {
  return TOOL_SPECS.map((spec) => {
    const properties: Record<string, unknown> = {};
    if (spec.operations) {
      properties['op'] = {
        type: 'string',
        enum: Object.keys(spec.operations),
        description: 'What to do.',
      };
    }
    for (const [name, schema] of Object.entries(spec.parameters)) {
      // `ops` is ours rather than JSON Schema's, and a client handed a key its validator does not
      // know is a client that may refuse the whole tool. Which ops take what is in the description.
      const { ops: _ops, blank: _blank, ...carried } = schema;
      properties[name] = carried;
    }

    const required = [...spec.requires];
    if (spec.operations && !spec.defaultOperation) {
      required.unshift('op');
    }

    return {
      name: spec.name,
      description: `${spec.description}${describeOperations(spec)}`,
      inputSchema: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    };
  });
}
