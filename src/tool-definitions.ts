/**
 * The tool surface: a few dozen tools, each shaped like a task rather than an engine call.
 *
 * A tool that does several related things takes an `op`. Which arguments each op needs is
 * written once, in `operations`, and read twice: rendered into the description the client
 * sees, and enforced before dispatch, so the two cannot drift. Every schema refuses arguments
 * it does not name, an unknown op is refused with the valid set spelled out, and so is a value
 * outside the set its parameter lists, because a silent default is how a wrong call reads as a
 * working one.
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

/**
 * The extra sections `project_info` can be asked for.
 *
 * Here rather than beside the table that fetches them because the schema and the table are in
 * different files and both have to hold the same list: written twice, a section added to one and
 * not the other is either offered and refused or fetchable and undiscoverable. The server's table
 * is keyed by this, so the compiler is what keeps them level.
 */
const PROJECT_INFO_SECTIONS = [
  'autoloads',
  'plugins',
  'export_presets',
  'audio_buses',
  'health',
  'validation',
] as const;

export type ProjectInfoSection = (typeof PROJECT_INFO_SECTIONS)[number];

/** Whether [op] reads [name] on [spec]. A parameter that names no ops is read by all of them. */
export function opTakes(spec: ToolSpec, op: string, name: string): boolean {
  const ops = spec.parameters[name]?.ops;
  return ops === undefined || ops.includes(op);
}

/** Every argument [op] takes, in the order the schema declares them. */
export function argumentsOf(spec: ToolSpec, op: string): string[] {
  return Object.keys(spec.parameters).filter((name) => opTakes(spec, op, name));
}

/**
 * The calls that take no `projectPath`, read off the schemas rather than remembered: a tool that
 * declares none, and an op of a tool whose `projectPath` belongs to other ops.
 *
 * Both the skill and the tool reference open by saying which calls need one, and both said it in
 * prose that named the `runtime_*` and `debug_*` families and nothing else. `editor_status` takes no
 * arguments at all and `editor_output` takes its own, and an argument a tool does not declare is
 * refused rather than ignored, so a session following that sentence failed on what is often its
 * first call. Generated here so the sentence cannot go on being true of a surface that moved.
 *
 * By op and not by tool, since a call is an op. Read by tool the list named four tools and stood
 * beside per-op lines that refused what it promised: `editor_run stop` and `wait` and
 * `editor_launch restart` take none, on a tool that takes one for its other ops, and a session
 * following the sentence was refused twice in an hour with "stop takes: andChildren". Each such op
 * is named with its tool, the way a call is written.
 */
export function callsWithoutProjectPath(): string[] {
  const calls: string[] = [];
  for (const spec of TOOL_SPECS) {
    if (!Object.hasOwn(spec.parameters, 'projectPath')) {
      calls.push(spec.name);
      continue;
    }
    for (const op of Object.keys(spec.operations ?? {})) {
      if (!opTakes(spec, op, 'projectPath')) {
        calls.push(`${spec.name} ${op}`);
      }
    }
  }
  return calls.sort();
}

/**
 * The opening clause both renderings share, built once so they cannot say it differently.
 *
 * They already did: one escaped every backtick in the generated names and the other did not, and the
 * case holding both of them compared the names, which is what the markup sits between. Two callers
 * building the same sentence is the arrangement that allows it.
 *
 * The count decides the grammar, including at none, which nothing produces today and which a tool
 * gaining a `projectPath` would: "except , which take none" is what the list-joining version says
 * there, and it would ship in the skill every agent reads. The list is an argument so a case can
 * read those branches out of this function rather than out of a copy of it, since a copy is wrong
 * in the same way as the original or in a different one, and neither tells you anything.
 */
export function projectPathSentence(without: readonly string[] = callsWithoutProjectPath()): string {
  if (without.length === 0) {
    return 'Every call takes `projectPath`';
  }
  const named = without.map((name) => `\`${name}\``).join(', ');
  return `Every call takes \`projectPath\` except ${named}, which ${
    without.length === 1 ? 'takes' : 'take'
  } none`;
}

/**
 * Which game answers a `runtime_*` or `debug_*` call that names neither `projectPath` nor `pid`.
 *
 * Built once and rendered into the skill, the tool reference and the argument's own description,
 * because it was written in each of those separately and each said a different amount of it: the
 * reference said those tools "pick between running games" and stopped, and `projectPath` said
 * "not needed with one game", which says nothing about two. A session with another project's game
 * listed beside its own read both and could not tell what was answering it. What decides is in
 * `chooseRuntime` and in `ownGameAmong` above it, so the sentence is one and the order is theirs.
 */
export function theGamePicked(): string {
  return (
    'the game this server started or is playing when it is among those running, named under ' +
    '`answeredBy` where there was a choice; else the only game there is; else a refusal naming ' +
    'every game and which argument tells them apart, `pid` when they are all one project and ' +
    '`projectPath` when they are not'
  );
}

