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

import type { JSONValue, ToolAnnotations } from '@modelcontextprotocol/server';
import { dictionary } from './dictionary.js';
import { ENGINE_FLAGS } from './launch.js';
import type { MCPToolDefinition } from './server-types.js';

type JsonSchema = Readonly<Record<string, JSONValue>>;

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

/**
 * What a call does to the project, the editor, the game or the machine.
 *
 * `read` changes nothing. `additive` adds or starts something and overwrites and removes nothing
 * itself: a new node, a new animation that refuses a name in use, a game run, a click (what the
 * game then does with it is the game's). `destructive` can overwrite, remove or end something that
 * was there before. Where an op can do either, it is
 * destructive: a client asks before a destructive call, and asking once too often costs a click
 * where asking once too rarely costs somebody's work.
 */
type Effect = 'read' | 'additive' | 'destructive';

interface OperationSpec {
  /** One line on what the op does, for the description. */
  readonly summary: string;
  readonly effect: Effect;
  /** Arguments the op needs on top of the tool's own. */
  readonly requires: readonly string[];
}

interface ToolSpecBase {
  readonly name: string;
  /** What a client shows a person in place of the name. */
  readonly title: string;
  readonly description: string;
  /**
   * What the fields of the answer mean, for a tool whose answer needs more than its description has
   * room for. Rendered in the skill's tool reference and on the site, and not in the description a
   * client is sent: Claude Code cuts that at 4096 characters, and the cut fell inside three tools'
   * text, taking editor_run's list of ops with it.
   */
  readonly answer?: string;
  readonly parameters: Readonly<Record<string, Parameter>>;
  /** Arguments every call needs, whatever the op. */
  readonly requires: readonly string[];
  /** The op assumed when none is given; absent means op is required. */
  readonly defaultOperation?: string;
}

/** A tool's effect is its ops' when it has them, so it is declared in one place or the other. */
export type ToolSpec = ToolSpecBase &
  (
    | { readonly operations: Readonly<Record<string, OperationSpec>>; readonly effect?: never }
    | { readonly operations?: never; readonly effect: Effect }
  );

/** The effects of every call [spec] can make. */
export function effectsOf(spec: ToolSpec): Effect[] {
  return spec.operations ? Object.values(spec.operations).map((op) => op.effect) : [spec.effect];
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
  'classes',
  'input_actions',
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
/** How the scene and resource tools answer when no editor serves the project. */
const WITHOUT_AN_EDITOR =
  "Through the editor when one serves the project; with none, a headless engine runs the editor's own tool and the answer says so under writtenBy, or readBy for a read. That engine runs every script of the file, where the editor runs only tool scripts, so what a script changes as the file loads or as a property is set is put back before anything is saved, and a file where that cannot be done, such as a scene whose script does not compile, is refused and nothing is written. Each file the written one refers to is named by its uid, as the editor names it, except a file the project's uid cache has no uid for yet (one made since the project was last scanned), which is named by path and listed under namedByPath with the call that scans it. An editor of the project that is running and has not reached this server is waited for rather than written around.";
/** What a run says about the imports it brought up to date before it started. */
const IMPORTED_FIRST =
  "importedFirst names the files whose import was behind them on disk, such as a picture changed since it was imported or one never imported, which were imported before the run through project_import reimport, so the run reads them as they are now; it is left out when every import was current. notImportedFirst lists, as project_import reimport does, any it could not import, and importNote says that the run reads those as they were. The import gives every script without a .uid sidecar one, as the editor's scan does, writing it beside the script in the project, and uidsWrittenFirst names those scripts. The files inside an addon are counted per addon rather than named, under importedInAddons and uidsWrittenInAddons. importTookMs is how long the import took; it is outside the run's own time limit, so a call that imported can take that much longer than the limit it was given.";
const WHOLE_NUMBERS =
  'A whole number of 2^53 or more, such as a 64-bit seed or a resource uid, is written as its digits, {"_type": "int", "value": "9007199254740993"}, the form a read answers with: a JSON number that large can arrive as a neighbour of the one sent, so sent as a number it is refused.';
const SCRIPT_PATH: JsonSchema = {
  type: 'string',
  description: 'Script file inside the project, such as "scripts/player.gd".',
};
const RESOURCE_FILE = 'File inside the project, such as "sprites/hero.png" or "materials/steel.tres".';
const RESOURCE_PATH: JsonSchema = { type: 'string', description: RESOURCE_FILE };
const NODE_PATH: JsonSchema = {
  type: 'string',
  description: 'Node path from the scene root, such as "Player/Sprite2D". "." is the root.',
};
const PROPERTIES: JsonSchema = {
  type: 'object',
  description: `Properties to set, keyed by Godot property name. Vectors, colours and the like may be written as {"x": 1, "y": 2} or tagged {"_type": "Vector2", "x": 1, "y": 2}, which is the form a read answers with, so a value read off one node can be written straight to another. One carrying a field its type has not, such as a z for a Vector2, is refused naming it. A colour may also be given as its html code, "#ff8000" or "#ff800080". A key may also be a colon path into one of the components of a vector, a colour, a rectangle or a transform, as GDScript names them, so one axis is written alone: "position:x", "modulate:a", "region_rect:size:y"; a component the value does not have is refused, naming the ones it has. A property holding a node takes the path to it from the node being set, such as "../Player". A property holding a Resource takes the res:// path of a file, which a read answers with its class and, when its script declares one, scriptClass, or a resource built into the scene as {"_type": "CircleShape2D", "radius": 8}, its class (an engine class or a script's class_name) beside its properties. A typed list or map of resources or nodes, such as Array[Item], takes each in the same forms, a node by its path; a read answers a resource built into the scene in that form, with what it holds away from the defaults, so it too can be written to another node. script takes the res:// path of a script to attach, one with no class_name included, and is attached before the rest are set, so the properties it declares can be given beside it. Each value is read back once set, and one the engine changed or refused is refused with what it holds. An enum property takes its number or the name of a value: as the script spells it, as the inspector shows it, or for an engine enum as the class's constant, so Add or BLEND_MODE_ADD; a value past an export range, or a number no value of an enum has, is written as given and named under outsideDeclared. A key may reach into a resource built into this one: the property holding it, a slash, then one of its own, so a TileSet's first atlas source takes "sources/0/0:0/0/probability". A resource kept in a file of its own, or built into the scene an instance comes from, is written in that file, or replaced here by one of this file's own. The next element of a list is made by writing to it, as the inspector's Add Element makes it: physics_layer_0/collision_layer on a TileSet with no physics layer makes its first, and "sources/0/0:0/0/physics_layer_0/polygon_0/points" a tile's first collision polygon on that layer. ${WHOLE_NUMBERS}`,
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
  description:
    'add_track: the track to add. remove_track: the track to take out, found by its type, nodePath and property as read answers them; its keyframes are not needed.',
  properties: {
    type: {
      type: 'string',
      enum: [
        'property',
        'method',
        'position_3d',
        'rotation_3d',
        'scale_3d',
        'blend_shape',
        'bezier',
        'audio',
        'animation',
      ],
      description: 'add_track makes property and method tracks; remove_track takes any type read answers.',
    },
    nodePath: { type: 'string', description: 'Target node, relative to the AnimationPlayer root.' },
    property: { type: 'string', description: 'For property tracks: the property to animate.' },
    method: {
      type: 'string',
      description:
        "For method tracks: the method to call. The answer's methodFound says whether the target node has it; a method it lacks is still added, since it may be written next, and until it exists each call the track makes fails.",
    },
    keyframes: {
      type: 'array',
      description: 'add_track: the keys to add, each at its own time.',
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
  required: ['type', 'nodePath'],
  additionalProperties: false,
};

const SCRIPT_MODIFICATIONS: JsonSchema = {
  type: 'array',
  description:
    'Additions to make, in order. A name the script already declares at the top level, or one the call adds twice, refuses the call before anything is written.',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['add_function', 'add_variable', 'add_signal', 'add_constant'] },
      name: { type: 'string' },
      params: { type: 'string', description: 'Functions and signals: the parameter list, "delta: float".' },
      returnType: { type: 'string', description: 'Functions: the return type.' },
      body: {
        type: 'string',
        description:
          'Functions: the body, its lines separated by \\n. Indent shared by every line is taken off and one tab put on, so it can be written indented or not.',
      },
      varType: {
        type: 'string',
        description:
          'Variables and constants: the type annotation; without one, the type the value evaluates to.',
      },
      defaultValue: {
        type: 'string',
        description:
          'Variables: the initial value. Constants: the value, which a constant needs. As written in GDScript.',
      },
      isExport: { type: 'boolean', description: 'Variables: add @export.' },
      exportHint: { type: 'string', description: 'Variables: the export hint, such as "range(0, 100)".' },
      isOnready: { type: 'boolean', description: 'Variables: add @onready.' },
      position: {
        type: 'string',
        enum: ['end', 'after_ready', 'after_init'],
        description:
          'Functions: where to insert. end, the default, is the end of the file; after_ready and after_init are after _ready or _init, above the comments and annotation lines that open the function after it, and the end when nothing follows. A function goes in with two blank lines on each side, as gdformat writes them.',
      },
    },
    required: ['type', 'name'],
    additionalProperties: false,
  },
};

const INPUT_EVENTS: JsonSchema = {
  type: 'array',
  description:
    'The events that trigger the action, each bound to every device, as the editor binds them. A read names device only on an event bound to one device.',
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
      physical: {
        type: 'boolean',
        description:
          'Keys: bind the key by where it sits on the keyboard (physical_keycode) rather than by what it types, as the editor offers, so W stays the key above S on any layout. Default false.',
      },
    },
    required: ['type'],
    additionalProperties: false,
  },
};

const TILESET_SOURCES: JsonSchema = {
  type: 'array',
  description:
    'Atlas sources, one per texture. A wholly transparent cell gets no tile, and the answer lists those cells as leftBlank; a strip at the right or bottom that no whole tile reaches is described in notInAnyTile. A path that already exists is refused, as create_tileset would replace the whole TileSet.',
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
      sourceId: { type: 'number', description: 'TileSet source id, or -1 to erase the cell.' },
      atlasCoords: { ...XY, description: 'The tile in the source. Needed by every cell but an erased one.' },
      alternativeTile: { type: 'number' },
    },
    required: ['coords', 'sourceId'],
    additionalProperties: false,
  },
};