const PROJECT_PATH: JsonSchema = {
  type: 'string',
  description: 'Absolute path to the project directory, the one holding project.godot.',
};
const RUNNING_PROJECT_PATH: JsonSchema = {
  type: 'string',
  description: `Which game, when more than one is running: the project directory it was started from. The pick without it, in order: ${theGamePicked().replaceAll('`', '')}. Not needed with one game, nor for a call to this server's own.`,
};
const RUNNING_PID: JsonSchema = {
  type: 'number',
  description:
    'Which game, when several are running from one project, such as a bench and its workers: its process id, as editor_status lists under runtimes. Without it the game this server started or plays is the one asked when it is among them, and the answer says so under answeredBy; with one game per project it is not needed at all.',
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
    'Properties to set, keyed by Godot property name. Vectors, colours and the like may be written as {"x": 1, "y": 2} or tagged {"_type": "Vector2", "x": 1, "y": 2}, which is the form a read answers with, so a value read off one node can be written straight to another.',
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
      ctrl: { type: 'boolean', description: 'Keys: bind it with Ctrl held.' },
      alt: { type: 'boolean', description: 'Keys: bind it with Alt held.' },
      shift: { type: 'boolean', description: 'Keys: bind it with Shift held.' },
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
  description: 'set_theme_color: r, g and b from 0 to 1, with a optional and opaque by default.',
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
        items: { type: 'string', enum: PROJECT_INFO_SECTIONS },
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
      from: {
        type: 'string',
        enum: ['disk', 'editor'],
        ops: ['get'],
        description:
          'get: where to read. Default disk, which starts a short-lived engine and reads project.godot, needs no editor and is what an automatic check can reproduce. editor asks the open editor instead, which costs no engine and answers what the editor holds, including changes nobody has saved. Asking for editor with none connected is refused rather than answered from disk, so an answer never means the other one quietly.',
      },
      prefix: {
        type: 'string',
        ops: ['get'],
        description:
          'get: answer with every setting whose name starts with this, and the type the engine registers for each, instead of one setting by name. "debug/gdscript/warnings/" answers the whole family. The type matters: a family of levels can hold a setting that is a bool, and writing a level over it looks like it worked.',
      },
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
      deadzone: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Input actions: analogue deadzone, 0 to 1. Default 0.5.',
      },
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
      // Neither is required because either will do, and which one is missing is a better refusal
      // than a list of both: the engine answers that, since it is what reads them.
      get: { summary: 'read one setting, or every setting under prefix', requires: [] },
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
      'Searches text or a regular expression across project files and returns file paths with line numbers. What the engine steps over is not searched: directories spelled with a dot, node_modules, and any directory holding a .gdignore. A vendored engine or an export directory is therefore absent from the results rather than matching the code you are looking for in a copy nobody runs.',
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
          'forward: what this resource loads, with cycles reported. reverse: every file that refers to it and how, a scene instancing it, a script extending, preloading or loading it, and for a script with a class_name every use of that name. Each reference carries a kind, and two of them are mentions rather than uses: doc is a name inside a ## documentation comment, which renaming would break in the generated docs, and comment is one in ordinary prose, which it would only make stale. summary.in_code is the count with both of those left out, which is the number to read when the question is whether anything still uses this. Default forward.',
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
      refresh_uids: {
        summary:
          'import the project so every script and shader has its .uid sidecar, and name under uidsCreated the ones this made and under stillWithoutUid the ones the engine would not import: it writes no scene and no script, so a project whose sidecars are all present is left untouched',
        requires: [],
      },
      refresh_classes: {
        summary:
          'rewrite .godot/global_script_class_cache.cfg from the class_name declarations on disk, and name under unseenByEditor any class the editor open on this project still cannot resolve: rewriting the file does not reach the list a running editor loaded, so "added: []" means the file was already right rather than that nothing is wrong. A class the cache held after the last rebuild and had lost when this one began is named under lostSinceLastRebuild: the editor wrote the file without it in between, on a save or a scan, and will again until restarted',
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
      "Runs the project's gdUnit4 tests headless and answers with every case that did not pass: where it is, and what the assertion said. Suites where everything passed are counted rather than listed, and an engine message keeps the frames above gdUnit4 rather than the twenty inside it, so a clean tier answers in a few lines. The class list is rebuilt first, so a suite written a moment ago is found, and the rebuild's answer is under classes: a class it puts back that the cache had after the last rebuild is named under classes.lostSinceLastRebuild, which is the editor writing its shorter list over the file on every save until restarted. On Windows and Linux the run gets a user:// of its own, so a suite that saves a game writes nowhere near the saves of the copy somebody plays. On macOS the engine reads user:// off HOME and the run writes where the player keeps theirs, which the answer says under savesNote rather than leaving to be found in a save list. A run that found nothing to run is never called a pass: gdUnit4 exits cleanly for one, so the answer says so and names the path it looked in. A run where nothing failed but nodes were left in the tree comes back under warnings, with the count per suite: gdUnit4 decides its verdict on those and keeps them out of its report, so they are read off what it printed. Needs gdUnit4 under addons/gdUnit4.",
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
        description:
          'Stop each suite at its first failing case. Default false: every case runs. With it on, the counts are of what ran, notRun says how many cases were left, and fixing what is named and running again finds the next one, which looks like a flaky tier and is not.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
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
      signalName: { type: 'string', description: 'The signal it emits, such as "pressed".' },
      targetNodePath: { type: 'string', description: 'The node whose method is called.' },
      methodName: { type: 'string', description: 'The method on that node, called when it emits.' },
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
      animationName: {
        type: 'string',
        description: 'The animation in the player. add_state: the one that state plays.',
      },
      length: { type: 'number', description: 'create: seconds. Default 1.' },
      loopMode: {
        type: 'string',
        enum: ['none', 'linear', 'pingpong'],
        description: 'create: default none.',
      },
      step: { type: 'number', description: 'create: keyframe snap in seconds. Default 0.1.' },
      track: ANIMATION_TRACK,
      animTreePath: { type: 'string', description: 'The AnimationTree node.' },
      stateName: { type: 'string', description: 'add_state: the state to add.' },
      stateMachinePath: {
        type: 'string',
        description: 'add_state: a nested state machine. Default the root.',
      },
      fromState: { type: 'string', description: 'connect_states: the state the transition leaves.' },
      toState: { type: 'string', description: 'connect_states: the state it arrives at.' },
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
        description:
          "structure: also list what the script inherits, walking extends through the project's other scripts. Each such member carries inherited_from, the file declaring it, and the answer gains inherits_from, the chain that was walked. A name the script overrides is listed at both its lines rather than once. A native base is not walked, since it declares nothing in a file: editor_classes info answers for those. Default false.",
      },
      line: { type: 'integer', minimum: 0, description: 'completion, hover: zero-based line.' },
      character: { type: 'integer', minimum: 0, description: 'completion, hover: zero-based column.' },
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
      "Errors and warnings for a script from the editor's language server, and whether the script is clean. Needs the editor running. Diagnostics are checked against the project's own files, and the two that the files disprove are named rather than passed on: a member the class cache's file declares comes back under contradictedByTheFile, and a class this project declares that the diagnostic could not resolve comes back under typesTheEditorHasNotLoaded, with inTheClassCache saying whether a launched game would resolve it. staleAnalysis then says what to do, and for both states it is editor_rescan first: it asks the editor already running, starts nothing, and has cleared each in every reproduction measured. The one exception is named when it applies: an editor whose last scan wrote the class cache shorter than the file holds a list behind the files and writes it on every scan, so on that editor the rescan loads nothing and staleAnalysis says editor_launch restart instead. What follows differs: for a stale analysed type, editor_rescan with reloadScript recompiles the held copy and editor_launch restart is the last resort that costs a window; for a class missing from the cache, project_import refresh_classes rewrites the cache from disk at the cost of a short headless engine, which matters beside a running bench.",
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
      'Opens the Godot editor on a project, in a window on this machine, or restarts the one already connected. An editor goes on serving the addon it read at startup, so restart is what puts a gdharness upgrade into effect; it saves open scenes on the way out and answers with the version that came back. Only an editor with a window can be restarted, because the engine hands back none of the arguments it was started with. editor_status says which editor is connected and whether it is holding an old addon. Opening a project is a save and so is closing one, which is the part that is not obvious from outside: the editor imports the project on open and writes project.godot back, and Godot writes only what differs from its own defaults, so a key named deliberately at its default value is dropped either way. A restart says which under settingsDropped in its own answer because it waits for the editor to return. An open cannot, since it answers as soon as the process exists and the save happens during the import minutes later, so editor_status carries that reading once the editor has connected. Nothing else will say a key went until something depends on one. A restart of an editor this server opened is a quit and then a launch, and this server can be ended between them, usually by the reconnect the restart was being taken for: the editor is gone and nothing replaces it. That is written down before the quit, so the next server says so under restartInterrupted in editor_status rather than waiting for an editor that is not coming, and open finishes it, saying so under finishesRestart.',
    // open alone: a restart is of the editor already connected, which names its own project, and
    // an argument that is accepted and then ignored is one a caller can be wrong about for ever.
    parameters: { projectPath: { ...PROJECT_PATH, ops: ['open'] } },
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
      "The run: starting the project, stopping it, or booting it once to see whether it comes up clean. start keeps it running and collecting output until it quits or is stopped, windowed where there is a display and headless where there is not, unless headless says otherwise; only runtime_capture needs the window. A run that quits on its own is kept, so a scene that prints an answer and quits is start, then editor_output until running is false. What runs is a scene: a SceneTree script is not an entry point here, so put the script on the root of a scene of its own and name that in scene. args hands the game its own flags, the ones it reads with OS.get_cmdline_user_args(), and a run carrying any is started by this server rather than by the editor. check boots it headless for a few frames, waits for it to quit, and answers with the verdict: whether it came up, and every error and warning it printed on the way. start and check both wait first for a scan the open editor is running and for the class cache it writes just after, since a game booted in between resolves no global class, as does every other engine this server starts on the project; waitedForEditorScanMs says how long, and scanNote says when a scan ran past thirty seconds and the game started during it. A start waits for the game to become something the runtime_* tools can talk to and says which it is under runtime: listening with the port it took, or why not, so the first call after a start does not have to be made twice. When it is not listening, mayYetAnnounce says whether that is final: false is a runtime that is not coming, true is a game still on its way up, which editor_status will see and runtimeWaitMs waits longer for. A start this server made also answers with transcript, the file both the run's streams are written to, so a watch on it can be armed off the start rather than off a second call.",
    parameters: {
      // start and check alone, because they are the two that need telling which project. The
      // others are about the run already going, which this server is holding and can name for
      // itself: asking a caller to repeat it is asking for something that cannot disagree and
      // must therefore be right, and taking it while ignoring it is the silent default this
      // schema exists to refuse.
      projectPath: { ...PROJECT_PATH, ops: ['start', 'check'] },
      scene: {
        type: 'string',
        ops: ['start', 'check'],
        description: 'A scene to run instead of the main scene.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        ops: ['start', 'check'],
        description:
          'The game\'s own arguments, what OS.get_cmdline_user_args() answers, such as ["--level=2"]. The separator is added here. A run with any is started by this server rather than by the editor, which fixes the game\'s command line when it opens the project, so the debug_* tools do not answer for it.',
      },
      headless: { type: 'boolean', ops: ['start'], description: 'start: force a window or no window.' },
      savesIn: {
        type: 'string',
        ops: ['start', 'check'],
        description:
          "An absolute directory for this run's user://, so a game that saves writes nowhere near the copy somebody plays: opening a save writes the one being left, and a game that autosaves writes on its own. Godot takes no flag for it, so this is the environment, and the run is started by this server rather than played by the editor, which cannot be given one. It does not have to exist: the engine makes it, and the Godot/app_userdata/<project> tree under it, measured on 4.7.2. On macOS the engine reads user:// off HOME and ignores it, also measured, and the answer says so under savesNote rather than leaving the caller to find out from the player's save list.",
      },
      env: {
        type: 'object',
        ops: ['start', 'check'],
        description:
          "Environment variables for this run alone, as a map of strings, over the server's own environment. Like savesIn, a run carrying any is started by this server rather than played by the editor. Names beginning with GDHARNESS_ are refused: they are this server's contract with the addon in the game, and the runtime directory is set here whatever the rest of the environment says, so a game that moves TEMP still announces where this server looks.",
      },
      runtimeWaitMs: {
        type: 'integer',
        minimum: 0,
        ops: ['start'],
        description:
          'start: how long to wait for the game to announce its runtime before answering. Default 5000, or half as long again as the last boot of this project took when that is more, up to 60000: the server notes how long each game took to announce, so a project that boots slowly is waited for from its second start on without being asked to. What it waits for is the first frame, so everything the game does before drawing one is inside it, including work the args just asked for: a flag that simulates six years of game time before anything is drawn makes the announcement that late, on a project that announces promptly without it. Raise it for such a run rather than reading runtime listening false as a fault. 0 does not wait at all, which is the one to pass for a scene that announces nothing by construction, such as a bench that prints and quits.',
      },
      frames: {
        type: 'integer',
        minimum: 1,
        ops: ['check'],
        description: 'check: frames to run before quitting. Default 3.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        ops: ['check', 'wait'],
        description:
          'check: how long to give the boot before it is called hung. Default 60000. wait: how long to wait for the run to end before answering anyway. Default 600000.',
      },
      andChildren: {
        type: 'boolean',
        ops: ['stop'],
        description:
          "stop: also end what the game started for itself, with OS.create_process or otherwise, such as a bench's workers and whatever those started in turn. Only the processes under the run's, to any depth, that are games of this project are ended: announced as one, or this project's engine run with --path on this project by its command line, which is how a bench whose workers deliberately carry no runtime is reached. They are named under endedChildren, with what identified each under identifiedBy; any other process under the run is left and named under childrenLeft, and childrenUnknown is true when nothing could be listed, with the note saying whether the platform would not or the run has no process to list under. Default false, and the run's process is ended either way.",
      },
    },
    requires: [],
    operations: {
      start: {
        summary: 'run the project until it quits or is stopped',
        requires: ['projectPath'],
      },
      stop: {
        summary:
          'end the run and answer with what it printed last, naming the process ended under endedPid: for a run the editor plays, the number its game announced under, read at the stop rather than remembered, and the operating system hands a freed number to the next process, so it can equal the game before it. A game that started processes of its own keeps them unless andChildren says to end those too',
        requires: [],
      },
      check: {
        summary: 'boot headless, quit after a few frames, and report the verdict',
        requires: ['projectPath'],
      },
      wait: { summary: 'wait for the run to end, then answer as editor_output does', requires: [] },
    },
    defaultOperation: 'start',
  },
  {
    name: 'editor_output',
    description:
      "What the project started by editor_run has printed, as entries with a severity: the errors and warnings the engine reported, each with where it happened, and everything else as info. For a run the editor plays the reports come from the game itself, through the runtime addon, since the editor's debugger relays what a game prints and not what it reports; a played game without the runtime addon answers here with its prints alone. Answers with the counts and the verdict as well as the entries. heldAt is three answers: null for a run this server knows is not held, running or over, an object for one it knows is held at a breakpoint, whether the adapter said so or the runtime did by accepting a connection and never answering, and absent with heldUnknown beside it for a server that connected to the debugger after the stop and has no runtime to ask, since the adapter reports a stop only to the sessions connected when it happened. A run that has quit still answers here, with running false and its exit code, until the next one starts; a run ended by a signal has no exit code, and exitSignal names the signal instead. A run this server started also answers with transcript, the file both its streams are written to: uncapped, written while the run is going, and the thing to read or tail for a long run rather than the engine's own log, which every engine start rotates away. Read the file for output and this answer for state: endedBy says whether gdharness ended the run, and a transcript that has stopped growing is a run between prints rather than a run that is over. running is asked of the operating system whenever there is a process to ask about, which is every run this server started and every editor-played run whose game announced its runtime. For an editor-played run that never announced, there is no process id here and running is the editor's answer, which can lag: one measured elsewhere reported a game as playing for fifteen seconds after its process had been ended from outside. editor_status names that game under runtimes, which does not depend on the editor answering. op: \"editor\" answers about the editor itself instead, which is a different log and the only way anything here can read what an editor printed: its console reaches no plugin, so the addon cannot scrape it, and an editor gdharness opened is asked for a log file as it starts. That covers the whole session from the editor's first line, which is where the output worth reading usually is, since the class cache, the plugins and the language server all say what they have to say before any harness has connected. The answer carries the entries in the order they were printed and, beside them under repeated, each message shape several lines share: how many, what varied in each slot of it and how many different values stood there, the first occurrence, and the ordinary lines above the group, found by walking back past the group rather than by counting lines. An editor somebody opened by hand has no console here and is refused saying so rather than answered empty, because an editor that printed nothing and an editor nobody captured are not the same thing.",
    parameters: {
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info'],
        description: 'The least severe entry to include. Default info, which is everything.',
      },
      sinceLastCall: {
        // A run's log is held open and remembers how far a caller has been shown. The editor's is
        // read off disk on every call, so there is no mark to move and nothing to be since: taking
        // this there would be accepting an argument and ignoring it.
        ops: ['run'],
        type: 'boolean',
        description:
          'Only entries this has not already answered with at this severity. Default false. Measured per severity floor and not across them, so polling for errors leaves the rest of the output for a later read rather than consuming it, and a read with contains is a search over the whole run and consumes nothing.',
      },
      cpu: {
        // About a running process, which an editor's console is not: the question is what it
        // printed, and it is answered from a file whether the editor is still there or not.
        ops: ['run'],
        type: 'boolean',
        description:
          'Also answer with cpuSeconds, the processor time the run has used. Default false, because asking costs a subprocess. Worth it when elapsedMs is climbing and nothing is being printed: processor time standing still is a run that has stopped doing anything, rather than one that is slow.',
      },
      contains: {
        type: 'string',
        description:
          'Only entries mentioning this text, matched against everything the run has printed rather than against the entries this answer would otherwise carry: a line is found however much was printed after it.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description:
          'The most entries to answer with, newest kept. Default 200, and omitted says how many matching entries that left out. A run long enough to pass it needs this raised, not just filtered: filtering narrows what counts as matching, and the newest of those is still all one answer carries.',
      },
      before: {
        ops: ['editor'],
        type: 'integer',
        minimum: 0,
        description:
          'How many lines above a repeated group to carry with it, counting only lines that are not themselves part of a group. Default 3. The line that explains a wall of identical errors is the last ordinary line above it, so this walks past the wall rather than a fixed distance back.',
      },
    },
    operations: {
      run: {
        summary: 'What the game a run is playing has printed, which is everything described above',
        requires: [],
      },
      editor: {
        summary:
          'What the connected editor itself has printed, from its first line, with repeated messages grouped and the ordinary lines above each group carried with it',
        requires: [],
      },
    },
    defaultOperation: 'run',
    requires: [],
  },
  {
    name: 'editor_status',
    description:
      'Whether the editor addon is connected, which Godot answers, whether the editor is playing something, and whether a game with the runtime addon is reachable: runtimeConnected counts the games of the project this server serves, and runtimes lists every game on the machine with ofThisProject saying which is which, since a game of another project is reached only by naming its projectPath. playingInEditor is null when the editor was not asked or did not answer, which is not the same as a no: with no editor connected there is nobody to ask, and an editor that does not serve the question is given a moment and then left. A game can be playing while this is null, so read it as unanswered rather than as nothing playing, and use processActive and runtimes, which come from elsewhere and do not depend on the editor answering. editor.scan says whether the editor is scanning or importing and how many milliseconds ago its last scan finished (finishedMsAgo), or is null when it did not answer: the editor rewrites the class cache just after a scan, and editor_run waits that out before starting a game, saying so under waitedForEditorScanMs. Each game under runtimes is pinged with a short wait, so one held at a breakpoint is listed as unreachable rather than making this call wait out the runtime timeout; for the run this server is reporting on, heldAt says whether that is what it is, with the same three answers editor_output gives. A game the editor played announces the editor under editorPid, and so does whatever that game started for itself; a game some other server started announces none, which is how the two are told apart when both are running from one project. When connected is false, mayYetConnect says whether that is final: the editor dials this server rather than the other way round and backs off between tries, so for the first half-minute after a server starts, false means "not reached yet" as often as it means "no editor". True is worth waiting out; false is an editor that is not there. False beside restartInterrupted is one that an editor_launch restart on a previous server asked to quit, where the launch half never ran because that server was ended in between, usually by the reconnect the restart was taken for; editor_launch open finishes it. listeningSince is when this server took the bridge port, which is what that window is measured from and what a caller wanting its own window should read. An editor this server opened counts for as long as its process lives, however far past that window the import runs, and awaitingLaunchedEditor names its pid so the two reasons for true are told apart. settingsDropped appears here once when the editor this server opened saved project.godot on its way in, which is the same reading editor_launch restart makes in its own answer. A game that has announced itself in a protocol this server does not speak is listed under unreadable rather than left out, with the protocol it speaks and whether the server or the addon is the older half. This happens during an upgrade that moves the runtime protocol, which most do not: installing replaces the addon on disk as soon as the pin moves, while a server that is already running stays on the version it started with, so the two speak different protocols until the server is reconnected. Those games are real and running, but no tool here can reach them until the halves match, so runtimes stays empty and runtimeConnected stays false. An upgrade that leaves the protocol alone opens no such window and this list stays empty through it. addonIsStale is decided by the code of the editor addons rather than their version, so an editor started before an upgrade that left that code alone reports the older addonVersion, is not stale, and addonNote says so: it needs no restart. port is the one the editor bridge is on; when that is not the one this server was configured with, portWanted names the configured one and portNote says why it moved and, when it was the server this one replaced, which pid kept it. A server replacing another of its project that holds the configured port waits for it to stand down and takes the port over, which takes a few seconds; bridgeHandover says so while it waits, and it moves only if that server has not let go within the wait.',
    parameters: {},
    requires: [],
  },
  {
    name: 'editor_rescan',
    description:
      'Makes the running editor scan the project filesystem, so files written outside it are picked up. The scan is a change-detecting walk rather than an unconditional reparse, so a file another engine has already imported reads as settled and the walk does not look inside it: its class_name then stays out of the list the editor resolves against, however many times you scan. Any class in that state is named under unseenByEditor, which is what no check on disk can see, since the declaration and the cache are both correct there and only the editor disagrees. The cure is this call on its own, with no change to the declaring script: measured against a real editor on three platforms, with idle waits of the same length ruled out so the scan is credited rather than the time it takes, and reproduced in a second project against its own reproduction in 203ms. editor_launch restart also does it and costs a window, and project_import refresh_classes does not: it rewrites the cache and does not touch what the editor is holding. A scan writes .godot/global_script_class_cache.cfg from the list the editor is holding, so a class the editor cannot resolve goes out of that file with it. That is not a reason to refuse the scan, because on a class the editor has merely not walked yet the scan is the cure; what the answer does instead is name the loss under cacheLost and rebuild the cache from the files, naming what came back under cacheRestored, so no fresh engine, CI run or clone inherits the short file. An editor that lost classes is still holding the short list, so the note says to restart it before scanning again. The other direction is guarded the same way: a class the editor still holds for a script that was renamed or deleted comes back into the cache at a path that is not there, and the next engine to read it fails on "Could not parse global class" in whichever correct script shares the bare name, so the cache is rebuilt without it and the answer names it under cacheDropped; the editor goes on holding it until it is restarted, and every scan until then ends in that rebuild. A script or shader written outside the editor has no .uid sidecar until something imports it, and the scan writes one beside it, which a project that commits sidecars needs before the commit. Needs the editor connected.',
    parameters: {
      projectPath: PROJECT_PATH,
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description: 'How long to wait for the scan. Default 30000.',
      },
      reloadScript: {
        type: 'string',
        description:
          'A script to recompile in the editor after the scan, for the half a scan does not reach: a script the editor has loaded keeps the copy it built, that copy is refreshed when one of its dependencies changes rather than when it changes itself, and a scan leaves it alone. Measured here, a built copy comes back without a method added to it while script_diagnostics on the same script reads clean in the same window, so the copy the editor built and whatever the analyser resolves types against are not known to be one thing: reload for the copy, and read the diagnostics as a separate answer rather than as this one confirmed. This recompiles into the same object, so the holders that kept the stale copy alive see the new one. The methods it has afterwards come back under reloadedMethods, because a reload that compiled nothing and answered OK is the failure worth catching.',
      },
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
      member: {
        type: 'string',
        ops: ['info'],
        description:
          'info: one member by name, a method, property, signal, enum or constant, with its signature and which class declares it, looked for on the class and every ancestor. The whole of Control is seventy thousand characters; the question "does this engine have it, and what does it take" is this. A name nothing declares is refused with the members whose names contain it.',
      },
    },
    requires: ['projectPath'],
    operations: {
      query: { summary: 'classes matching a filter or category', requires: [] },
      info: {
        summary: 'methods, properties, signals and enums of one class, or one member of it by name',
        requires: ['className'],
      },
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
      pid: RUNNING_PID,
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
          'property: which one to read. find: read this one off every node matched, so a panel of labels is one call rather than one per label. Colons read through what a node holds, "_game:clock:speed", which is where a game keeps what is worth asking about. A number or a key steps into a list or a map, "_game:run:roster:0:traits", which is how the lists a game keeps its state in are walked: a roster, a board, an in-tray. A packed list, such as a PackedStringArray, steps the same way. A negative number counts from the end. A step written as a call, "get_viewport():gui_get_focus_owner()", calls a method that takes no arguments and walks into what it returned, which is how a question only a method answers is read in one call: which control holds the focus in the viewport this one is in. A list or a map answers the calls that read it and take no arguments, "_game:run:board:size()" or "_game:inbox:keys()", and not those that change it, such as clear() or sort(). A step that is not there is named, and says what was there instead.',
      },
      depth: {
        type: 'integer',
        minimum: 0,
        ops: ['tree'],
        description: 'tree: levels to descend, 0 for the node alone. Default 3.',
      },
      includeProperties: {
        type: 'boolean',
        ops: ['tree'],
        description:
          'tree: include every stored property of each node. Default false, and one row of a form answered seventy-six thousand characters with it; properties names the few that are wanted.',
      },
      properties: {
        type: 'array',
        items: { type: 'string' },
        ops: ['tree'],
        description:
          'tree: the properties to read off each node, by name, so the text of every label and button under a panel is one call: a node that has not got one leaves it out. Colons read through what a node holds, as property does for find.',
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
          'find: part of what the node has written on it as drawn, the way the text op reads it, case-insensitively, which is how a button is reached by the word on it rather than by a generated path. Its own text, so a row is found by the label in it, and hidden nodes match. A bare word is a contains; write a glob and it is one, matched against the whole of what the node says, the same as namePattern. A label with a line break is matched with the break in the words, and a backslash followed by n counts as one.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        ops: ['find', 'text'],
        description:
          'find: the most nodes to answer with, default 100. text: the most lines, default 500, with omitted saying how many lines that left behind. A screen whose dialog sits under a long list is a screen read with omitted greater than zero, so raise this or point root at the dialog rather than reading the answer as what is on screen.',
      },
      includeHidden: {
        type: 'boolean',
        ops: ['text', 'find'],
        description:
          'text: read hidden nodes as well, for checking that something is not showing. Default false. find: default true, since a find means the node whether or not it is drawn; false answers with what the player can actually see, which is how a panel that keeps a label for every line and hides the ones that do not is read. A node counts as hidden when anything above it is, and how many matches were left out comes back under hidden.',
      },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        ops: ['metrics'],
        description: 'metrics: which to read. Default all.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description:
          'How long to wait for the answer before answering pending with a requestId, which runtime_invoke op result collects the reply by. Default 10000, or GDHARNESS_RUNTIME_TIMEOUT_MS.',
      },
    },
    requires: [],
    operations: {
      tree: { summary: 'the live scene tree', requires: [] },
      text: {
        summary:
          "every line of text under nodePath, the values in its fields included, in the order somebody reads the screen, leaving out what is hidden and everything under it. Every line reads as drawn: rich text without its tags, text only as far as it has been typed out, a translation rather than its key, an upper-case label in capitals and a secret field as its mask. Tab titles, menu bar titles, list items, a tree's column titles and rows, and an open menu's items read a line each",
        requires: [],
      },
      find: {
        summary:
          'the paths of every node matching className, script, namePattern, group or says, with property read off each, hidden ones included unless includeHidden says otherwise',
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
      'Sets a property or calls a method on a node in the running game. Needs the game running with the runtime addon. A call that takes longer than timeoutMs is not cancelled: the answer is pending: true with a requestId, the call goes on and does everything it was asked, and op result with that requestId collects its reply once it comes.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      nodePath: {
        type: 'string',
        ops: ['set', 'call'],
        description: 'Absolute node path, such as "/root/Main/Player".',
      },
      property: {
        type: 'string',
        ops: ['set'],
        description:
          'set: which one to write. Colons write through what a node holds, "_game:run:day", and a number or a key steps into a list or a map on the way, "_game:run:roster:0:name", a negative number counting from the end, and a step written as a call, "get_viewport():gui_embed_subwindows", walks through what a method taking no arguments returned. The answer reads back off the same holder, and a write that leaves the property as it was, because the engine would not take it, is refused and says what the property still holds.',
      },
      value: {
        ops: ['set'],
        blank: true,
        description:
          'set: the value, fitted to the property\'s type. "" writes an empty string. A property typed as or holding an object takes a path naming one the game holds, the way call\'s args do, and holds that instance. A typed list or map, such as Array[int] or Dictionary[String, int], takes a JSON list or object with each element fitted to its element type, and an element that cannot become one is refused by its index or key.',
      },
      method: {
        type: 'string',
        ops: ['call'],
        description:
          'call: which one to call. Colons call through what a node holds, "_game:run:advance", the same way a property is written through them, a list or a map is stepped into by index or key, "_game:run:roster:0:retire", and a step written as a call walks through what a method taking no arguments returned, "get_viewport():gui_get_focus_owner".',
      },
      args: {
        type: 'array',
        ops: ['call'],
        description:
          'call: the arguments, fitted to the method\'s parameter types. A parameter typed as an object takes a path naming one the game holds and is handed that instance: a colon path read from nodePath, "_game:run:wares:3", or one starting at a node, "/root/Main/Hud" or "/root/Main:_game:run". A path that reaches no object, or an object of another class than the parameter declares, is refused. A parameter typed as a list or map, such as Array[int] or Array[Gear], is built from a JSON list or object element by element, objects named by their paths.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        ops: ['set', 'call'],
        description:
          'set, call: how long to wait for the answer before answering pending with a requestId, which does not stop the call. Default 10000, or GDHARNESS_RUNTIME_TIMEOUT_MS. Give a longer one for a call known to take a while, such as one that plays many turns in one go.',
      },
      requestId: {
        type: 'integer',
        minimum: 1,
        ops: ['result'],
        description: 'result: the requestId a pending answer gave.',
      },
    },
    requires: [],
    operations: {
      set: {
        summary: 'set a property, on a node or on an object it holds',
        requires: ['nodePath', 'property', 'value'],
      },
      call: {
        summary: 'call a method, on a node or on an object it holds, and return its result',
        requires: ['nodePath', 'method'],
      },
      result: {
        summary: 'collect the reply to a set or call whose wait ran out, by the requestId it answered with',
        requires: ['requestId'],
      },
    },
  },
  {
    name: 'runtime_capture',
    description:
      'A picture of the running game: the whole screen or one viewport, as an image. Needs the game running with a window.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      viewportPath: {
        type: 'string',
        ops: ['viewport'],
        description: 'viewport: the Viewport node. Default the root viewport.',
      },
      width: {
        type: 'integer',
        minimum: 1,
        description:
          "Scale the image to this width. Given alone, the height keeps the picture's proportions.",
      },
      height: {
        type: 'integer',
        minimum: 1,
        description:
          "Scale the image to this height. Given alone, the width keeps the picture's proportions.",
      },
      outputPath: {
        type: 'string',
        description:
          'Also save the picture as a PNG at this absolute path, for somebody to open later; the answer says where. Refused unless it ends in .png, its directory exists, it is outside the project, and no file is there already.',
      },
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
      pid: RUNNING_PID,
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
          'action: the InputMap action name. An engine dialog is not answered this way: AcceptDialog reads the Escape key itself and never asks the InputMap, so ui_cancel goes in and the question stays up. Dismiss one with the key op and keycode Escape, or click its button.',
      },
      pressed: {
        type: 'boolean',
        ops: ['action', 'key', 'mouse_click'],
        description:
          'action, key: leave it out and the press is a whole one, down and up a frame apart. true holds it down, false lets go of one being held. mouse_click is one raw event, so it is down unless you say false; a wheel button down is a whole step, since a wheel is never held.',
      },
      strength: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        ops: ['action'],
        description: 'action: 0 to 1. Default 1.',
      },
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
          'text: what to type. A newline is Enter and a tab is Tab, a space is a space, and "" with replace empties the field. choose: the item to take, by what it says as drawn, which in a game with translations is the translation; the key it holds is matched after that.',
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
      shift: { type: 'boolean', ops: ['key'], description: 'key: hold Shift with it. Default false.' },
      ctrl: { type: 'boolean', ops: ['key'], description: 'key: hold Ctrl with it. Default false.' },
      alt: { type: 'boolean', ops: ['key'], description: 'key: hold Alt with it. Default false.' },
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
        description:
          'mouse_motion: the movement the event carries. Left out, it is the distance from where the last injected pointer event put the pointer, and none for the first; that is what a control that drags reads. Give it to send a motion the position does not show.',
      },
      relativeY: {
        type: 'number',
        ops: ['mouse_motion'],
        description: 'mouse_motion: as relativeX.',
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
      key: {
        summary:
          "press a key, or hold it. Not for a menu a click has opened: an OptionButton or PopupMenu pops up as a window of its own that a key sent to the game never reaches, so an arrow moves nothing in it and Enter closes it with nothing chosen. choose is what selects there. The limit is that menu's own navigation, not windows in general: an embedded dialog whose owner reads keys in _input gets them, and a binding catcher up in one takes the key first time",
        requires: ['keycode'],
      },
      text: {
        summary:
          'type a string into the field being edited, a character at a time, and say what it landed in and what it holds afterwards, a secret field as its mask',
        requires: ['text'],
      },
      mouse_click: {
        summary:
          'one mouse button event at a position, carrying the buttons held once it has happened. A drag is a press held with pressed true, motions, and a release with pressed false. A wheel button is a whole step, press and release together as a mouse sends one, and the answer says released: a lone wheel press holds the viewport on the control that took it, so every click after it lands there',
        requires: ['x', 'y'],
      },
      mouse_motion: {
        summary:
          'move the mouse to a position, carrying the distance from where the last injected event put it unless relativeX and relativeY say otherwise, and the buttons held, so a control that drags moves under a run of these between a held mouse_click and its release',
        requires: ['x', 'y'],
      },
    },
  },
  {
    name: 'runtime_wait',
    description:
      'Lets the running game get on with it and answers when something has happened: a number of frames, a signal, a property reaching a value, or words appearing on a screen. Needs the game running with the runtime addon.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      frames: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        ops: ['frames'],
        description: 'frames: how many to let pass, 1 to 600. More than that is refused.',
      },
      nodePath: {
        type: 'string',
        ops: ['signal', 'until'],
        description:
          'signal, until: the node. Needed for a signal and for a property; for says it defaults to /root, the whole screen.',
      },
      signal: { type: 'string', ops: ['signal'], description: 'signal: the signal name.' },
      property: {
        type: 'string',
        ops: ['until'],
        description:
          'until: the property name, or a colon path through what the node holds, "_game:run:day", read the way runtime_inspect property reads one, a step written as a call included. Walked again on every frame, so a holder the game replaces while the wait is on is followed.',
      },
      value: { ops: ['until'], description: "until: the value to wait for, fitted to the property's type." },
      says: {
        type: 'string',
        ops: ['until'],
        description:
          'until: wait for these words to appear anywhere under nodePath, or anywhere in the game when no nodePath is given, instead of for a property, which is how a panel that rebuilds its labels is waited on at all: the labels are named afresh each redraw and the panel is what stays put. Case-insensitive, part of a line, on a node the player can see unless includeHidden says otherwise; a label with a line break is matched with the break in the words, and a backslash followed by n counts as one. Instead of, not as well as: a call carrying this and a property is refused, because they ask about different things and answering one of them silently is how a caller watches a screen believing they are watching a property. It looks every frame while a look is cheap and less often on a screen large enough for a look to cost a real share of a frame, so the game keeps its speed; the answer counts the frames the wait spanned and the looks it took.',
      },
      includeHidden: {
        type: 'boolean',
        ops: ['until'],
        description:
          'until, with says: count words on a hidden node too. Default false, since a wait for words is a wait for them to be shown: a button that exists hidden through a whole animation carries its words the whole time and satisfied the wait at once, and every wait on that screen fell back to counting frames.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: 120000,
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
        // Not required here: a wait for words has a node to default to and a wait for a property
        // does not, and the declaration cannot say which, so the handler asks.
        requires: [],
      },
    },
  },

  // -------------------------------------------------------------------------------------------
  // debug
  // -------------------------------------------------------------------------------------------
  {
    name: 'debug_breakpoint',
    description:
      "Sets or removes a breakpoint through the editor's debug adapter. Needs the editor, not a running game: set them first, then editor_run, and the game stops where you asked. The editor keeps a breakpoint set this way for one play, so every breakpoint this server holds is sent again before each play editor_run starts, and the start answer lists them under breakpoints. The set is also kept in the project, for the server that comes after a reconnect: a breakpoint stays until it is removed here, whichever server set it. Every answer lists the whole set under held, and the breakpoints the user set in the editor's own gutter under setInEditor; setting one here never takes those away, and removing a line here clears it whoever set it. Godot clears every breakpoint in the editor when a debug session opens unless network/debug_adapter/sync_breakpoints is on, which the addon turns on as it loads; an editor running an older addon is said so under breakpointsAtRisk, here and in editor_status.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      line: { type: 'integer', minimum: 1, description: 'One-based line.' },
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
      "Where the debugged game is stopped: the stack trace, what is in scope at a frame with the values, or the debug adapter's console output so far. A stop is reported by the editor's adapter only to the sessions connected when it happened, so a server that connected afterwards, which is every server after a reconnect, is shown a thread and no frames about a game still sitting at its breakpoint. That server asks the runtime instead: a held game accepts a connection and never answers, and the refusal then says held rather than running, and that the stack cannot be read from here. debug_control continue lets it go, and the next stop is one this session is told about, with its stack.",
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