const COLOUR: JsonSchema = {
  type: ['object', 'string'],
  description:
    'set_theme_color: r, g and b from 0 to 1, with a optional and opaque by default, or an html code such as "#ff8000" or "#ff800080".',
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
    title: 'Project info',
    effect: 'read',
    description:
      'What a project is: its name and main scene from project.godot, the Godot that answers, and how many scenes, scripts and assets it holds, other counting every remaining file, leaving out the .import and .uid files the engine writes beside others, the addons gdharness installed and any folder holding a .gdignore, with optional sections on top.',
    parameters: {
      projectPath: PROJECT_PATH,
      include: {
        type: 'array',
        items: { type: 'string', enum: [...PROJECT_INFO_SECTIONS] },
        description:
          "Extra sections: registered autoloads, the classes the project's scripts declare with class_name, each with its script, read from the files, the input actions project.godot holds with their events (an engine ui_ action only when the project rebinds it, as engineAction), addons and whether each is enabled, export presets, the audio bus layout, a health report, or export validation. health and validation compile every script of the project in headless engines and name each that fails with its first error, and each file a scene, resource or script refers to that does not exist.",
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
    title: 'Project settings',
    description:
      "Reads or writes project.godot (settings, autoloads, the main scene, input actions and plugins) and the audio bus layout, default_bus_layout.tres unless audio/buses/default_bus_layout names another. project_info include lists the autoloads, input actions and audio buses as the project holds them. A write with an editor open on the project is handed to the editor, which takes the settings the write changed or names from the file (named under editorAdopted), including a setting the file already held, since the editor can hold another value after the file was put back, or reloads the bus layout, so it answers the new values and does not save the old ones back over them. editorNote is an editor that could not take the write, or one on another release's addon that was not asked, which still holds the old values until editor_launch restart. An enabled plugin's code still loads on the editor's next start. set answers old_value and new_value, with was_new true when project.godot did not set the setting before, and was_default true when what it held was the engine's own default, which old_value then is. add_input_action on an action that exists, one of the engine's ui_ actions included, replaces its events, and its deadzone when one is given, and answers was_new false with what it held under old_events and old_deadzone. A set of the value the setting already holds, in the same type, writes nothing and answers unchanged true and saved false. unset takes a setting's line out of project.godot, the way back from a set of a misspelt name, and answers removed, old_value and default_value, the value that holds now (null for a setting the engine does not declare); on one the file does not set it answers removed false and writes nothing. Every write keeps the sections and keys of project.godot in the order the file had them, so a change moves no other line; the save is the engine's, and like the editor's it writes Godot's header and config/features into a file that lacks them. get answers exists, true for any setting the engine knows, and at_default, true when the value is the engine's own default and so has no line in project.godot. Each setting under prefix carries at_default too, so a family read separates what the project sets from the engine's defaults; it is absent for a setting the engine registers no default for, such as an input action the project added, which only the project can have set.",
    parameters: {
      projectPath: PROJECT_PATH,
      setting: {
        type: 'string',
        ops: ['get', 'set', 'unset'],
        description: 'Setting path, such as "display/window/size/viewport_width".',
      },
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
        ops: ['set'],
        description:
          'The value to write, fitted to the type the setting is registered as, the way scene_node set fits a property. Engine types may be written as their fields, {"x": 1, "y": 2}, or tagged, {"_type": "Vector2", "x": 1, "y": 2}, and infinity as {"_type": "float", "value": "inf"}, the form a read answers with; one carrying a field its type has not is refused naming it, and a colour may also be its html code, "#ff8000". "" writes an empty string. A setting the engine does not declare is written as given, a whole number as an int, and when one in its section is named like it, note names the nearest, as it may be a misspelt one.',
      },
      name: { type: 'string', ops: ['add_autoload', 'remove_autoload'], description: 'Autoload name.' },
      path: {
        type: 'string',
        ops: ['add_autoload'],
        description: 'Autoload script or scene inside the project.',
      },
      enabled: {
        type: 'boolean',
        ops: ['add_autoload', 'set_audio_bus_effect'],
        description:
          'add_autoload: Godot 4 loads every autoload in the list, so false is refused. Use global: false to keep the name out of the global scope, or remove_autoload to stop it loading. set_audio_bus_effect: whether the effect is on. Default true.',
      },
      global: {
        type: 'boolean',
        ops: ['add_autoload'],
        description:
          'Autoloads: make the name a global variable, the * in project.godot and the editor\'s "Global Variable" column. Default true. The autoload loads either way.',
      },
      scenePath: { ...SCENE_PATH, ops: ['set_main_scene'] },
      actionName: {
        type: 'string',
        ops: ['add_input_action', 'remove_input_action'],
        description: 'Input action name, such as "jump".',
      },
      events: { ...INPUT_EVENTS, ops: ['add_input_action'] },
      deadzone: {
        type: 'number',
        ops: ['add_input_action'],
        minimum: 0,
        maximum: 1,
        description:
          'Input actions: analogue deadzone, 0 to 1. Default: the deadzone of the action being rebound, or 0.5 for a new one.',
      },
      pluginName: {
        type: 'string',
        ops: ['enable_plugin', 'disable_plugin'],
        description: 'Folder name under addons/.',
      },
      busName: {
        type: 'string',
        ops: ['add_audio_bus', 'remove_audio_bus', 'rename_audio_bus'],
        description: 'Audio bus name.',
      },
      newBusName: {
        type: 'string',
        ops: ['rename_audio_bus'],
        description:
          'rename_audio_bus: the name the bus takes. Every bus sending to it is sent to the new name (named under resent), and every scene and resource line giving a node the old bus is rewritten (named under rewritten); a script naming the old bus in a string is named under namedInScripts and left as it is.',
      },
      sendTo: {
        type: 'string',
        ops: ['set_audio_bus_send'],
        description:
          'set_audio_bus_send: the name of the bus to send to, one before this bus, as the editor offers them; a later bus, the bus itself or a name the layout does not have is refused.',
      },
      parentBusIndex: {
        type: 'number',
        ops: ['add_audio_bus'],
        description:
          'Audio buses: the bus to send to. Default 0, Master. The new bus goes right after it, so every later bus moves one along, and the answer lists them all.',
      },
      busIndex: {
        type: 'number',
        ops: ['set_audio_bus_effect', 'set_audio_bus_volume', 'set_audio_bus_send'],
        description: 'Audio bus index.',
      },
      effectIndex: {
        type: 'number',
        ops: ['set_audio_bus_effect'],
        description:
          'Slot on the bus for the effect: the effect there is replaced, and one past the last adds one. Any other slot is refused.',
      },
      effectType: {
        type: 'string',
        ops: ['set_audio_bus_effect'],
        description: 'Effect class, such as "AudioEffectReverb".',
      },
      volumeDb: { type: 'number', ops: ['set_audio_bus_volume'], description: 'Bus volume in decibels.' },
    },
    requires: ['projectPath'],
    operations: {
      // Neither is required because either will do, and which one is missing is a better refusal
      // than a list of both: the engine answers that, since it is what reads them.
      get: { effect: 'read', summary: 'read one setting, or every setting under prefix', requires: [] },
      set: { effect: 'destructive', summary: 'write one setting', requires: ['setting', 'value'] },
      unset: {
        effect: 'destructive',
        summary: 'take a setting out of project.godot, so the engine default holds',
        requires: ['setting'],
      },
      add_autoload: {
        effect: 'additive',
        summary: 'register an autoload singleton',
        requires: ['name', 'path'],
      },
      remove_autoload: { effect: 'destructive', summary: 'unregister an autoload', requires: ['name'] },
      set_main_scene: {
        effect: 'destructive',
        summary: 'choose the scene the game starts in',
        requires: ['scenePath'],
      },
      add_input_action: {
        effect: 'destructive',
        summary: 'register an input action and its events, or rebind one that exists',
        requires: ['actionName', 'events'],
      },
      remove_input_action: {
        effect: 'destructive',
        summary: 'remove an input action the project defines',
        requires: ['actionName'],
      },
      enable_plugin: { effect: 'destructive', summary: 'enable an addon', requires: ['pluginName'] },
      disable_plugin: { effect: 'destructive', summary: 'disable an addon', requires: ['pluginName'] },
      add_audio_bus: { effect: 'additive', summary: 'add an audio bus', requires: ['busName'] },
      remove_audio_bus: {
        effect: 'destructive',
        summary: 'remove an audio bus, sending what sent to it on to where it sent',
        requires: ['busName'],
      },
      set_audio_bus_effect: {
        effect: 'destructive',
        summary: 'put an effect in a slot on a bus',
        requires: ['busIndex', 'effectIndex', 'effectType'],
      },
      set_audio_bus_volume: {
        effect: 'destructive',
        summary: 'set a bus volume',
        requires: ['busIndex', 'volumeDb'],
      },
      rename_audio_bus: {
        effect: 'destructive',
        summary: 'rename an audio bus, with the sends and scenes naming it',
        requires: ['busName', 'newBusName'],
      },
      set_audio_bus_send: {
        effect: 'destructive',
        summary: 'choose the bus a bus sends to',
        requires: ['busIndex', 'sendTo'],
      },
    },
  },
  {
    name: 'project_search',
    title: 'Search the project',
    effect: 'read',
    description:
      'Searches text or a regular expression across project files and returns file paths with line numbers. What the engine steps over is not searched: directories spelled with a dot, node_modules, and any directory holding a .gdignore, which not_searched names when the search passed one. A vendored engine or an export directory is therefore absent from the results rather than matching the code you are looking for in a copy nobody runs. The addons gdharness installed are not searched either, since nobody on the project wrote them.',
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
    title: 'Project dependencies',
    effect: 'read',
    description: 'What a resource depends on, or what depends on it.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: RESOURCE_PATH,
      direction: {
        type: 'string',
        enum: ['forward', 'reverse'],
        description:
          "forward: what this resource loads, with cycles reported, a script's dependencies including every script whose class_name it uses, marked by_class with the name, and the script of every autoload it names, marked by_autoload with the autoload's name. summary.total_resources is the file asked about, so 1; total_dependencies counts each file reached, directly or through another, once however many places load it; total_references counts the entries in the tree, and missing names every file referenced that does not exist, with the files referring to it. reverse: every file that refers to it and how, for a file that is gone as well while anything still refers to it, answered with exists: false (a missing file nothing refers to is refused, naming the nearest files), a scene instancing it, a script extending, preloading or loading it, and for a script with a class_name every use of that name, and for an autoload's script every use of the autoload's name, with autoload naming it. Each reference carries a kind: ext_resource, extends, preload, load or path for a reference by path; setting, plugin, export_preset and import for one in project.godot, a plugin.cfg, export_presets.cfg or an import sidecar; class_name for a use of the declared name, the declaration itself being the script asked about; autoload for code naming the autoload. Two kinds are mentions rather than uses: doc is a name inside a ## documentation comment, which renaming would break in the generated docs, and comment is one in ordinary prose, which it would only make stale. summary.in_code is the count with both of those left out, which is the number to read when the question is whether anything still uses this. Default forward.",
      },
      depth: { type: 'number', description: 'forward: how many levels to follow. Default unlimited.' },
      includeBuiltin: {
        type: 'boolean',
        description: "forward: include the engine's own res://. resources. Default false.",
      },
      fileTypes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'reverse: extensions to look in, plus "godot" for project.godot, "cfg" for plugin.cfg and export_presets.cfg, and "import" for import sidecars. Default all of tscn, tres, gd, gdshader, godot, cfg and import, since an autoload, the main scene and a plugin script are named only in the settings files.',
      },
    },
    requires: ['projectPath', 'resourcePath'],
  },
  {
    name: 'project_import',
    title: 'Asset imports',
    description:
      'The import pipeline: what needs importing, how a resource is imported, reimports, UIDs, and the global class list the editor and the engine read.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: { ...RESOURCE_PATH, ops: ['status', 'options', 'set_options', 'uid', 'reimport'] },
      includeUpToDate: {
        type: 'boolean',
        ops: ['status'],
        description: 'status: list resources that are current as well. Default false.',
      },
      options: {
        type: 'object',
        ops: ['set_options'],
        description:
          'set_options: import options keyed as the .import file spells them, {"compress/mode": 1}. A dictionary option whose keys are numbers, a font\'s opentype_features or any option already holding number keys, takes them written as strings of digits, and opentype_features also takes an OpenType tag by its four-letter name: {"opentype_features": {"liga": 0}} turns ligatures off. Both are written as the numbers the engine reads. One already holding the value given is answered under unchanged_options rather than updated_options, and when none changed nothing is written or reimported. changed gives each option written as {was, now}, was null for one the import file did not hold.',
        additionalProperties: true,
      },
      reimport: {
        type: 'boolean',
        ops: ['set_options'],
        description:
          'set_options: reimport afterwards, answered under reimport as project_import reimport answers. Default true.',
      },
      force: {
        type: 'boolean',
        ops: ['reimport'],
        description: 'reimport: reimport even what is current. Default false.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        ops: ['reimport', 'set_options'],
        description:
          'reimport, set_options: how long to wait for the editor to finish reimporting. Default 300000.',
      },
    },
    requires: ['projectPath'],
    operations: {
      status: {
        effect: 'read',
        summary:
          'which resources are outdated or failed, or one resource with resourcePath, each with its reason and a status the summary counts: needs_reimport (out of date, or a file the engine imports that has never been imported), failed, up_to_date, missing_source, or not_imported (a file the engine does not import at all, with why). Judged by content with the checks the editor makes before it reimports: a sidecar changed since its import, as setting an option without a reimport leaves it; a sidecar with no uid or written for another file; an output under .godot/imported that is gone (missing_outputs) or changed; a source whose hash differs from the one its import recorded, or with no record. Beyond the editor, a glTF scene whose import does not depend on an image it names, because it was built before that image was imported (imported_without; a scene whose import runs an import script is not judged on images). failed is an import that failed, which the editor never tries again on its own. Without resourcePath, a sidecar whose source is gone is listed as missing_source',
        requires: [],
      },
      options: { effect: 'read', summary: 'the import options of one resource', requires: ['resourcePath'] },
      set_options: {
        effect: 'destructive',
        summary: 'change import options in the sidecar, then apply them with a reimport of that resource',
        requires: ['resourcePath', 'options'],
      },
      reimport: {
        effect: 'destructive',
        summary:
          "reimport what status says is outdated or failed, one resource with resourcePath, or what is current as well with force. Through the open editor when one serves the project, so it reloads what it holds, waiting for it to finish; otherwise through the engine's own import pass. The editor scans first, since its reimport passes over a file it has not taken in, such as one an installer has just written; what that scan imported is named under importedByTheScan and is not imported again unless force asks. Answered from a second status read: reimported lists what is current now, notReimported what is not, one entry per status and reason with the paths sharing them, and via says which of the two did the work. Either takes in every file that is behind, so a reimport of one resourcePath names under alsoImported the others it imported. When nothing needs reimporting, nothing runs, and the answer has the two lists empty, a note saying so, and no via. A whole-project reimport also answers missingSource, the .import files whose source is not beside them, empty when there are none, whether or not anything needed reimporting; one resourcePath is not a walk of the project and leaves it out. stillImporting is an editor that had not finished within timeoutMs",
        requires: [],
      },
      uid: {
        effect: 'read',
        summary:
          "the UID of one file and where it was read: a script's or shader's .uid file, an imported file's .import, or a scene's or resource's own header",
        requires: ['resourcePath'],
      },
      refresh_uids: {
        effect: 'additive',
        summary:
          'import the project so every script and shader has its .uid sidecar and the uid cache holds the uid of every file, scenes made with no editor among them, which a headless write names a reference by (see namedByPath), and name under uidsCreated the sidecars this made, under uidsCached the res:// files whose uid the cache holds now and did not before, and under stillWithoutUid the ones the engine would not import: it writes no scene and no script, so a project whose sidecars are all present is left untouched',
        requires: [],
      },
      refresh_classes: {
        effect: 'destructive',
        summary:
          'rewrite .godot/global_script_class_cache.cfg from the class_name declarations on disk, and name under unseenByEditor any class the editor open on this project still cannot resolve: rewriting the file does not reach the list a running editor loaded, so "added: []" means the file was already right rather than that nothing is wrong. A class the cache held after the last rebuild and had lost when this one began is named under lostSinceLastRebuild: the editor wrote the file without it in between, on a save or a scan, and will again until restarted',
        requires: [],
      },
    },
  },
  {
    name: 'project_export',
    title: 'Export',
    description:
      "Export presets and exports. add_preset writes a preset to export_presets.cfg with the keys the editor's Project > Export writes for a new one, every platform option left at its default, and makes it the platform's runnable preset when the platform has none. It answers where this engine's export templates belong and whether the preset's platform has them, since an export needs them; list says the same for every preset. An editor open on the project does not see a preset added this way until it restarts. run names, as alsoWritten, what else the export wrote beside its output, such as the .pck a Windows or Linux build cannot start without. Its entries are the errors and warnings the export printed, the newest two hundred distinct ones, one printed more than once carrying times, and errors and warnings count them; exported is true only when this run wrote the output and printed no error.",
    parameters: {
      projectPath: PROJECT_PATH,
      preset: {
        type: 'string',
        ops: ['run', 'add_preset'],
        description: 'Preset name from export_presets.cfg. add_preset: the name of the new one.',
      },
      platform: {
        type: 'string',
        ops: ['add_preset'],
        enum: ['Windows Desktop', 'Linux', 'macOS', 'Android', 'iOS', 'Web'],
        description: 'add_preset: the platform the preset exports for.',
      },
      outputPath: {
        type: 'string',
        ops: ['run', 'add_preset'],
        description:
          'Where the export is written, inside the project. The directory is created if it is not there: Godot\'s command-line exporter refuses a missing one with "The given export path doesn\'t exist", which reads as a wrong path in the preset. add_preset: the path the preset exports to from the editor, optional.',
      },
      debug: { type: 'boolean', ops: ['run'], description: 'run: a debug export. Default false.' },
    },
    requires: ['projectPath'],
    operations: {
      list: { effect: 'read', summary: 'the presets in export_presets.cfg', requires: [] },
      run: { effect: 'destructive', summary: 'export with a preset', requires: ['preset', 'outputPath'] },
      add_preset: {
        effect: 'additive',
        summary: 'add an export preset to export_presets.cfg',
        requires: ['preset', 'platform'],
      },
    },
  },
  {
    name: 'project_test',
    title: 'Run tests',
    effect: 'additive',
    description:
      "Runs the project's gdUnit4 tests headless and answers with every case that did not pass: where it is, and what the assertion said. Each entry under failed carries its first report as message and detail, and, when it has more than one, its reports under reports in the order the case met them: gdUnit4 goes on past a failed assertion, and a case can fail several and then stop on a runtime error, which makes its status error. Identical reports fold into one with times, at most twenty different ones are kept (reportsLeftOut counts the rest), and past about a megabyte the largest cases keep only their first message (failedWithoutDetail). failures counts the cases that failed an assertion and errors the cases that hit an error, so such a case counts in both. Suites where everything passed are counted, not listed, and an engine message keeps the frames above gdUnit4, not the twenty inside it; identical engine messages come back once under engineEntries, with times saying how often they were printed. The class list is rebuilt first, so a suite written a moment ago is found, and the rebuild's answer is under classes, with the classes each addon declares counted under addedInAddons and changedInAddons rather than named: a class it puts back that the cache had after the last rebuild is named under classes.lostSinceLastRebuild, which is the editor writing its shorter list over the file on every save until restarted. What changed on disk since it was imported is then imported before any suite runs, and named under importedFirst. On Windows and Linux the run gets a user:// of its own, away from a player's saves; on macOS the engine reads user:// off HOME, so it writes where the player keeps theirs, and savesNote says so. A run that found nothing to run is never called a pass, and names the path it looked in. A script that does not load stops gdUnit4 before any suite runs: its errors come back in full under scriptErrors, and the scripts that failed only because one they depend on did are listed by path under failedThroughDependency. When they failed on a class whose own script has a parser error, which gdUnit4 never names, that script is checked by the engine and its error comes first under scriptErrors, with the class it declares under declares, and the errors a script has only because that class did not resolve, which the engine reads as Variant, are kept apart under followFromUnresolved. An autoload that does not compile stops the run at once, its errors listed the same way. A client sending a progress token is told as each suite finishes, and at least every twenty seconds. A run that ends without a report, at its timeout or otherwise, names the suites it finished under suitesFinished, the failing ones with their failed cases under suitesFailing, and the one it was in under suiteRunning. When a client cuts a run off, that is kept in the project and the next project_test there carries it under previousRunCut. A run where nothing failed but orphan nodes were left comes back under warnings, with the count per suite: gdUnit4 decides its verdict on those and keeps them out of its report, so they are read off what it printed. A run whose every case passed is still not called passed when it printed a script error that no case failed on: gdUnit4 fails a case on the script errors its logger sees, and it cannot see a stack overflow, so the cases pass on whatever the faulted calls returned. Those errors come back under uncaughtScriptErrors, and under engineEntries by index with detailUnder rather than with their backtrace a second time; a backtrace that repeats, as a recursion's does, has each repeated frame or cycle of frames written once with the frames it covers and how many times. One raised inside assert_error(...).is_runtime_error is the test's own and is not listed there, and none are when the project turns off gdUnit4's report/godot/script_error setting; a suite declares them all the same. Needs gdUnit4 under addons/gdUnit4.",
    answer:
      "passed is the verdict to read. exitCode is the engine's own exit, gdUnit4's code for what it saw, and is 0 beside passed false when the run is failed for something gdUnit4 does not judge, such as an engine error no suite declared. time is gdUnit4's own sum of the seconds its cases took, from its report. tookMs is the whole call in milliseconds, from the class rebuild to the engine's exit, which is what a caller waits for. The run is judged as gdharness test judges it: undeclaredErrors names each engine error that no suite declared in its GDHARNESS_EXPECTED_ERRORS constant, with the suite and the case that printed it, and declaredNotPrinted each declared error its case did not print. A declared text must be the whole error after ERROR: and its space, so a longer error its case printed holding the text is named under printedInstead. Either fails the run, and each suite holding one is listed with its count. engineErrors counts every engine error the run printed but those a suite declared. " +
      IMPORTED_FIRST,
    parameters: {
      projectPath: PROJECT_PATH,
      path: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'A test directory or suite file inside the project, or a list of them, all run on one engine: a named set of suites boots once rather than once per suite. An entry given twice, or a suite inside a directory also listed, runs once. An entry that is not there is left out and named under missing, the rest run, and such a run is never called passed; when no entry is there the run is refused before the engine starts, naming each one. Default tests and test, those the project has, which is where gdharness test looks.',
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Suites or cases to leave out, as "suite_name" or "suite_name:test_name". A bare test name is read as a suite name and leaves out nothing; an entry that named a case which ran all the same comes back under ignoreNotApplied with the form that would have left it out. Every case the list left out comes back under ignored as suite_name:test_name, so a run called passed says what it did not run, and an entry naming no suite or case under path comes back under ignoreUnmatched.',
      },
      tests: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Run only these cases of the suites under path, each "test_name" or "suite_name:test_name", the suite by its file name without .gd or its res:// path. Only the suites holding them run, with their other cases left out. A name no suite there declares as a top-level func is refused before the engine starts, with the nearest names; a case asked for that gdUnit4 did not report comes back under testsNotRun, and the run is not called passed.',
      },
      engineArgs: {
        type: 'array',
        items: { type: 'string' },
        description: `The engine's own flags for the run, such as ["--verbose"], a value going as the next entry. Only those that change what the engine logs, draws for debugging, checks on the GPU, which renderer draws, how it times frames or whether it builds the tree a screen reader reads: ${Object.keys(ENGINE_FLAGS).join(', ')}. Any other is refused. With --verbose, engineEntries holds the ordinary lines the run printed as well, which is where the engine names the instances leaked and the resources still in use at exit.`,
      },
      failFast: {
        type: 'boolean',
        description:
          'Stop each suite at its first failing case. Default false: every case runs. With it on, the counts are of what ran, notRun says how many cases were left, and fixing what is named and running again finds the next one, which looks like a flaky tier and is not.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description:
          'How long the run may take before it is killed, counted from the engine starting it: the class rebuild and any import before it are outside the limit, and tookMs counts them. Default 600000. A run killed at the limit answers timedOut and silentForMs, how long it had printed nothing; it is called hung only when that was half the limit, or thirty seconds of a longer one, and otherwise it was still running and wants a longer timeoutMs or a narrower path, unless it ended repeating one script error, which the verdict names instead. A run whose autoload did not compile is stopped as soon as the engine says so, and names the script that did not under scriptErrors.',
      },
      printed: {
        type: 'string',
        description:
          'Also answer with every line the run printed that contains this, under printed, whether it passed or not: a suite that prints a marker beside the numbers it measured carries them back without failing an assertion to do it. Matched case aside, in the text and the backtrace, at most 200 lines, the newest kept; printedOmitted counts the rest.',
      },
    },
    requires: ['projectPath'],
  },

  // -------------------------------------------------------------------------------------------
  // scene
  // -------------------------------------------------------------------------------------------
  {
    name: 'scene_create',
    title: 'Create or save a scene',
    description: `Creates a scene file where none is, saves one, or saves a copy under a new path. create makes a folder the path names that is not there, and names it under madeFolder; its answer names the root's type and name, and under script the script the root carries. A save of a scene open in the editor saves the editor's copy, unsaved changes included. ${WITHOUT_AN_EDITOR}`,
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      rootNodeType: {
        type: 'string',
        ops: ['create'],
        description:
          'create: the root node class, an engine class or a class_name a project script declares, which the root is made as with that script attached. Default Node.',
      },
      rootNodeName: {
        type: 'string',
        ops: ['create'],
        description:
          "create: the root node name. Default the class name, as the editor names a new root, or with inherits the name of that scene's root.",
      },
      inherits: {
        type: 'string',
        ops: ['create'],
        description:
          "create: a scene for the new one to inherit, such as \"parts/crate.tscn\", as the editor's New Inherited Scene makes one. Its root is an instance of that scene, so changes there reach it, and scene_node set gives the nodes it inherits values of this scene's own. The root's class is that scene's, so rootNodeType is not given with it; the answer names it under rootNodeType and the scene under inherits.",
      },
      script: { type: 'string', ops: ['create'], description: 'create: a script to attach to the root.' },
      newPath: { type: 'string', ops: ['save_as'], description: 'save_as: where the copy goes.' },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      create: { effect: 'destructive', summary: 'a new scene with one root node', requires: [] },
      save: {
        effect: 'destructive',
        summary:
          'save the scene as it is in the editor, or as the file loads when the editor does not have it open; from says which',
        requires: [],
      },
      save_as: { effect: 'destructive', summary: 'save a copy under newPath', requires: ['newPath'] },
    },
    defaultOperation: 'create',
  },
  {
    name: 'scene_tree',
    title: 'Scene tree',
    effect: 'read',
    description:
      'The nodes of a scene file: names, classes and hierarchy, with properties when asked. A node that instances another scene names that file under instanceOf, and the nodes listed under it come from that file rather than this one; its editableChildren says whether this scene, or a scene it inherits, keeps values of its own for them (scene_node set editableChildren). The root of a scene inheriting another names the scene it inherits under inherits, and every node that scene or one further down makes names its file under inheritedFrom; this file holds only the values it changes on them. A node in any group answers groups, sorted, from this file and every scene it comes from. Needs no editor: one serving the project answers and says whether it holds unsaved changes to the scene, and with none a headless engine reads the file without making its nodes, so no script of theirs runs (autoloads still start once it has answered, as in every headless call). For the nodes of a game that is running, runtime_inspect tree.',
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      depth: {
        type: 'number',
        description:
          'How many levels to descend. Default: all. A node at the last level that has children of its own lists none and says how many under childrenNotListed.',
      },
      includeProperties: { type: 'boolean', description: "Include each node's properties. Default false." },
    },
    requires: ['projectPath', 'scenePath'],
  },
  {
    name: 'scene_node',
    title: 'Scene nodes',
    description: `One node in a scene file: add, read, set, duplicate, reparent or delete it, paint TileMap cells, or bake a navigation region. Any ClassDB node type or script class can be added, so a NavigationRegion2D, an AnimationTree or a Camera3D is an add with that nodeType and its properties, and another scene is instanced by an add with instancePath. A set with properties {"name": "Boss"} renames a node, and answers nodePath as its new path. A rename or a reparent carries the node paths naming the node, as the editor's rename does: NodePath values on nodes (in arrays, dictionaries, built-in resources, %unique paths) and the tracks its players' animations hold, saving a library kept in a .tres of its own, and answers each rewrite under retargeted and each path it left under notRetargeted. The move is followed into every other .tscn that instances or inherits this scene at any depth: the editable children, values, added nodes and connections named by the old path are rewritten, since Godot finds a moved node's values by unique_id but editable children only by path and drops the values kept below them on the next save, and that scene's node paths and tracks are carried as above. A delete rewrites no path, and answers under stillNaming what named the deleted node and now names nothing. A property holding a Resource takes the res:// path of one, so a texture, a material or a theme is a set like any other. A write is refused while the editor holds unsaved changes to the scene. A node this scene inherits takes values of this scene's own, and so does a node inside an instance of another scene once that instance's editableChildren is true; neither can be moved, renamed, copied or deleted, since the other scene makes it again on load. ${WITHOUT_AN_EDITOR}`,
    answer:
      "get answers nodeType, the node's engine class, with scriptClass when its script declares a class_name; nodePath, its path from the root however it was named; setHere, the properties this scene's own file sets on it; and valuesFrom, the scene every other value comes from, when another scene makes the node. A set that gives a property the value the node has without it (what the scene it comes from gives, or its default) leaves it out of the file, as the editor does, and answers it under notStored, with notStoredNote saying what it follows now. retargeted lists each path a rename or a reparent rewrote, as {scenePath, nodePath, property or animation and track, from, to}, and notRetargeted each it left, with a reason: a track kept in another scene or an imported file, or a value another scene gives that the move left naming nothing. followed names the other scenes a move rewrote, and notFollowed any left as they were, with why. stillNaming lists each node path and track, here and in the scenes instancing or inheriting this one, that named a deleted node, and deletedWithIt each node of this scene's own that went with it, the nodes inside an instance going with the instance. groups lists, sorted, every group a node is in, on a get, an add that gave addGroups and every set that changes them; get adds groupsHere, the groups this file puts it in, when another scene puts it in others, and layers, each layer mask it answers (collision_layer, collision_mask, visibility_layer) as the layers it holds, {layer, name} with the name project.godot gives the layer. Each of these lists is answered only when it names anything. add and set answer each property given under properties as the node holds it once written; alsoChanged gives the other properties the engine changed in step with a set, as a Control's offsets with its size, and those a reparent changed to keep the node where it is drawn, as {was, now}; namesNoNode, each node path written naming no node. get adds placement, a Node3D's position, rotation_degrees and scale from its transform.",
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      nodePath: {
        ...NODE_PATH,
        ops: ['get', 'set', 'duplicate', 'reparent', 'delete', 'set_tilemap_cells', 'bake_navigation'],
      },
      parentNodePath: {
        type: 'string',
        ops: ['add', 'duplicate'],
        description: 'add: where the node goes. Default the root. duplicate: where the copy goes.',
      },
      nodeType: {
        type: 'string',
        ops: ['add'],
        description:
          'add: the node class, such as "CharacterBody2D", or a class_name a project script declares, which the node is made as with that script attached. Give this or instancePath. The answer\'s nodeType is the class of the node made, for an instance the class of its scene\'s root.',
      },
      instancePath: {
        type: 'string',
        ops: ['add'],
        description:
          'add: a scene to instance as the new node instead of a class, such as "ui/panel.tscn". It is saved as an instance of that file, the way the editor\'s Instantiate Child Scene saves one, so changes to that scene reach it; properties set its root. A scene that is the target or instances it is refused.',
      },
      nodeName: { type: 'string', ops: ['add'], description: "add: the new node's name." },
      properties: { ...PROPERTIES, ops: ['add', 'set'] },
      editableChildren: {
        type: 'boolean',
        ops: ['set'],
        description:
          "set: on an instance of another scene, whether its children are editable here, as the editor's Editable Children makes them. True lets scene_node set give the nodes inside that instance values of this scene's own, which no other instance shares. An instance nested inside another takes it once the one around it has editable children. False drops every value this scene keeps for them, and every node it added below one of them. The answer names the nodes whose values went under droppedValues (they stay, with the instance's own values) and the added nodes that went under droppedNodes; a node added straight under the instance stays. The answer says editableChildren as the file now holds it.",
      },
      addGroups: {
        type: 'array',
        items: { type: 'string' },
        ops: ['add', 'set'],
        description:
          "add and set: groups to put the node in, saved in this scene's file as the editor's Groups dock saves them. One it is in already is kept as it is.",
      },
      removeGroups: {
        type: 'array',
        items: { type: 'string' },
        ops: ['set'],
        description:
          'set: groups to take the node out of. One it is not in is refused, and so is one another scene puts it in (the scene that makes it, instances it or is inherited here), which only that scene can take it out of.',
      },
      newName: { type: 'string', ops: ['duplicate'], description: "duplicate: the copy's name." },
      newParentPath: {
        type: 'string',
        ops: ['reparent'],
        description:
          "reparent: the new parent, which may be the one it has, to move it among its siblings. In the scenes the move is followed into, the parent_id_path, from_uid_path and to_uid_path saved beside each rewritten path are dropped, since their ids ran through the old parent; the node's own unique_id is kept, and the next save writes the dropped ones again.",
      },
      keepGlobalTransform: {
        type: 'boolean',
        ops: ['reparent'],
        description:
          "reparent: whether the node stays where it is drawn, its transform worked out again under the new parent, as the editor's reparent and Node.reparent keep it. A Control keeps its position only. A Node3D kept in place under a parent scaled unevenly across its turn ends up sheared, which no position, rotation and scale describe, and the answer then carries its transform under alsoChanged and says so under sheared. Default true; false keeps its own transform, so it moves with the new parent.",
      },
      index: {
        type: 'integer',
        minimum: 0,
        ops: ['add', 'duplicate', 'reparent'],
        description:
          "add, duplicate and reparent: where the node goes among the parent's children, 0 for first. Default last, except for a copy under the original's own parent, which goes right after it. Child order is draw order in a CanvasItem and layout order in a Container.",
      },
      includeDefaults: {
        type: 'boolean',
        ops: ['get'],
        description: 'get: include properties still at their default. Default false.',
      },
      layer: {
        type: 'number',
        ops: ['set_tilemap_cells'],
        description: 'set_tilemap_cells: the layer of a TileMap. Default 0. A TileMapLayer is one layer.',
      },
      cells: { ...TILEMAP_CELLS, ops: ['set_tilemap_cells'] },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      add: {
        effect: 'additive',
        summary: 'add a node of any class, or an instance of a scene',
        requires: ['nodeName'],
      },
      get: {
        effect: 'read',
        summary:
          "read a node's class, path, properties and where its values come from, and a TileMapLayer's or TileMap's cells as set_tilemap_cells takes them, the first 1000 with cellCount for all. An instance of another scene also answers instanceOf and editableChildren, as scene_tree does",
        requires: ['nodePath'],
      },
      set: {
        effect: 'destructive',
        summary:
          'set properties on a node, make the children of an instance editable, or put it in groups or take it out of them; give any of them together',
        requires: ['nodePath'],
      },
      duplicate: {
        effect: 'additive',
        summary:
          "copy a node and its children, right after it or under parentNodePath, answering the copy's newNodePath, parentNodePath and index",
        requires: ['nodePath', 'newName'],
      },
      reparent: {
        effect: 'destructive',
        summary:
          'move a node under another parent, keeping where it is drawn, or to another place among its siblings',
        requires: ['nodePath', 'newParentPath'],
      },
      delete: { effect: 'destructive', summary: 'remove a node and its children', requires: ['nodePath'] },
      set_tilemap_cells: {
        effect: 'destructive',
        summary: 'place tiles in a TileMapLayer or TileMap',
        requires: ['nodePath', 'cells'],
      },
      bake_navigation: {
        effect: 'destructive',
        summary:
          "bake a NavigationRegion2D or NavigationRegion3D from the geometry under it, as the editor's Bake button does, into the scene or its polygon's own file (savedTo); one holding none is given one (made). Answers polygons and vertices, with a note saying why when none came out, and meshesNote on the engine's mesh warning. It reads a script-free copy of the scene",
        requires: ['nodePath'],
      },
    },
  },
  {
    name: 'scene_signal',
    title: 'Scene signals',
    description: `Signal connections in a scene file. Each connection answers with its flags as the number and as flagNames; persist is on every connection, since a scene saves no other kind. A connect of a pair already connected says alreadyConnected, with flagsBefore when it changed the flags. A connect to a method the target does not have is still written, as the editor's own dialog allows, since the method may be written next; methodFound false says so, and until the method exists the signal fails each time it is emitted. One whose method cannot take what the signal passes, with its binds and unbinds (too few or too many arguments, an object where the method takes a value or the reverse, or an engine class unrelated to the one it takes), is written too, and answers argumentsFit false with misfit saying why; list gives each connection its methodFound, and misfit when it has one. list marks editable false on a connection an instanced scene makes inside itself, which only that scene can change. ${WITHOUT_AN_EDITOR}`,
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      sourceNodePath: { type: 'string', ops: ['connect', 'disconnect'], description: 'The node that emits.' },
      signalName: {
        type: 'string',
        ops: ['connect', 'disconnect'],
        description: 'The signal it emits, such as "pressed".',
      },
      targetNodePath: {
        type: 'string',
        ops: ['connect', 'disconnect'],
        description: 'The node whose method is called.',
      },
      methodName: {
        type: 'string',
        ops: ['connect', 'disconnect'],
        description: 'The method on that node, called when it emits.',
      },
      flags: {
        type: 'number',
        ops: ['connect'],
        description: 'connect: Object.ConnectFlags, such as 1 for deferred.',
      },
      nodePath: { type: 'string', ops: ['list'], description: 'list: only connections involving this node.' },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      connect: {
        effect: 'additive',
        summary: 'connect a signal to a method',
        requires: ['sourceNodePath', 'signalName', 'targetNodePath', 'methodName'],
      },
      disconnect: {
        effect: 'destructive',
        summary: 'remove a connection',
        requires: ['sourceNodePath', 'signalName', 'targetNodePath', 'methodName'],
      },
      list: { effect: 'read', summary: 'every connection in the scene', requires: [] },
    },
  },
  {
    name: 'scene_animation',
    title: 'Animations',
    description:
      "Animations in an AnimationPlayer and states in an AnimationTree state machine. The player and the tree are nodes, so scene_node add puts one in the scene first. read answers with every track of an animation in the shape add_track takes, so a track read off one animation can be added to another. add_track on a path the animation already has a track of that type for adds the keys to that track, as the editor keys a property it already animates, answering existingTrack true and keysAdded beside keys, the track's count; a key at a time that track already has a key at is refused. A key past the animation's end, where it never plays, is written and named under pastLength. remove_track takes out every track of the type, nodePath and property given, with its keys. remove clears the player's autoplay when it named the animation and names under statesPlayingNothing the states that played it, which stay in their trees playing nothing until remove_state takes them out. Every state machine has Start and End, which cannot be added or removed; a transition from Start sets the state it begins in. read and read_states need no editor: one serving the project answers and says whether it holds unsaved changes to the scene, and with none a headless engine reads the file without running the scene's scripts. The ops that write go through the editor when one serves the project; with none, a headless engine runs the editor's own tool and the answer says so under writtenBy. That engine runs every script of the file, where the editor runs only tool scripts, so what a script changes as the file loads is put back before anything is saved, and a file where that cannot be done, such as a scene whose script does not compile, is refused and nothing is written. An editor of the project that is running and has not reached this server is waited for rather than written around.",
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      playerNodePath: {
        type: 'string',
        ops: ['read', 'create', 'add_track', 'remove_track', 'set', 'rename', 'remove'],
        description: 'The AnimationPlayer node.',
      },
      animationName: {
        type: 'string',
        ops: ['read', 'create', 'add_track', 'remove_track', 'set', 'rename', 'remove', 'add_state'],
        description:
          'The animation in the player. read: the one to answer with whole, its tracks a list; without it, read lists them, each with the number of its tracks under tracks. add_state: the one that state plays. One the player does not have yet is written all the same, answering animationFound false and why under animationMissing.',
      },
      newName: {
        type: 'string',
        ops: ['rename'],
        description:
          "rename: the animation's new name in the library it is in. The player's autoplay and every state of the scene's AnimationTrees that plays it are renamed with it, named under autoplay and statesFollowed.",
      },
      length: {
        type: 'number',
        ops: ['create', 'set'],
        description:
          'create and set: seconds, more than 0. create: default 1. set: a key past the new end is kept, as the editor keeps it, and named under pastLength, since it never plays.',
      },
      loopMode: {
        type: 'string',
        ops: ['create', 'set'],
        enum: ['none', 'linear', 'pingpong'],
        description: 'create: default none.',
      },
      step: {
        type: 'number',
        ops: ['create', 'set'],
        description: 'create and set: keyframe snap in seconds, 0 or more. create: default 0.1.',
      },
      track: { ...ANIMATION_TRACK, ops: ['add_track', 'remove_track'] },
      animTreePath: {
        type: 'string',
        ops: ['read_states', 'add_state', 'remove_state', 'connect_states', 'disconnect_states'],
        description: 'The AnimationTree node.',
      },
      stateName: {
        type: 'string',
        ops: ['add_state', 'remove_state'],
        description:
          "add_state: the state to add. It goes right of the rightmost state in the editor's graph, answered under position. remove_state: the state to take out, with every transition leaving or reaching it, named under transitionsRemoved.",
      },
      stateMachinePath: {
        type: 'string',
        ops: ['read_states', 'add_state', 'remove_state', 'connect_states', 'disconnect_states'],
        description: 'A nested state machine, by the names of the states that lead to it. Default the root.',
      },
      fromState: {
        type: 'string',
        ops: ['connect_states', 'disconnect_states'],
        description: 'connect_states and disconnect_states: the state the transition leaves.',
      },
      toState: {
        type: 'string',
        ops: ['connect_states', 'disconnect_states'],
        description: 'connect_states and disconnect_states: the state it arrives at.',
      },
      transitionType: {
        type: 'string',
        ops: ['connect_states'],
        enum: ['immediate', 'sync', 'at_end'],
        description: 'connect_states: default immediate.',
      },
      advanceCondition: {
        type: 'string',
        ops: ['connect_states'],
        description: 'connect_states: the condition parameter that advances.',
      },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      read: {
        effect: 'read',
        summary: 'the animations of an AnimationPlayer, or one with its tracks',
        requires: ['playerNodePath'],
      },
      read_states: {
        effect: 'read',
        summary: 'the states and transitions of an AnimationTree state machine',
        requires: ['animTreePath'],
      },
      create: {
        effect: 'additive',
        summary: 'a new animation in an AnimationPlayer',
        requires: ['playerNodePath', 'animationName'],
      },
      add_track: {
        effect: 'additive',
        summary: 'a property or method track with keyframes',
        requires: ['playerNodePath', 'animationName', 'track'],
      },
      remove_track: {
        effect: 'destructive',
        summary: 'a track and its keys from an animation',
        requires: ['playerNodePath', 'animationName', 'track'],
      },
      set: {
        effect: 'destructive',
        summary: "an animation's length, loop mode or step",
        requires: ['playerNodePath', 'animationName'],
      },
      rename: {
        effect: 'destructive',
        summary: 'an animation, with what plays it',
        requires: ['playerNodePath', 'animationName', 'newName'],
      },
      remove: {
        effect: 'destructive',
        summary: 'an animation from its player',
        requires: ['playerNodePath', 'animationName'],
      },
      add_state: {
        effect: 'additive',
        summary: 'a state playing an animation, in an AnimationTree',
        requires: ['animTreePath', 'stateName', 'animationName'],
      },
      remove_state: {
        effect: 'destructive',
        summary: 'a state and its transitions from an AnimationTree',
        requires: ['animTreePath', 'stateName'],
      },
      connect_states: {
        effect: 'additive',
        summary: 'a transition between two states',
        requires: ['animTreePath', 'fromState', 'toState'],
      },
      disconnect_states: {
        effect: 'destructive',
        summary: 'the transition from one state to another',
        requires: ['animTreePath', 'fromState', 'toState'],
      },
    },
  },

  // -------------------------------------------------------------------------------------------
  // script
  // -------------------------------------------------------------------------------------------
  {
    name: 'script_edit',
    title: 'Edit scripts',
    description:
      "Creates a GDScript file, or adds functions, variables and signals to one. Every declaration written carries a type. Both load what they wrote under the project's own warning settings and answer with parses; the engine's reasons for a refusal come back under engine_messages. create answers with the extends and class_name the engine read, and a script declaring a class_name is put in the project's class list, with registered saying whether it is there; a class_name another script or an engine class holds, or an extends naming no class, is refused with nothing written. modify makes every addition or none, refuses with nothing changed additions that would stop a script that parses from parsing, giving the engine's reasons, and answers with the line each one is on in the file written; with an editor serving the project it reloads the script there too, so the editor's answers read what was written, and editorReloaded says so (editorNote when it could not, or when a script tab holds unsaved edits that saving would write over the file). rename renames a class or a member wherever the engine uses it and writes every file or none. A new name already taken is refused with nothing written, a member's included when a class inheriting it already uses the name in code, as a local or a parameter. changed lists each file with its changed lines as they now read, and leftAlone lists every other whole-word occurrence of the old name with what the tokenizer makes of it (code, string, comment, doc, nodePath, scene, text, or ignored for a file under a .gdignore directory, which is never changed) and, where it is not plain, why: a string that is the old name whole, such as find_children's type or a call's method name, which nothing renames or compiles and which is listed first; a node named like the class; a call on a value whose type the analyser could not tell. A member rename answers under languageServer how many requests it made and how long they took. A comment, documentation line, string or text file line with nothing more to say is given under leftAloneInProse by file, kind and line instead, and code that is certainly another symbol of the same name, a bare name in a file where nothing inherits the member or one the language server resolved to another declaration, under leftAloneOtherSymbols as each why with the files and lines it covers. summary.leftAlone counts each of the three lists beside the total. When those two grouped lists run past 300 lines, they are written with each line's text to a file under the project's .godot directory instead, of which the newest ten are kept, and leftAloneDetail names the file and counts what is in it. Read both before calling the rename done; nothing in them was changed. Afterwards an open editor scans the changed files and reloads every changed script, which is also the compile check, and its answer comes back under editor; with no editor the class cache is rebuilt and the changed scripts are compiled in a fresh engine, under classCache and compiled. written is true once the files are written, and ok is false when what came after the write failed: the files are left changed, and note says so.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      className: {
        type: 'string',
        ops: ['create'],
        description: 'create: a class_name for the script. Not with content.',
      },
      extends: {
        type: 'string',
        ops: ['create'],
        description:
          'create: the base class. Default the class the template is written for, or Node with no template. Not with content.',
      },
      content: {
        type: 'string',
        ops: ['create'],
        description:
          'create: the whole file, written as given, instead of a template, className and extends.',
      },
      template: {
        type: 'string',
        enum: ['singleton', 'state_machine', 'component', 'resource'],
        ops: ['create'],
        description:
          'create: a starting shape. resource is written for a Resource and the others for a Node; an extends outside that class is refused.',
      },
      modifications: { ...SCRIPT_MODIFICATIONS, ops: ['modify'] },
      symbol: {
        type: 'string',
        ops: ['rename'],
        description:
          "rename: what to rename, declared by the script at scriptPath: its class_name, or a method, variable, constant, signal, enum, enum value or inner class at its top level. A class_name is renamed from the files and needs no editor: every bare use in code, the declaration, doc links such as [Told] and [method Told.say], and the script_class a .tres records. A script that declares something of its own by the old name, and a use after a dot, are left alone, since which of those mean the class cannot be told from the text. Everything else, an inner class and an enum value included, is renamed from what the editor's language server resolves to it, so it needs the editor open on this project; a method is renamed together with every override of it in the classes inheriting it, and from the topmost class declaring it when scriptPath's is itself an override. Doc links naming the member through any class inheriting it are renamed too, and so are a scene's or resource's saved value of a variable on a node or resource whose script inherits it, and a connection naming the signal on its emitter or the method on its receiver. A name the engine itself declares on the native base, such as _ready, is refused, as is a new name already taken: by a class, an autoload, an identifier in code, a native class or built-in type, or a member anywhere in the class's chain.",
      },
      newName: { type: 'string', ops: ['rename'], description: 'rename: the new name.' },
      newScriptPath: {
        type: 'string',
        ops: ['rename'],
        description:
          'rename: also move the declaring script here, with its .uid beside it, rewriting every string that names it by path in the same style it was written (res:// or relative), and the relative paths in the moved script itself.',
      },
      preview: {
        type: 'boolean',
        ops: ['rename'],
        description:
          'rename: answer with what would change and what would be left alone, and write nothing. Default false.',
      },
    },
    requires: ['projectPath', 'scriptPath'],
    operations: {
      create: { effect: 'additive', summary: 'a new script file', requires: [] },
      modify: { effect: 'additive', summary: 'add to an existing script', requires: ['modifications'] },
      rename: {
        effect: 'destructive',
        summary: 'rename a class or a member wherever the engine uses it, across the project',
        requires: ['symbol', 'newName'],
      },
    },
  },
  {
    name: 'script_info',
    title: 'Script info',
    description:
      "What a script contains: its structure from the file, or symbols, completions and hover text from the editor's language server. It reads .gd files only, and answers what a script uses rather than what uses it: project_search finds where a class, a member or a signal is named.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      includeInherited: {
        type: 'boolean',
        ops: ['structure'],
        description:
          "structure: also list what the script inherits, walking extends through the project's other scripts. Each such member carries inherited_from, the file declaring it, and the answer gains inherits_from, the chain that was walked. A name the script overrides is listed at both its lines rather than once. A native base is not walked, since it declares nothing in a file: editor_classes info answers for those. Default false.",
      },
      line: {
        type: 'integer',
        minimum: 1,
        ops: ['completion', 'hover'],
        description: 'completion, hover: the line, counted from 1 as the editor shows it.',
      },
      character: {
        type: 'integer',
        minimum: 1,
        ops: ['completion', 'hover'],
        description:
          'completion, hover: the column, counted from 1 as the editor shows it, with a tab counted as one. symbols gives each name at the line and column hover is asked at.',
      },
    },
    requires: ['projectPath', 'scriptPath'],
    operations: {
      structure: {
        effect: 'read',
        summary:
          "functions, variables (static ones marked is_static; one written with := has the type of a literal or built-in constructor it is given, marked inferred, as a constant always does), signals, constants, enums, inner_classes (each with its name, line and extends, and its own members in these same fields), class_name, extends and line_count, read from the file, and dependencies: the paths it loads or preloads as written, then the scripts declaring each project class_name its code uses, which classes_used names with the class; autoloads_used names each autoload the code uses by its global name, with the autoload's script, which the project loads rather than this script, so it is not under dependencies. A member or inner class with a ## documentation comment directly above it carries the comment's text as doc, and the script's own, the ## block above class_name or extends or one followed by a blank line before any member, comes back as class_doc",
        requires: [],
      },
      symbols: {
        effect: 'read',
        summary:
          'document symbols from the language server, each with its kind, the line and column of its name, and the lastLine of its declaration',
        requires: [],
      },
      completion: {
        effect: 'read',
        summary: 'completions at a position, narrowed to the part of a name written before it, at most 100',
        requires: ['line', 'character'],
      },
      hover: { effect: 'read', summary: 'hover text at a position', requires: ['line', 'character'] },
    },
    defaultOperation: 'structure',
  },
  {
    name: 'script_diagnostics',
    title: 'Script diagnostics',
    effect: 'read',
    description:
      "Errors and warnings for a script, or for several, from the editor's language server, and whether each is clean. With no editor of this project open, so no language server of it to ask, a short headless engine compiles the scripts instead and the answer says checkedBy: engine: every error that stops a script compiling, up to its first syntax error, with its line and no column (a call to a method another class lacks is not one, since GDScript checks those only on self: the object may be a subclass that has it, so it fails at run time instead), dependenciesWithErrors naming the other scripts that failed while it loaded, typesMissingFromTheClassCache naming a class the project declares that the engine could not resolve because the class cache lacks it, with staleAnalysis saying what rewrites the cache, and warnings null, since the engine reports warnings only to an editor. Each diagnostic carries its severity (error or warning), its message, and where it is as the editor shows it: line and column counted from 1, and endLine and endColumn just past its end. Diagnostics are checked against the project's own files, and the two that the files disprove are named rather than passed on: a member the class cache's file declares, or a project class it extends does, a method, property, constant, static function or enum member, comes back under contradictedByTheFile with the script declaring it, and so does one a diagnostic names alone as an external class member, read against the class it is looked up on in the line it is on; and a class this project declares that the diagnostic could not resolve comes back under typesTheEditorHasNotLoaded, with inTheClassCache saying whether a launched game would resolve it. staleAnalysis then says what to do, and for both states it is editor_rescan first: it asks the editor already running, starts nothing, and has cleared each in every reproduction measured. Two exceptions are named when they apply. For an enum member, constant or static function of a global class the reload comes first: in the one project that has reproduced a stale enum member, editor_rescan with reloadScript on the declaring script cleared it and a plain rescan did not. And an editor whose last scan wrote the class cache shorter than the file holds a list behind the files and writes it on every scan, so on that editor the rescan loads nothing and staleAnalysis says editor_launch restart instead. What follows differs: for a stale analysed type, editor_rescan with reloadScript recompiles the held copy and editor_launch restart is the last resort that costs a window; for a class missing from the cache, project_import refresh_classes rewrites the cache from disk at the cost of a short headless engine, which matters beside a running bench.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'A script inside the project, a folder, or a list of either, such as "scripts/player.gd" or ["scripts/economy", "ui/shop.gd"]. A folder is its .gd files at any depth, skipping what the engine skips. One script is answered on its own. Several are answered together, with clean, errors and warnings for all of them: a script with nothing to report is named in nothingReported, and every other is answered under scripts in that same shape, including a script that could not be read, named with why while the rest are still asked about. Any number of scripts is one call, which reports progress as it goes.',
      },
    },
    requires: ['projectPath', 'scriptPath'],
  },

  // -------------------------------------------------------------------------------------------
  // resource
  // -------------------------------------------------------------------------------------------
  {
    name: 'resource_edit',
    title: 'Edit resources',
    description:
      'Resource files: read one, create any ClassDB resource as .tres, change one, write a shader, build a TileSet, or set a Theme colour or font size. A material is a create with resourceType StandardMaterial3D, ShaderMaterial or CanvasItemMaterial. read answers with the properties the file sets, in the form modify takes, with resourceType the engine class and scriptClass the class_name of its script when it declares one, and a Theme lists its items there as "Button/colors/font_color". create and modify answer each property given under properties as the file holds it once saved, in the same form. A create or modify whose properties made the engine change others, as a Gradient given more colours than offsets gives each new point an offset of 0, names each of those under alsoChanged with what it held before and holds now. A property holding a resource takes its res:// path; a file never imported is refused with the reimport that imports it. move takes any file of the project, a script or an image as much as a resource, or a directory, and works from the files, so it needs no editor; one serving the project is brought up to it as after a move in its own FileSystem dock, its open scenes and cached resources named for the new paths and the project settings the move rewrote taken from the file. read needs no editor either: with none serving the project, a headless engine reads the file. The ops that write a resource go through the editor when one serves the project; with none, a headless engine runs the tool the editor would and the answer says so under writtenBy. That engine runs the script of the resource, where the editor runs only tool scripts, so what a script changes as the file loads or as a property is set is put back before the save, and a resource where that cannot be done is refused and the file left as it was.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: {
        ...RESOURCE_PATH,
        description: `${RESOURCE_FILE} move: a directory too. read: also a resource kept inside a scene or resource file, by the path a read answers a property holding it with, such as "res://hero.tscn::Animation_jump".`,
      },
      resourceType: {
        type: 'string',
        ops: ['create'],
        description:
          'create: the resource class, such as "PhysicsMaterial" or "StandardMaterial3D", or a class_name a project script declares, which the resource is made as with that script attached.',
      },
      properties: { ...PROPERTIES, ops: ['create', 'modify'] },
      script: {
        type: 'string',
        ops: ['create'],
        description: 'create: a script to attach, for custom resources.',
      },
      includeDefaults: {
        type: 'boolean',
        ops: ['read'],
        description: 'read: include properties still at their default. Default false.',
      },
      shaderType: {
        type: 'string',
        ops: ['create_shader'],
        enum: ['canvas_item', 'spatial', 'particles', 'sky', 'fog'],
        description: 'create_shader.',
      },
      code: {
        type: 'string',
        ops: ['create_shader'],
        description: 'create_shader: the shader source. Default: a minimal shader of that type.',
      },
      sources: { ...TILESET_SOURCES, ops: ['create_tileset'] },
      newPath: {
        type: 'string',
        ops: ['move'],
        description:
          'move: where it goes, inside the project, and for a file with the extension it has. A file goes with its .import and .uid, and a directory with everything in it. Every path naming what moved in a scene, resource, script, project.godot or other text file is rewritten in the style it was written in, res:// or relative, and so is every relative path inside a moved file. A string naming it any other way, such as the start of a path built at run time, is answered under leftAlone rather than changed, and so is a scene or resource saved as .scn or .res, which this cannot rewrite.',
      },
      preview: {
        type: 'boolean',
        ops: ['move'],
        description:
          'move: answer with what would move and change, and write nothing. A move that would be refused is refused here too, with the same reason. Default false.',
      },
      controlType: {
        type: 'string',
        ops: ['set_theme_color', 'set_theme_font_size', 'remove_theme_item'],
        description:
          'Theme ops: the theme type, a Control or Window class such as "Button", or the name of a type variation, which can be any name. A name that is no such class is set as a variation and answered with a note saying so.',
      },
      colorName: {
        type: 'string',
        ops: ['set_theme_color'],
        description: 'set_theme_color: such as "font_color".',
      },
      color: { ...COLOUR, ops: ['set_theme_color'] },
      fontSizeName: {
        type: 'string',
        ops: ['set_theme_font_size'],
        description: 'set_theme_font_size: such as "font_size".',
      },
      size: {
        type: 'number',
        ops: ['set_theme_font_size'],
        description: 'set_theme_font_size: pixels, a whole number of 1 or more.',
      },
      item: {
        type: 'string',
        ops: ['remove_theme_item'],
        description:
          'remove_theme_item: the item to take out, its kind and name as the file writes them, such as "colors/font_color" or "styles/normal". Without it, every item of controlType goes, and the type with them, its base_type among them when it is a variation of one. The answer names each one removed.',
      },
    },
    requires: ['projectPath', 'resourcePath'],
    operations: {
      read: { effect: 'read', summary: 'the properties a resource file sets', requires: [] },
      create: { effect: 'destructive', summary: 'a new resource of any class', requires: ['resourceType'] },
      modify: {
        effect: 'destructive',
        summary: 'set properties on an existing resource',
        requires: ['properties'],
      },
      create_shader: { effect: 'destructive', summary: 'a .gdshader file', requires: ['shaderType'] },
      create_tileset: {
        effect: 'destructive',
        summary:
          "a TileSet from texture atlases; its physics, terrain and custom data layers, and each tile's collision and other values, are written with modify after it",
        requires: ['sources'],
      },
      set_theme_color: {
        effect: 'destructive',
        summary: 'a colour in a Theme',
        requires: ['controlType', 'colorName', 'color'],
      },
      set_theme_font_size: {
        effect: 'destructive',
        summary: 'a font size in a Theme',
        requires: ['controlType', 'fontSizeName', 'size'],
      },
      remove_theme_item: {
        effect: 'destructive',
        summary: 'take one item, or every item of a type, out of a Theme',
        requires: ['controlType'],
      },
      move: {
        effect: 'destructive',
        summary:
          "move or rename a file or a directory, and every path in the project naming it. With no editor an import pass then rebuilds the project's uid cache, so a reference by uid leads to the new path, uidTable says whether it ran, and writtenByImport names the .uid and .import files it gave to scripts and assets that had none. A directory's answer names each file moved",
        requires: ['newPath'],
      },
    },
  },

  // -------------------------------------------------------------------------------------------
  // editor
  // -------------------------------------------------------------------------------------------
  {
    name: 'editor_launch',
    title: 'Open, restart or close the editor, or bind its debug adapter again',
    description:
      "Opens the Godot editor on a project, or restarts or closes the one already connected, or binds its debug adapter again. close saves open scenes, quits the editor and waits for its process to go, which is the only way to end a hidden one short of killing it; an editor this server opened that has not connected yet has nothing of this server's to save, so close stops its process instead. open answers once the process has started, and the editor dials in after its import; a call needing the editor made before then waits for the one this server opened, for as long as a restart waits, and is refused naming it if it has not arrived. open refuses while an editor of the project is already running and has not reached this server, naming its pid, rather than putting a second on the project. The editor is an ordinary visible one on the desktop in use, and on Windows it is shown without being activated, so opening or reopening it does not take the keyboard from whatever the user is typing in. hidden: true opens it headless instead and, on Windows, on a desktop of its own, where the games it plays go too; a hidden editor serves the bridge, the language server and the debug adapter as a visible one does. A game a visible editor plays opens as a window on the desktop in use. An editor goes on serving the addon it read at startup, so restart is what puts a gdharness upgrade into effect, and nothing else here restarts one; it saves open scenes on the way out. An editor a server opened is started again by the server, visible unless hidden: true is passed again, once the old one has gone: it waits 90 seconds for that, or GDHARNESS_EDITOR_RESTART_TIMEOUT_MS, and an old editor still running after it is not replaced, since the new one would find its ports held. One opened by hand restarts itself, which only one with a window can do, because the engine hands back none of the arguments it was started with. Godot tries each server port once, as the editor starts, so a restart binds a debug adapter that came back without its port again, in the editor that came back. rebind does the same for the connected editor without restarting it, whoever opened it; a debug session open on the adapter ends with it and is opened again by the next debug call. editor_status says which editor is connected and whether it is holding an old addon. Opening a project is a save and so is closing one, which is the part that is not obvious from outside: the editor imports the project on open and writes project.godot back, and Godot writes only what differs from its own defaults, so a key named deliberately at its default value is dropped either way. A restart of an editor this server opened is a quit and then a launch, and this server can be ended between them, usually by the reconnect the restart was being taken for: the editor is gone and nothing replaces it. That is written down before the quit, so the next server says so in editor_status rather than waiting for an editor that is not coming, and open finishes it. An open is refused when the editor it would start could never reach this server: a project other than the one this server serves, whose editor dials that project's own server; a project without the gdharness editor addon installed and enabled; and a project whose editor a restart is already bringing back.",
    answer:
      "close answers settingsDropped, naming what its save took out of project.godot and left out when it took nothing, and settingsNote when the file could not be read to tell; an editor stopped before it connected is answered with beforeConnecting. close and restart name under savedScenes the open scenes that had unsaved changes and were saved on the way out, an empty list when none had; a scene that would not save refuses the close or restart and leaves the editor running. Both answer tookMs, how long the editor took to go or to come back. restart answers with the version that came back, and says under settingsDropped which keys its save dropped, because it waits for the editor to return. An open cannot, since it answers as soon as the process exists and the save happens during the import minutes later, so editor_status carries that reading once the editor has connected. Nothing else will say a key went until something depends on one. A restart answers lspListening and dapListening once the editor's servers are up. When either came back without its port, serversSaid gives the lines the editor's log panel has about its servers, the one place Godot says why a port would not bind, and when it was the debug adapter, which is bound again in the editor that came back, debugAdapterRebound says whether that took; neither is there when both came up. Godot clears that panel whenever a game is played, unless its run/output/always_clear_output_on_play setting is off, so after a play the lines from the editor's own start are gone. rebind answers rebound, with lspListening, dapListening and serversSaid, the lines that rebind made the panel print. A restart that a server's end interrupted shows as restartInterrupted in editor_status, and the open that finishes it says so under finishesRestart.",
    // open alone: a restart is of the editor already connected, which names its own project, and
    // an argument that is accepted and then ignored is one a caller can be wrong about for ever.
    parameters: {
      projectPath: { ...PROJECT_PATH, ops: ['open'] },
      hidden: {
        type: 'boolean',
        ops: ['open', 'restart'],
        description:
          'Open the editor headless and, on Windows, on a desktop of its own, so no window of it or of the games it plays appears. Default false: one visible editor, shown without taking the focus. On restart only for an editor a server opened; one opened by hand comes back as it was, so hidden is refused there.',
      },
      silent: {
        type: 'boolean',
        ops: ['open', 'restart'],
        description:
          "Open the editor with no sound out of the machine, started with --audio-driver Dummy, so a tool script, a preview or a scene playing in its viewport is heard by nobody. Default true: pass false to hear it. The answer's arguments are what the editor was started with. The editor hands no audio driver to a game it plays, so editor_run's own silent decides that game's sound. A hidden editor is headless and silent either way. On restart only for an editor a server opened; one opened by hand comes back as it was.",
      },
    },
    requires: [],
    operations: {
      open: { effect: 'additive', summary: 'open the editor on a project', requires: ['projectPath'] },
      restart: {
        effect: 'destructive',
        summary: 'restart the connected editor and wait for it',
        requires: [],
      },
      close: {
        effect: 'destructive',
        summary: 'save and quit the connected editor, and wait for it to go',
        requires: [],
      },
      rebind: {
        effect: 'destructive',
        summary:
          "stop and start the connected editor's debug adapter in place, ending its debug sessions, and answer whether it listens",
        requires: [],
      },
    },
    defaultOperation: 'open',
  },
  {
    name: 'editor_run',
    title: 'Run the game',
    description:
      "The run: starting the project, stopping it, or booting it once to see whether it comes up clean. start keeps it running and collecting output until it quits or is stopped, windowed where there is a display and headless where there is not, unless headless says otherwise; only runtime_capture needs the window. A run that quits on its own is kept, so a scene that prints an answer and quits is start, then editor_output until running is false. What runs is a scene: a SceneTree script is not an entry point here, so put the script on the root of a scene of its own and name that in scene. args hands the game its own flags, the ones it reads with OS.get_cmdline_user_args(), and a run carrying any is started by this server rather than by the editor. check boots it headless for a few frames, waits for it to quit, and answers with the verdict: whether it came up, and every error and warning it printed on the way. start and check both wait first for a scan the open editor is running and for the class cache it writes just after, since a game booted in between resolves no global class, as does every other engine this server starts on the project; waitedForEditorScanMs says how long, and scanNote says when a scan ran past thirty seconds and the game started during it. Then whatever changed on disk since it was imported is imported, and named under importedFirst. A start waits for the game to become something the runtime_* tools can talk to and says which it is under runtime: listening with the port it took, or why not, so the first call after a start does not have to be made twice. When it is not listening, mayYetAnnounce says whether that is final: false is a runtime that is not coming, true is a game still on its way up, which editor_status will see and runtimeWaitMs waits longer for, and the note then says what a runtime_* call naming no projectPath meets until it announces. A start this server made also answers with transcript, the file both the run's streams are written to, so a watch on it can be armed off the start rather than off a second call.",
    parameters: {
      // start and check need telling which project. The ops about the run already going take it
      // too, because a call copied from the start carries it, and they check it rather than ignore
      // it: the one thing it can say is which project's run is meant.
      projectPath: {
        ...PROJECT_PATH,
        ops: ['start', 'check', 'stop', 'wait', 'profile'],
        description:
          'Absolute path to the project directory, the one holding project.godot. stop, wait, profile: optional, the project whose run is meant; a run of another project is refused rather than touched.',
      },
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
          'The game\'s own arguments, what OS.get_cmdline_user_args() answers, such as ["--level=2"]. The separator is added here, so a flag the engine reads goes to the game instead, and the answer says so under argsNote. A run with any is started by this server rather than by the editor, which fixes the game\'s command line when it opens the project, so its debugger is the keeper holding it rather than the editor; the debug_* tools answer for it all the same.',
      },
      engineArgs: {
        type: 'array',
        items: { type: 'string' },
        ops: ['start', 'check'],
        description: `The engine's own flags, before the separator, such as ["--verbose"] or ["--fixed-fps", "60"], a value going as the next entry. Only those that change what the engine logs, draws for debugging, checks on the GPU, which renderer draws, how it times frames or whether it builds the tree a screen reader reads, and Movie Maker's --write-movie: ${Object.keys(ENGINE_FLAGS).join(', ')}. Any other is refused, since the engine's command line can also run scripts, open other projects and write files. --rendering-driver takes vulkan, d3d12, metal, opengl3, opengl3_es, opengl3_angle or dummy, and --rendering-method forward_plus, mobile or gl_compatibility, so the same scene can be measured on another driver and a project's OpenGL fallback exercised on a machine that has Vulkan; they choose what draws a run with a window. --accessibility always has the game build the tree a screen reader reads, as the project's accessibility/general/accessibility_support at Always Active does, so runtime_inspect accessibility can read it; otherwise the engine builds it only when a screen reader is running. --write-movie takes an absolute path outside the project, in a directory that exists, ending in .avi (one file, video and sound) or .png (one numbered PNG per frame and a .wav beside them), where nothing it would write is there already; it needs a start with headless: false, since the engine crashes writing a movie headless, and it records at the project's editor/movie_writer/fps unless --fixed-fps says otherwise. A run with any is started by this server, as one with args is. A check given --verbose answers with everything printed rather than only errors and warnings, since what verbose adds, the instances leaked at exit among it, is printed as ordinary lines.`,
      },
      headless: { type: 'boolean', ops: ['start'], description: 'start: force a window or no window.' },
      visible: {
        type: 'boolean',
        ops: ['start'],
        description:
          'start: on Windows, show the window on the desktop in use. By default a windowed run this server starts goes on a desktop of its own, where it renders and runtime_capture works but the window never shows and never takes the keyboard. A game a visible editor plays opens on the desktop in use, and one a hidden editor (editor_launch hidden: true) plays goes on its desktop. Elsewhere than Windows the window shows either way. Default false.',
      },
      silent: {
        type: 'boolean',
        ops: ['start'],
        description:
          "start: run the game with no sound out of the machine, by starting the engine with --audio-driver Dummy: every stream still plays and every playback position still advances, so what is playing can still be asked. The editor takes no engine flags for a game it plays, so a silent windowed run is started by this server, whose keeper is its debugger rather than the editor. A headless run, check's included, is silent already, and so is a test run. Default true, for an exported build too: pass false to hear the game, which a windowed run with the editor connected then plays through the editor.",
      },
      executable: {
        type: 'string',
        ops: ['start'],
        description:
          'start: an exported build to run instead of the project, as a path inside the project such as export/windows/game.exe, so what a player runs can be measured. It takes args, engineArgs, savesIn, env, headless and visible as the project does, goes on the hidden desktop the same way, and is ended by stop, but takes no scene (its pack holds the main scene) and no profile, and has no debugger: a release build quits when given one. Its runtime is not waited for.',
      },
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
          'start: how long to wait for the game to announce its runtime before answering. Default 5000, or half as long again as the slowest of the last five boots of the same scene when that is more, up to 60000: the server notes how long each game took to announce, per scene and for the main scene when none is named, since a boot moves with the load on the machine, so a scene that boots slowly is waited for from its second start on without being asked to, and a harness scene that announces late sets nothing for the main scene. What it waits for is the first frame, so everything the game does before drawing one is inside it, including work the args just asked for: a flag that simulates six years of game time before anything is drawn makes the announcement that late, on a project that announces promptly without it. Raise it for such a run rather than reading runtime listening false as a fault. 0 does not wait at all, which is the one to pass for a scene that announces nothing by construction, such as a bench that prints and quits.',
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
      profile: {
        type: 'boolean',
        ops: ['start'],
        description:
          "start: profile the run's GDScript with the engine's own script profiler from its start, for editor_run profile to answer which functions took the time. A run this server starts dials the process that keeps it as its debugger, on loopback, with breakpoints and error breaks skipped so it never stops to wait; a game the editor plays is profiled through the editor's debugger session. Needs an engine built with debugging, which the editor binary is and a release export template is not. The start answers profile.on and, under profile.totals, how the numbers will arrive. Default false.",
      },
      callersOf: {
        type: 'string',
        ops: ['profile'],
        description:
          "profile: also answer, under callers, where the project's scripts name this function in code: its name, or Class.name for the functions of one class. Each place has its script, line, the named function it is written in (within), whether the function is called there or passed on as a Callable (called), and the profile's calls, self and total milliseconds for the function it is in, those taking the most time first, forty at most. Found by name in the source, since the engine's profiler records nothing about who made a call, so a method of the same name on another class is listed too, except, when Class.name was asked, one called through another class of the project by name or through a parameter, local or class variable declared as one, and a call made through a string is not. A parameter, local or class variable of the same name is not the function and is not listed. A property's get or set block, which the profile names Class.@name_getter or Class.@name_setter, is asked about by that name or by the property's: the places are where the property is named, each saying instead of called whether it writes the property (access write), which runs the set block, or reads it (access read), which runs the get block, and the rows are both blocks'. Inside the property's own blocks its name is the value stored, which the engine reads and writes without running them, so those lines are not places.",
      },
      mark: {
        type: 'boolean',
        ops: ['profile'],
        description:
          'profile: answer as usual and set the run\'s mark at these totals, so a later profile with since: "mark" answers for one action, a press or a commit, apart from the boot and everything before it. The mark is kept beside the run\'s profile, so a server that replaces this one reads it too, and setting it again moves it. Given with since, the answer counts from the mark before it moves, which times one span after another. Default false.',
      },
      since: {
        type: 'string',
        enum: ['mark'],
        ops: ['profile'],
        description:
          'profile: "mark" answers only what was added after the mark that mark: true set in this run: per function the calls and self and total milliseconds since it, with the functions that added no call left out, frames and coveredMs since it, and callersOf read off the same difference. Refused when no mark was set in this run, or when the profile holds less than it did at the mark, which is a profiler started again since.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        ops: ['profile'],
        description: 'profile: how many functions to answer with, those with the most self time. Default 30.',
      },
      andChildren: {
        type: 'boolean',
        ops: ['stop'],
        description:
          "stop: also end what the game started for itself, with OS.create_process or otherwise, such as a bench's workers and whatever those started in turn. Only the processes under the run's, to any depth, that are games of this project are ended: announced as one, or this project's engine run with --path on this project by its command line, which is how a bench whose workers deliberately carry no runtime is reached. They are named under endedChildren, with what identified each under identifiedBy; any other process under the run is left and named under childrenLeft, and childrenUnknown is true when nothing could be listed, with the note saying whether the platform would not or the run has no process to list under. Default false, and the run's process is ended either way.",
      },
      graceful: {
        type: 'boolean',
        ops: ['start', 'stop'],
        description:
          "stop, and a start that ends the run going before it: ask the game to close first, the way a player's close asks it, so its own handling of a close runs, which a game keeping a crash mark needs to take the mark down. The runtime addon delivers the close request to every node and then the root window's close_requested, and a tree with auto_accept_quit on then quits. The game is given ten seconds to exit, GDHARNESS_CLOSE_WAIT_MS sets another, and is ended the ordinary way when it does not, or when it has no runtime listening, refuses the close, or does not answer within three seconds, as a game held at a breakpoint does not; notClosedBecause (previousRunNotClosedBecause on a start) then says which. Default true; false ends the process at once.",
      },
      pid: {
        type: 'integer',
        minimum: 1,
        ops: ['stop'],
        description:
          "stop: a game of this project that no server here is holding, by its process id as editor_status lists it under runtimes: one a server before a reconnect started and left no note for, or one started some other way. It is ended only when it announced itself for this project and the operating system describes it as this project's engine run, --path on the project and no editor flag, started before it announced; otherwise nothing is signalled and the answer says which of those failed. The run this server holds is ended the ordinary way whether or not its number is given.",
      },
    },
    requires: [],
    operations: {
      start: {
        effect: 'additive',
        summary: 'run the project until it quits or is stopped',
        requires: ['projectPath'],
      },
      stop: {
        effect: 'destructive',
        summary:
          'end the run, asking the game to close first unless graceful is false, naming the process ended under endedPid, and answer with the errors and warnings it printed under entries (editor_output has the rest); a game that started processes of its own keeps them unless andChildren says to end those too',
        requires: [],
      },
      check: {
        effect: 'additive',
        summary:
          'boot headless, quit after a few frames, and report the verdict: booted is true only for a run that quit on its own within timeoutMs, exited 0 and printed no error, so a game that reached _ready and then raised an error answers false',
        requires: ['projectPath'],
      },
      wait: {
        effect: 'read',
        summary: 'wait for the run to end, then answer as editor_output does',
        requires: [],
      },
      profile: {
        effect: 'read',
        summary:
          'where the run spends its time by GDScript function, while it runs or after it ended, sorted by self time. A run started with profile: true is profiled from its start; a game the editor plays that was not is profiled from the moment this is asked; a run this server started without it is refused, since its debugger is fixed as it starts',
        requires: [],
      },
    },
    answer:
      "start: through is gdharness for a game this server started itself, and editor for one the editor plays. scene is the scene the game started in, the project's main scene when none was given. runtime carries addonIsStale and staleNote when the game announced on a runtime addon other than this server's, which no runtime_* call is then sent to, and staleNote says what brings it into step. refreshedClasses names the class_name declarations on disk that the engine's class cache was missing, which were added to it before the game started so the game could resolve them; it is empty when the cache was current. stop: endedPid is, for a run the editor plays, the number its game announced under, read at the stop rather than remembered, and the operating system hands a freed number to the next process, so it can equal the game before it. stopped is false, with the number under notSignalled, when that number no longer answers as the process the run was started as and nothing was signalled, the note naming which property it failed on, and false with the number under stillGoing when what was told to end was still running ten seconds later. endedThrough says how the stop ended a run that was going: close (the game was asked to close and exited, so exitCode is its own), keeper (the process that started the game ended it through the handle it holds), signal (its pid was signalled once shown to still be the run), or editor (the editor playing it was asked). exitedBeforeStop is true when the run was already over when the stop came, so nothing was ended and exitCode, when anything collected it, is the one it ended with. A start that ends the run before it says how under endedPreviousRunThrough, with the same values, and one that refused to signal that run names the property it failed on under previousRunLeftBecause. check: hung is a run killed at timeoutMs, and errors and warnings count what it printed, which comes back under entries with repeats folded together. entries holds the errors and warnings and not the ordinary lines the run printed, which printedLinesNotShown counts; a check given --verbose holds those too, and editor_run start then editor_output reads everything. An engine crash is an error whatever it prints after: the crash handler's report is the entry, and the engine version and the native and GDScript backtraces are its detail, so a crashed run is never booted or clean. arguments is the engine command line the check ran, as a start's is, and durationMs runs from that engine's start to the check's answer, after its exit, so it holds no import that came first. start and check: " +
      IMPORTED_FIRST +
      " An exported build carries its own imports and is not asked. waitedForEditorScanMs and scanNote are left out when no editor scan was waited for. A silent windowed run has --audio-driver Dummy in its arguments; a headless run is silent without it, and one the editor plays with sound has no arguments of its own. profile: per function its script, the function (Class.name when the script declares a class_name), the line its body's first statement is on, for a lambda the named function it is written in (within), calls, and self and total milliseconds, with functionsCounted, scriptMs (the self time of them all) and coveredMs. The runtime addon's own functions, gdharness answering its tools inside the game, are not among them: their self time is runtimeAddonMs, over runtimeAddonFunctions functions. complete is true when the engine's own totals arrived, which it sends only when the profiler is switched off: the runtime addon does that as a game quits, so a scene that does its work in _ready and quits is covered whole; otherwise the answer is the frames summed so far and the note says what that misses. frames counts the frames of the profile that arrived, and the engine's totals also hold the work after the last of them, so once complete a function run every frame can show a call more than frames. Self time counts a call into the engine's own methods as the caller's, and a call through super too, while the overridden function's row counts it again: such a row carries selfIncludesSuper, so self times along an override chain overlap. The profiler's own cost of timing a call lands in the self time of the function called; with the runtime addon it is measured each run on an empty function, as perCallOverheadUs, and a row with at least half its selfMs in it carries overheadMs, since a small function called often costs that much less without the profiler. A function the profiler started inside is left out, since its time would be counted from the engine's start. The milliseconds are time passed while the function ran, not processor time given to it, so they grow when other processes compete for the processor: compare two profiles taken under the same load. They are also summed over every thread: a function run by WorkerThreadPool or a Thread on several threads at once counts each thread's time, the engine does not say which thread a call ran on, and a function waiting for them has the wait in its own self time, so selfMs is not time taken from frames, and scriptMs can exceed coveredMs, which the note then says. A property's get and set blocks are named Class.@name_getter and Class.@name_setter, as the engine names them, and their rows carry property, the property's name. A game the editor plays that was not started with profile: true says, in the answer, that it was profiled from the moment it was asked. A profile with mark answers marked: true; one with since answers since: \"mark\" and markSetMsAgo, and lessThanAtMark counts the functions left out for reading less than at the mark, which the engine's own totals, capped, can do when they replace the frames' sum.",
    defaultOperation: 'start',
  },
  {
    name: 'editor_output',
    title: 'Game and editor output',
    description:
      "What the project started by editor_run has printed, as entries with a severity: the errors and warnings the engine reported, each with where it happened, and everything else as info. For a run the editor plays the reports come from the game itself, through the runtime addon, since the editor's debugger relays what a game prints and not what it reports; a played game without the runtime addon answers here with its prints alone, with errorsUnread true and no clean, since what it raised reaches nothing here. A run answers with counts and a verdict: clean is true when no error was reported, and warnings, counted beside it, do not make it false. heldAt is three answers: null for a run this server knows is not held, running or over, an object for one it knows is held at a breakpoint, whether the adapter said so or the runtime did by accepting a connection and never answering, and absent with heldUnknown beside it for a server that connected to the debugger after the stop and has no runtime to ask, since the adapter reports a stop only to the sessions connected when it happened. A run that has quit still answers here, with running false and its exit code, until the next one starts; a run ended by a signal has no exit code, and exitSignal names the signal instead. A run this server started also answers with transcript, the file both its streams are written to: uncapped, written while the run is going, and the thing to read or tail for a long run rather than the engine's own log, which every engine start rotates away. Read the file for output and this answer for state: endedBy says whether gdharness ended the run, and a transcript that has stopped growing is a run between prints rather than a run that is over. running is asked of the operating system whenever there is a process to ask about, which is every run this server started and every editor-played run whose game announced its runtime. For an editor-played run that never announced, there is no process id here and running is the editor's answer, which can lag: one reported a game as playing fifteen seconds after its process was ended from outside. editor_status names that game under runtimes, which does not depend on the editor answering. op: \"editor\" answers about the editor itself instead, which is a different log and the only way anything here can read what an editor printed: its console reaches no plugin, so the addon cannot scrape it, and an editor gdharness opened is asked for a log file as it starts. That covers the whole session from the editor's first line, where the output worth reading usually is, since the class cache, the plugins and the language server speak before any harness connects. It answers counts with no clean, since an editor neither passes nor fails, the entries in the order they were printed and, beside them under repeated, each message shape several lines share: how many, what varied in each slot of it and how many different values stood there, the first occurrence, and the ordinary lines above the group, found by walking back past the group rather than by counting lines. An editor somebody opened by hand has no console here and is refused saying so rather than answered empty, because an editor that printed nothing and an editor nobody captured are not the same thing. startedAt is when the run began and elapsedMs how long it has been going; for a run that is over, endedAt is when it ended and elapsedMs how long it ran, and both are left out when nobody saw the end, as for a game closed in the editor or a run picked up from a note written before ends were recorded.",
    answer:
      "Each entry's source says where it was read: transcript for a line of the run's transcript file, which holds both its streams and is how every run with one is read; stdout or stderr for a line of that stream of a run with no transcript, such as an editor-played run picked up after a reconnect whose first server left no note; debugger for what the editor's debug adapter reported and the game never printed, such as the script error a game stopped on.",
    parameters: {
      projectPath: {
        type: 'string',
        description:
          "The project whose output you mean to read. It picks nothing, since this reads the one run or editor this server holds, and a call naming another project than that one's is refused rather than answered with output from a different game.",
      },
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
          'The most entries to answer with, newest kept. Identical entries come back as one, at the first of them, with times saying how many were printed, so the limit counts distinct entries. Default 200, and omitted says how many distinct matching entries that left out. A run long enough to pass it needs this raised, not just filtered: filtering narrows what counts as matching, and the newest of those is still all one answer carries.',
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
        effect: 'read',
        summary: 'What the game a run is playing has printed, which is everything described above',
        requires: [],
      },
      editor: {
        effect: 'read',
        summary:
          "What the connected editor itself has printed, from its first line, with repeated messages grouped and the ordinary lines above each group carried with it. The engine's progress bars are one line per task, saying how far an unfinished one got",
        requires: [],
      },
    },
    defaultOperation: 'run',
    requires: [],
  },
  {
    name: 'editor_status',
    title: 'Editor status',
    effect: 'read',
    description:
      'Whether the editor addon is connected, which Godot answers, whether the editor is playing something, and which games with the runtime addon are reachable, of this project and of every other on the machine. Read connected with mayYetConnect: the editor dials this server and backs off between tries, so for the first half-minute after a server starts false means not reached yet as often as no editor; mayYetConnect true is worth waiting out, false is final, and editorCannotConnect, restartInterrupted, restartUnderway, closedHere and editorsNotYetConnected say why. An editor that has connected and not yet greeted reports nothing about itself, and every other call made in that window waits up to ten seconds for it to settle. playingInEditor null means unanswered rather than nothing playing: processActive and runtimes do not depend on the editor answering. game.run names the run editor_output and editor_run stop answer for, and stays named after it ends. addonIsStale, on a connected editor and on each running game (absent with neither), says it runs addon code other than what this server ships, and staleNote says which half moves: the project, by a gdharness upgrade it spells out to run in a shell, the editor by a restart, or this server by a reconnect. A false editor.lspListening or editor.dapListening comes with serversNote: editor_launch rebind binds the debug adapter again in place, and editor_launch restart the language server. editor.scan says whether the editor is scanning, which editor_run waits out before starting a game. A game announced in a protocol this server does not speak is listed under unreadable, during an upgrade that moves the protocol, until the halves match.',
    answer:
      "projectIs, when present, is the gdharness version of the addons in the project, which differs from this server's (project_info says which of the two to move), and configIs, when present, the version the project's MCP config starts, which differs from this server's, so the next connection runs that one. server names this server: its pid, its version, and lifecycleLog, the file every gdharness server of the user appends a line to when it starts, when its client first names itself, when it replaces another server of its project, and when it ends, with why it ended (the client closing its end as stdin:end, a signal by name, superseded with the successor's pid, an uncaught exception or rejection with its stack, or the exit code) and the calls it was answering then. The parent's command line follows on its own line a few seconds after the start. A server killed without warning writes no ended line, and on Windows every kill is that, so a started line with no ended line after it is a server something killed. " +
      "runtimeConnected counts the games of the project this server serves, and runtimes lists every game on the machine with ofThisProject saying which is which, since a game of another project is reached only by naming its projectPath. playingInEditor is null when the editor was not asked or did not answer, which is not the same as a no: with no editor connected there is nobody to ask, and an editor that does not serve the question is given a moment and then left. A game can be playing while this is null, so read it as unanswered rather than as nothing playing, and use processActive and runtimes, which come from elsewhere and do not depend on the editor answering. Its play says which play the editor is on: play.play counts the plays that editor has started since it opened, whoever started them, and play.editorPid is the editor, so two reads with different pairs are two plays even when both say playing. game.run names the run processActive is about, the one editor_output and editor_run stop answer for: its pid, its project, and adopted true when this server read it back from another server rather than starting it. It stays named after the run ends, beside processActive false, so editor_output can still read what that run printed; null when there is no run at all. startedAt says when it began, and endedAt when it ended, wherever something saw the end: a run adopted from a note another server wrote can have ended hours before this server started. editor.lspListening and editor.dapListening say whether anything accepts connections on the ports the editor names, lspPort and dapPort: Godot binds each once, as the editor starts, and reports a failure only in the log panel of the editor itself, so a false comes with serversNote: editor_launch rebind binds the debug adapter again in place, and editor_launch restart the language server. editor.scan says whether the editor is scanning or importing and how many milliseconds ago its last scan finished (finishedMsAgo), or is null when it did not answer: the editor rewrites the class cache just after a scan, and editor_run waits that out before starting a game, saying so under waitedForEditorScanMs. Each game under runtimes is pinged with a short wait, so one held at a breakpoint is listed as unreachable rather than making this call wait out the runtime timeout; for the run this server is reporting on, heldAt says whether that is what it is, with the same three answers editor_output gives. A game the editor played announces the editor under editorPid, and so does whatever that game started for itself; a game some other server started announces none, which is how the two are told apart when both are running from one project. Each game also says which runtime addon it loaded, under addonVersion (null when it cannot say); addonIsStale is true when that code is not what this server ships, and staleNote says whether the project needs the gdharness upgrade command, spelled out to run in a shell, the game a restart, or this server a reconnect. A second checkout of a project, such as a git worktree, carries addons of its own and is where this shows. A runtime_* call to such a game is refused with the staleNote and not sent. When connected is false, mayYetConnect says whether that is final: the editor dials this server rather than the other way round and backs off between tries, so for the first half-minute after a server starts, false means \"not reached yet\" as often as it means \"no editor\". True is worth waiting out; false is an editor that is not there. False beside editorCannotConnect is a project without the gdharness editor addon installed or enabled, where no editor can ever dial in, however young the server or whichever editor is open; its remedies say how to install or enable it. False beside restartInterrupted is one that an editor_launch restart on a previous server asked to quit, where the launch half never ran because that server was ended in between, usually by the reconnect the restart was taken for; editor_launch open finishes it. True beside restartUnderway is a restart still in progress, its server alive and within the wait for the old editor to go: the editor is coming, and opening another would put two on one project. listeningSince is when this server took the bridge port, which is what that window is measured from and what a caller wanting its own window should read. An editor this server opened counts for as long as its process lives, however far past that window the import runs, and awaitingLaunchedEditor names its pid so the two reasons for true are told apart. Any editor of this project running and not yet connected, whoever opened it, makes it true as well and is named under editorsNotYetConnected with its pid and start time, so a restart a reconnect interrupted after its launch is not read as nothing being there. settingsDropped appears here once when the editor this server opened saved project.godot on its way in and took a key out of it, which is the same reading editor_launch restart makes in its own answer. A game that has announced itself in a protocol this server does not speak is listed under unreadable rather than left out, with the protocol it speaks and whether the server or the addon is the older half. This happens during an upgrade that moves the runtime protocol, which most do not: installing replaces the addon on disk as soon as the pin moves, while a server that is already running stays on the version it started with, so the two speak different protocols until the server is reconnected. Those games are real and running, but no tool here can reach them until the halves match, so runtimes stays empty and runtimeConnected stays false. An upgrade that leaves the protocol alone opens no such window and this list stays empty through it. addonIsStale is decided by the code of the editor addons rather than their version, so an editor started before an upgrade that left that code alone reports the older addonVersion, is not stale, and addonNote says so: it needs no restart. A stale editor is asked nothing but to quit: every other call to it is refused with staleNote, which names editor_launch restart, the upgrade command or a reconnect. port is the one the editor bridge is on; when that is not the one this server was configured with, portWanted names the configured one and portNote says why it moved and, when it was the server this one replaced, which pid kept it. A server replacing another of its project that holds the configured port waits for it to stand down and takes the port over, which takes a few seconds; bridgeHandover says so while it waits, and it moves only if that server has not let go within the wait. An editor that has connected and not yet greeted, which lasts a frame and longer while it imports, reports nothing about itself: greeting says so, addonIsStale is absent rather than guessed, and a restart asked then waits for the greeting to learn who opened it. startedByAnEditor is an editor another editor started, by Godot's own restart or the project manager, which has none of the arguments a server gave the one before it; startedByAnEditorNote says what that costs. An engine run that loads the editor addon to do one job and quit, such as a gate's godot --headless --import, an export or a script, is not taken as the editor: a process that greets without a server's mark has its command line read first, and from the socket opening until its greeting and that read are done, identifying is true and connected false; one started with such an option is turned away, and turnedAway names the last one, its pid and the option. Every other call made while an editor is arriving, before its greeting or while it is looked up, waits up to ten seconds for it to settle rather than acting on connected as it reads in that window. serverVersion is the gdharness version of this server. bridgeAvailable says the editor bridge is listening; when it failed to start, startupError gives the error, and retryingBridge is true while this server tries again. announcedAt is the file where this server told editors of its project which port to dial. connectedAt is when the editor connected, and lastPongAt when it last answered this server's keep-alive ping. addonDigest is a hash of the editor addon's code, which addonIsStale compares with what this server ships. debugPort is the port of the editor's remote debugger, the one games it plays connect to. openedByAServer says a gdharness server started this editor, and syncsBreakpoints that it keeps its breakpoints when a debug session opens, which Godot otherwise clears. pendingRequests counts the requests sent to the editor and not yet answered, and queuedResources the files with writes waiting behind another write to the same file.",
    parameters: {},
    requires: [],
  },
  {
    name: 'editor_rescan',
    title: 'Rescan the project',
    effect: 'additive',
    description:
      'Makes the running editor scan the project filesystem, so files written outside it are picked up. A scan or an import the editor is already running is waited out first rather than scanned over, which would start a second import over it. waitedMs is the whole call, and waitedForEditorScanMs, given only when a scan or an import was already running, the part spent waiting it out. The scan is a change-detecting walk rather than an unconditional reparse, so a file another engine has already imported reads as settled and the walk does not look inside it: its class_name then stays out of the list the editor resolves against, however many times you scan. Any class in that state is named under unseenByEditor, which is what no check on disk can see, since the declaration and the cache are both correct there and only the editor disagrees. The cure is this call on its own, with no change to the declaring script: measured against a real editor on three platforms, with idle waits of the same length ruled out so the scan is credited rather than the time it takes, and reproduced in a second project against its own reproduction in 203ms. editor_launch restart also does it and costs a window, and project_import refresh_classes does not: it rewrites the cache and does not touch what the editor is holding. The walk also passes over a file whose .uid alone changed, so the editor keeps the old UID and every engine reading its cache warns of a duplicate; before scanning, each file whose .uid names a UID the editor does not hold for it is read again and named under uidsReread, and files on disk naming one UID between them are named under uidsDuplicatedOnDisk, which reading again cannot settle. A class the scan brings in is named under broughtIn, and every script naming it is reloaded in the editor and named under dependentsReloaded: what the editor compiled from them while it could not see the class stays compiled that way after the scan, and a script extending a new base class went on reporting "Could not find base class" until reloaded. One that would not reload is named under dependentsNotReloaded and the call is not ok, as it is not when the script named in reloadScript was not reloaded. An editor importing answers nothing until the import is over, and a hidden one imports on the thread that answers, so a large addon install can leave the rescan itself unanswered: that is waited for as any busy editor is, within timeoutMs, and when the wait runs out first the answer is stillWorking. The classes the editor could not see before that scan are then noted in the project, and the next editor_rescan of the same editor, from any server, names them under broughtIn and reloads what names them, which it could not otherwise know to do, since by then the editor sees them. A scan writes .godot/global_script_class_cache.cfg from the list the editor is holding, so a class the editor cannot resolve goes out of that file with it. That is not a reason to refuse the scan, because on a class the editor has merely not walked yet the scan is the cure; what the answer does instead is name the loss under cacheLost and rebuild the cache from the files, naming what came back under cacheRestored, so no fresh engine, CI run or clone inherits the short file. An editor that lost classes is still holding the short list, so the note says to restart it before scanning again. The other direction is guarded the same way: a class the editor still holds for a script that was renamed or deleted comes back into the cache at a path that is not there, and the next engine to read it fails on "Could not parse global class" in whichever correct script shares the bare name, so the cache is rebuilt without it and the answer names it under cacheDropped; the editor goes on holding it until it is restarted, and every scan until then ends in that rebuild. A script or shader written outside the editor has no .uid sidecar until something imports it, and the scan writes one beside it, which a project that commits sidecars needs before the commit. Needs the editor connected.',
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
          "A script to recompile in the editor after the scan, for the half a scan does not reach: a script the editor has loaded keeps the copy it built, that copy is refreshed when one of its dependencies changes rather than when it changes itself, and a scan leaves it alone. Measured here, a built copy comes back without a method added to it while script_diagnostics on the same script reads clean in the same window, so the copy the editor built and whatever the analyser resolves types against are not known to be one thing: reload for the copy, and read the diagnostics as a separate answer rather than as this one confirmed. This recompiles into the same object, so the holders that kept the stale copy alive see the new one. What the reload changed comes back under methodsAdded, methodsRemoved, constantsAdded and constantsRemoved, with each enum value as Kind.SHORT among the constants, since an enum member is held as a constant and never shows among the methods; methodsHeld and constantsHeld count what the copy holds afterwards, because a reload that compiled nothing and answered OK is the failure worth catching. listMembers adds the whole lists. A script that does not compile is not reloaded: reloadProblem gives Godot's error, says whether the copy the editor holds survived, and names the classes the file uses, whose held copies being behind is what failed one before. A @tool script is not reloaded either, since it runs inside the editor and reloading one from inside a call can take the editor down: reloadProblem says so, and editor_launch restart recompiles it. A path spelled in another case than the file is reloaded under the spelling on disk, which is the one the editor holds its copy under, and that spelling comes back under reloadedAs. A script open in a script tab with unsaved edits is reloaded from the file all the same, and unsavedInEditorNote says that saving the tab writes its text back over the file; open tabs with no unsaved edits reread what changed, as they do when the editor's window takes the focus.",
      },
      listMembers: {
        type: 'boolean',
        description:
          'With reloadScript: also answer the whole member lists, heldBeforeReload and reloadedMethods for the methods, heldConstantsBeforeReload and reloadedConstants for the constants, each with what the script inherits from the scripts it extends. Default false: a script holding hundreds of constants answers hundreds of lines twice to say what one reload added.',
      },
    },
    requires: ['projectPath'],
  },
  {
    name: 'editor_classes',
    title: 'Engine classes',
    description: "The engine's ClassDB: find classes, read one in full, or walk an inheritance tree.",
    parameters: {
      projectPath: PROJECT_PATH,
      filter: { type: 'string', ops: ['query'], description: 'query: a substring of the class name.' },
      category: {
        type: 'string',
        ops: ['query'],
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
          'visual',
          'animation',
          'ui',
        ],
        description: 'query: limit to one family.',
      },
      instantiableOnly: {
        type: 'boolean',
        ops: ['query'],
        description: 'query: leave out abstract classes. Default false.',
      },
      className: {
        type: 'string',
        ops: ['info', 'inheritance'],
        description: 'info, inheritance: the class.',
      },
      includeInherited: {
        type: 'boolean',
        ops: ['info'],
        description:
          "info: also name every member the class inherits, under inherited: one entry per ancestor, nearest first, with the names of the methods, properties, signals and enums it declares. The class's own members stay in full; member reads any inherited one in full. Default false.",
      },
      member: {
        type: 'string',
        ops: ['info'],
        description:
          'info: one member by name, a method, property, signal, enum or constant, with its signature and which class declares it, looked for on the class and every ancestor. The whole of Control is seventy thousand characters; the question "does this engine have it, and what does it take" is this. A name nothing declares is refused with the members whose names contain it.',
      },
    },
    requires: ['projectPath'],
    operations: {
      query: { effect: 'read', summary: 'classes matching a filter or category', requires: [] },
      info: {
        effect: 'read',
        summary: 'methods, properties, signals and enums of one class, or one member of it by name',
        requires: ['className'],
      },
      inheritance: {
        effect: 'read',
        summary: 'ancestors and descendants of one class',
        requires: ['className'],
      },
    },
    defaultOperation: 'query',
  },

  // -------------------------------------------------------------------------------------------
  // runtime
  // -------------------------------------------------------------------------------------------
  {
    name: 'runtime_inspect',
    title: 'Inspect the running game',
    description:
      'Questions about the running game: what is written on the screen, the scene tree, the nodes matching a query, where one node is on screen, what one property reads, the performance metrics, or what it tells a screen reader. Needs the game running with the runtime addon.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      nodePath: {
        type: 'string',
        ops: ['tree', 'text', 'find', 'rect', 'property', 'accessibility'],
        description:
          'tree, find, text: where to start, default /root. rect: the node to place. property: the node to read, or an engine singleton by name as runtime_invoke takes them, "Engine" with property "get_frames_drawn()". accessibility: only the elements that node and those below it made, whether as node or part_of, each window keeping the outermost of them with what they hold, and matched counting them. What a ScrollContainer holds out of its sight is not in the tree until it is scrolled to, so an element missing under one may be scrolled away rather than hidden.',
      },
      property: {
        type: 'string',
        ops: ['property', 'find'],
        description:
          'property: which one to read. find: read this one off every node matched, so a panel of labels is one call rather than one per label. Colons read through what a node holds, "_game:clock:speed", which is where a game keeps what is worth asking about. A number or a key steps into a list or a map, "_game:run:roster:0:traits", which is how the lists a game keeps its state in are walked: a roster, a board, an in-tray. A key holding a colon, a bracket or a quote is written in double quotes, \'stock:"base:dew"\', as a refusal listing the keys writes it. A packed list, such as a PackedStringArray, steps the same way. A negative number counts from the end. A vector, a colour, a rectangle or a transform is stepped into by its components as GDScript names them, so one axis is one number: "size:x", "global_position:y", "modulate:a", "global_transform:origin:z"; a name the value does not have is refused, naming the ones it has. A step written as a call, "get_viewport():gui_get_focus_owner()", calls a method that only reads (an engine method the engine marks as reading, or a game method not declared -> void, so queue_free() is refused) and walks into what it returned, which is how a question only a method answers is read in one call: which control holds the focus in the viewport this one is in. An engine method that reads takes literal arguments in its brackets, words in double quotes, numbers, true, false or null, so a control\'s theme is read where it is drawn: \'get_theme_stylebox("panel"):content_margin_top\' or \'get_theme_constant("separation")\'. A game method is given none in a path, since nothing marks one as only reading; runtime_invoke call takes those. A list or a map answers the calls that read it and take no arguments, "_game:run:board:size()" or "_game:inbox:keys()", and not those that change it, such as clear() or sort(). A step that is not there is named, and says what was there instead.',
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
        ops: ['tree', 'accessibility'],
        description:
          'tree: the properties to read off each node, by name, so the text of every label and button under a panel is one call: a node that has not got one leaves it out. Colons read through what a node holds, as property does for find. accessibility: the fields to keep on each element, such as ["role", "name", "node"], leaving out the rest (bounds, actions, tooltip); children are always kept.',
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
          'find: a case-insensitive glob on the node name, such as "Enemy*", or several separated by | the way says takes them, such as "Enemy*|Boss", with \\| for a bar in a name. Matched against the whole name, so a bare word finds only a node called exactly that; an answer of none says how many names contain it and what glob would have found them.',
      },
      group: { type: 'string', ops: ['find'], description: 'find: a group the node is in.' },
      says: {
        type: 'string',
        ops: ['find', 'accessibility'],
        description:
          'accessibility: only the elements whose name, value or value_text says these words, matched as find matches them, with what they hold. find: part of what the node has written on it as drawn, the way the text op reads it, case-insensitively and with a typed space matching any space the game draws (a non-breaking one included), which is how a button is reached by the word on it rather than by a generated path. Its own text, so a row is found by the label in it, and hidden nodes match. A bare word is a contains; write a glob and it is one, matched against the whole of what the node says, the same as namePattern, and a glob that finds nothing says under note how many nodes it would find open at both ends. A label with a line break is matched with the break in the words, and a backslash followed by n counts as one. Alternatives separated by | match when any one of them does, each by these rules ("*won*|*lost*"); write \\| for a bar that is part of the words.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        ops: ['find', 'text', 'accessibility'],
        description:
          'find: the most nodes to answer with, default 100. text: the most lines, default 500, with omitted saying how many lines that left behind. accessibility: the most elements below the windows, depth first, with omitted counting the rest; default all. At most 5000 for either. A screen whose dialog sits under a long list is a screen read with omitted greater than zero, so raise this or point root at the dialog rather than reading the answer as what is on screen.',
      },
      includeHidden: {
        type: 'boolean',
        ops: ['text', 'find'],
        description:
          'text: read hidden nodes as well, for checking that something is not showing. Default false. find: default true, since a find means the node whether or not it is drawn; false answers with what the player can actually see, which is how a panel that keeps a label for every line and hides the ones that do not is read. A node counts as hidden when the engine would not draw it: a hidden Control, Node2D or Node3D above it hides it, a plain Node in between breaks that chain as it does for the engine, and a hidden canvas layer or window hides everything in it. How many matches were left out comes back under hidden.',
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
          'How long to wait for the answer before answering pending with a requestId, which runtime_invoke op result collects the reply by. Default 10000, or GDHARNESS_RUNTIME_TIMEOUT_MS; accessibility defaults to 30000 or that, whichever is longer.',
      },
    },
    requires: [],
    operations: {
      tree: { effect: 'read', summary: 'the live scene tree', requires: [] },
      text: {
        effect: 'read',
        summary:
          "every line of text under nodePath, the values in its fields included, in reading order, leaving out what is hidden and everything under it. Every line reads as drawn: rich text without tags, text only as far as it is typed out, a translation rather than its key, an upper-case label in capitals and a secret field as its mask. Tab titles, menu bar titles, list items, a tree's column titles and rows, and an open menu's items and the titles of its separators read a line each",
        requires: [],
      },
      find: {
        effect: 'read',
        summary:
          'the paths of every node matching className, script, namePattern, group or says, with property read off each, hidden ones included unless includeHidden says otherwise',
        requires: [],
      },
      rect: {
        effect: 'read',
        summary:
          "one node's rectangle or position, in canvas and in window pixels. Canvas is the node's own viewport; window is where it is drawn in the game's window, through any embedded dialog or SubViewport it sits in, which is what runtime_input mouse_click and mouse_motion take. A 3D node answers with the point to aim at, which is the middle of what it draws rather than the origin it stands on, the rectangle it covers under covers, the camera that drew it, and behind_camera when it is not in front of one",
        requires: ['nodePath'],
      },
      property: {
        effect: 'read',
        summary:
          'what one property reads on a node, or through the objects it holds, refusing a name nothing along the way has',
        requires: ['nodePath', 'property'],
      },
      metrics: {
        effect: 'read',
        summary:
          "frame time, memory, draw calls and the rest. frame_time is the mean wall time of the last frames_timed frames (up to 120; the game, physics and the wait for the display included), frame_time_max the slowest, both in seconds and null before a frame has passed; vsync says whether a frame waits for the display, and max_fps is the game's frame-rate cap, 0 for none. process_frames and physics_frames count frames and physics steps since the start; get_frames_drawn() stays 0 headless. physics_steps_per_second is the physics steps a second over those frames, fewer than physics_ticks_per_second when a frame needs more than max_physics_steps_per_frame or the editor's Game view slows it. fps, process_time_max and physics_time are the engine's monitors, set once a second: the last second's frames and its slowest process and physics step, so they trail a change by up to a second, and the last two are worst cases, not the frame. Memory, object and render counts are read as asked. memory_static is the engine's CPU-side allocation in bytes; render_video_mem_used, render_texture_mem_used and render_buffer_mem_used are the renderer's GPU memory in bytes, which memory_static leaves out",
        requires: [],
      },
      accessibility: {
        effect: 'read',
        summary:
          'what the game tells a screen reader, read through UI Automation as a Windows screen reader does, under windows: one tree per window, each element with its role (text for static text, button, check_box, group for a control holding others), name, value, value_text (a range\'s spoken words, such as "75%"), description, placeholder, bounds in the window\'s pixels, the actions a reader is offered (click, focus, toggle, set_value, select, expand_collapse, scroll_into_view), and focused on the focused one. node is the node that made the element; a part a node made of itself has part_of, the node drawn around it that holds its words, or part_of_candidates where several are, and part: announcement marks the text a window announces through. An empty name reads as nothing: static text takes it from accessibility_update_set_value, and _note counts the text elements on screen with none. tooltip is the node\'s tooltip_text, which a Windows reader is not told. With nothing focused, the engine calls GdharnessRuntime focused. Needs a windowed Windows run started with engineArgs ["--accessibility", "always"] or accessibility_support at Always Active, since the engine builds the tree only when asked; reading takes a second or two',
        requires: [],
      },
    },
    defaultOperation: 'tree',
  },
  {
    name: 'runtime_invoke',
    title: 'Set or call in the running game',
    description:
      'Sets a property or calls a method on a node, or on one of the engine singletons nodePath names, in the running game. Needs the game running with the runtime addon. The answer carries elapsed_usec, how long the call or the write took inside the game, measured around it there: the round trip to the game is a second or more, so timing from outside measures that instead. A method that awaits is answered with the value it returns once it ends, and awaited true; elapsed_usec then runs to its end, and one that outlasts timeout is collected with op result. Errors the engine reported while a called method ran come back under errors and warnings under warnings, the first 20 of each, with errors_not_shown and warnings_not_shown counting the rest. A script error ends the function it is raised in, which then returns the default of its return type, 0, "" or null, so one that ended the called method itself is named under ended_by_error_at, and result is not a value the method returned. A call that takes longer than timeoutMs is not cancelled: the answer is pending: true with a requestId, the call goes on and does everything it was asked, and op result with that requestId collects its reply once it comes. A game this server started that its debugger holds is said so, with where, before a call and under heldAt when a call reached a breakpoint.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      nodePath: {
        type: 'string',
        ops: ['set', 'call'],
        description:
          'Absolute node path, such as "/root/Main/Player", or the name of an engine singleton: Engine, Performance, RenderingServer, AudioServer, PhysicsServer2D, PhysicsServer3D, NavigationServer2D, NavigationServer3D, Time or TranslationServer, so "RenderingServer" with method viewport_get_measured_render_time_cpu reads what the engine measures. The other singletons are refused: OS runs programs, DisplayServer switches the keyboard layout and Input moves the real pointer.',
      },
      property: {
        type: 'string',
        ops: ['set'],
        description:
          'set: which one to write. Colons write through what a node holds, "_game:run:day", and a number or a key steps into a list or a map on the way, "_game:run:roster:0:name", a negative number counting from the end, and a step written as a call, "get_viewport():gui_embed_subwindows", walks through what a reading method returned, as runtime_inspect property describes. A map keyed by numbers is stepped into by the number, "_game:units:3". A component of a vector, a colour or a transform, "position:x", writes that one alone: the value holding it is a copy, so it is put back where it was read from, setter and all, and a component of what a call returned is refused, since the game keeps that copy nowhere. The answer reads back off the same holder, and a write that leaves the property as it was is refused and says what it still holds: the engine not taking it and a setter keeping the value look the same, so the refusal names neither. A write of the value the property already holds, at its own precision, as a float given in 64 bits to a property keeping 32, is not refused: it answers unchanged: true.',
      },
      value: {
        ops: ['set'],
        blank: true,
        description: `set: the value, fitted to the property's type. ${WHOLE_NUMBERS} A number the property would have to cut is refused rather than truncated: a fraction into an int, a number other than 0 or 1 into a bool. A vector, colour or the like may be written as its fields, {"x": 140, "y": 300}, or tagged, {"_type": "Vector2", "x": 140, "y": 300}, which is the form a read answers with, and one carrying a field its type has not, such as a z for a Vector2, is refused naming it. A colour may also be given as its html code, "#ff8000" or "#ff800080". Text is written as sent: the JSON string "" writes an empty string, and quote marks inside the string are written into the text. An enum property takes the name of a value as well as its number, as the script or the inspector spells it, and a name none of its values has is refused listing them. A number past the range a property is exported with, or one none of its enum values has, is written, as the engine writes it, and the answer says so under outside_declared. A property typed as or holding an object takes a path naming one the game holds, the way call's args do, and holds that instance, or null, which the text null also means, to empty it. One declared as Variant or untyped takes anything, as the engine does: a value of the kind it holds is fitted to it, an int staying an int, and any other is stored as sent, a fraction into one holding an int included. A typed list or map, such as Array[int] or Dictionary[String, int], takes a JSON list or object with each element fitted to its element type, and an element that cannot become one is refused by its index or key, as is an object of another script than the one the list holds, whether or not that script has a class_name.`,
      },
      method: {
        type: 'string',
        ops: ['call'],
        description:
          'call: which one to call. Colons call through what a node holds, "_game:run:advance", the same way a property is written through them, a list or a map is stepped into by index or key, "_game:run:roster:0:retire", and a step written as a call walks through what a reading method returned, "get_viewport():gui_get_focus_owner", as runtime_inspect property describes.',
      },
      args: {
        type: 'array',
        ops: ['call'],
        description: `call: the arguments, fitted to the method's parameter types. An RID is passed as the {"_type": "RID", "id": ...} a read answers it with, such as a viewport's for RenderingServer's render timing. ${WHOLE_NUMBERS} A number a parameter would have to cut is refused rather than truncated: a fraction for an int, a number other than 0 or 1 for a bool. A vector, colour or the like may be written as its fields, {"x": 140, "y": 300}, or tagged, {"_type": "Vector2", "x": 140, "y": 300}. A parameter typed as an object takes a path naming one the game holds and is handed that instance: a colon path read from nodePath, "_game:run:wares:3", or one starting at a node, "/root/Main/Hud" or "/root/Main:_game:run". A path that reaches no object, or an object of another class than the parameter declares, is refused, and so are too few or too many arguments. The engine names a parameter typed as a script class without class_name by the class the script extends, so an object of that class with another script passes that check and the engine refuses the call: the answer says the method did not run, with the engine's reason. A parameter typed as a list or map, such as Array[int] or Array[Gear], is built from a JSON list or object element by element, objects named by their paths. The method itself takes its arguments here only: brackets on it holding arguments are refused.`,
      },
      properties: {
        type: ['boolean', 'array'],
        items: { type: 'string' },
        ops: ['call'],
        description:
          'call: read the object the call answered with in the same answer, under result_properties: true for every variable its script declares, or a list of names, each a colon path walked from that object the way property paths are ("dead_allowed", "terms:0:name"). A name that is not there is listed under result_properties_missing with why, and a result that is not an object answers properties_note instead. Without it an object comes back as its class and id only.',
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
        effect: 'destructive',
        summary: 'set a property, on a node or on an object it holds',
        requires: ['nodePath', 'property', 'value'],
      },
      call: {
        effect: 'destructive',
        summary: 'call a method, on a node or on an object it holds, and return its result',
        requires: ['nodePath', 'method'],
      },
      result: {
        effect: 'read',
        summary: 'collect the reply to a set or call whose wait ran out, by the requestId it answered with',
        requires: ['requestId'],
      },
    },
  },
  {
    name: 'runtime_capture',
    title: 'Capture the screen',
    description:
      "A picture of the running game: the whole screen, one region or node of it at full resolution, or one viewport, as an image. The whole screen is the game's window, with the game's own dialogs and popups laid over it where they sit, also when a project opens them as windows of their own (subwindows not embedded); one of its windows lying outside the game's window, or minimised, is not in it, and viewport captures a shown one by its path. Needs the game running with a window. A capture asked for before the game's first frame is drawn waits for that frame, since the game announces itself before it and the viewport holds nothing it drew until then.",
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      viewportPath: {
        type: 'string',
        ops: ['viewport'],
        description:
          'viewport: the Viewport node. Default the root viewport. A Window of the game that is hidden or minimised has nothing drawn to it, and is refused naming which.',
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
      region: {
        type: 'object',
        ops: ['screenshot'],
        description:
          "screenshot: capture only this rectangle of the window, at the game's own pixels: x, y, width and height in window pixels, or the window rectangle runtime_inspect rect answers, passed as it came. A region partly outside the window is cut to it and the answer says clipped; one wholly outside is refused. The answer names the region captured in window pixels, and drawnAt when the project draws at its own size and stretches that to the window, since the picture then has the game's pixels rather than the window's.",
      },
      nodePath: {
        type: 'string',
        ops: ['screenshot'],
        description:
          "screenshot: capture only where this node is drawn, as runtime_inspect rect answers it: a Control's rectangle, what a 3D node's geometry covers, or what a Sprite2D draws. A node with a position and no extent is refused; give region around it instead. Not with region.",
      },
      zoom: {
        type: 'integer',
        minimum: 1,
        maximum: 16,
        description:
          'Enlarge the picture this many times, each pixel made a square of pixels rather than blended with its neighbours, so a thin line or a corner can be read. Not with width or height. Default 1.',
      },
      outputPath: {
        type: 'string',
        description:
          'Also save the picture as a lossless PNG at this absolute path, for somebody to open later or a script to compare; the answer says where. Refused unless it ends in .png, its directory exists, it is outside the project, and no file is there already.',
      },
      inline: {
        type: 'boolean',
        description:
          'Send the picture back in the answer. Default true, as a JPEG when that is smaller than the PNG and the picture has no transparency (the text says so, with both sizes), since every picture an answer carries stays in the session for as long as it lasts. false sends none and needs outputPath, for a capture a script compares rather than one somebody looks at.',
      },
    },
    requires: [],
    operations: {
      screenshot: { effect: 'read', summary: 'the screen', requires: [] },
      viewport: { effect: 'read', summary: "one viewport's texture", requires: [] },
    },
    defaultOperation: 'screenshot',
  },
  {
    name: 'runtime_input',
    title: 'Send input to the game',
    description:
      "Input to the running game: a whole click on a Control or a 3D node named by path or on a control named by the words on it, an item chosen out of a menu, typing into whatever has the focus, or a raw action, key, mouse button, mouse motion or drag. All of it works headless, where the viewport is the project's window size and the GUI only takes what is inside it. On gdharness's own desktop, where a windowed run goes, Windows refuses to say where the pointer is: every pointer answer there carries pointer_on_hidden_desktop, and the first of the run pointer_note saying why it matters: get_mouse_position() on the root window, and the mouse positions derived from it, read a meaningless position, while what reads the event itself (the control under it, hover, tooltips, input handlers) gets the injected position. A native window no real pointer has entered gets no hover from Godot, so the runtime supplies it there and the answers say hover_supplied.",
    answer:
      "click: what was under the pointer, and what became of the control: in_tree, removed or freed. Named by says, found says which match it was, its index being the index argument that presses the same match again, found.item names the tab, list entry, tree row or menu bar title pressed (kind; index, the item's own number in its control, which is not found.index; says; and for a row the column of the cell saying the words), and found.pressedOn says \"the words\" for words in a RichTextLabel pressed where they are drawn, or \"the middle of the label\" with a note saying why they could not be placed; on a rich label link_pressed says whether the press reached a link, with link_meta giving the meta the label reports clicked, an empty one included. A control scrolled into view first is scrolled each container out from it a frame after the one inside, and scrolled_into_view says whether a scroll value changed. A button in toggle mode, a CheckBox or CheckButton included, answers pressed with before and after, its button_pressed either side of the click: the same value twice is a click the game undid, and after is null when the click freed it. A refusal for a pointer turned off names where mouse_behavior_recursive was set. On a 3D node landed says the interface did not swallow the press: no control under the pointer stopped it, a control letting the pointer pass included, and every viewport on the way out from the room had the pointer over what shows the room. choose: what was chosen, read before the press, which is heard rather than assumed; what became of the control named (in_tree, removed or freed, since a game can rebuild its screen on the pick); and what the button in front of the menu shows now when it is still there. A menu is opened rather than clicked because its items are drawn rather than built, and the item is looked for as the menu stands once open, since a game can fill a menu as it opens. action, key, mouse_click and joypad_button: the event as it was sent, with whole saying whether the press was let go of again and pressed whether it is left held down (true only after pressed true), for a key the keycode, physical_keycode and unicode it carried, and for a controller button its number, its name and the device. mouse_motion: the position and the relative movement sent. mouse_drag: from, to, motions sent and relative_total. joypad_motion: the axis by number and name, the value and the device. key, mouse_click and click answer actions, the InputMap actions the event also presses. mouse_click answers hovered, the control under the point afterwards; the other events are aimed at nothing. A click that did not land on a control whose mouse_filter is ignore, as a Label's is, says so under why_not_landed. An action or a key answers focused with the path of the Control holding the keyboard focus when it went in, since that Control gets it before the game's _unhandled_input: Space or Enter on a focused button presses the button. A mouse_click, mouse_motion or mouse_drag with a point outside the window's viewport says so under outside_viewport, with the viewport's rectangle, since no control there receives it.",
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      nodePath: {
        type: 'string',
        ops: ['click', 'choose'],
        description:
          'click: the Control to click, at its centre, or the 3D node to click, where it is drawn; with says, where to look for the control instead, default the whole tree. choose: the PopupMenu, or the OptionButton or MenuButton in front of one.',
      },
      says: {
        type: 'string',
        ops: ['click'],
        description:
          'click: the words on the control to click, matched the way runtime_inspect find matches says (a plain word is contained in the text, a pattern with * or ? is a glob over it, and | separates alternatives), among the controls on screen, and pressed in the same frame it was found in, so a panel rebuilding between a find and a click cannot free it first. Words on a label inside a button press the button. A control with something drawn over its centre that would take the pointer, such as a screen shown over it or a dialog stacked above its own, is not on screen; nor is one on a hidden canvas layer, one outside the viewport, or one a container clips away that a click does not scroll. The refusal counts those apart. The matches are ranked the way a person picks what to press: an enabled button before anything else, a disabled one included, then a control whose whole text, or one whole line of it such as the title on a card, is the words before one saying them as part of more, and the best one is pressed; found.picked says why. Several matches at the best rank are refused with each one listed, and index picks one. A match saying the words only as part of more is named under found.partOf, and is refused when another control says exactly the words (hidden, off the screen, covered, or on screen taking clicks without being a button), since it would stand in for that one, and when it lets the pointer through to what is under it; index presses it anyway. Words found only inside longer words ("out" in "Scout") rank after every other match and are refused unless index is given; words starting a longer word ("Recruit" in "Recruits") count. An empty field says its placeholder, and a control with no text of its own, a picture on a button, says its accessibility name. A tab, a list entry, a tree row and a menu bar title each count as a match of their own and are pressed where they are drawn, after their control scrolls them into view; a disabled one is refused. An item of an open menu is drawn by the menu rather than held as a control, so a click finds none, and the refusal names the menu and the choose call that picks it.',
      },
      action: {
        type: 'string',
        ops: ['action'],
        description:
          'action: the InputMap action name. A Viewport never hands an action to a shortcut, so the buttons whose Shortcut holds the action are sent it as their Shortcut too, and pressed as by the key bound to it: one button at most, the last in the tree that takes it, passing over one that is disabled, hidden or outside its shortcut context. The answer names those buttons under shortcuts and the one pressed under shortcut_pressed, null when none took it. An engine dialog is not answered this way: AcceptDialog reads the Escape key itself and never asks the InputMap, so ui_cancel goes in and the question stays up. Dismiss one with the key op and keycode Escape, or click its button.',
      },
      pressed: {
        type: 'boolean',
        ops: ['action', 'key', 'mouse_click', 'joypad_button'],
        description:
          'action, key, mouse_click, joypad_button: leave it out and the press is a whole one, down and up a frame apart. true holds it down, false lets go of one being held. A wheel button held down is still a whole step, since a wheel is never held.',
      },
      holdFrames: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        ops: ['action', 'key', 'mouse_click', 'joypad_button'],
        description:
          'action, key, mouse_click, joypad_button: hold a whole press down for this many process frames and then let go, both inside the game, so a pour, a charge or a long press runs to a set length. A press, a frames wait and a release sent as three calls hold it for the time between the calls as well. The answer says held_frames, and under held_for the seconds the hold lasted and the physics_frames that ran in it: a process frame is no set time, and a headless game, drawing nothing, runs them far faster than the sixty physics ticks a second that _physics_process sees. Not with pressed, and not on a wheel step. Default 1.',
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
          'text: what to type. A newline is Enter and a tab is Tab, a space is a space, and "" with replace empties the field. choose: the item to take, by what it says as drawn, which in a game with translations is the translation; the key it holds is matched after that. An item whose whole words are these comes first; otherwise the words match as says does anywhere, a plain word as part of the item, a glob, or alternatives split at |, enabled items ahead of disabled ones, and several matching equally are refused with each listed.',
      },
      replace: {
        type: 'boolean',
        ops: ['text'],
        description:
          'text: true writes over what the field already says, which is what filling one in means. Default false types at the caret, so a field reading 2.1 typed "0.3" at reads 2.10.3. The answer says what the field holds afterwards either way. A read-only field is refused.',
      },
      index: {
        type: 'number',
        ops: ['click', 'choose'],
        description:
          'click: which of several controls saying the words, counting from 0 in the order a refusal lists them, best matches first. choose: the item to take, by where it is in the list, when text will not do.',
      },
      shift: { type: 'boolean', ops: ['key'], description: 'key: hold Shift with it. Default false.' },
      ctrl: { type: 'boolean', ops: ['key'], description: 'key: hold Ctrl with it. Default false.' },
      alt: { type: 'boolean', ops: ['key'], description: 'key: hold Alt with it. Default false.' },
      x: {
        type: 'number',
        ops: ['mouse_click', 'mouse_motion', 'mouse_drag'],
        description: 'mouse_click, mouse_motion: window pixels. mouse_drag: where the press is.',
      },
      y: {
        type: 'number',
        ops: ['mouse_click', 'mouse_motion', 'mouse_drag'],
        description: 'mouse_click, mouse_motion: window pixels. mouse_drag: where the press is.',
      },
      toX: {
        type: 'number',
        ops: ['mouse_drag'],
        description: 'mouse_drag: where the release is, in window pixels.',
      },
      toY: { type: 'number', ops: ['mouse_drag'], description: 'mouse_drag: as toX.' },
      via: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        ops: ['mouse_drag'],
        description:
          'mouse_drag: points the stroke passes through on the way, in order, each [x, y]. The motions are spread along the whole stroke by distance. Default none: a straight line.',
      },
      frames: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        ops: ['mouse_drag'],
        description:
          'mouse_drag: how many process frames the stroke takes, one motion each, as a real mouse sends one a frame; a hand takes about 20 to 60 for a stroke across a screen.',
      },
      button: {
        type: ['string', 'number'],
        ops: ['click', 'mouse_click', 'mouse_drag', 'joypad_button'],
        description:
          'click, mouse_click, mouse_drag: left, right, middle, wheel_up or wheel_down, or a button number. Default left. joypad_button: the controller button, by name (a, b, x, y, back, guide, start, left_stick, right_stick, left_shoulder, right_shoulder, dpad_up, dpad_down, dpad_left, dpad_right, misc1, paddle1 to paddle4, touchpad) or by its JoyButton number; a, b, x and y are the bottom, right, left and top face buttons, as Godot names them, whatever the controller prints on them.',
      },
      axis: {
        type: ['string', 'number'],
        ops: ['joypad_motion'],
        description:
          'joypad_motion: the stick or trigger axis, by name (left_x, left_y, right_x, right_y, trigger_left, trigger_right) or by its JoyAxis number.',
      },
      value: {
        type: 'number',
        minimum: -1,
        maximum: 1,
        ops: ['joypad_motion'],
        description:
          'joypad_motion: where the axis is, -1 to 1: down and right are positive on a stick, and a trigger runs 0 to 1. The axis stays there until another motion moves it, as a stick held over does; send 0 to let it go back.',
      },
      device: {
        type: 'number',
        minimum: 0,
        ops: ['joypad_button', 'joypad_motion'],
        description: 'joypad_button, joypad_motion: which controller, counting from 0. Default 0.',
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
        effect: 'additive',
        summary:
          'press and release on a Control, a frame apart, named by nodePath or by says with the words on it (found under nodePath when both are given), or on a 3D node where it is drawn. A control out of sight inside a ScrollContainer is scrolled to first, and a link in a RichTextLabel is pressed where its words are drawn. A disabled button, a control that does not process and one whose pointer mouse_behavior_recursive turned off are refused, since the press would do nothing; by says, one the pointer can reach is picked over it',
        requires: [],
      },
      choose: {
        effect: 'additive',
        summary:
          "take an item out of a menu, by what it says or by where it is in the list: the menu is opened, the item found in it as it stands then, and pressed through the engine's own path, which needs no window and does not depend on what ui_accept is bound to. A disabled or hidden button in front of the menu is refused, and so is a press the menu did not take",
        requires: ['nodePath'],
      },
      action: { effect: 'additive', summary: 'press an action, or hold it', requires: ['action'] },
      key: {
        effect: 'additive',
        summary:
          "press a key, or hold it. Not for a menu a click has opened: an OptionButton or PopupMenu pops up as a window of its own that a key sent to the game never reaches, so an arrow moves nothing in it and Enter closes it with nothing chosen. choose is what selects there. The limit is that menu's own navigation, not windows in general: an embedded dialog whose owner reads keys in _input gets them, and a binding catcher up in one takes the key first time",
        requires: ['keycode'],
      },
      text: {
        effect: 'additive',
        summary:
          'type a string into the field being edited, a character at a time, and say what it landed in and what it holds afterwards, a secret field as its mask. The field is the focus of the dialog that has the focus when one does, which is where the keys go',
        requires: ['text'],
      },
      mouse_click: {
        effect: 'additive',
        summary:
          'click a mouse button at a position, pressed and released a frame apart, each event carrying the buttons held once it has happened; the answer says whole. A drag is mouse_drag. A wheel button is always a whole step, press and release together as a mouse sends one: a lone wheel press holds the viewport on the control that took it, so every click after it lands there',
        requires: ['x', 'y'],
      },
      mouse_motion: {
        effect: 'additive',
        summary:
          'move the mouse to a position, carrying the distance from where the last injected event put it unless relativeX and relativeY say otherwise, and the buttons held',
        requires: ['x', 'y'],
      },
      mouse_drag: {
        effect: 'additive',
        summary:
          'a whole drag in one call, as a hand makes one: press at x, y, a motion each frame for frames frames, and release at toX, toY; for a stir, a paint stroke or a slow slider',
        requires: ['x', 'y', 'toX', 'toY', 'frames'],
      },
      joypad_button: {
        effect: 'additive',
        summary:
          'press a controller button, or hold it, as an InputEventJoypadButton, so a game reading the pad in _input or _unhandled_input gets what a controller sends; an action bound to the button fires with it, as it would for a real one. Pressed and released a frame apart unless pressed says otherwise',
        requires: ['button'],
      },
      joypad_motion: {
        effect: 'additive',
        summary:
          'move a stick or trigger axis to a value, as an InputEventJoypadMotion, which is what a game reading the sticks gets; the axis stays there until another motion moves it',
        requires: ['axis', 'value'],
      },
    },
  },
  {
    name: 'runtime_wait',
    title: 'Wait in the running game',
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
        ops: ['signal', 'watch', 'until'],
        description:
          'signal, watch, until: the node. Needed for a signal without a watch, a watch and a property; for says it defaults to /root, the whole screen.',
      },
      signal: { type: 'string', ops: ['signal', 'watch'], description: 'signal, watch: the signal name.' },
      watch: {
        type: 'integer',
        minimum: 1,
        ops: ['signal'],
        description:
          'signal: the watch an earlier watch answered, in place of nodePath and signal. Answers at once, with fired_before_wait, when the signal fired after the watch was armed, and otherwise waits for it; times counts how often it fired, and args is what the first carried. The watch goes with the answer.',
      },
      property: {
        type: 'string',
        ops: ['until'],
        description:
          'until: the property name, or a colon path through what the node holds, "_game:run:day", read the way runtime_inspect property reads one, a step written as a call included, and one axis of a vector as well: "global_position:x" with compare ">=" stops once a thing has travelled far enough. Walked again on every frame, so a holder the game replaces while the wait is on is followed.',
      },
      value: {
        ops: ['until'],
        description:
          "until: the value to wait for, fitted to the property's type and compared at the precision the property keeps, so -1.1 meets a 32-bit float holding -1.10000002. A value the property would have to cut is refused: a fraction on a whole number, a number other than 0 or 1 on a bool. An enum property is waited for by the name of a value as well as its number, as set takes it. On a property holding an object, whether declared to or untyped and holding one or null, the text null means null. One declared to hold an object refuses any value other than null, since it can never hold it.",
      },
      compare: {
        type: 'string',
        enum: ['==', '!=', '>=', '<=', '>', '<'],
        ops: ['until'],
        description:
          'until, with a property: how what the property reads stands to value before the wait is met. Default ==. != waits for it to read as anything else. >=, <=, > and < put a number in order, met on the first look past the value or level with it at the precision the property keeps, which is how a counter that steps rather than lands is waited on: a day counter on a fast clock went from 31 to 34 between two looks, and a wait for 32 ran out. For these the value is the number it is rather than fitted to the property, so a fraction on a whole-number property is a threshold rather than refused, and a property holding anything but a number is refused.',
      },
      says: {
        type: 'string',
        ops: ['until'],
        description:
          'until: wait for these words to appear anywhere under nodePath, or anywhere in the game when no nodePath is given, instead of for a property, which is how a panel that rebuilds its labels is waited on at all: the labels are named afresh each redraw and the panel is what stays put. Matched the way runtime_inspect find matches says: case-insensitive, a plain word anywhere in the text, a pattern with * or ? a glob over the whole of it, and alternatives separated by | met by whichever appears first ("*won*|*lost*"); on a node the player can see unless includeHidden says otherwise; a label with a line break is matched with the break in the words, and a backslash followed by n counts as one. Instead of, not as well as: a call carrying this and a property is refused, because they ask about different things and answering one of them silently is how a caller watches a screen believing they are watching a property. It looks every frame while a look is cheap and less often on a screen large enough for a look to cost a real share of a frame, so the game keeps its speed; the answer counts the frames the wait spanned and the looks it took, and says under looking_ms how long the looks took between them.',
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
      frames: { effect: 'read', summary: 'let frames pass', requires: ['frames'] },
      signal: {
        effect: 'read',
        summary: 'wait for a signal and answer with what it carried',
        // nodePath and signal, or a watch in their place, which the declaration cannot say, so the
        // handler asks.
        requires: [],
      },
      watch: {
        effect: 'read',
        summary:
          'start recording a signal and answer at once with a watch; arm it before the call meant to set the signal off, then collect it with signal and the watch. A client can run a call sent beside a wait only after the wait answers, so a wait sent with the call misses it',
        requires: ['nodePath', 'signal'],
      },
      until: {
        effect: 'read',
        summary:
          'wait for a property to read as a value, or for words to appear under a node, and answer with what it found; one already true when asked answers at once, with frames 0',
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
    title: 'Breakpoints',
    description:
      "Sets, removes or lists breakpoints. A set on a script that is not there, or past its last line, is refused, as nothing would ever stop there; a remove takes any line, and with no editor connected answers removed false, saying why, when none was held there. Set them first, then editor_run, and the game stops where you asked. With the editor connected it goes through the editor's debug adapter; with none, it is held here. A game this server starts itself, which editor_run start does for a run given args, savesIn, env or silent, or with no editor, is handed every breakpoint held here as it starts, and one set while that game runs reaches it at once (runningGame says so). The editor keeps a breakpoint set this way for one play, so every breakpoint this server holds is sent again before each play editor_run starts, and the start answer lists them under breakpoints. The set is also kept in the project, for the server that comes after a reconnect: a breakpoint stays until it is removed here, whichever server set it. Every answer lists the whole set under held, and the breakpoints the user set in the editor's own gutter under setInEditor; setting one here never takes those away, and removing a line here clears it whoever set it. Godot clears every breakpoint in the editor when a debug session opens unless network/debug_adapter/sync_breakpoints is on, which the addon turns on as it loads; an editor where it was turned off again is said so under breakpointsAtRisk, here and in editor_status.",
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: { ...SCRIPT_PATH, ops: ['set', 'remove'] },
      line: { type: 'integer', minimum: 1, ops: ['set', 'remove'], description: 'One-based line.' },
    },
    requires: ['projectPath'],
    operations: {
      set: { effect: 'additive', summary: 'set a breakpoint', requires: ['scriptPath', 'line'] },
      remove: { effect: 'destructive', summary: 'remove a breakpoint', requires: ['scriptPath', 'line'] },
      list: {
        effect: 'read',
        summary:
          'the breakpoints held here under held, and with the editor connected the ones set in its gutter under setInEditor',
        requires: [],
      },
    },
  },
  {
    name: 'debug_control',
    title: 'Step the debugger',
    description:
      "Pauses, continues or steps the debugged game. A step waits for the game to stop again and answers with the stack where it ended up; one that has not stopped the game again within ten seconds answers heldAgain false and no stack. A game the editor plays is moved through the editor's debug adapter, which cannot pause or step out: it answers a pause by reporting the game stopped and leaving it running, and implements no stepOut, so hold such a game with a breakpoint and step over or into from there. A game this server started itself has its keeper as its debugger, which does both: pause breaks into the game wherever it is, a script spinning in a loop included, which is how a game hung on its first frame is asked where it is. For such a game a step that ends in gdharness's runtime addon, as one past a function's last line does when the addon's _process runs next, is stepped on to the game's own script as a pause is; and since the engine reports every stop the same way, a step that stops on a line holding a breakpoint says onBreakpoint under held, whether the step ended there or ran into it.",
    parameters: {},
    requires: [],
    operations: {
      pause: {
        effect: 'additive',
        summary:
          "stop a game this server started where it is, answering with the stack. The game takes it between frames, and in a script every 2048 lines it runs, so a loop that sleeps between few lines can take seconds; the call waits thirty, and past that answers paused false with the request still standing. Stopped between frames, where no script runs, the game is stepped on to the next line of script it runs, and stopped in gdharness's runtime addon, an autoload whose _process runs first in every frame, on to the next line of the game's own script, for up to five seconds; one whose stack is still the addon's after them says so in a note",
        requires: [],
      },
      continue: { effect: 'additive', summary: 'resume after a breakpoint', requires: [] },
      step_over: { effect: 'additive', summary: 'run the current line', requires: [] },
      step_into: {
        effect: 'additive',
        summary: 'run the current line, stopping inside whatever it calls',
        requires: [],
      },
      step_out: {
        effect: 'additive',
        summary:
          'run to the end of the current function and stop in its caller; a game this server started only',
        requires: [],
      },
    },
  },
  {
    name: 'debug_state',
    title: 'Debugger state',
    description:
      "Where the debugged game is stopped: the stack trace, what is in scope at a frame with the values, or the debugger's console output so far, its last thousand lines, with any earlier ones counted under notShown. For a game this server started, its keeper's debugger answers: each frame names its script as the project spells it under script and on this machine under path, and held says which thread stopped and why. For a game the editor plays, the editor's debug adapter answers. A stop is reported by the editor's adapter only to the sessions connected when it happened, so a server that connected afterwards, which is every server after a reconnect, is shown a thread and no frames about a game still sitting at its breakpoint. That server asks the runtime instead: a held game accepts a connection and never answers, and the refusal then says held rather than running, and that the stack cannot be read from here. debug_control continue lets it go, and the next stop is one this session is told about, with its stack.",
    parameters: {
      frameId: {
        type: 'number',
        ops: ['variables'],
        description:
          'variables: which frame, from a stack answer. Default the innermost. A frame the stack no longer holds is refused, and a scope whose values did not arrive in time answers variables null and is named under valuesMissing.',
      },
    },
    requires: [],
    operations: {
      stack: { effect: 'read', summary: 'the stack trace', requires: [] },
      variables: {
        effect: 'read',
        summary: 'locals, members and globals at a frame, with their values',
        requires: [],
      },
      output: { effect: 'read', summary: 'console output captured through the debug adapter', requires: [] },
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

/** The longest description a client is sent; Claude Code cuts a tool's description beyond it. */
export const MOST_DESCRIPTION_CHARACTERS = 4096;

/** A tool's description as a client is sent it: the prose, its ops, and where its answer is described. */
function servedDescription(spec: ToolSpec): string {
  const answer =
    spec.answer === undefined
      ? ''
      : ' The tool reference in the gdharness skill, and the site, say what every field of the answer means.';
  return `${spec.description}${describeOperations(spec)}${answer}`;
}

/**
 * The sentence a parameter's served description ends with when only some of its tool's ops read it,
 * or '' when every op does.
 *
 * An op's line in the tool description names only what that op needs, so an optional argument read
 * by one op reached a client described as if every op took it. A session passed projectPath to
 * editor_launch close, which the schema it was sent gave no reason to doubt, and was refused.
 */
function onlyForOps(spec: ToolSpec, ops: readonly string[] | undefined): string {
  if (ops === undefined || Object.keys(spec.operations ?? {}).every((op) => ops.includes(op))) {
    return '';
  }
  return ops.length === 1 ? `Only for op ${ops[0]}.` : `Only for ops ${ops.join(', ')}.`;
}

/** The specs as the protocol carries them. */
export function buildToolDefinitions(): MCPToolDefinition[] {
  return TOOL_SPECS.map((spec) => {
    const properties: Record<string, JSONValue> = {};
    if (spec.operations) {
      properties['op'] = {
        type: 'string',
        enum: Object.keys(spec.operations),
        description: 'What to do.',
      };
    }
    for (const [name, schema] of Object.entries(spec.parameters)) {
      // `ops` is ours rather than JSON Schema's, and a client handed a key its validator does not
      // know is a client that may refuse the whole tool, so which ops read it goes into the text.
      const { ops, blank: _blank, ...carried } = schema;
      const only = onlyForOps(spec, ops);
      const said = carried['description'];
      properties[name] =
        only === ''
          ? carried
          : { ...carried, description: typeof said === 'string' ? `${said} ${only}` : only };
    }

    const required = [...spec.requires];
    if (spec.operations && !spec.defaultOperation) {
      required.unshift('op');
    }

    return {
      name: spec.name,
      title: spec.title,
      description: servedDescription(spec),
      inputSchema: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
      annotations: annotationsOf(spec),
    };
  });
}

/**
 * The hints a client decides from whether to ask before a call, for the most a call can do.
 *
 * Hints are per tool and ops are not, so a tool with one destructive op is destructive for every
 * call to it. Every tool works on the project, its editor, its game and this machine, never on
 * anything outside, which is what `openWorldHint` asks. Idempotence is left unclaimed: the spec
 * reads its absence as "not idempotent", the safe answer, and few of these would be anything else.
 */
function annotationsOf(spec: ToolSpec): ToolAnnotations {
  const effects = effectsOf(spec);
  const readOnly = effects.every((effect) => effect === 'read');
  return {
    readOnlyHint: readOnly,
    ...(readOnly ? {} : { destructiveHint: effects.includes('destructive') }),
    openWorldHint: false,
  };
}
