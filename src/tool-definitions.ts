/**
 * The tool surface: a few dozen tools, each shaped like a task rather than an engine call.
 *
 * A tool that does several related things takes an `op`. Which arguments each op needs is
 * written once, in `operations`, and read twice: rendered into the description the client
 * sees, and enforced before dispatch, so the two cannot drift. Every schema refuses arguments
 * it does not name, an unknown op is refused with the valid set spelled out, and so is a value
 * outside the set its parameter lists, because a silent default is how a wrong call reads as a
 * working one.
 *
 * Every client carries the whole list on every call, so the text is short: what a tool and each op
 * does, and what a first correct call needs. What a caller learns from a refusal is said by the
 * refusal, and what the answer's fields mean is in `answer`, which the reference carries and the
 * list does not. `test/regressions.ts` holds the size of the list.
 */

import type { JSONValue, Tool, ToolAnnotations } from '@modelcontextprotocol/server';
import { dictionary } from './dictionary.js';
import { IDLE_CLOSE_MINUTES, IDLE_CLOSE_SETTING } from './idle-close.js';
import { HIDDEN_WINDOW_FPS } from './launch.js';

export type MCPToolDefinition = Tool;

type JsonSchema = Readonly<Record<string, JSONValue>>;

/**
 * A parameter's schema, and which ops read it.
 *
 * `ops` is what makes an argument belong to some of a tool's ops rather than all of them. A tool
 * refuses an argument nothing names. Without this it took one named for a different op and threw
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
   * What the fields of the answer mean, and what the call does past what a first call needs.
   * Rendered in the skill's tool reference and on the site, and not in the description a client is
   * sent, which every client carries on every call.
   */
  readonly answer: string;
  /**
   * What the tool leaves changed, for the reference, when its effect alone would mislead. A test
   * run is additive to a client, and it still rewrites the class cache and adds `.uid` files.
   */
  readonly changes?: string;
  readonly parameters: Readonly<Record<string, Parameter>>;
  /** Arguments every call needs, whatever the op. */
  readonly requires: readonly string[];
  /** The op assumed when none is given. Absent means op is required. */
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
  return calls.toSorted();
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
 * Built once and rendered into the skill and the tool reference, because it was written in each
 * of those separately and each said a different amount of it: the reference said those tools "pick
 * between running games" and stopped, and `projectPath` said "not needed with one game", which says
 * nothing about two. A session with another project's game listed beside its own read both and
 * could not tell what was answering it. What decides is in `chooseRuntime` and in `ownGameAmong`
 * above it, so the sentence is one and the order is theirs. The argument carries
 * `THE_GAME_PICKED_IN_SHORT`, since the tool list is paid for on every call.
 */
export function theGamePicked(): string {
  return (
    'A call naming neither `projectPath` nor `pid` goes to the game this server started or is ' +
    'playing, named under `answeredBy` when others run too. Failing that, it goes to the only game ' +
    'running. Otherwise the call is refused. The refusal names every game and the argument that ' +
    'tells them apart: `pid` within one project, `projectPath` across projects.'
  );
}

/** The order of `theGamePicked` in one sentence, for the running-game `projectPath` of every tool. */
export const THE_GAME_PICKED_IN_SHORT =
  'Without it or pid, the call goes to the game this server started or plays, else to the only game running.';

const PROJECT_PATH: JsonSchema = {
  type: 'string',
  description: 'Absolute path.',
};
const RUNNING_PROJECT_PATH: JsonSchema = {
  type: 'string',
  description: `Which game, when several run: its project folder. ${THE_GAME_PICKED_IN_SHORT}`,
};
const RUNNING_PID: JsonSchema = {
  type: 'number',
  description: 'Which game, when several run from one project: its process id.',
};
const SCENE_PATH: JsonSchema = {
  type: 'string',
  description: 'Scene file, such as "scenes/main.tscn".',
};
/** How the scene and resource tools answer when no editor serves the project. */
export const WITHOUT_AN_EDITOR =
  'Goes through the editor when one serves the project, and otherwise through a headless engine. writtenBy (readBy for a read) says which.';
/** What a call answers of the class list it brought up to date before its engine ran. */
const CLASSES_REBUILT = 'A class_name missing from the class list is added first, under classesRebuiltFirst.';
/** What a scene write says it saved on nodes it was not asked to change. */
export const ALSO_SAVED =
  'A scene is saved as the engine holds it once loaded, so one not last saved by an editor can gain or lose lines on any node. alsoSaved lists each.';
/** What a run says about the imports it brought up to date before it started. */
const IMPORTED_FIRST =
  "importedFirst names the files imported before the run because their import was behind, and uidsWrittenFirst the scripts given a .uid. importTookMs is outside the run's time limit.";
const WHOLE_NUMBERS =
  'A whole number of 2^53 or more is written {"_type": "int", "value": "9007199254740993"}.';
const SCRIPT_PATH: JsonSchema = {
  type: 'string',
  description: 'Script file inside the project, such as "scripts/player.gd".',
};
const RESOURCE_FILE = 'File inside the project, such as "sprites/hero.png" or "materials/steel.tres".';
/** The platforms project_export add_preset takes, by the names export_presets.cfg gives them. */
export const EXPORT_PLATFORMS: readonly string[] = [
  'Windows Desktop',
  'Linux',
  'macOS',
  'Android',
  'iOS',
  'Web',
];
const RESOURCE_PATH: JsonSchema = { type: 'string', description: RESOURCE_FILE };
const NODE_PATH: JsonSchema = {
  type: 'string',
  description: 'Node path from the scene root, such as "Player/Sprite2D". "." is the root.',
};
const PROPERTIES: JsonSchema = {
  type: 'object',
  description: `Properties to set, keyed by Godot name. Vectors are {"x": 1, "y": 2}, a colour may be "#ff8000", "position:x" sets one component. A node property takes a path such as "../Player", a Resource property a res:// path or {"_type": "CircleShape2D", "radius": 8}. "script" attaches first, "metadata/key" adds metadata and null removes it. ${WHOLE_NUMBERS}`,
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
    'add_track: the track to add, of type property or method. remove_track: the track to take out, as read answers it.',
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
    },
    nodePath: {
      type: 'string',
      description:
        'Target node, relative to the AnimationPlayer\'s root_node. A property track also takes "Sprite2D:position" in place of property.',
    },
    property: { type: 'string', description: 'Property tracks: the property to animate.' },
    update: { type: 'string', enum: ['continuous', 'discrete', 'capture'] },
    interpolation: {
      type: 'string',
      enum: ['nearest', 'linear', 'cubic', 'linear_angle', 'cubic_angle'],
      description: 'Default linear.',
    },
    loopWrap: { type: 'boolean' },
    method: {
      type: 'string',
      description: 'Method tracks: the method to call. remove_track: only the keys calling it.',
    },
    keyframes: {
      type: 'array',
      description: 'add_track: the keys, each at its own time.',
      items: {
        type: 'object',
        properties: {
          time: { type: 'number', description: 'Seconds.' },
          value: { description: 'Property tracks: the value.' },
          transition: { type: 'number', description: 'Property tracks: easing to the next key. Default 1.' },
          args: { type: 'array', description: 'Method tracks: the arguments.' },
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
  description: 'Additions to make, in order.',
  items: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['add_function', 'add_variable', 'add_signal', 'add_constant', 'add_enum'],
      },
      name: { type: 'string' },
      values: {
        type: 'array',
        items: { type: 'string' },
        description: 'Enums: the members, each a name or "FLEE = 5".',
      },
      params: { type: 'string', description: 'Functions and signals: the parameters, "delta: float".' },
      returnType: { type: 'string' },
      body: {
        type: 'string',
        description: 'Functions: the lines separated by \\n.',
      },
      varType: { type: 'string', description: 'Variables and constants: the type annotation.' },
      defaultValue: {
        type: 'string',
        description: 'Variables and constants: the value as GDScript writes it. A constant needs one.',
      },
      isExport: {
        type: 'boolean',
        description: 'Variables: add @export. Default true with exportHint or exportGroup.',
      },
      exportHint: {
        type: 'string',
        description: 'Variables: "range(0, 100)" for @export_range(0, 100).',
      },
      exportGroup: {
        type: 'string',
        description: 'Variables: the inspector group, such as "Stats/Loot".',
      },
      isOnready: { type: 'boolean' },
      isStatic: { type: 'boolean' },
      position: {
        type: 'string',
        enum: ['end', 'after_ready', 'after_init'],
        description: 'Functions: where to insert. Default end.',
      },
    },
    required: ['type', 'name'],
    additionalProperties: false,
  },
};

const INPUT_EVENTS: JsonSchema = {
  type: 'array',
  description: 'The events that trigger the action, each bound to every device.',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['key', 'mouse_button', 'joypad_button', 'joypad_motion'] },
      keycode: { type: 'string', description: 'Keys: the key name, such as "Space" or "W".' },
      button: {
        type: 'number',
        description:
          'Mouse and joypad buttons. Mouse: 1 left, 2 right, 3 middle, 4 to 7 the wheel, 8 and 9 the side buttons. Joypad: the button index, 0 being A.',
      },
      axis: {
        type: 'number',
        description:
          'Joypad axes: the index, 0 and 1 the left stick, 2 and 3 the right, 4 and 5 the triggers.',
      },
      axisValue: { type: 'number', description: 'Joypad axes: -1 or 1.' },
      ctrl: { type: 'boolean' },
      alt: { type: 'boolean' },
      shift: { type: 'boolean' },
      physical: { type: 'boolean', description: 'Keys: bind by key position rather than what it types.' },
    },
    required: ['type'],
    additionalProperties: false,
  },
};

const TILESET_SOURCES: JsonSchema = {
  type: 'array',
  description: 'Atlas sources, one per texture. A path that already exists is refused.',
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
  description: 'Cells to place. A cell named twice takes its last entry.',
  items: {
    type: 'object',
    properties: {
      coords: XY,
      sourceId: { type: 'number', description: 'TileSet source id, or -1 to erase the cell.' },
      atlasCoords: { ...XY, description: 'The tile in the source. Not needed to erase.' },
      alternativeTile: { type: 'number' },
    },
    required: ['coords', 'sourceId'],
    additionalProperties: false,
  },
};

const COLOUR: JsonSchema = {
  type: ['object', 'string'],
  description: 'r, g and b from 0 to 1 with a optional, or an html code such as "#ff8000".',
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
      'The project name, main scene and Godot version, with counts of its scenes, scripts and assets. Optional sections go on top. ' +
      CLASSES_REBUILT,
    answer:
      'Assets are images, fonts, sound, models, video and shaders, and other counts every remaining file. No count includes the .import and .uid files beside others, the addons gdharness installed, a file in a folder holding a .gdignore or its own project.godot, or one behind a link out of the project. ' +
      "classes lists each class_name with its script, read from the files. Those an addon declares are counted per addon under inAddons, unless addonClasses names the addon. input_actions lists the project's actions with their events, and an engine ui_ action only when the project rebinds it, as engineAction. export_presets marks as runnable the one preset of its platform the editor's one-click deploy uses. " +
      'health and validation name each script that fails with its first error, each missing file a scene, resource or script refers to, each input action a script reads by a literal name that nothing defines, with every line reading it, and each scene connection whose method or signal the node at its end lacks or whose argument count does not fit. ' +
      "health's score starts at 100 and loses each finding's weight, 15 for a missing main scene and 5 for a broken connection. Its grade is A from 90 down to F below 60, so a failed check can still grade A. Notes such as TODO under addons/ are left out.",
    parameters: {
      projectPath: PROJECT_PATH,
      include: {
        type: 'array',
        items: { type: 'string', enum: [...PROJECT_INFO_SECTIONS] },
        description:
          'Extra sections. health and validation compile every script and report broken scripts, missing files, unknown input actions, broken connections and export problems. health adds a score.',
      },
      addonClasses: {
        type: 'array',
        items: { type: 'string' },
        description: 'For classes: addon folders under res://addons whose classes are listed, not counted.',
      },
      preset: { type: 'string', description: 'For validation: the export preset to validate against.' },
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'full adds what to do about it to each validation finding. Needs validation in include.',
      },
    },
    requires: ['projectPath'],
  },
  {
    name: 'project_settings',
    title: 'Project settings',
    description:
      'Reads or writes project.godot (settings, autoloads, the main scene, input actions and plugins) and the audio bus layout. A write with an editor open on the project goes through the editor.',
    answer:
      "get answers exists, true for any setting the engine knows, at_default, true when the value is the engine's own default and so has no line in project.godot, default_value, that default, when it is not at it, and overrides, the value each feature's override holds. Each setting under prefix carries at_default too, and default_value when it is not at it. at_default is absent for a setting with no engine default, such as an input action the project added. An override answers override_of, its base setting, and one project.godot does not set answers exists false with holds, the base setting's value. A setting an override file sets is answered with the project's value and overridden_in, the file and the value a run reads. " +
      "set answers old_value and new_value, with was_new true when project.godot did not set the setting before, and was_default true when what it held was the engine's own default, which old_value then is. It adds overrides with overridesNote when a feature's override still replaces the setting, and overriddenNote when an override file does. A set that writes nothing answers unchanged true and saved false. " +
      "unset answers removed, old_value and default_value, the value that holds now. default_value is null for a setting the engine does not declare. unset of an override, such as name.feature, also answers override_of and holds, the base setting's value that builds with the feature now read. On a setting the file does not set, unset answers removed false, its note naming the nearest settings when the engine does not declare it either. " +
      'add_input_action on an existing action replaces its events, and its deadzone when one is given, and answers was_new false with old_events and old_deadzone. add_autoload on a name already registered replaces its entry and answers action updated with old_path. ' +
      "Every write changes only the lines of the settings it names, apart from the header comment and config_version. An enabled plugin's code loads on the editor's next start. " +
      "editorNote, on any write, is an editor that could not take the write, or one on another release's addon that was not asked. That editor still holds the old values until editor_launch restart. " +
      'rename_audio_bus answers resent, the buses sending to the old name, rewritten, the scene and resource lines giving a node the old bus, and namedInScripts, the scripts naming it in a string, which are left as they are. add_audio_bus lists every bus after the new one moves.',
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
          'Where to read. disk (default) reads project.godot. editor asks the open editor, unsaved changes included.',
      },
      prefix: {
        type: 'string',
        ops: ['get'],
        description:
          'Answer every setting whose name starts with this, such as "debug/gdscript/warnings/", instead of one.',
      },
      value: {
        blank: true,
        ops: ['set'],
        description:
          'The value, fitted to the registered type: an enum takes its name or number, vectors are {"x": 1, "y": 2}, a colour may be "#ff8000". An undeclared setting is written as given, so a packed array is tagged {"_type": "PackedStringArray", "value": ["res://a/"]}.',
      },
      name: {
        type: 'string',
        ops: ['add_autoload', 'remove_autoload'],
        description: 'A name already registered is replaced.',
      },
      path: {
        type: 'string',
        ops: ['add_autoload'],
        description: 'Script or scene inside the project.',
      },
      enabled: {
        type: 'boolean',
        ops: ['add_autoload', 'set_audio_bus_effect'],
        description: 'set_audio_bus_effect: whether the effect is on. Default true.',
      },
      global: {
        type: 'boolean',
        ops: ['add_autoload'],
        description: 'Make the name a global variable. Default true.',
      },
      scenePath: { ...SCENE_PATH, ops: ['set_main_scene'] },
      actionName: {
        type: 'string',
        ops: ['add_input_action', 'remove_input_action'],
        description: 'Such as "jump".',
      },
      events: { ...INPUT_EVENTS, ops: ['add_input_action'] },
      deadzone: {
        type: 'number',
        ops: ['add_input_action'],
        minimum: 0,
        maximum: 1,
        description: "Default: the rebound action's, or 0.5.",
      },
      pluginName: {
        type: 'string',
        ops: ['enable_plugin', 'disable_plugin'],
        description: 'Folder under addons/.',
      },
      busName: {
        type: 'string',
        ops: ['add_audio_bus', 'remove_audio_bus', 'rename_audio_bus'],
        description: 'The audio bus.',
      },
      newBusName: {
        type: 'string',
        ops: ['rename_audio_bus'],
        description: 'The name the bus takes. Buses sending to it follow.',
      },
      sendTo: {
        type: 'string',
        ops: ['set_audio_bus_send'],
        description: 'The bus to send to, one before this bus.',
      },
      parentBusIndex: {
        type: 'number',
        ops: ['add_audio_bus'],
        description: 'The bus to send to. Default 0, Master.',
      },
      busIndex: {
        type: 'number',
        ops: ['set_audio_bus_effect', 'set_audio_bus_volume', 'set_audio_bus_send'],
        description: 'The audio bus, by index.',
      },
      effectIndex: {
        type: 'number',
        ops: ['set_audio_bus_effect'],
        description: 'Slot on the bus: the effect there is replaced, and one past the last adds one.',
      },
      effectType: {
        type: 'string',
        ops: ['set_audio_bus_effect'],
        description: 'Effect class, such as "AudioEffectReverb".',
      },
      volumeDb: { type: 'number', ops: ['set_audio_bus_volume'], description: 'Volume in decibels.' },
      mute: { type: 'boolean', ops: ['set_audio_bus_volume'], description: 'Mute the bus, or unmute it.' },
      solo: {
        type: 'boolean',
        ops: ['set_audio_bus_volume'],
        description: 'Solo the bus, silencing every bus not soloed.',
      },
      bypassEffects: {
        type: 'boolean',
        ops: ['set_audio_bus_volume'],
        description: "Pass the sound by the bus's effects.",
      },
    },
    requires: ['projectPath'],
    operations: {
      // Neither is required because either will do, and which one is missing is a better refusal
      // than a list of both: the engine answers that, since it is what reads them.
      get: { effect: 'read', summary: 'read one setting, or every setting under prefix', requires: [] },
      set: { effect: 'destructive', summary: 'write one setting', requires: ['setting', 'value'] },
      unset: {
        effect: 'destructive',
        summary: 'take a setting out, so the engine default holds',
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
        summary: 'remove an input action',
        requires: ['actionName'],
      },
      enable_plugin: { effect: 'destructive', summary: 'enable an addon', requires: ['pluginName'] },
      disable_plugin: { effect: 'destructive', summary: 'disable an addon', requires: ['pluginName'] },
      add_audio_bus: { effect: 'additive', summary: 'add an audio bus', requires: ['busName'] },
      remove_audio_bus: {
        effect: 'destructive',
        summary: 'remove an audio bus',
        requires: ['busName'],
      },
      set_audio_bus_effect: {
        effect: 'destructive',
        summary: 'put an effect in a slot on a bus',
        requires: ['busIndex', 'effectIndex', 'effectType'],
      },
      set_audio_bus_volume: {
        effect: 'destructive',
        summary: "set a bus's volume, mute, solo or bypass",
        requires: ['busIndex'],
      },
      rename_audio_bus: {
        effect: 'destructive',
        summary: 'rename an audio bus, with the sends naming it',
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
      'Searches text or a regular expression across project files and answers file paths with line numbers, one entry per matching line. A line over 400 characters is cut around its first match. Dot names, addons gdharness installed, and folders holding a .gdignore or their own project.godot are skipped.',
    answer:
      'total_matches counts the matching lines, however often each holds the query. Past maxResults truncated is true, and the summary still counts the whole search. A line cut to the 400 characters around its first match carries shownFrom, the column they start at, and lineLength, the length of the whole line. not_searched names each skipped folder or link the search passed, a link out of the project or to a folder the search is inside among them. A path naming a skipped folder is searched as asked, and note says the whole-project search steps over it. When no file searched has one of fileTypes, note names the extensions there are.',
    parameters: {
      projectPath: PROJECT_PATH,
      query: { type: 'string', description: 'The text or pattern to find.' },
      path: {
        type: 'string',
        description:
          'A folder or file inside the project to search, such as "res://src". Default: the whole project.',
      },
      fileTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extensions to search, such as ["gd", "tscn"]. Default: every text file.',
      },
      regex: { type: 'boolean', description: 'Read the query as a regular expression. Default false.' },
      caseSensitive: { type: 'boolean', description: 'Default false.' },
      maxResults: {
        type: 'integer',
        minimum: 1,
        description: 'How many matching lines to answer. Default 100.',
      },
    },
    requires: ['projectPath', 'query'],
  },
  {
    name: 'project_dependencies',
    title: 'Project dependencies',
    effect: 'read',
    description: `What a resource depends on, or what depends on it. ${CLASSES_REBUILT}`,
    answer:
      "forward lists each file this one loads or names by its path, with kind: ext_resource, extends, preload, load, include, or path for a path only written in a string, which the file may never load. A reference closing a cycle is marked circular, with the cycle under circular_references. A script's dependencies include every script whose class_name it uses, marked by_class, and the script of every autoload it names, marked by_autoload. An ext_resource whose uid names another file than its path is followed to that file, as the engine loads it, with the path under stale_path. One whose uid names no file is followed by its path, with the uid under unknown_uid. A load or preload of an unknown uid is listed under that uid as missing. A shader's #include is followed relative to the shader. A file the depth stops at carries beyond_depth, how many files it names that were not walked. A file's dependencies are listed at its first entry, and later entries carry dependencies_listed_above. summary.total_dependencies counts each file reached once, total_references counts the entries in the tree, and missing names each file referenced that does not exist, with the files referring to it. " +
      'reverse lists every file that refers to this one and how, for a file that is gone too, answered with exists: false. It covers a scene instancing it, a script extending, preloading or loading it, every use of its class_name, and every use of its autoload name, marked autoload. ext_resource, extends, preload, load, include and path mark a reference by path, with stale_path or unknown_uid as forward has them. setting, plugin, export_preset and import mark one in project.godot, a plugin.cfg, export_presets.cfg or an import sidecar. class_name marks a use of the declared name. Three kinds are not uses: doc, a name in a ## comment, comment, one in ordinary prose, and stale_path as a kind, an ext_resource naming it by a path the engine does not load. A file claiming the same uid is listed under shares_uid, since the engine loads only one file per uid. summary.in_code counts the uses with those left out, which is the number to read when asking whether anything still uses this.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: RESOURCE_PATH,
      direction: {
        type: 'string',
        enum: ['forward', 'reverse'],
        description:
          'forward: what this resource loads, as a tree. reverse: every file that refers to it. Default forward.',
      },
      depth: {
        type: 'integer',
        minimum: 1,
        description:
          'forward: levels to follow. Default unlimited, which can answer a megabyte. 2 or 3 stays near.',
      },
      includeBuiltin: {
        type: 'boolean',
        description: "forward: include the engine's own res://. resources. Default false.",
      },
      fileTypes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'reverse: extensions to look in, plus "godot", "cfg" and "import" for those files. Default all.',
      },
    },
    requires: ['projectPath', 'resourcePath'],
  },
  {
    name: 'project_import',
    title: 'Asset imports',
    description:
      'The import pipeline: what needs importing, how a resource is imported, reimports, UIDs, and the global class list the editor and the engine read.',
    answer:
      "options answers remap, deps and params as the .import file holds them, so an enum option such as compress/mode is its number: the engine gives scripts no list of a built-in importer's options or of what the numbers mean, so Godot's documentation of that importer is where a number is looked up. reimport is answered from a second status read: reimported lists what is current now, notReimported what is not, one entry per status and reason with the paths sharing them, and via says which of the two did the work. importedByTheScan names what the editor's scan imported first, and alsoImported, on a reimport of one resourcePath, the others it imported. wroteInProject names, by source, what an import wrote into the project itself rather than under .godot, such as the .translation a CSV gives each language, which version control sees and internationalization/locale/translations names. The import gives every script without a .uid sidecar one, as the editor's scan does, and uidsWritten names those scripts, counted per addon under uidsWrittenInAddons for the ones inside an addon. When nothing needed reimporting, the two lists are empty, a note says so, and there is no via. A whole-project reimport also answers missingSource, the .import files whose source is not beside them, empty when there are none, even when nothing needed reimporting. One resourcePath leaves it out. stillImporting is an editor that had not finished within timeoutMs. " +
      'status judges by content, with the checks the editor makes before a reimport: a sidecar changed since its import, a sidecar with no uid or written for another file, an output under .godot/imported that is gone (missing_outputs) or changed, and a source whose hash differs from the recorded one. A glTF scene built before an image it names was imported is named under imported_without. failed is an import that failed, which the editor never retries on its own. ' +
      'set_options answers changed, each option written as {was, now}, unchanged_options for the ones already holding the value, and nothing is written or reimported when none changed. A dictionary option keyed by numbers, such as a font\'s opentype_features, takes its keys as strings of digits, and opentype_features also takes a four-letter OpenType tag: {"opentype_features": {"liga": 0}} turns ligatures off. Its reimport is answered under reimport as op reimport answers. ' +
      "refresh_classes answers added, and for a running editor unseenByEditor (a class it cannot resolve), heldBehindInEditor (one it holds from an older text) and lostSinceLastRebuild (one the editor's own save dropped from the cache, until it restarts). staleInThisEngine names a class the rebuild added that the autoloads' engine did not know. twiceDeclared names a class several scripts declare, so rename it in all but one. unreadableList says the old list could not be read and every class was added. " +
      'refresh_uids names under uidsCreated the sidecars it made, under uidsCached the files the cache newly took, and under stillWithoutUid the ones the engine would not import. It writes no scene and no script.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: { ...RESOURCE_PATH, ops: ['status', 'options', 'set_options', 'uid', 'reimport'] },
      includeUpToDate: {
        type: 'boolean',
        ops: ['status'],
        description: 'List resources that are current as well. Default false.',
      },
      options: {
        type: 'object',
        ops: ['set_options'],
        description: 'Import options keyed as the .import file spells them, {"compress/mode": 1}.',
        additionalProperties: true,
      },
      importer: {
        type: 'string',
        ops: ['set_options'],
        description:
          "The importer to switch to, such as image. The file's options go back to its defaults first.",
      },
      reimport: {
        type: 'boolean',
        ops: ['set_options'],
        description: 'Reimport afterwards. Default true.',
      },
      force: {
        type: 'boolean',
        ops: ['reimport'],
        description: 'Reimport even what is current. Default false.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        ops: ['reimport', 'set_options'],
        description: 'How long to wait for the editor to finish reimporting. Default 300000.',
      },
    },
    requires: ['projectPath'],
    operations: {
      status: {
        effect: 'read',
        summary: 'which resources are outdated or failed, or one with resourcePath, each with its reason',
        requires: [],
      },
      options: { effect: 'read', summary: 'the import options of one resource', requires: ['resourcePath'] },
      set_options: {
        effect: 'destructive',
        summary: 'change import options or the importer in the sidecar, then reimport that resource',
        requires: ['resourcePath'],
      },
      reimport: {
        effect: 'destructive',
        summary: 'reimport what status says is outdated or failed, or one resource with resourcePath',
        requires: [],
      },
      uid: {
        effect: 'read',
        summary: 'the UID of one file and where it was read. A file with none answers uid null',
        requires: ['resourcePath'],
      },
      refresh_uids: {
        effect: 'additive',
        summary: 'give every script and shader a .uid sidecar and fill the uid cache',
        requires: [],
      },
      refresh_classes: {
        effect: 'destructive',
        summary: 'rewrite the class list from the class_name declarations on disk',
        requires: [],
      },
    },
  },
  {
    name: 'project_export',
    title: 'Export',
    description:
      "Export presets and exports. add_preset writes a preset to export_presets.cfg with its platform's default options. A secret option is never answered. list shows every preset, with its options when preset is given. run imports what changed on disk, then exports.",
    answer:
      "add_preset writes the keys the editor's Project > Export writes for a new preset, and every option a new preset of its platform shows at its default, and makes it the platform's runnable preset when the platform has none. set_preset answers under changed what each value held before and holds now, and under unchanged what already held the value given. saved is false when nothing changed, and nothing is written when any of it is refused. Option names are the exporter's own, as the Export dialog's Options tab shows them, such as binary_format/embed_pck. An enum takes the name the dialog shows or its number. An option the dialog shows only while another is on, such as codesign/identity behind codesign/enable, is taken when the preset has that one on or the same call turns it on. A secret option, such as a signing password, is written to .godot/export_credentials.cfg, where the editor keeps secrets out of the committed file. A file an option names that is not there is written and listed under missing_files, or for a secret under secretsNamingNoFile. " +
      "exportFilter's dependencies are what the engine counts as them, so a file named only in a string, such as a scene path in an exported property, or a script reached only by its class_name, is left out of the export, though project_dependencies lists both. " +
      "remove_preset names under runnableNow the next preset of the platform that becomes runnable, or null, and takes a secret the preset held with it. A preset op answers where this engine's export templates belong and whether the preset's platform has them, and list says so for every preset. An editor open on the project does not see a preset added this way until it restarts. " +
      'run names under importedFirst what it imported first. A preset with shader_baker/enabled on, whose platform draws with Forward+ or Mobile, is exported by an editor drawing with that renderer, named under bakedWith, since a headless one bakes no shader. On Windows that editor draws out of sight. Elsewhere its window shows, which showWindow allows. run answers bytes, the size of the output, and alsoWritten, what the export wrote beside it, such as the .pck a Windows or Linux build needs. Its entries are the newest two hundred distinct errors and warnings it printed, one printed more than once carrying times, and errors and warnings count them. exported is true only when this run wrote the output and printed no error.',
    parameters: {
      projectPath: PROJECT_PATH,
      preset: {
        type: 'string',
        ops: ['list', 'run', 'add_preset', 'set_preset', 'remove_preset'],
        description:
          "Preset name from export_presets.cfg. add_preset: the name of the new one. list: answers this preset's options too.",
      },
      platform: {
        type: 'string',
        ops: ['add_preset'],
        enum: [...EXPORT_PLATFORMS],
        description: 'The platform the preset exports for.',
      },
      outputPath: {
        type: 'string',
        ops: ['run', 'add_preset', 'set_preset'],
        description: 'Where the export is written, inside the project. A missing folder is created.',
      },
      debug: { type: 'boolean', ops: ['run'], description: 'A debug export. Default false.' },
      showWindow: {
        type: 'boolean',
        ops: ['run'],
        description:
          "Linux and macOS: let a preset that bakes shaders export with the editor's window showing.",
      },
      pack: {
        type: 'boolean',
        ops: ['run'],
        description:
          'Export the resources alone, as a .pck or .zip by outputPath, with no templates. Not with debug.',
      },
      exportFilter: {
        type: 'string',
        ops: ['set_preset'],
        enum: ['all_resources', 'scenes', 'resources', 'exclude'],
        description: 'What the preset exports. All but all_resources use files.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        ops: ['set_preset'],
        description: 'The files the filter lists, as res:// paths.',
      },
      includeFilter: {
        type: 'string',
        ops: ['set_preset'],
        description:
          'Non-resource files to export too, as comma-separated patterns such as "*.json, data/*".',
      },
      excludeFilter: {
        type: 'string',
        ops: ['set_preset'],
        description: 'Files to leave out, as comma-separated patterns such as "*.txt".',
      },
      customFeatures: {
        type: 'string',
        ops: ['set_preset'],
        description: 'Custom feature tags the export carries, comma-separated.',
      },
      options: {
        type: 'object',
        ops: ['set_preset'],
        description: 'Platform options by name, such as {"binary_format/embed_pck": true}.',
      },
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
      set_preset: {
        effect: 'destructive',
        summary: "change a preset's path, filters and options",
        requires: ['preset'],
      },
      remove_preset: {
        effect: 'destructive',
        summary: 'take a preset out of export_presets.cfg',
        requires: ['preset'],
      },
    },
  },
  {
    name: 'project_test',
    title: 'Run tests',
    effect: 'additive',
    changes: 'Writes under `.godot` and adds `.uid` files. Changes no script or scene.',
    description:
      "Runs the project's gdUnit4 suites and answers with every case that did not pass, where it is and what its assertion said. Needs gdUnit4 under addons/gdUnit4.",
    answer: [
      'passed is the verdict to read.',
      '',
      'A user:// of its own is made for the run on Windows and Linux and goes when the run ends. On macOS the engine reads user:// off HOME, so the run writes where the player keeps theirs. A script that does not load stops gdUnit4 before any suite runs, and an autoload that does not compile stops the run at once. A client sending a progress token is told as each suite finishes, and at least every twenty seconds. A run whose every case passed is still not called passed when it printed a script error no case failed on, since gdUnit4 fails a case only on the script errors its logger sees, and it cannot see a stack overflow.',
      '',
      '- failed: one entry per case that did not pass, with its first report as message and detail. A case with more than one report has them all under reports, in the order the case met them. gdUnit4 goes on past a failed assertion, and a case can fail several and then stop on a runtime error, which makes its status error. Identical reports fold into one with times. At most twenty different ones are kept (reportsLeftOut counts the rest), and past about a megabyte the largest cases keep only their first message (failedWithoutDetail).',
      '- failures and errors: failures counts the cases that failed an assertion and errors the cases that hit an error, so such a case counts in both.',
      "- exitCode: the engine's own exit, gdUnit4's code for what it saw (100 a case failed, 101 only warnings, 105 script errors it detected). It is 0 beside passed false when the run is failed for something gdUnit4 does not judge, such as an engine error no suite declared.",
      "- time: gdUnit4's own sum of the seconds its cases took, from its report.",
      "- tookMs: the whole call in milliseconds, from the class rebuild to the engine's exit, which is what a caller waits for. tookMsBy splits it into the class rebuild (classes), the import after it (import) and the engine running the suites (engine), each with any wait for an engine slot or the editor's scan in it. Within engine, engineStart is what the engine spent before its first suite and engineCompile the part of it compiling the suites, which no case's time holds. A call that waited a second or more for slots in all is answered with an engine_slot_wait block giving waitedMs and who held them.",
      "- engineEntries: identical engine messages come back once, with times saying how often they were printed, and with script, line and function for the project script one points at, as editor_output's entries have. An engine message keeps the frames above gdUnit4, not the twenty inside it.",
      '- undeclaredErrors: each engine error that no suite declared in its GDHARNESS_EXPECTED_ERRORS constant, and each engine warning a suite printed and did not declare in its GDHARNESS_EXPECTED_WARNINGS, marked warning true, with the suite and the case that printed it. The run is judged as gdharness test judges it. gdUnit4 does not fail a case on push_error, push_warning or an engine error unless the project turns on its report/godot/push_error setting, so a case that printed one undeclared is otherwise in neither failed nor errors. It is named here, and the run is failed for it. With that setting on, gdUnit4 fails the case on each one, declared or not, and the note names those cases. One printed inside assert_error(...).is_push_error(...) or is_push_warning(...) passes there, and is declared all the same.',
      '- declaredNotPrinted: each declared error or warning its case did not print. A declared text must be the whole line after ERROR: or WARNING: and its space, so a longer one its case printed holding the text is named under printedInstead. Either fails the run, and each suite holding one is listed with its count.',
      '- engineErrors: every engine error the run printed but those a suite declared.',
      '- leakedAtExit: the engine\'s lines saying it exited still holding objects, resources, memory pages or a server\'s RIDs, which fail the run too. The note names any script of the project Godot itself never frees and, on a run with engineArgs ["--verbose"], what the engine held.',
      '- orphans: the total of the orphan nodes gdUnit4 counted. Each suite that left some has its count, and a warning saying how to free them, under warnings. left names each case that left some and the nodes, by class, name and script. A hook\'s are under before or after, or the one value "before or after" where no case began and the two cannot be told apart. gdUnit4 decides its verdict on orphans and keeps them out of its report, so they are read off what it printed.',
      '- suites: only the suites with something to say (a case that failed, erred or was skipped, a hook that failed, orphans, or an error undeclared or declared and not printed). suitesPassed counts the rest.',
      '- hookFailures: a before() or after() that failed, with its suite, line and whole message. failures and errors count cases and leave it out, so the verdict names it as failed hooks. The cases after a failed before() still run and are counted.',
      '- scriptErrors: the errors in full of a script that did not load, or of an autoload that did not compile. The scripts that failed only because one they depend on did are listed by path under failedThroughDependency. When they failed on a class whose own script has a parser error, which gdUnit4 never names, the engine checks that script and its error comes first, with the class it declares under declares. The errors a script has only because that class did not resolve, which the engine reads as Variant, are kept apart under followFromUnresolved.',
      "- uncaughtScriptErrors: the script errors no case failed on, which keep the run from being called passed. They are under engineEntries too, by index with detailUnder rather than with their backtrace a second time. A backtrace that repeats, as a recursion's does, has each repeated frame or cycle of frames written once with the frames it covers and how many times. One raised inside assert_error(...).is_runtime_error is the test's own and is not listed, and none are when the project turns off gdUnit4's report/godot/script_error setting. A suite declares them all the same.",
      '- suitesFinished, suitesFailing and suiteRunning: for a run that ends without a report, at its timeout or otherwise, the suites it finished, the failing ones with their failed cases, and the one it was in.',
      '- previousRunCut: a run a client cut off, kept in the project and carried by the next project_test there.',
      "- classes: the class rebuild's answer. The classes each addon declares are counted under addedInAddons and changedInAddons rather than named. A class the rebuild puts back that the cache had after the last rebuild is named under classes.lostSinceLastRebuild, which is the editor writing its shorter list over the file on every save until restarted.",
      '- uidsMissing: each suite the run ran with no .uid beside it, with uidsNote.',
      "- engineNote: the engine the run used and its version, when it was not this server's. A project other than the server's own runs the engine its harness config names under GODOT_PATH.",
      "- savesNote: on macOS, that the run wrote to the player's own user://.",
      '- windowed and windowNote: a suite needs a window when it declares const GDHARNESS_NEEDS_WINDOW: bool = true, or as a constant of a class that is true, or calls scene_runner and declares nothing. One declaring const GDHARNESS_ACCESSIBILITY: bool = true needs a window too. Its engine starts with --accessibility always, which makes Godot build the accessibility tree. On Windows the run also asks for the tree through UI Automation before its first suite, since only then does the engine send NOTIFICATION_ACCESSIBILITY_UPDATE. A run holding one has a window, at the size project.godot gives its viewport and with no sound, and windowed is true, on a desktop of its own on Windows. windowNote names those suites and any saying it runs headless whose every case was left out of a run that had a window. engines is 2 when the set mixed windowed and headless suites and ran as two engines, the windowed one first, with the counts and lists of both. An engine that wrote no report has its explanation as a text part before the answer, hung and timedOut are true when either engine was, and arguments holds the command line of each engine under windowed and headless. timeoutMs is one limit for the whole call, so the second engine gets what the first left of it. With under 5000 ms of it left the second engine is not started: suitesNotRun names its suites, the verdict gives the milliseconds left and the 5000 an engine needs to start, engines is 1, and the note says the windowed suites ran and the headless ones were not started. A case asked for by name in a script that is no suite is answered as not run. A call cut off keeps for previousRunCut the suites the windowed engine finished and the suites not yet run. On a machine with no display such a run is headless, windowed is false, and windowNote says so.',
      '- path: an entry that is not there is left out and named under missing, and such a run is never called passed. A script that declares test_ functions and does not extend GdUnitTestSuite is refused when named, and under a directory run whole it is named under notSuites. A case declared there that gdUnit4 never ran, in a suite that passed, comes back under testsNotRun, a row it skipped for data that does not fit the case under rowsMismatched, and a case it cannot run as declared (a parameter nothing fills, or a fuzzer after a setting) under casesUnrunnable, each with the reason gdUnit4 gave. With GDHARNESS_SUITE_FILES_ONLY set, a directory is refused with the suite files under it.',
      '- ignore: an entry that named a case which ran all the same comes back under ignoreNotApplied with the form that would have left it out. Every case the list left out comes back under ignored as suite_name:test_name, and every row as suite_name:test_name:N. An entry naming no suite, case or row under path comes back under ignoreUnmatched.',
      '- timeouts: a run killed at the limit answers timedOut and silentForMs, how long it had printed nothing. It is called hung only when that was half the limit, or thirty seconds of a longer one, and otherwise it was still running and wants a longer timeoutMs or a narrower path. The limit is counted from the engine starting, and the class rebuild and any import before it are outside it, though tookMs counts them.',
      '- failFast: the counts cover only what ran, and notRun counts the cases left.',
      '- printed: lines matched case aside in the text and the backtrace, at most 200, the newest kept. printedOmitted counts the rest.',
      `- ${IMPORTED_FIRST}`,
    ].join('\n'),
    parameters: {
      projectPath: PROJECT_PATH,
      path: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'A test directory or suite file, or a list of them. "suite.gd:test_name" runs one case alone. Default tests and test.',
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Suites, cases or rows to leave out: "suite", "suite:test", or "suite:test:N" for row N, from 0. suite is the file name without .gd, so a bare test name leaves out nothing.',
      },
      tests: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Run only these cases of the suites under path, each "test_name" or "suite_name:test_name".',
      },
      engineArgs: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Engine flags, such as ["--verbose"]. Only logging, debug drawing, GPU, renderer, frame timing and accessibility flags are taken.',
      },
      failFast: {
        type: 'boolean',
        description: 'Stop each suite at its first failing case. Default false.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description:
          'How long the run may take before it is killed, counted from the engine starting. Default 600000.',
      },
      printed: {
        type: 'string',
        description: 'Also answer with every line the run printed that contains this, under printed.',
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
    description: `Creates a scene file where none is, saves one, or saves a copy under a new path. A missing folder is made. ${WITHOUT_AN_EDITOR} ${ALSO_SAVED}`,
    answer:
      "create names a folder it made under madeFolder, and the root as scene_node get names a node: rootNodeType its engine class, scriptClass for a class_name, and the script it carries under script. A root made from a class_name is made as that script's base with the script attached. With inherits, the root is an instance of that scene, so changes there reach it, and the answer names the scene under inherits. A save of a scene open in the editor saves the editor's copy, unsaved changes included. save with from editor opens a closed scene in the editor, gives its @tool scripts and layout their frames, saves it and closes it, and says so under openedFirst, or stillOpen when it could not close it.",
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      rootNodeType: {
        type: 'string',
        ops: ['create'],
        description: 'The root node class, or a class_name a script declares. Default Node.',
      },
      rootNodeName: {
        type: 'string',
        ops: ['create'],
        description: 'The root node name. Default the class name.',
      },
      inherits: {
        type: 'string',
        ops: ['create'],
        description:
          'A scene for the new one to inherit, such as "parts/crate.tscn". The root takes that scene\'s class, so rootNodeType is not given with it.',
      },
      script: { type: 'string', ops: ['create'], description: 'A script to attach to the root.' },
      newPath: {
        type: 'string',
        ops: ['save_as'],
        description: 'Where the copy goes. An existing file is refused.',
      },
      from: {
        type: 'string',
        enum: ['editor'],
        ops: ['save'],
        description:
          "editor saves the editor's copy of the scene. Left out, a scene the editor has not open is saved as the file loads.",
      },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      create: { effect: 'destructive', summary: 'a new scene with one root node', requires: [] },
      save: {
        effect: 'destructive',
        summary: 'save the scene as the editor holds it, or as the file loads when the editor has it closed',
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
      'The nodes of a scene file: names, classes and hierarchy, with properties when asked. A node instancing another scene names it under instanceOf. Needs no editor. For the nodes of a running game, runtime_inspect tree.',
    answer:
      'type is the engine class, and a node whose script declares a class_name names it under scriptClass. The nodes listed under an instance come from its file, and its editableChildren says whether this scene, or one it inherits, keeps values of its own for them. One saved as a placeholder answers placeholder true, with InstancePlaceholder as its type. The root of an inheriting scene names the scene under inherits, and every node that scene or one further down makes names its file under inheritedFrom. A node in any group answers groups, sorted, from this file and every scene it comes from. The engine stops reading at a node instancing a scene it cannot load, and notRead lists that node and every one after it. A node at the last level that has children says how many under childrenNotListed. With properties, defaultsLeftOut counts the defaults left out, and on a node another scene makes setHere names the properties this file sets. A TileMapLayer or TileMap whose cells the file sets answers cellCount and cellsListedBy, the scene_node get call that lists them. An editor serving the project answers and says whether it holds unsaved changes to the scene. With none, a headless engine reads the file without making its nodes, so no script of theirs runs.',
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      depth: {
        type: 'integer',
        minimum: 0,
        description: 'Levels to descend, 0 being the root alone. Default: all.',
      },
      includeProperties: {
        type: 'boolean',
        description: "Include each node's properties that differ from a new node's. Default false.",
      },
      includeDefaults: {
        type: 'boolean',
        description:
          'List every stored property, defaults included. Large: a Control has about a hundred. Turns includeProperties on.',
      },
    },
    requires: ['projectPath', 'scenePath'],
  },
  {
    name: 'scene_node',
    title: 'Scene nodes',
    description: `One node in a scene file: add, read, set, duplicate, reparent or delete it, change its type, save it as a scene of its own, paint TileMap cells, or bake a navigation region. Another scene is instanced with instancePath. A set with properties {"name": "Boss"} renames a node, and the paths naming it are rewritten. ${WITHOUT_AN_EDITOR}`,
    answer:
      "get answers nodeType, the node's engine class, with scriptClass when its script declares a class_name. It answers nodePath, its path from the root however it was named, and setHere, the properties this scene's own file sets on it. valuesFrom is the scene every value outside setHere comes from, when another scene makes the node. An instance of another scene also answers instanceOf, editableChildren and placeholder. A set that gives a property the value the node has without it (what the scene it comes from gives, or its default) leaves it out of the file, as the editor does, and answers it under notStored, with notStoredNote saying what it follows now. retargeted lists each path a rename or a reparent rewrote, as {scenePath, nodePath, property or animation and track, from, to}, and notRetargeted each it left, with a reason: a track kept in another scene or an imported file, or a value another scene gives that the move left naming nothing. A rename or a reparent carries NodePath values on nodes (in arrays, dictionaries, built-in resources, %unique paths) and the tracks of the scene's players, saving a library kept in a .tres of its own. followed names the other scenes a move rewrote at any depth, and notFollowed any left as they were, with why. It names each link that leads out of the project and can hold a scene too, a folder or a scene file, since no scene behind one is read. A delete rewrites no path. scriptsNaming lists each line of a script that reads a node a rename, a reparent or a delete took by the path it had, as {scenePath, nodePath, script, line, from, to}: the script is on the node at nodePath, or is one that node's script extends, in this scene or one instancing or inheriting it, and to is the path that reaches the node from there now, absent after a delete. It reads $Path, %Unique, and a string handed to get_node, get_node_or_null or has_node on the node itself. A path built at run time is not seen. Scripts are left as they were, as the editor's own rename leaves them, so each line listed fails until it is changed. change_type answers nodeType and wasType, with scriptClass when nodeType named a class_name. Its dropped names each value the new class lacks. Its connectionsRemoved lists, in the shape a delete gives, each connection the new class has no signal or method for. Its cleared lists each node value typed so it cannot hold the new class, now null, as {nodePath, property}. bake_navigation answers polygons and vertices, savedTo (the polygon's file), made (true when the region had none and was given one), a note saying why when none came out, and meshesNote on the engine's mesh warning. A 2D bake_navigation that read no obstacle says in its note that all its outlines enclose is walkable, and names the nodes giving obstacles that sit under no region. stillNaming lists each node path and track, here and in the scenes instancing or inheriting this one, that named a deleted node. A property typed as a node, or an array or dictionary of nodes, holds the node itself, so the one that held a deleted node holds null there, as the editor saves it, and its entry adds cleared: true. deletedWithIt lists each node of this scene's own that went with it, the nodes inside an instance going with the instance. connectionsRemoved lists each connection the file held from or to a node a delete took, as {sourceNodePath, signalName, targetNodePath, methodName}. A duplicate's connectionsCopied lists those its copy got, in the same shape, and notUnique each copy of a node with a unique name, which the original keeps. A scene instancing or inheriting this one loses what it kept for a node a delete took or one below it: values set there, a node added there, a connection from or to one, and an editable mark. The engine skips each with a warning on every load, and the editor's next save leaves it out. dropped lists each as {scenePath, nodePath, entry}, entry being values, node, connection (with signal and method) or editable, and the scene is named under followed. A save_branch writes the node, its children, their values, built-in resources, groups and the connections among them to newScenePath, with the new root's position reset as the editor resets it. The instance put in its place keeps its name, place among its siblings, position, rotation, scale and unique_id. The rest of the scene keeps the connections to the branch's nodes and the properties holding them. A %unique path through one of them, in a value, a built-in resource or a track, is written as the plain path, since that node is unique only in the new scene. A scene that instances or inherits this one and keeps values below the branch gets the instance marked editable there, since its next save would drop them otherwise, and is named under followed. The root, a node another scene makes and an instance of a scene already are refused. save_branch answers nodePath, newScenePath and index. Its connectionsLost lists, in the same shape, each connection from a node inside the new scene to one outside it that the file cannot hold, since a scene saves a connection from inside an instance only once the instance's children are editable. Its namesOutside lists each node path or node in the new scene that reaches a node outside it, as {nodePath, property, path, names}, nodePath in the new scene and names here: a path is kept and reaches that node only where the scene is instanced as here, and a node is cleared, with cleared: true. Its retargeted gives each %unique path rewritten. Its scriptsNaming gives each script line naming a node through a %unique name across the branch's edge, with to only for a line outside the branch. groups lists, sorted, every group a node is in, on a get, an add that gave addGroups and every set that changes them. get adds groupsHere, the groups this file puts it in, when another scene puts it in others, and layers, each layer mask it answers (collision_layer, collision_mask, visibility_layer) as the layers it holds, {layer, name} with the name project.godot gives the layer. Each of these lists is answered only when it names anything. add and set answer each property given under properties as the node holds it once written, and set each one unset under unset. unsetNote names the scene an unset value now follows. alsoChanged gives the other properties the engine changed in step with a set, as a Control's offsets with its size, and those a reparent changed to keep the node where it is drawn or that the new parent sets, as a container gives a Control its layout_mode, as {was, now}. namesNoNode gives each node path written naming no node. sharedWith gives, for a property written through a resource built into the scene, each other {node, property} holding it, which changed too. setByScript gives what a script that is not a tool set as a headless write ran, which the file does not hold. loadsAs gives a value given that the file holds and the node's own script changes as the scene loads, as it loads. get adds placement, a Node3D's position, rotation_degrees and scale from its transform. A property typed outside the declared range, an enum number or name it does not list, flags it does not have, a file its filter does not take, or an alpha on a colour declared without one, is written as given and named under outsideDeclared. A set with a key reaching into a built-in resource, \"sources/0/0:0/0/probability\" on a TileSet or \"lines/1/text\" on a list of resources, writes inside it, and the next element of a list the engine keeps by index is made by writing to it. A node this scene inherits takes values of this scene's own, and so does a node inside an instance once that instance's editableChildren is true. editableChildren false answers the nodes whose values went under droppedValues and the added nodes that went under droppedNodes. A reparent drops the parent_id_path, from_uid_path and to_uid_path saved beside each rewritten path and keeps the node's unique_id. A Node3D kept in place under a parent scaled unevenly across its turn ends up sheared, and the answer then carries its transform under alsoChanged and says so under sheared. unset of a shader parameter is written back at the shader's default by an editor with a renderer on its next save. " +
      'An add with instancePath saves the node as an instance of that file, as Instantiate Child Scene does, and properties set its root. save_branch gives a newScenePath with no extension .tscn. set_tilemap_cells answers placed and erased, counting the cells as they end. ' +
      'properties takes more forms than the listed ones. An enum takes its number or a value\'s name, as the script spells it, as the inspector shows it, or as the engine constant, so Add or BLEND_MODE_ADD. A typed list or map of resources or nodes, such as Array[Item], takes each in the same forms. A map takes a plain object, with text for StringName and NodePath keys, and one keyed by anything else, such as Dictionary[Vector2i, int], takes {"_type": "Dictionary", "entries": [[key, value], ...]}. In a list or dictionary that declares no element type, a bare whole number is an int, and a whole float is {"_type": "float", "value": 7}. An element of an exported array is added by giving the array whole. A "metadata/" key that is not there is added, and null takes it off, named under metadataRemoved. Each value is read back once set, and one the engine changed or refused is refused with what it holds. ' +
      ALSO_SAVED,
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      nodePath: {
        ...NODE_PATH,
        ops: [
          'get',
          'set',
          'duplicate',
          'reparent',
          'delete',
          'change_type',
          'save_branch',
          'set_tilemap_cells',
          'bake_navigation',
        ],
      },
      newScenePath: {
        type: 'string',
        ops: ['save_branch'],
        description: 'Where the new scene goes, such as "props/crate.tscn". An existing file is refused.',
      },
      parentNodePath: {
        type: 'string',
        ops: ['add', 'duplicate'],
        description: 'add: where the node goes. Default the root. duplicate: where the copy goes.',
      },
      nodeType: {
        type: 'string',
        ops: ['add', 'change_type'],
        description:
          'The node class, such as "CharacterBody2D", or a declared class_name. add takes this or instancePath.',
      },
      instancePath: {
        type: 'string',
        ops: ['add'],
        description: 'A scene to instance instead of a class, such as "ui/panel.tscn".',
      },
      nodeName: { type: 'string', ops: ['add'], description: "The new node's name." },
      properties: { ...PROPERTIES, ops: ['add', 'set'] },
      unset: {
        type: 'array',
        items: { type: 'string' },
        ops: ['set'],
        description:
          'Properties whose line this scene\'s file drops, such as "modulate". Each then holds what its source gives.',
      },
      editableChildren: {
        type: 'boolean',
        ops: ['set'],
        description:
          'On an instance of another scene: whether its children are editable here. False drops the values and nodes added below it.',
      },
      placeholder: {
        type: 'boolean',
        ops: ['add', 'set'],
        description: 'With instancePath on add, or on set for an instance: save it as a placeholder.',
      },
      addGroups: {
        type: 'array',
        items: { type: 'string' },
        ops: ['add', 'set'],
        description: 'Groups to put the node in.',
      },
      removeGroups: {
        type: 'array',
        items: { type: 'string' },
        ops: ['set'],
        description: 'Groups to take the node out of. One it is not in is refused.',
      },
      newName: {
        type: 'string',
        ops: ['duplicate'],
        description: "The copy's name. The copy has the original's children and their connections.",
      },
      newParentPath: {
        type: 'string',
        ops: ['reparent'],
        description: 'The new parent, which may be the one it has, to move it among its siblings.',
      },
      keepGlobalTransform: {
        type: 'boolean',
        ops: ['reparent'],
        description:
          'Whether the node stays where it is drawn, as the editor keeps it. A Control keeps its position only. Default true. false keeps its own transform.',
      },
      index: {
        type: 'integer',
        minimum: 0,
        ops: ['add', 'duplicate', 'reparent'],
        description: "Where the node goes among the parent's children, 0 for first. Default last.",
      },
      includeDefaults: {
        type: 'boolean',
        ops: ['get'],
        description: 'Include properties still at their default. Default false.',
      },
      layer: {
        type: 'number',
        ops: ['set_tilemap_cells'],
        description: 'The layer of a TileMap. Default 0. A TileMapLayer is one layer.',
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
        summary: "read a node's class, properties and where its values come from, or a tilemap's cells",
        requires: ['nodePath'],
      },
      set: {
        effect: 'destructive',
        summary: 'set properties, groups, editableChildren or placeholder on a node, any together',
        requires: ['nodePath'],
      },
      duplicate: {
        effect: 'additive',
        summary: 'copy a node and its children, right after it or under parentNodePath',
        requires: ['nodePath', 'newName'],
      },
      reparent: {
        effect: 'destructive',
        summary: 'move a node under another parent, or among its siblings',
        requires: ['nodePath', 'newParentPath'],
      },
      delete: { effect: 'destructive', summary: 'remove a node and its children', requires: ['nodePath'] },
      change_type: {
        effect: 'destructive',
        summary: 'make a node another class, keeping its name, children, script and matching values',
        requires: ['nodePath', 'nodeType'],
      },
      save_branch: {
        effect: 'destructive',
        summary: 'a node and its children become a scene of their own, instanced in their place',
        requires: ['nodePath', 'newScenePath'],
      },
      set_tilemap_cells: {
        effect: 'destructive',
        summary: 'place tiles in a TileMapLayer or TileMap',
        requires: ['nodePath', 'cells'],
      },
      bake_navigation: {
        effect: 'destructive',
        summary: 'bake a NavigationRegion2D or 3D from the geometry under it',
        requires: ['nodePath'],
      },
    },
  },
  {
    name: 'scene_signal',
    title: 'Scene signals',
    description: `Signal connections in a scene file. A connect to a method the target lacks is still written and answers methodFound false. ${WITHOUT_AN_EDITOR} ${ALSO_SAVED}`,
    answer:
      'Each connection answers its flags as the number and as flagNames, binds and unbinds only when it has them. persist is on every connection, since a scene saves no other kind, and is added to flags either way. A read can name inherited, 32, on a connection an instanced scene makes. A connect of a pair already connected says alreadyConnected, with flagsBefore, bindsBefore and unbindsBefore when it changed them, and keeps what the call does not give. Until a method a connect names exists, the signal fails each time it is emitted. One whose method cannot take what the signal passes, with its unbinds, binds and appended source, is written too, and answers argumentsFit false with misfit saying why. list gives each connection its methodFound, and misfit when it has one. It marks editable false on a connection a scene this one instances or inherits makes, and names that scene under madeIn. A file can hold a connection the engine loads the scene without: one that binds to a missing method, one whose signal its source no longer declares, or one whose node is gone. Every tool that writes a .tscn puts each back as the file held it and says so under unmadeConnections.',
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
        description:
          'Object.ConnectFlags added together: deferred 1, persist 2, one_shot 4, reference_counted 8, append_source_object 16.',
      },
      binds: {
        type: 'array',
        ops: ['connect'],
        description:
          "The values passed after the signal's own. [] takes them off. Default: those the connection has.",
      },
      unbinds: {
        type: 'integer',
        minimum: 0,
        ops: ['connect'],
        description:
          "How many of the signal's own arguments are dropped from the end. 0 takes it off. Default: what the connection has.",
      },
      nodePath: { type: 'string', ops: ['list'], description: 'Only connections involving this node.' },
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
    description: `Animations in an AnimationPlayer and states in an AnimationTree state machine. scene_node add puts the player or tree in the scene first, and autoplay is scene_node set. read answers each track in the shape add_track takes. add_track on an existing track adds keys to it. remove_track takes out every matching track, or with a method only the keys calling it. A transition from Start sets the first state. read and read_states need no editor. ${WITHOUT_AN_EDITOR} ${ALSO_SAVED}`,
    answer:
      "read without animationName lists the animations, each with the number of its tracks under tracks. add_track on a path the animation already has a track of that type for answers existingTrack true, and keysAdded beside keys, the track's count. replaceKeys names each key it replaced under keysReplaced, its time and the value it held, and keysAdded then counts only the new times. A key written past the animation's end, by add_track or by a set that shortens it, is kept and named under pastLength, since it never plays. To move a key, remove it with times and add it at the new time. create names a library it made under libraryMade, an empty name being the player's default library. rename renames the player's autoplay and every state playing the animation, named under autoplay and statesFollowed. remove clears the player's autoplay when it named the animation, and names under statesPlayingNothing the states that played it, which stay until remove_state takes them out. " +
      'read_states gives each state that plays an animation animationFound, and animationMissing saying why when the player lacks it. add_state writes a state for an animation the player lacks all the same, answering animationFound false, and puts it right of the rightmost state in the graph, answered under position. remove_state names the transitions it took out under transitionsRemoved. Every state machine has Start and End, which cannot be added or removed. An immediate auto transition with no advanceCondition leaves its state the frame the state is reached. advanceMode defaults to auto for a transition leaving Start, since a machine leaves Start only through an auto one.',
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
          'The animation, "walk" or "moves/walk" with its library. read: the one to answer whole, else all are listed.',
      },
      newName: {
        type: 'string',
        ops: ['rename'],
        description: "The animation's new name. The player's autoplay and the states that play it follow.",
      },
      length: {
        type: 'number',
        ops: ['create', 'set'],
        description: 'Seconds, more than 0. create: default 1.',
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
        description: 'Keyframe snap in seconds, 0 or more. create: default 0.1.',
      },
      track: { ...ANIMATION_TRACK, ops: ['add_track', 'remove_track'] },
      times: {
        type: 'array',
        items: { type: 'number' },
        ops: ['remove_track'],
        description: 'Seconds of the keys to remove, keeping the rest of the track. Default every key.',
      },
      replaceKeys: {
        type: 'boolean',
        ops: ['add_track'],
        description: 'Put a keyframe in place of one at the same time. Default false, which refuses.',
      },
      animTreePath: {
        type: 'string',
        ops: ['read_states', 'add_state', 'remove_state', 'connect_states', 'disconnect_states'],
        description: 'The AnimationTree node.',
      },
      stateName: {
        type: 'string',
        ops: ['add_state', 'remove_state'],
        description: 'The state to add, or to take out with its transitions.',
      },
      stateMachinePath: {
        type: 'string',
        ops: ['read_states', 'add_state', 'remove_state', 'connect_states', 'disconnect_states'],
        description: 'A nested state machine, by the names of the states that lead to it. Default the root.',
      },
      fromState: {
        type: 'string',
        ops: ['connect_states', 'disconnect_states'],
        description: 'The state the transition leaves.',
      },
      toState: {
        type: 'string',
        ops: ['connect_states', 'disconnect_states'],
        description: 'The state it arrives at.',
      },
      transitionType: {
        type: 'string',
        ops: ['connect_states'],
        enum: ['immediate', 'sync', 'at_end'],
        description:
          "at_end waits for the state's animation to end, sync keeps the playback position. Default immediate.",
      },
      advanceCondition: {
        type: 'string',
        ops: ['connect_states'],
        description:
          'The condition parameter that advances it, parameters/conditions/<name>. Only with advanceMode auto.',
      },
      advanceMode: {
        type: 'string',
        ops: ['connect_states'],
        enum: ['auto', 'enabled', 'disabled'],
        description:
          'enabled advances only by travel(), disabled never. Default auto with advanceCondition or leaving Start, else enabled.',
      },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      read: {
        effect: 'read',
        summary: 'the animations of a player, or one with its tracks',
        requires: ['playerNodePath'],
      },
      read_states: {
        effect: 'read',
        summary: 'the states and transitions of a state machine',
        requires: ['animTreePath'],
      },
      create: {
        effect: 'additive',
        summary: 'a new animation',
        requires: ['playerNodePath', 'animationName'],
      },
      add_track: {
        effect: 'additive',
        summary: 'a property or method track',
        requires: ['playerNodePath', 'animationName', 'track'],
      },
      remove_track: {
        effect: 'destructive',
        summary: 'a track, or some of its keys',
        requires: ['playerNodePath', 'animationName', 'track'],
      },
      set: {
        effect: 'destructive',
        summary: 'length, loop mode or step',
        requires: ['playerNodePath', 'animationName'],
      },
      rename: {
        effect: 'destructive',
        summary: 'an animation, with what plays it',
        requires: ['playerNodePath', 'animationName', 'newName'],
      },
      remove: {
        effect: 'destructive',
        summary: 'an animation',
        requires: ['playerNodePath', 'animationName'],
      },
      add_state: {
        effect: 'additive',
        summary: 'a state playing an animation',
        requires: ['animTreePath', 'stateName', 'animationName'],
      },
      remove_state: {
        effect: 'destructive',
        summary: 'a state and its transitions',
        requires: ['animTreePath', 'stateName'],
      },
      connect_states: {
        effect: 'additive',
        summary: 'a transition between two states',
        requires: ['animTreePath', 'fromState', 'toState'],
      },
      disconnect_states: {
        effect: 'destructive',
        summary: 'a transition',
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
      "Creates a GDScript file, adds functions, variables, signals, constants and enums to one, or renames a class or member across the project. To change an existing line, edit the file's text. Each write is loaded and answered with parses. modify makes every addition or none. rename writes every file or none, and leftAlone lists each other occurrence of the old name, so read it before calling the rename done.",
    answer:
      "create answers the extends and class_name the engine read (class_name null for a script declaring none), and writes the .uid beside the script, answering it under uid. A class_name is put in the project's class list, with registered saying whether it is there, and an editor serving the project scans for it (editorRescanned). A class_name another script or an engine class holds, or an extends naming no class, is refused with nothing written. parses is false for a script that fails only because a script it depends on does, and dependencies_with_errors names those. " +
      "modify refuses, with nothing changed, additions that would stop a script that parses from parsing, giving the engine's reasons, and answers the line each one is on. With an editor serving the project it reloads the script there too (editorReloaded, or editorNote when it could not, or when a script tab holds unsaved edits that saving would write over the file). " +
      "rename renames a class or a member wherever the engine uses it. A class_name is renamed from the files and needs no editor: every bare use in code, the declaration, doc links such as [Told] and [method Told.say], and the script_class a .tres records. Everything else, an inner class and an enum value included, is renamed from what the editor's language server resolves to it, so it needs the editor open on this project. A method is renamed together with every override of it in the classes inheriting it. Doc links naming the member through any class inheriting it are renamed too, and so are a scene's or resource's saved value of a variable on a node or resource whose script inherits it, and a connection naming the signal on its emitter or the method on its receiver. A new name already taken is refused with nothing written, a member's included when a class inheriting it already uses the name in code. changed lists each file with its changed lines as they now read, and leftAlone lists every other whole-word occurrence of the old name with what the tokenizer makes of it (code, string, comment, doc, nodePath, scene, text, or ignored for a file under a .gdignore directory) and, where it is not plain, why: a string that is the old name whole (such as find_children's type or a call's method name, which nothing renames or compiles), a node named like the class, and a call on a value whose type the analyser could not tell. A comment, documentation line, string or text file line with nothing more to say is under leftAloneInProse by file, kind and line, and code that is certainly another symbol of the same name under leftAloneOtherSymbols. summary.leftAlone counts each of the three lists beside the total. Past 300 lines the two grouped lists are written with each line's text to a file under the project's .godot directory, of which the newest ten are kept, and leftAloneDetail names it. Nothing in them was changed. A member rename answers under languageServer how many requests it made and how long they took. Afterwards an open editor scans the changed files and reloads every changed script, under editor, and with no editor the class cache is rebuilt and the changed scripts compiled in a fresh engine, under classCache and compiled. written is true once the files are written, and ok is false when what came after the write failed: the files are left changed, and note says so. " +
      'newScriptPath also rewrites every string that names the moved script by path in the style it was written (res:// or relative) and the relative paths in the moved script itself. A relative string stays as written in the `text`, `tooltip_text`, `placeholder_text` and `resource_name` of a scene or resource, in node names and groups, on a `;` comment line of a Godot text file and in a .import file, while a res:// path there is rewritten. A GDScript comment stays whole.',
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      className: {
        type: 'string',
        ops: ['create'],
        description: 'A class_name for the script. Not with content.',
      },
      extends: {
        type: 'string',
        ops: ['create'],
        description:
          "The base class. Default the template's class, or Node with no template. Not with content.",
      },
      content: {
        type: 'string',
        ops: ['create'],
        description: 'The whole file, written as given, instead of a template, className and extends.',
      },
      template: {
        type: 'string',
        enum: ['singleton', 'state_machine', 'component', 'resource'],
        ops: ['create'],
        description: 'A starting shape. resource is written for a Resource and the others for a Node.',
      },
      modifications: { ...SCRIPT_MODIFICATIONS, ops: ['modify'] },
      symbol: {
        type: 'string',
        ops: ['rename'],
        description:
          'What to rename, declared by the script at scriptPath: its class_name, or a top-level method, variable, constant, signal, enum, enum value or inner class. Everything but a class_name needs the editor open.',
      },
      newName: {
        type: 'string',
        ops: ['rename'],
        description: 'The new name. One already taken is refused.',
      },
      newScriptPath: {
        type: 'string',
        ops: ['rename'],
        description: 'Also move the declaring script here, with its .uid, rewriting the paths that name it.',
      },
      preview: {
        type: 'boolean',
        ops: ['rename'],
        description:
          'Answer with what would change and what would be left alone, and write nothing. Default false.',
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
      "What a script contains: its structure from the file, or symbols, completions and hover text from the editor's language server. It reads .gd files only. For where a class, member or signal is used, project_search.",
    answer:
      'structure gives each parameter\'s default as the source text after its =, so = null reads "null", and null for a parameter with none. Static variables are marked is_static, and one written with := has the type of a literal or built-in constructor it is given, marked inferred, as a constant always does. An export in an inspector group names it under group, as "Stats/Loot" for a subgroup. Each enum has its members under values and their numbers under numbers, counted as the engine counts and left out from one given an expression. inner_classes gives each with its name, line and extends, and its own members in the same fields. It also answers class_name, extends, is_abstract and line_count. dependencies are the paths the script loads or preloads as written, by a constant too, and the paths it or an inner class extends by, then the scripts declaring each project class_name its code uses, which classes_used names with the class. autoloads_used names each autoload the code uses, with its script. A member or inner class with a ## comment directly above it carries the text as doc, and the script\'s own comment above class_name or extends comes back as class_doc. With includeInherited each inherited member carries inherited_from, the file declaring it, the answer gains inherits_from, the chain walked, and a name the script overrides is listed at both its lines. ' +
      'symbols gives each symbol its kind, the line and column of its name, and lastLine, the end of its declaration. detail is the language server\'s own text, which writes a default through the engine (Callable() as "null::null") and leaves out a signal\'s argument types. completion is narrowed to the part of a name written before the position. symbols, completion and hover name under unseenByEditor each project class the editor cannot see yet, with unseenNote: the language server reads such a class as nothing, so a completion after self. in a script extending one comes back empty. editor_rescan brings it in.',
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      includeInherited: {
        type: 'boolean',
        ops: ['structure'],
        description:
          "Also list what the script inherits through the project's other scripts. A native base is for editor_classes info.",
      },
      line: {
        type: 'integer',
        minimum: 1,
        ops: ['completion', 'hover'],
        description: 'The line, counted from 1 as the editor shows it.',
      },
      character: {
        type: 'integer',
        minimum: 1,
        ops: ['completion', 'hover'],
        description: 'The column, counted from 1 as the editor shows it, a tab counted as one.',
      },
    },
    requires: ['projectPath', 'scriptPath'],
    operations: {
      structure: {
        effect: 'read',
        summary:
          'functions, variables, signals, constants, enums, class_name, extends and dependencies, from the file',
        requires: [],
      },
      symbols: {
        effect: 'read',
        summary: 'document symbols from the language server, each with its kind and lines',
        requires: [],
      },
      completion: {
        effect: 'read',
        summary: 'completions at a position, at most 100',
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
      "Errors and warnings for a script or several, from the editor's language server, and whether each is clean. With no editor open, a headless engine compiles instead and checkedBy says engine. Lines and columns count from 1. If staleAnalysis appears, editor_rescan first.",
    answer:
      'Each diagnostic carries its severity, its message, and line, column, endLine and endColumn as the editor shows them. One script is answered on its own. Several are answered together, each named by its res:// path: a script with nothing to report is named in nothingReported, and every other is answered under scripts, a script that could not be read named with why. A folder skips what the engine skips and the addons gdharness installed. A script named under a folder holding a .gdignore is checked as asked and listed under underGdignore, and one under a folder holding its own project.godot under inNestedProject. A class the class cache lacks is put in it first, under classesRebuiltFirst. ' +
      'The engine, with no editor, answers every error up to the first syntax error, at its line with no column, and the warnings at the levels the project sets, warnings being null when it could not answer. A method or property another class lacks is not a compile error, since the object may be a subclass that has it. dependenciesWithErrors names the other scripts that failed while it loaded, and typesMissingFromTheClassCache a project class the engine could not resolve because the cache lacks it. A language server that stops answering partway leaves the rest to the engine, and checkedBy then says language server, then engine, with checkedByLanguageServer counting the scripts it answered. ' +
      'A diagnostic the files disprove is named rather than passed on: a member the class cache or a project class it extends declares comes back under contradictedByTheFile with the declaring script, and a project class the diagnostic could not resolve under typesTheEditorHasNotLoaded, with inTheClassCache. staleAnalysis then says what to do, usually editor_rescan. For an enum member, constant or static function of a global class it is editor_rescan with reloadScript on the declaring script. For an editor whose last scan wrote the class cache shorter than the files, it is editor_launch restart. A class missing from the cache is mended by project_import refresh_classes.',
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'A script, a folder (its .gd files at any depth), or a list of either, such as ["scripts/economy", "ui/shop.gd"].',
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
    description: `Resource files: read one, create any ClassDB resource as .tres (a material is a create with resourceType StandardMaterial3D, ShaderMaterial or CanvasItemMaterial), change one, write a shader, build a TileSet, set a Theme colour or font size, or move a file or directory. read answers in the form modify takes. A Theme item is named \`Button/colors/font_color\`. move and read need no editor. ${WITHOUT_AN_EDITOR}`,
    answer:
      "create and modify answer each property given under properties as the file holds it once saved, and modify each one unset under unset. A property given its default is left out of a .tres file and named under notStored. alsoChanged names what the engine changed in step with a given property, and alsoSaved what the save changed, added or dropped in the main resource, as {property, was, saved}. loadsAs and setByScript (with setByScriptNote) name what a script of the resource changes as the file loads. read lists under notLoaded the lines the engine does not load, which a modify drops. read of a shader says whether it compiles under compiles, with compileErrors. A Curve reads as the inspector shows it (point_count, point_0/position). A file never imported is refused with the reimport that imports it. move with an editor open brings it up to date as after a move in the FileSystem dock. With none, an import pass rebuilds the uid cache, and uidTable says whether it ran and writtenByImport names the .uid and .import files it gave. A directory's answer names each file moved. A resource built into a scene becomes a file of its own by a create given its _type and the rest of what a read answers for it as properties, then a set of the property to the new file. " +
      "properties takes the forms scene_node's answer lists. A resource with a script that is not a tool, written by a headless engine, has what that script changes put back before the save, answered under setByScript, and one where that cannot be done is refused with the file left as it was. " +
      'create_tileset gives a wholly transparent cell no tile and lists it under leftBlank, describes a strip no whole tile reaches under notInAnyTile, and answers tileSize, the size the first source sets. A custom data layer written with modify after it takes a type name such as "int". create_shader answers compiles, and compileErrors with each error\'s line. ' +
      "A controlType that is no Control or Window class is set as a type variation, with a note saying so. A colorName or fontSizeName the engine's theme gives the class none by is set, with a note naming the nearest it has. remove_theme_item without item takes the type with every item, and its base_type when it is a variation, naming each one removed. " +
      'move rewrites every path naming what moved in a scene, resource, script, project.godot or other text file, in the style it was written, res:// or relative, and the relative paths inside a moved file. A relative string stays as written in the text, tooltip_text, placeholder_text and resource_name of a scene or resource, in node names and groups, on a ; comment line and in a .import file. A GDScript comment stays whole. A string naming it any other way, such as the start of a path built at run time, and a .scn or .res file, which this cannot rewrite, are answered under leftAlone. A preview is refused when the move would be.',
    parameters: {
      projectPath: PROJECT_PATH,
      resourcePath: {
        ...RESOURCE_PATH,
        description: `${RESOURCE_FILE} move: a directory too. read: also a resource inside a scene file, such as "res://hero.tscn::Animation_jump".`,
      },
      resourceType: {
        type: 'string',
        ops: ['create'],
        description: 'The resource class, such as "PhysicsMaterial", or a declared class_name.',
      },
      properties: { ...PROPERTIES, ops: ['create', 'modify'] },
      unset: {
        type: 'array',
        items: { type: 'string' },
        ops: ['modify'],
        description:
          'Properties whose line the file drops, keyed as in properties, such as "shader_parameter/tint".',
      },
      script: {
        type: 'string',
        ops: ['create'],
        description: 'A script to attach.',
      },
      includeDefaults: {
        type: 'boolean',
        ops: ['read'],
        description: 'Include properties still at their default. Default false.',
      },
      shaderType: {
        type: 'string',
        ops: ['create_shader'],
        enum: ['canvas_item', 'spatial', 'particles', 'sky', 'fog'],
        description: 'The shader_type line.',
      },
      code: {
        type: 'string',
        ops: ['create_shader'],
        description: 'The shader source, written as given. Default: a minimal shader of that type.',
      },
      sources: { ...TILESET_SOURCES, ops: ['create_tileset'] },
      newPath: {
        type: 'string',
        ops: ['move'],
        description:
          'Where it goes, inside the project. A file goes with its .import and .uid, and paths naming it are rewritten.',
      },
      preview: {
        type: 'boolean',
        ops: ['move'],
        description: 'Answer with what would move and change, and write nothing. Default false.',
      },
      controlType: {
        type: 'string',
        ops: ['set_theme_color', 'set_theme_font_size', 'remove_theme_item'],
        description:
          'The theme type, a Control or Window class such as "Button", or the name of a type variation.',
      },
      colorName: {
        type: 'string',
        ops: ['set_theme_color'],
        description: 'Such as "font_color".',
      },
      color: { ...COLOUR, ops: ['set_theme_color'] },
      fontSizeName: {
        type: 'string',
        ops: ['set_theme_font_size'],
        description: 'Such as "font_size".',
      },
      size: {
        type: 'number',
        ops: ['set_theme_font_size'],
        description: 'Pixels, a whole number of 1 or more.',
      },
      item: {
        type: 'string',
        ops: ['remove_theme_item'],
        description:
          'The item to take out, such as `colors/font_color`. Without it, every item of controlType goes.',
      },
    },
    requires: ['projectPath', 'resourcePath'],
    operations: {
      read: { effect: 'read', summary: 'the properties a resource file sets', requires: [] },
      create: { effect: 'destructive', summary: 'a new resource of any class', requires: ['resourceType'] },
      modify: {
        effect: 'destructive',
        summary: 'set or unset properties on an existing resource',
        requires: [],
      },
      create_shader: { effect: 'destructive', summary: 'a .gdshader file', requires: ['shaderType'] },
      create_tileset: {
        effect: 'destructive',
        summary: 'a TileSet from texture atlases. Its layers and tile data are written with modify after it',
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
        summary: 'move or rename a file or a directory, and every path in the project naming it',
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
      "Opens the Godot editor on a project, or restarts or closes the one already connected, or binds its debug adapter again. open answers once the process has started, and the editor dials in after its import. close saves open scenes and quits. restart puts a gdharness upgrade into effect. rebind ends the debug adapter's sessions. editor_status says which editor is connected.",
    answer:
      "close answers settingsDropped, naming what its save took out of project.godot and left out when it took nothing, and settingsNote when the file could not be read to tell. An editor stopped before it connected is answered with beforeConnecting. close and restart name under savedScenes the open scenes that had unsaved changes and were saved on the way out, an empty list when none had. A scene that would not save refuses the close or restart and leaves the editor running. Both answer tookMs, how long the editor took to go or to come back. restart answers with the version that came back, and hidden, whether it came back with no window, and says under settingsDropped which keys its save dropped, because it waits for the editor to return. An open cannot, since it answers as soon as the process exists and the save happens during the import minutes later, so editor_status carries that reading once the editor has connected. Nothing else will say a key went until something depends on one. A restart answers lspListening and dapListening once the editor's servers are up. When either came back without its port, serversSaid gives the lines the editor's log panel has about its servers, the one place Godot says why a port would not bind, and when it was the debug adapter, which is bound again in the editor that came back, debugAdapterRebound says whether that took. Neither is there when both came up. Godot clears that panel whenever a game is played, unless its run/output/always_clear_output_on_play setting is off, so after a play the lines from the editor's own start are gone. rebind answers rebound, with lspListening, dapListening and serversSaid, the lines that rebind made the panel print. A restart that a server's end interrupted shows as restartInterrupted in editor_status, and the open that finishes it says so under finishesRestart. " +
      "The editor is an ordinary visible one on the desktop in use, shown without being activated on Windows. hidden: true opens it out of sight, on a desktop of its own on Windows that still draws its views for editor_capture, and headless on Linux and macOS, where editor_capture refuses it. A hidden editor serves the bridge, the language server and the debug adapter as a visible one does. A game a visible editor plays opens as a window on the desktop in use. open refuses while an editor of the project is already running and has not reached this server, naming its pid. An editor a server opened is started again by the server as it was started, once the old one has gone: it waits 90 seconds for that, or GDHARNESS_EDITOR_RESTART_TIMEOUT_MS. One opened by hand restarts itself and comes back with a window, so one with no window is refused unless hidden: false accepts one. A restart is a quit and then a launch, and this server can be ended between them: that is written down before the quit, so the next server says so in editor_status, and open finishes it. An open is refused when the editor it would start could never reach this server: a project other than the one this server serves, a project without the gdharness editor addon installed and enabled, a project whose editor a restart is already bringing back, or one whose editor addon on disk is another release's.",
    // open alone: a restart is of the editor already connected, which names its own project, and
    // an argument that is accepted and then ignored is one a caller can be wrong about for ever.
    parameters: {
      projectPath: { ...PROJECT_PATH, ops: ['open'] },
      hidden: {
        type: 'boolean',
        ops: ['open', 'restart'],
        description: `Open the editor out of sight. Default false on open, and on restart how the editor was started. One opened by hand comes back with a window, so hidden: true is refused there. A hidden editor quits after ${String(IDLE_CLOSE_MINUTES)} minutes with no call, set by ${IDLE_CLOSE_SETTING}, 0 turning it off.`,
      },
      silent: {
        type: 'boolean',
        ops: ['open', 'restart'],
        description:
          'Open the editor with no sound. Default true on open, and on restart how the editor was started.',
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
        summary: "restart the connected editor's debug adapter in place",
        requires: [],
      },
    },
    defaultOperation: 'open',
  },
  {
    name: 'editor_run',
    title: 'Run the game',
    description:
      'The run: start the project, stop it, wait for it, profile it, or boot it once to see whether it comes up clean. start keeps it running and collecting output until it quits or is stopped. A scene that prints an answer and quits is start, then editor_output until running is false. What runs is a scene, named in scene. check boots headless for a few frames and answers whether it came up, with every error and warning. A start says under runtime whether the runtime_* tools can reach the game. One server holds one run.',
    parameters: {
      // start and check need telling which project. The ops about the run already going take it
      // too, because a call copied from the start carries it, and they check it rather than ignore
      // it: the one thing it can say is which project's run is meant.
      projectPath: {
        ...PROJECT_PATH,
        ops: ['start', 'check', 'stop', 'wait', 'profile'],
        description: 'Absolute path. stop, wait, profile: optional, the project whose run is meant.',
      },
      scene: {
        type: 'string',
        ops: ['start', 'check'],
        description: 'A scene to run instead of the main scene.',
      },
      suites: {
        type: ['string', 'array'],
        items: { type: 'string' },
        ops: ['start'],
        description:
          'gdUnit4 suites to play instead of a scene: a suite file or test directory, or a list. Needs gdUnit4 in the project.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        ops: ['start', 'check'],
        description: 'The game\'s own arguments, such as ["--level=2"].',
      },
      engineArgs: {
        type: 'array',
        items: { type: 'string' },
        ops: ['start', 'check'],
        description:
          'Engine flags, such as ["--verbose"] or ["--max-fps", "60"]. Only logging, debug drawing, GPU, renderer, frame timing, accessibility and --write-movie flags are taken.',
      },
      headless: {
        type: 'boolean',
        ops: ['start'],
        description: 'Force a window or none. Default a window where there is a display.',
      },
      visible: {
        type: 'boolean',
        ops: ['start'],
        description: 'Show the window on the desktop in use. By default it goes on a desktop of its own.',
      },
      silent: {
        type: 'boolean',
        ops: ['start'],
        description: "Default true. false plays the game's sound.",
      },
      executable: {
        type: 'string',
        ops: ['start'],
        description:
          'An exported build to run instead of the project, inside the project or an absolute path. No scene or profile.',
      },
      godot: {
        type: 'string',
        ops: ['start', 'check'],
        description: 'An absolute path to another Godot for this run.',
      },
      savesIn: {
        type: 'string',
        ops: ['start', 'check'],
        description: "An absolute directory for this run's user://.",
      },
      env: {
        type: 'object',
        ops: ['start', 'check'],
        description: 'Environment variables for this run, a map of strings.',
      },
      runtimeWaitMs: {
        type: 'integer',
        minimum: 0,
        ops: ['start'],
        description:
          'How long to wait for the game to announce its runtime. Default 5000, raised up to 60000 for a scene that booted slowly before. 0 does not wait.',
      },
      frames: {
        type: 'integer',
        minimum: 1,
        ops: ['check'],
        description: 'Frames to run before quitting. Default 3.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        ops: ['check', 'wait'],
        description: 'check: how long before the boot is called hung, default 60000. wait: default 600000.',
      },
      profile: {
        type: 'boolean',
        ops: ['start'],
        description: "Profile the run's GDScript from its start. Needs an engine built with debugging.",
      },
      engineCalls: {
        type: 'boolean',
        ops: ['start'],
        description: 'With profile: also time engine calls. Crashes a threaded game.',
      },
      callersOf: {
        type: 'string',
        ops: ['profile'],
        description: 'Also answer where scripts name this function: its name, or Class.name.',
      },
      mark: {
        type: 'boolean',
        ops: ['profile'],
        description: 'Set the run\'s mark at these totals, for a later profile with since "mark".',
      },
      since: {
        type: 'string',
        enum: ['mark'],
        ops: ['profile'],
        description: 'Answer only what ran after the mark.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        ops: ['profile'],
        description: 'Functions to answer with, most self time first. Default 30.',
      },
      andChildren: {
        type: 'boolean',
        ops: ['stop'],
        description: 'Also end what the game started for itself, such as workers.',
      },
      graceful: {
        type: 'boolean',
        ops: ['start', 'stop'],
        description: 'Ask the game to close first. Default true. false ends it at once.',
      },
      pid: {
        type: 'integer',
        minimum: 1,
        ops: ['stop'],
        description:
          'A game of this project that no server here holds, as editor_status lists it under runtimes.',
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
        summary: 'end the run and answer with the errors and warnings it printed',
        requires: [],
      },
      check: {
        effect: 'additive',
        summary: 'boot headless, quit after a few frames, and report whether it booted clean',
        requires: ['projectPath'],
      },
      wait: {
        effect: 'read',
        summary:
          'wait for the run to end, be held by its debugger or crash, then answer as editor_output does',
        requires: [],
      },
      profile: {
        effect: 'read',
        summary: 'where the run spends its time by GDScript function, sorted by self time',
        requires: [],
      },
    },
    answer:
      "start: through is gdharness for a game this server started itself, and editor for one the editor plays. scene is the scene the game started in, the project's main scene when none was given. runtime says whether the game is listening and on which port, and when it is not, mayYetAnnounce says whether that is final: false is a runtime that is not coming, true is a game still on its way up, which editor_status will see and runtimeWaitMs waits longer for. A game whose engine could not create a renderer on the hidden desktop is ended there with mayYetAnnounce false and a note naming the failure. runtime carries addonIsStale and staleNote when the game announced on a runtime addon other than this server's, which no runtime_* call is then sent to, and staleNote says what brings it into step. refreshedClasses names the class_name declarations on disk that the engine's class cache was missing, which were added to it before the game started. transcript is the file both the run's streams are written to, so a watch on it can be armed off the start. A start ends a run of the same project first and is refused while a run of another project is held. A run given args, engineArgs, savesIn, env, godot or a silent window is started by this server rather than by the editor, whose debugger is then the keeper holding it, and the debug_* tools answer for it all the same. args put after the separator, so a flag the engine reads goes to the game instead, and argsNote says so. headless: the editor plays a game headless only when the project's editor/run/main_run_args holds --headless, so a headless start of a project whose editor plays with a window is started by this server instead. A game that restarts itself with OS.set_restart_on_exit stays one run: editor_output and editor_status follow the process it restarted into and name those before it under restartedFrom. " +
      'A windowed run this server starts on the hidden desktop has no display to wait on, so it is given --disable-vsync and --max-fps ' +
      String(HIDDEN_WINDOW_FPS) +
      " unless engineArgs, the project's editor/run/main_run_args or its application/run/max_fps cap its frames. A game that turns vsync on as it runs slows to two frames a second again. A headless start given --fixed-fps says so under framesNote. --accessibility always has the game build the tree runtime_inspect accessibility reads. --rendering-driver takes vulkan, d3d12, metal, opengl3, opengl3_es, opengl3_angle or dummy, and --rendering-method forward_plus, mobile or gl_compatibility. --write-movie needs the path to be in a directory that exists, with nothing it would write already there, and records at the project's editor/movie_writer/fps unless --fixed-fps says otherwise. A check given --verbose answers with everything printed rather than only errors and warnings. " +
      "stop: endedPid is, for a run the editor plays, the number its game announced under, read at the stop rather than remembered, and the operating system hands a freed number to the next process, so it can equal the game before it. stopped is false, with the number under notSignalled, when that number no longer answers as the process the run was started as and nothing was signalled, the note naming which property it failed on, and false with the number under stillGoing when what was told to end was still running ten seconds later. endedThrough says how the stop ended a run that was going: close (the game was asked to close and exited, so exitCode is its own), keeper (the process that started the game ended it through the handle it holds), signal (its pid was signalled once shown to still be the run), or editor (the editor playing it was asked). exitedBeforeStop is true when the run was already over when the stop came, so nothing was ended and exitCode, when anything collected it, is the one it ended with. A start that ends the run before it says how under endedPreviousRunThrough, with the same values, and one that refused to signal that run names the property it failed on under previousRunLeftBecause. notClosedBecause (previousRunNotClosedBecause on a start) says why a graceful close did not end the game: it has no runtime listening, refuses the close or does not answer within three seconds, as a game held at a breakpoint does not. GDHARNESS_CLOSE_WAIT_MS sets another ten seconds. andChildren ends processes announced as games of this project, or this project's engine run with --path on it, with identifiedBy saying which. Any other process under the run is left and named under childrenLeft, and childrenUnknown is true when nothing could be listed. A pid is ended only when it announced itself for this project and the operating system describes it as this project's engine run, --path on the project and no editor flag, started before it announced. " +
      "check: hung is a run killed at timeoutMs, and errors and warnings count what it printed, which comes back under entries with repeats folded together. printed holds the ordinary lines the run printed, the newest 50 kept and printedLinesNotShown counting those left out. A check keeps no run for editor_output to read afterwards. editor_run start then editor_output reads everything. An engine crash is an error whatever it prints after: the crash handler's report is the entry, and the engine version and the native and GDScript backtraces are its detail, so a crashed run is never booted or clean. A crash that printed no report is an error entry, read off its exit code or signal. arguments is the engine command line the check ran, and durationMs runs from that engine's start to the check's answer. start and check wait first for a scan the open editor is running and for the class cache it writes just after, since a game booted in between resolves no global class. waitedForEditorScanMs and scanNote say how long, and when a scan ran past thirty seconds, and are left out when no scan was waited for. " +
      IMPORTED_FIRST +
      ' An exported build carries its own imports and is not asked. A silent windowed run has --audio-driver Dummy in its arguments. ' +
      "profile: per function its script, the function (Class.name when the script declares a class_name), the line its body's first statement is on, for a lambda the named function it is written in (within), calls, and self and total milliseconds, with functionsCounted, scriptMs (the self time of them all) and coveredMs. The functions of gdharness's own runtime are not among them, and their self time is runtimeAddonMs, over runtimeAddonFunctions functions. complete is true when the engine's own totals arrived, which it sends only when the profiler is switched off: the runtime addon does that as a game quits, so a scene that does its work in _ready and quits is covered whole. Otherwise the answer is the frames summed so far and the note says what that misses. frames counts the frames of the profile that arrived, and the engine's totals also hold the work after the last of them, so once complete a function run every frame can show a call more than frames. firstFrame and lastFrame are the game's own numbers, counted from 0, in a run this server started. A firstFrame above 0 is frames run before the profiler came on, and a gap between the two is frames that never arrived. A call to another script function is not in the caller's self time. A call through an engine method, such as callv, emit_signal or any Node method, is not either when the run started with engineCalls: true: it is the caller's engineMs, left out when 0. Without engineCalls no row has engineMs and those calls stay in the caller's selfMs. engineMs is never more than totalMs less selfMs. Calls to built-in types and utility functions such as print stay in self time, and so does a call through super, while the overridden function's row counts it again: such a row carries selfIncludesSuper. The profiler's own cost of timing a call lands in the self time of the function called, and a row with at least half its selfMs in it carries overheadMs, with perCallOverheadUs measured each run. The milliseconds are time passed while the function ran, not processor time, so compare two profiles taken under the same load. They are summed over every thread, so scriptMs can exceed coveredMs. A property's get and set blocks are named Class.@name_getter and Class.@name_setter, and their rows carry property. A game the editor plays that was not started with profile: true says it was profiled from the moment it was asked. A run this server started without profile: true is refused, since its debugger is fixed as it starts. callersOf lists, under callers, each place with its script, line, the named function it is written in (within), whether the function is called there or passed on as a Callable (called), and the profile's calls, self and total milliseconds for the function it is in, forty at most. A function called through a string, and a parameter, local or class variable of the same name, are not listed. A property's blocks are asked about by their profile name or by the property's, and each place then says whether it writes the property (access write) or reads it (access read). A profile with mark answers marked: true, and one with since answers since: \"mark\" and markSetMsAgo. The mark is kept beside the run's profile, so a server that replaces this one reads it too, and setting it again moves it. since counts from the mark before it moves, and lessThanAtMark counts the functions left out for reading less than at the mark. " +
      'engineCalls crashes the game or corrupts strings when any script runs off the main thread, through WorkerThreadPool, a Thread, a node processing on a sub-thread or threaded loading, and on Linux and macOS when a script frees an object through an untyped call. profile alone is safe. A headless run given --fixed-fps races ahead of the clock: given --fixed-fps 60 one ran two hours of game time in a second. --write-movie takes an absolute path outside the project ending in .avi or .png, and a run with headless: false. savesIn need not exist: the engine makes Godot/app_userdata/<project> under it, and runtime.userDir names the directory user:// is. On macOS the engine ignores it, and savesNote says so.',
    defaultOperation: 'start',
  },
  {
    name: 'editor_output',
    title: 'Game and editor output',
    description:
      'What the project started by editor_run has printed, as entries with a severity: the errors and warnings the engine reported, each with where it happened, and everything else as info. A run answers with counts and a verdict: clean is true when no error was reported. A run that has quit still answers until the next one starts. transcript is the file both streams are written to. op editor answers about the editor itself instead.',
    answer:
      "For a run the editor plays the reports come from the game itself, through the runtime addon. A played game without the runtime addon answers with its prints alone, with errorsUnread true and no clean. A run ended by a signal has no exit code, and exitSignal names the signal. endedBy says whether gdharness ended the run, and a transcript that has stopped growing is a run between prints rather than a run that is over. startedAt is when the run began and elapsedMs how long it has been going. For a run that is over, endedAt is when it ended and elapsedMs how long it ran, and both are left out when nobody saw the end. running is asked of the operating system whenever there is a process to ask about. For an editor-played run that never announced, running is the editor's answer, which can lag. " +
      "An entry with lines under its headline has them as detail, and, when one of them names a project script, script, line and function say where: the at: line when it names one, otherwise the innermost frame of the backtrace that does. A push_error or push_warning has the engine's own push_error as its at: line, so its script and line are the game's call that raised it. Each entry's source says where it was read. transcript is a line of the run's transcript file, which holds both its streams and is how every run with one is read. stdout or stderr is a line of that stream of a run with no transcript, such as an editor-played run picked up after a reconnect whose first server left no note. debugger is what the editor's debug adapter reported and the game never printed, such as the script error a game stopped on. A printerr line is info: it prints to stderr, and the engine reports no error for it. " +
      "op editor answers counts with no clean, since an editor neither passes nor fails, the entries in the order they were printed and, beside them under repeated, each message shape several lines share: how many, what varied in each slot of it and how many different values stood there, the first occurrence, and the ordinary lines above the group. It covers the whole session from the editor's first line, because an editor gdharness opened is asked for a log file as it starts. An editor somebody opened by hand has no console here and is refused. With no editor connected, connected is false, editorRunning says whether the editor whose console it is still runs, and editorNote whether this server closed it or it went without a close, as a crash does. The next editor gdharness opens on the project starts a new console. With none connected and none ever opened here on the project, there is no console, and the refusal says so. Op editor leaves out the \"Path to node is invalid\" error Godot prints as gdharness loads a scene holding a ViewportTexture: the engine looks the path up in the scene of the editor's current tab, and the write is right. The same error from a project's own script stays.",
    parameters: {
      projectPath: {
        type: 'string',
        description: 'The project whose output you mean. Another project than the held one is refused.',
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
        description: 'Only entries not already answered at this severity. Default false.',
      },
      cpu: {
        // About a running process, which an editor's console is not: the question is what it
        // printed, and it is answered from a file whether the editor is still there or not.
        ops: ['run'],
        type: 'boolean',
        description: 'Also answer with cpuSeconds, the processor time the run has used. Costs a subprocess.',
      },
      contains: {
        type: 'string',
        description: 'Only entries mentioning this text, matched against everything the run has printed.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description:
          'The most entries to answer with, newest kept. Identical entries come back as one with times. Default 200.',
      },
      before: {
        ops: ['editor'],
        type: 'integer',
        minimum: 0,
        description: 'How many ordinary lines above a repeated group to carry with it. Default 3.',
      },
    },
    operations: {
      run: {
        effect: 'read',
        summary: 'what the game a run is playing has printed',
        requires: [],
      },
      editor: {
        effect: 'read',
        summary: 'what the editor itself has printed, from its first line',
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
      'Whether the editor addon is connected, which Godot answers, whether the editor is playing something, and which games with the runtime addon are reachable, of every project on the machine. For the first half-minute after a server starts, connected false with mayYetConnect true can mean not reached yet.',
    answer:
      "server names this server: its pid, its version, and lifecycleLog, the file every gdharness server of the user appends a line to when it starts, when its client first names itself, when it replaces another server of its project, and when it ends, with why it ended (the client closing its end as stdin:end, a signal by name, superseded with the successor's pid, an uncaught exception or rejection with its stack, or the exit code) and the calls it was answering then. A server killed without warning writes no ended line, and on Windows every kill is that, so a started line with no ended line after it is a server something killed. serverVersion is the gdharness version of this server. projectIs, when present, is the gdharness version of the addons in the project, which differs from this server's (project_info says which of the two to move), and configIs the version the project's MCP config starts, so the next connection runs that one. " +
      "runtimeConnected counts the games of the project this server serves on this release's runtime addon, and runtimes lists every game on the machine with ofThisProject saying which is which, since a game of another project is reached only by naming its projectPath, and userDir, the directory its user:// is. Each game under runtimes is pinged with a short wait, so one held at a breakpoint is listed as unreachable rather than making this call wait out the runtime timeout. A game the editor played announces the editor under editorPid, and so does whatever that game started for itself. A game some other server started announces none. Each game says which runtime addon it loaded under addonVersion (null when it cannot say), and addonIsStale is true when that code is not what this server ships. staleNote says whether the project needs the gdharness upgrade command, spelled out to run in a shell, the game a restart, or this server a reconnect. A second checkout of a project, such as a git worktree, carries addons of its own. A runtime_* call to a stale game is refused with the staleNote and not sent. A game announced in a protocol this server does not speak is listed under unreadable, with the protocol it speaks and whether the server or the addon is the older half, during an upgrade that moves the protocol, until the halves match. Such games are running, but no tool here can reach them, so runtimes stays empty and runtimeConnected stays false. " +
      'play says which play the editor is on: play.play counts the plays that editor has started since it opened, whoever started them, and play.editorPid is the editor, so two reads with different pairs are two plays even when both say playing. game.run names the run processActive is about, the one editor_output and editor_run stop answer for: its pid, its project, and adopted true when this server read it back from another server rather than starting it. It stays named after the run ends, beside processActive false, and is null when there is no run at all. startedAt says when it began, and endedAt when it ended, wherever something saw the end. heldAt says whether the run is held, with the same three answers editor_output gives. ' +
      "editor.lspListening and editor.dapListening say whether anything accepts connections on the ports the editor names, lspPort and dapPort, and are absent until an editor has connected: Godot binds each once, as the editor starts, and reports a failure only in the log panel of the editor itself, so a false comes with serversNote: editor_launch rebind binds the debug adapter again in place, and editor_launch restart the language server. editor.scan says whether the editor is scanning or importing and how many milliseconds ago its last scan finished (finishedMsAgo), or is null when it did not answer. editor.openScenes lists the scenes open in the editor's tabs, leaving out a tab of a scene never saved, editor.editedScene the one it is showing, and editor.unsavedScenes those with changes not yet written to disk, where an empty entry is a scene never saved. All three come with scan and are absent when it is null. " +
      'When connected is false, mayYetConnect says whether that is final: the editor dials this server and backs off between tries. False is an editor that is not there. editorCannotConnect is a project without the gdharness editor addon installed or enabled, where no editor can ever dial in, and its remedies say how to install or enable it. restartInterrupted is a restart an earlier server asked to quit and never launched, usually because the reconnect the restart was taken for ended that server in between, and editor_launch open finishes it. restartUnderway is a restart still in progress, so another editor is not to be opened. closedHere and quitUnused say this server closed the editor, or that a hidden editor quit with no call for the idle minutes its project sets, with the scenes the next call that needs it opens again. listeningSince is when this server took the bridge port. An editor this server opened counts for as long as its process lives, and awaitingLaunchedEditor names its pid. Any editor of this project running and not yet connected, whoever opened it, is named under editorsNotYetConnected with its pid and start time. An editor that has connected and not yet greeted reports nothing about itself: greeting says so, addonIsStale is absent rather than guessed, and every other call made in that window waits up to ten seconds for it to settle. settingsDropped appears once when the editor this server opened saved project.godot on its way in and took a key out of it. An engine run that loads the editor addon to do one job and quit, such as godot --headless --import, an export or a script, is not taken as the editor: from the socket opening until its greeting and its command line are read, identifying is true and connected false, and turnedAway names the last one turned away, with its pid and the option. ' +
      "addonIsStale is decided by the code of the editor addons rather than their version, so an editor started before an upgrade that left that code alone reports the older addonVersion, is not stale, and addonNote says so. A stale editor is asked nothing but to quit: every other call to it is refused with staleNote. port is the one the editor bridge is on. When that is not the one this server was configured with, portWanted names the configured one and portNote says why it moved. A server replacing another of its project waits for it to stand down and takes the port over, which takes a few seconds, and bridgeHandover says so while it waits. startedByAnEditor is an editor another editor started, by Godot's own restart or the project manager, which has none of the arguments a server gave the one before it, and startedByAnEditorNote says what that costs. bridgeAvailable says the editor bridge is listening. When it failed to start, startupError gives the error, and retryingBridge is true while this server tries again. announcedAt is the file where this server told editors of its project which port to dial. connectedAt is when the editor connected, and lastPongAt when it last answered this server's keep-alive ping. addonDigest is a hash of the editor addon's code. debugPort is the port of the editor's remote debugger. openedByAServer says a gdharness server started this editor, syncsBreakpoints that it keeps its breakpoints when a debug session opens, and hidden that it runs with no window anybody can see. pendingRequests counts the requests sent to the editor and not yet answered, and queuedResources the files with writes waiting behind another write to the same file.",
    parameters: {},
    requires: [],
  },
  {
    name: 'editor_rescan',
    title: 'Rescan the project',
    effect: 'additive',
    changes: 'Writes under `.godot` and adds `.uid` files. Changes no script or scene.',
    description:
      'Makes the running editor scan the project filesystem, so files written outside it are picked up. Calling it again is the cure for a class_name the editor cannot see, named under unseenByEditor by other tools. editor_launch restart also does it. Needs the editor connected.',
    answer:
      'waitedMs is the whole call, and waitedForEditorScanMs, given only when a scan or an import was already running, the part spent waiting it out. waitedForEditorAnswerMs, given when an idle editor took a second or more to say so, is how long that took: such an editor is busy on the thread that answers with an earlier request rather than scanning, so the time is added to timeoutMs rather than taken from it, and the note says so. stillWorking is true when a scan was still running at the end of the wait. The scan the call started is looked at once even when the wait has run out, so stillWorking is never said of a scan nothing looked at. ' +
      'The scan the editor runs on its own is a change-detecting walk, so a file another engine has already imported reads as settled and its class_name stays out of the list the editor resolves against, however often it scans. Calling this again is the cure. editor_launch restart also does it and costs a window, and project_import refresh_classes does not touch what the editor holds. The walk also passes over a file whose .uid alone changed, so each file whose .uid names a UID the editor does not hold for it is read again before scanning and named under uidsReread, and files on disk naming one UID between them are named under uidsDuplicatedOnDisk, which reading again cannot settle. Every script naming a brought-in class is reloaded, because what the editor compiled from them while it could not see the class stays compiled that way. One that would not reload is named under dependentsNotReloaded and the call is not ok, as it is not when the script named in reloadScript was not reloaded. A script that fails to compile is tried again once the scripts it is compiled against that the editor holds behind their files are reloaded, named under reloadedFirst. The classes the editor could not see before that scan are noted in the project, and the next editor_rescan of the same editor, from any server, names them under broughtIn and reloads what names them. A scan writes .godot/global_script_class_cache.cfg from the list the editor is holding, so a class the editor cannot resolve goes out of that file: the answer names the loss under cacheLost and rebuilds the cache from the files, naming what came back under cacheRestored, and the note says to restart an editor that lost classes before scanning again. A class the editor still holds for a script that was renamed or deleted is left out of the rebuilt cache and named under cacheDropped, and every scan until the editor restarts ends in that rebuild. A script or shader written outside the editor has no .uid sidecar until something imports it, and the scan writes one beside it. A hidden editor imports on the thread that answers, so a large addon install can leave the rescan itself unanswered, and when the wait runs out first the answer is stillWorking.',
    parameters: {
      projectPath: PROJECT_PATH,
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description: 'How long to wait for the scan. Default 30000.',
      },
      reloadScript: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'A script to recompile in the editor after the scan, or a list recompiled in order. A loaded script keeps the copy it built unless reloaded here. A script that does not compile, or a @tool script, is not reloaded, and reloadProblem says why. A list is answered under reloads.',
      },
      listMembers: {
        type: 'boolean',
        description: 'With reloadScript: also answer the whole member lists. Default false.',
      },
    },
    requires: ['projectPath'],
  },
  {
    name: 'editor_capture',
    title: "Capture the editor's view of a scene",
    effect: 'read',
    description:
      "A picture of a scene as the editor's 2D or 3D view draws it, including what its @tool scripts draw, which runtime_capture cannot show. Needs a connected editor that draws: a visible one, or a hidden one on Windows.",
    answer:
      "The picture, with its size in pixels and which view drew it. When width or height scaled the picture, it also gives the size the view drew at. A scene with unsaved changes in the editor is captured as the editor holds it and says so. Other calls to the editor wait for the capture. The view is the editor's own, at its zoom and scroll for that scene, and in 3D with its grid and gizmos.",
    parameters: {
      projectPath: PROJECT_PATH,
      scenePath: SCENE_PATH,
      view: {
        type: 'string',
        enum: ['2d', '3d'],
        description: "Which of the editor's views draws the scene. Default 3d for a Node3D root, else 2d.",
      },
      width: {
        type: 'integer',
        minimum: 1,
        description: 'Scale the picture to this width, keeping its proportions when height is not given.',
      },
      height: {
        type: 'integer',
        minimum: 1,
        description: 'Scale the picture to this height, keeping its proportions when width is not given.',
      },
      outputPath: {
        type: 'string',
        description: 'Also save a PNG at this absolute path outside the project, which must not exist.',
      },
      inline: {
        type: 'boolean',
        description: 'Send the picture back in the answer. Default true. false needs outputPath.',
      },
    },
    requires: ['projectPath', 'scenePath'],
  },
  {
    name: 'editor_classes',
    title: 'Engine classes',
    description:
      "The engine's ClassDB, with the classes the project's scripts declare beside it: find classes, read one in full, or walk an inheritance tree. info reads engine classes only, and script_info structure reads a project class. " +
      CLASSES_REBUILT,
    answer:
      "The project's classes are read from the scripts on disk, so one written a moment ago is there before any scan. query and inheritance answer them under project_classes, project_children and project_descendants, each with its path, what it extends and whether it is abstract. filtered_count, direct_children_count and all_descendants_count count the engine classes in the lists beside them. instantiableOnly leaves out an engine class that cannot be instantiated and a project class that is @abstract or built on one that cannot be, and keeps a class extending an @abstract one. info gives each property of a class that can be made its default, the value a new one holds. includeInherited gives one entry per ancestor, nearest first, with the names of what it declares, and member reads any inherited member in full, looked for on the class and every ancestor. The whole of Control is seventy thousand characters.",
    parameters: {
      projectPath: PROJECT_PATH,
      filter: { type: 'string', ops: ['query'], description: 'A substring of the class name.' },
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
        description: 'Limit to one family.',
      },
      instantiableOnly: {
        type: 'boolean',
        ops: ['query'],
        description: 'Leave out abstract classes. Default false.',
      },
      className: {
        type: 'string',
        ops: ['info', 'inheritance'],
        description: 'The class.',
      },
      includeInherited: {
        type: 'boolean',
        ops: ['info'],
        description: 'Also name every member the class inherits, under inherited.',
      },
      member: {
        type: 'string',
        ops: ['info'],
        description:
          'One member by name, with its signature and the class that declares it. Use it for "does the engine have it", since a whole class can run to seventy thousand characters.',
      },
    },
    requires: ['projectPath'],
    operations: {
      query: {
        effect: 'read',
        summary: "classes matching a filter or category, the engine's and the project's",
        requires: [],
      },
      info: {
        effect: 'read',
        summary: 'methods, properties, signals and enums of one class, or one member of it by name',
        requires: ['className'],
      },
      inheritance: {
        effect: 'read',
        summary: 'ancestors and descendants of one class, an engine class or one a project script declares',
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
    description: 'Reads the running game. Needs the game running with the runtime addon.',
    answer:
      "tree: a node at the last level that has children answers children_not_shown with their count instead of children. text: lines, count, and under omitted how many lines the limit left behind. out_of_view counts the lines left out for being drawn outside the viewport or a ScrollContainer, with a note saying so. A line drawn as a copy under a node saying the same words, as an outline or a glow is, reads once, counted under copies. Every line reads as drawn: rich text without tags, text only as far as it is typed out, a translation rather than its key, an upper-case label in capitals and a secret field as its mask. Tab titles, menu bar titles, list items, a tree's column titles and rows, and an open menu's items and the titles of its separators read a line each. find: nodes and count, with hidden counting the matches left out as hidden and out_of_view those left out as drawn out of view, each with a note. A match drawn under a matching node drawing the same words names that node under copyOf, and distinct counts the rest. A node counts as hidden when the engine would not draw it: a hidden Control, Node2D or Node3D above it hides it, a plain Node in between breaks that chain, and a hidden canvas layer or window hides everything in it. A glob that finds nothing says under note how many nodes it would find open at both ends, and a bare word that names contain says how many do and what glob would have found them. A label with a line break is matched with the break in the words, and a backslash followed by n counts as one. rect: canvas is the node's own viewport and window is where it is drawn in the game's window, through any embedded dialog or SubViewport. A 2D node answers where it stands, and a sprite, collision shape, polygon or line also the rectangle it covers under covers. A 3D node answers the point to aim at, which is the middle of what it draws, the rectangle it covers, the camera that drew it, and behind_camera when it is not in front of one. For a Control, visible and in_view, false when it is drawn wholly outside its viewport or a ScrollContainer holding it, and drawn_over names what a pointer at its centre would reach instead, such as a dialog over the screen. What a ScrollContainer holds out of its sight is not in the tree until it is scrolled to. metrics: frame_time is the mean wall time of the last frames_timed frames (up to 120, with the game, physics and the wait for the display included), frame_time_max the slowest, both in seconds and null before a frame has passed. vsync says whether a frame waits for the display, and max_fps is the game's frame-rate cap, 0 for none. process_frames and physics_frames count frames and physics steps since the start, and get_frames_drawn() stays 0 headless. physics_steps_per_second is the physics steps a second over those frames, fewer than physics_ticks_per_second when a frame needs more than max_physics_steps_per_frame or the editor's Game view slows it. fps, process_time_max and physics_time are the engine's monitors, set once a second: the last second's frames and its slowest process and physics step, so they trail a change by up to a second, and the last two are worst cases, not the frame. memory_static is the engine's CPU-side allocation in bytes. render_video_mem_used, render_texture_mem_used and render_buffer_mem_used are the renderer's GPU memory in bytes, which memory_static leaves out. accessibility: under windows, each element with its role (text for static text, button, check_box, group for a control holding others), name, value, value_text (a range's spoken words, such as \"75%\"), description, placeholder, bounds in the window's pixels, the actions a reader is offered (click, focus, toggle, set_value, select, expand_collapse, scroll_into_view), and focused on the focused one. node is the node that made the element. A part a node made of itself has part_of, the node drawn around it that holds its words, or part_of_candidates where several are, and part: announcement marks the text a window announces through. An empty name reads as nothing: static text takes it from accessibility_update_set_value, and _note counts the text elements on screen with none. tooltip is the node's tooltip_text, which a Windows reader is not told. With nothing focused, the engine calls GdharnessRuntime focused. tookMsBy splits the read's milliseconds into starting PowerShell (start), loading UI Automation (load) and walking the windows (walk). A read stopped at its deadline says instead which of those it had reached. With nodePath, only the elements that node and those below it made are kept, whether as node or part_of, each window keeping the outermost of them with what they hold, and matched counting them. A screen whose dialog sits under a long list is a screen read with omitted greater than zero, so raise limit or point nodePath at the dialog rather than reading the answer as what is on screen. A step of a property path that is not there is named, with what was there instead.",
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      nodePath: {
        type: 'string',
        ops: ['tree', 'text', 'find', 'rect', 'property', 'accessibility'],
        description:
          'tree, find, text: where to start, default /root. rect, property, accessibility: the node. A unique name "%Player" works. property also takes an engine singleton, as runtime_invoke does.',
      },
      property: {
        type: 'string',
        ops: ['property', 'find'],
        description:
          'The property to read, or a script constant. find reads it off every node matched. A colon path reads through what a node holds: "_game:clock:speed", an index or key "_game:run:roster:0:traits", or a component "size:x". A step written as a call, "get_viewport():gui_get_focus_owner()", calls a method that only reads.',
      },
      depth: {
        type: 'integer',
        minimum: 0,
        ops: ['tree'],
        description: 'Levels to descend, 0 for the node alone. Default 3.',
      },
      includeProperties: {
        type: 'boolean',
        ops: ['tree'],
        description: 'Include every stored property. Large, so prefer properties.',
      },
      properties: {
        type: 'array',
        items: { type: 'string' },
        ops: ['tree', 'accessibility'],
        description:
          'tree: properties to read off each node, colon paths allowed. accessibility: the fields to keep, such as ["role", "name"].',
      },
      className: {
        type: 'string',
        ops: ['find'],
        description: 'A native class, matching its subclasses too, or a class_name.',
      },
      script: { type: 'string', ops: ['find'], description: 'The script file the node carries.' },
      namePattern: {
        type: 'string',
        ops: ['find'],
        description:
          'A case-insensitive glob on the whole node name, such as "Enemy*", or alternatives split at |, such as "Enemy*|Boss". Write \\| for a bar in a name.',
      },
      group: { type: 'string', ops: ['find'], description: 'A group the node is in.' },
      says: {
        type: 'string',
        ops: ['find', 'accessibility'],
        description:
          'The words a node shows, as drawn, case-insensitive. A bare word is a contains, * or ? makes a glob over the whole text, | splits alternatives. accessibility: filters elements by name, value or value_text.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        ops: ['find', 'text', 'accessibility'],
        description:
          'find: most nodes, default 100. text: most lines, default 500. accessibility: most elements, default all. At most 5000.',
      },
      includeHidden: {
        type: 'boolean',
        ops: ['text', 'find'],
        description:
          'Count hidden nodes and controls outside the viewport. text: default false. find: default true.',
      },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        ops: ['metrics'],
        description: 'Which to read. Default all.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description:
          'How long to wait before answering pending with a requestId. Default 10000, accessibility 75000.',
      },
    },
    requires: [],
    operations: {
      tree: {
        effect: 'read',
        summary: 'the live scene tree, with current_scene naming the scene shown',
        requires: [],
      },
      text: {
        effect: 'read',
        summary: 'every line of text under nodePath in reading order, as drawn, leaving out what is hidden',
        requires: [],
      },
      find: {
        effect: 'read',
        summary:
          'the nodes matching className, script, namePattern, group or says, with property read off each',
        requires: [],
      },
      rect: {
        effect: 'read',
        summary: "one node's rectangle or position in canvas and window pixels",
        requires: ['nodePath'],
      },
      property: {
        effect: 'read',
        summary: 'what one property reads on a node, or through the objects it holds',
        requires: ['nodePath', 'property'],
      },
      metrics: {
        effect: 'read',
        summary: 'frame time, memory, draw calls and the rest',
        requires: [],
      },
      accessibility: {
        effect: 'read',
        summary:
          'what the game tells a screen reader. Needs a windowed Windows run with engineArgs ["--accessibility", "always"]',
        requires: [],
      },
    },
    defaultOperation: 'tree',
  },
  {
    name: 'runtime_invoke',
    title: 'Set or call in the running game',
    description:
      'Sets a property or calls a method on a node, or on an engine singleton nodePath names, in the running game. Needs the game running with the runtime addon. A call that takes longer than timeoutMs is not cancelled: the answer is pending with a requestId, and op result collects it.',
    answer:
      "Errors raised meanwhile come back under errors and warnings. When ended_by_error_at is given, result is not a value the method returned. At most 20 errors and warnings are given, with errors_not_shown and warnings_not_shown counting the rest. A write a setter kept from changing anything is refused with what it reported. A method declared to return an enum has its result named under result_named, such as PROCESS_MODE_INHERIT, and an Error as the engine words it, such as Unavailable for 2. A write of the value the property already holds, at its own precision, answers unchanged: true. A game this server started that its debugger holds is said so, with where, before a call, and heldAt, the object editor_output gives, says when a call reached a breakpoint. A number past the range a property is exported with, or one none of its enum values has, is written, and the answer says so under outside_declared. A parameter typed as a script class without class_name is named by the class the script extends, so an object of that class with another script passes the check and the engine refuses the call: the answer says the method did not run, with the engine's reason. A path that reaches no object, or an object of another class than the parameter declares, is refused, and so are too few or too many arguments. A call on a list or map that changes it, such as clear() or sort(), is not a step in a path.",
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      nodePath: {
        type: 'string',
        ops: ['set', 'call'],
        description:
          'Node path such as "/root/Main/Player", a unique name such as "%Player", or an engine singleton such as Engine, Performance, Time or PhysicsServer2D. call: also a class_name or res:// path, for a static function.',
      },
      property: {
        type: 'string',
        ops: ['set'],
        description:
          'The property to write. A colon path goes through what a node holds, "_game:run:day", "_game:run:roster:0:name" or "position:x". Steps are as runtime_inspect property describes.',
      },
      value: {
        ops: ['set'],
        blank: true,
        description: `The value, fitted to the property's type. Vectors are {"x": 140, "y": 300}, a colour may be "#ff8000", an enum takes its name or number. An object property takes a path to one the game holds, or null, and a resource its res:// path. ${WHOLE_NUMBERS}`,
      },
      method: {
        type: 'string',
        ops: ['call'],
        description:
          'The method, or a colon path through what a node holds, "_game:run:advance". Change a list or map with set.',
      },
      args: {
        type: 'array',
        ops: ['call'],
        description: `The arguments, fitted to the parameter types. An object parameter takes a path to one the game holds, "/root/Main/Hud", or a resource's res:// path. Another engine object is {"_type": its class, and its properties}. ${WHOLE_NUMBERS}`,
      },
      properties: {
        type: ['boolean', 'array'],
        items: { type: 'string' },
        ops: ['call'],
        description:
          'Read the object the call answered with under result_properties: true for every variable its script declares, or a list of colon paths.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        ops: ['set', 'call'],
        description: 'How long to wait before answering pending with a requestId. Default 10000.',
      },
      requestId: {
        type: 'integer',
        minimum: 1,
        ops: ['result'],
        description: 'The requestId a pending answer gave.',
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
      "A picture of the running game: the whole screen, one region or node of it at full resolution, or one viewport. The screen is the game's window with its dialogs and popups laid over it. Needs the game running with a window. A capture before the first frame is drawn waits for it.",
    answer:
      "A region partly outside the window is cut to it and answered clipped. The answer names the region captured in window pixels, and drawnAt when the project draws at its own size and stretches that to the window, since the picture then has the game's pixels. nodePath captures what runtime_inspect rect answers for the node: a Control's rectangle, what a 3D node's geometry covers, or what a Sprite2D draws. zoom makes each pixel a square of pixels rather than blending it. An inline picture is sent as a JPEG when that is smaller than the PNG and the picture has no transparency, and the text says so with both sizes. outputPath saves a lossless PNG, and the answer says where.",
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      viewportPath: {
        type: 'string',
        ops: ['viewport'],
        description: 'The Viewport node. Default the root viewport. A hidden or minimised Window is refused.',
      },
      width: {
        type: 'integer',
        minimum: 1,
        description: 'Scale the image to this width, keeping its proportions when height is not given.',
      },
      height: {
        type: 'integer',
        minimum: 1,
        description: 'Scale the image to this height, keeping its proportions when width is not given.',
      },
      region: {
        type: 'object',
        ops: ['screenshot'],
        description:
          'Capture only this rectangle: x, y, width and height in window pixels, as runtime_inspect rect answers.',
      },
      nodePath: {
        type: 'string',
        ops: ['screenshot'],
        description: 'Capture only where this node is drawn. Not with region.',
      },
      zoom: {
        type: 'integer',
        minimum: 1,
        maximum: 16,
        description: 'Enlarge the picture this many times. Not with width or height. Default 1.',
      },
      outputPath: {
        type: 'string',
        description: 'Also save a PNG at this absolute path outside the project, which must not exist.',
      },
      inline: {
        type: 'boolean',
        description: 'Send the picture back in the answer. Default true. false needs outputPath.',
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
    changes: 'Acts on the running game. Writes no file.',
    description: 'Input to the running game. Works headless.',
    answer:
      "On the hidden desktop the run's first pointer_note says why that matters. A native window no real pointer has entered gets no hover from Godot, so the runtime supplies it and the answers say hover_supplied. click: what was under the pointer, and what became of the control: in_tree, removed or freed. A button answers pressed_signal, whether its pressed signal fired during the click. Named by says, found says which match it was, its index being the index argument that presses the same match again, found.item names the tab, list entry, tree row or menu bar title pressed (its kind, its says, its index, which is the item's own number in its control and not found.index, and for a row the column of the cell saying the words), and found.pressedOn says \"the words\" for words in a RichTextLabel pressed where they are drawn, or \"the middle of the label\" with a note saying why they could not be placed. found.picked says why a match was picked, and found.partOf names a match saying the words only as part of more, which is refused when another control says exactly the words (hidden, off the screen, covered, or on screen taking clicks without being a button) and when it lets the pointer through to what is under it. Words found only inside longer words (\"away\" in \"Faraway\") rank after every other match and are refused unless index is given. Words starting a longer word count. An empty field says its placeholder, and a control with no text of its own says its accessibility name. A disabled tab, list entry or row is refused. On a rich label link_pressed says whether the press reached a link, with link_meta giving the meta the label reports clicked, an empty one included. A control scrolled into view first is scrolled each container out from it a frame after the one inside, and scrolled_into_view says whether a scroll value changed. A button in toggle mode, a CheckBox or CheckButton included, answers pressed with before and after, its button_pressed either side of the click: the same value twice is a click the game undid, and after is null when the click freed it. A refusal for a pointer turned off names where mouse_behavior_recursive was set. On a 3D node landed says the interface did not swallow the press: no control under the pointer stopped it, a control letting the pointer pass included, and every viewport on the way out from the room had the pointer over what shows the room. A disabled button, a control that does not process and one mouse_behavior_recursive turned off are refused, since the press would do nothing. choose: what was chosen, read before the press, which is heard rather than assumed. A menu is opened rather than clicked because its items are drawn rather than built, and the item is looked for as the menu stands once open, since a game can fill a menu as it opens. It also answers what became of the control named (in_tree, removed or freed, since a game can rebuild its screen on the pick), and what the button in front of the menu shows now when it is still there. A disabled or hidden button in front of the menu is refused, and so is a press the menu did not take. action, key, mouse_click and joypad_button: the event as it was sent, with whole saying whether the press was let go of again and pressed whether it is left held down (true only after pressed true), for a key the keycode, physical_keycode and unicode it carried, and for a controller button its number, its name and the device. A held press answers held_frames and under held_for the seconds the hold lasted and the physics_frames that ran in it: a process frame is no set time, and a headless game, drawing nothing, runs them far faster than the sixty physics ticks a second that _physics_process sees. mouse_motion: the position and the relative movement sent. mouse_drag: from, to, motions sent and relative_total. touch: the finger's index, the position, whole and pressed as a mouse_click has them, and emulates_mouse, since in the game's window the engine makes mouse events carrying DEVICE_ID_EMULATION from the first finger down where emulate_mouse_from_touch is on. touch_drag: what mouse_drag answers, with index and emulates_mouse. joypad_motion: the axis by number and name, the value and the device. key, mouse_click, click, joypad_button and joypad_motion answer actions, the InputMap actions the event also presses. For a motion, those are the ones its direction reaches past their deadzone, and none for one inside it. mouse_click, mouse_motion and mouse_drag answer hovered, the control under the pointer once the events are handled, or null over none. The other events are aimed at nothing. mouse_click with a press, and mouse_drag, answer press_went_to, the path of what the press went to (a control, or a window embedded over the point), read before it, or null when nothing there takes the pointer. Given nodePath naming a Control, landed says whether that is the control or inside it. A click that did not land on a control whose mouse_filter is ignore, as a Label's is, says so under why_not_landed, and one on a control with something drawn over it names that, a window stacked above the one the control is in among them. An action, a key, a joypad_button or a joypad_motion answers focused with the path of the Control holding the keyboard focus when it went in, since that Control gets it before the game's _unhandled_input: Space or Enter on a focused button presses the button, and a stick or dpad pressing ui_down moves a focused list's selection, or the focus, and never reaches the game's handler. Where the press moved the focus, focused_after names the Control holding it once the event was handled, or null when nothing does. A click and a mouse_click answer focused_after too, read in the viewport holding what was clicked. A key that a focused LineEdit or TextEdit took as typing names that field under typed_into, with what it holds under holds, since a field being edited keeps the key from the game's _unhandled_input. editing_ended true, on a key or on text, is a LineEdit that stopped being edited, as Enter does by submitting it: it keeps the focus, and nothing typed into it lands until it is clicked again. text with the focus on a control that is no LineEdit or TextEdit answers holds null and a note saying so, since a focused button takes a space or Enter as a press. A mouse_click, mouse_motion or mouse_drag given nodePath answers it under path, its points in the pixels of the window they went to, and that window under window when it is not the game's own. One with a point outside the viewport it went to says so under outside_viewport, with the viewport's rectangle, since no control there receives it. A wheel button is always a whole step, as a mouse sends one: a lone wheel press holds the viewport on the control that took it, so every later click lands there. key is not for a menu a click has opened: an OptionButton or PopupMenu pops up as a window of its own that a key never reaches, so arrows move nothing and Enter closes it unchosen, and choose selects there. An embedded dialog whose owner reads keys in _input gets them. An engine dialog is not answered by action: AcceptDialog reads the Escape key itself and never asks the InputMap, so ui_cancel goes in and the question stays up. action answers shortcuts, the buttons it was sent to as their Shortcut, and shortcut_pressed, the one pressed, null when none took it: at most one button, the last in the tree that takes it, passing over one that is disabled, hidden or outside its shortcut context. text answers what it landed in and what the field then holds (a secret field as its mask), a character at a time, and with a dialog focused the field is that dialog's focus, where the keys go. replace false types at the caret, so a field reading 2.1 typed \"0.3\" at reads 2.10.3. A joypad axis stays where a motion puts it until another motion moves it, and holdFrames needs a value other than 0.",
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      nodePath: {
        type: 'string',
        ops: ['click', 'choose', 'mouse_click', 'mouse_motion', 'mouse_drag', 'touch', 'touch_drag'],
        description:
          'click: the Control or 3D node. With says, where to look instead. choose: the PopupMenu, or its OptionButton or MenuButton. Pointer ops: the node whose space x and y are in, default the window.',
      },
      says: {
        type: 'string',
        ops: ['click'],
        description:
          'The words on the control to click, matched as runtime_inspect find matches says. The best match is pressed, and index picks among equals.',
      },
      action: {
        type: 'string',
        ops: ['action'],
        description: 'The InputMap action name.',
      },
      pressed: {
        type: 'boolean',
        ops: ['action', 'key', 'mouse_click', 'joypad_button', 'touch'],
        description: 'Leave out for a whole press. true holds it down, false lets go of one held.',
      },
      holdFrames: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        ops: ['action', 'key', 'mouse_click', 'joypad_button', 'joypad_motion', 'touch'],
        description: 'Hold a whole press for this many process frames, then let go. Not with pressed.',
      },
      strength: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        ops: ['action'],
        description: 'Default 1.',
      },
      keycode: {
        type: ['string', 'number'],
        ops: ['key'],
        description: 'The key name, such as "Space" or "A", or its Godot keycode.',
      },
      text: {
        type: 'string',
        ops: ['text', 'choose'],
        blank: true,
        description:
          'text: what to type. A newline is Enter. choose: the item to take, by what it says as drawn.',
      },
      replace: {
        type: 'boolean',
        ops: ['text'],
        description: 'true writes over what the field says. Default false types at the caret.',
      },
      index: {
        type: 'number',
        ops: ['click', 'choose', 'touch', 'touch_drag'],
        description:
          'click: which equal match, from 0. choose: the item by place. touch: the finger. Default 0.',
      },
      shift: { type: 'boolean', ops: ['key'], description: 'Hold Shift with it.' },
      ctrl: { type: 'boolean', ops: ['key'], description: 'Hold Ctrl with it.' },
      alt: { type: 'boolean', ops: ['key'], description: 'Hold Alt with it.' },
      x: {
        type: 'number',
        ops: ['click', 'mouse_click', 'mouse_motion', 'mouse_drag', 'touch', 'touch_drag'],
        description:
          "Window pixels, or nodePath's own space when given. click: the point in the control's own space instead of its centre.",
      },
      y: {
        type: 'number',
        ops: ['click', 'mouse_click', 'mouse_motion', 'mouse_drag', 'touch', 'touch_drag'],
        description: 'As x.',
      },
      toX: {
        type: 'number',
        ops: ['mouse_drag', 'touch_drag'],
        description: 'Where the release is, in the space x is in.',
      },
      toY: {
        type: 'number',
        ops: ['mouse_drag', 'touch_drag'],
        description: 'As toX.',
      },
      via: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        ops: ['mouse_drag', 'touch_drag'],
        description: 'Points the stroke passes through, each [x, y]. Default a straight line.',
      },
      frames: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        ops: ['mouse_drag', 'touch_drag'],
        description: 'Process frames the stroke takes. A hand takes 20 to 60.',
      },
      button: {
        type: ['string', 'number'],
        ops: ['click', 'mouse_click', 'mouse_drag', 'joypad_button'],
        description:
          'Mouse: left, right, middle, wheel_up or wheel_down. Default left. Joypad: a name such as a, start, dpad_up or left_shoulder, or a JoyButton number.',
      },
      axis: {
        type: ['string', 'number'],
        ops: ['joypad_motion'],
        description: 'A name such as left_x or trigger_right, or a JoyAxis number.',
      },
      value: {
        type: 'number',
        minimum: -1,
        maximum: 1,
        ops: ['joypad_motion'],
        description:
          'The axis position. Down and right are positive, and a trigger runs 0 to 1. It stays until another motion moves it, or for holdFrames. 0 lets it go back.',
      },
      device: {
        type: 'number',
        minimum: 0,
        ops: ['joypad_button', 'joypad_motion'],
        description: 'Controller, from 0.',
      },
      doubleClick: {
        type: 'boolean',
        ops: ['click', 'mouse_click'],
        description: 'Click twice, the second press marked double_click.',
      },
      relativeX: {
        type: 'number',
        ops: ['mouse_motion'],
        description: 'The movement carried. Default the distance from the last injected pointer event.',
      },
      relativeY: {
        type: 'number',
        ops: ['mouse_motion'],
        description: 'As relativeX.',
      },
    },
    requires: [],
    operations: {
      click: {
        effect: 'additive',
        summary: 'press and release a Control named by nodePath or says, or a 3D node where it is drawn',
        requires: [],
      },
      choose: {
        effect: 'additive',
        summary: 'take an item out of a menu, by its words or its place in the list',
        requires: ['nodePath'],
      },
      action: { effect: 'additive', summary: 'press an action, or hold it', requires: ['action'] },
      key: {
        effect: 'additive',
        summary: 'press a key, or hold it. Not for an open menu: choose selects there',
        requires: ['keycode'],
      },
      text: {
        effect: 'additive',
        summary: 'type into the field being edited',
        requires: ['text'],
      },
      mouse_click: {
        effect: 'additive',
        summary: 'click a mouse button at a position',
        requires: ['x', 'y'],
      },
      mouse_motion: {
        effect: 'additive',
        summary: 'move the mouse to a position',
        requires: ['x', 'y'],
      },
      mouse_drag: {
        effect: 'additive',
        summary: 'press at x, y, move a step each frame, release at toX, toY',
        requires: ['x', 'y', 'toX', 'toY', 'frames'],
      },
      touch: {
        effect: 'additive',
        summary: 'press a finger at x, y and lift it, or hold it',
        requires: ['x', 'y'],
      },
      touch_drag: {
        effect: 'additive',
        summary: 'mouse_drag for one finger',
        requires: ['x', 'y', 'toX', 'toY', 'frames'],
      },
      joypad_button: {
        effect: 'additive',
        summary: 'press a controller button, or hold it',
        requires: ['button'],
      },
      joypad_motion: {
        effect: 'additive',
        summary: 'move a stick or trigger axis to a value',
        requires: ['axis', 'value'],
      },
    },
  },
  {
    name: 'runtime_wait',
    title: 'Wait in the running game',
    description:
      'Answers when something has happened in the running game. A watch records from before the call that sets it off, so a change over before the next call arrives is still seen. Needs the game running with the runtime addon.',
    answer:
      'until: met, and value, the last reading of the property when the wait answered, whatever the wait asked for. A wait that was not met also answers waited_for, the value it compared against. outside_declared, for == and !=, says the value waited for is not one the property declares. A number no value of an enum has, or one past an export range, is waited for all the same, since a game may store one. elapsed_ms and frames say how long it waited. A wait for says looks every frame while a look is cheap and less often on a screen large enough for a look to cost a real share of a frame. The answer counts the frames the wait spanned and the looks it took, and says under looking_ms how long the looks took between them. A look on a large screen is read about 2ms to a frame, except the last look as the time runs out, which is read whole. longest_hold_ms is the longest the looks held one frame, which tells a long frame the game logs apart from one the wait caused. A wait that runs out while a hidden node holds the words says so under unseen_note. What is drawn over a node is not looked at, so words under a dialog or a panel count either way. ' +
      'signal with a watch answers at once, with fired_before_wait, when the signal fired after the watch was armed, and otherwise waits for it. times counts how often it fired, args is what the first carried, fired_after_ms the milliseconds from the arming to the first, and elapsed_ms how long the wait itself took. A watch that never fired says that one fired before the arming is not counted. The watch goes with the answer either way. ' +
      'recorded: changes, each with frame (process frames since the watch was armed, 0 the reading at arming: a process frame is no set time, and a headless game, drawing nothing, runs them far faster than the sixty physics ticks a second that _physics_process sees, so game_time is the clock), elapsed_ms (wall-clock milliseconds since the arming), game_time (the seconds of process time the game had been given between the arming and that frame, scaled by Engine.time_scale as a tween is, and like frame it counts from the watch, not from the start of the game) and value. A property that changes every frame records one change a frame up to 1000, an answer of tens of thousands of characters. frames and elapsed_ms say how long it recorded. calls lists each runtime_invoke set or call and runtime_input sent while it recorded, in order, with call (the tool and op), what it was given of path, method, property, action, keycode, button, pressed and says, and frame, the last reading taken before it ran, so what it changed shows from the next reading at the earliest. Two calls sent one after the other arrive frames apart, which frame tells apart from a delay in the game itself. calls_dropped counts any past 1000. dropped says so when more than 1000 changes came, and ended when recording stopped before it was collected: the node was freed, the path stopped reading, or 120000 ms passed. A client can run a call sent beside a wait only after the wait answers, so a wait sent with the call misses it.',
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      frames: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        ops: ['frames'],
        description: 'How many to let pass, 1 to 600.',
      },
      seconds: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: 120,
        ops: ['seconds'],
        description: "The game's own time to let pass, above 0 up to 120, scaled by Engine.time_scale.",
      },
      nodePath: {
        type: 'string',
        ops: ['signal', 'watch', 'until'],
        description:
          'The node, such as "/root/Main/Player" or "%Player". Needed but for a signal with a watch and for says, which defaults to /root.',
      },
      signal: {
        type: 'string',
        ops: ['signal', 'watch'],
        description: 'The signal name. watch takes it or property, not both.',
      },
      watch: {
        type: 'integer',
        minimum: 1,
        ops: ['signal', 'recorded'],
        description:
          'The watch an earlier watch call answered. signal takes it in place of nodePath and signal.',
      },
      property: {
        type: 'string',
        ops: ['until', 'watch'],
        description:
          'watch: record this property every frame until recorded collects it. until: the property name or a colon path as runtime_inspect property reads one, such as "global_position:x" with compare ">=".',
      },
      value: {
        ops: ['until'],
        description:
          "The value to wait for, fitted to the property's type. An enum takes a name or a number.",
      },
      compare: {
        type: 'string',
        enum: ['==', '!=', '>=', '<=', '>', '<'],
        ops: ['until'],
        description:
          'How what the property reads stands to value. Default ==. The orderings suit a counter that steps.',
      },
      says: {
        type: 'string',
        ops: ['until'],
        description:
          'Wait for these words to appear instead of for a property, matched as runtime_inspect find matches says. Not with property.',
      },
      includeHidden: {
        type: 'boolean',
        ops: ['until'],
        description: 'With says: count words on a hidden node or one outside the viewport. Default false.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: 120000,
        ops: ['signal', 'until'],
        description: 'How long to wait before answering anyway, 1 to 120000. Default 5000.',
      },
    },
    requires: [],
    operations: {
      frames: { effect: 'read', summary: 'let frames pass', requires: ['frames'] },
      seconds: {
        effect: 'read',
        summary: "let seconds of the game's own time pass, which a headless game's frames are no measure of",
        requires: ['seconds'],
      },
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
          'start recording a signal or a property, answering with a watch. Arm it before the call that sets it off, then collect it with signal or recorded',
        // A signal or a property, which the declaration cannot say, so the handler asks.
        requires: ['nodePath'],
      },
      recorded: {
        effect: 'read',
        summary: 'what a watch of a property recorded since it was armed',
        requires: ['watch'],
      },
      until: {
        effect: 'read',
        summary: 'wait for a property to read as a value, or for words to appear under a node',
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
      "Sets, removes or lists breakpoints. A set on a line the engine never stops on is refused, naming the next line it does. A breakpoint set before editor_run is in place from the game's first frame. Every answer lists the whole set under held, and the ones set in the editor's gutter under setInEditor.",
    answer:
      "With the editor connected a set goes through the editor's debug adapter, and with none it is held here. A game this server starts itself, which editor_run start does for a run given args, savesIn, env or silent, for a headless run of a project whose editor plays its games with a window, or with no editor, is handed every breakpoint held here as it starts, and one set while that game runs reaches it, and the set answers once the game has taken it, which it does between frames, so a call made after the answer stops there (runningGame says so). Such a game does not stop on a script error, so a run that meets one carries on past it: editor_output has the error with where it happened, and a breakpoint on that line stops the game before the line runs. The editor keeps a breakpoint set this way for one play, so every breakpoint this server holds is sent again before each play editor_run starts, and the start answer lists them under breakpoints. The set is also kept in the project, for the server that comes after a reconnect: a breakpoint stays until it is removed here, whichever server set it. Setting one here never takes the ones set in the editor's gutter away, and removing a line here clears it whoever set it. A remove takes any line, and with no editor connected answers removed false, saying why, when none was held there. A set on a script behind a link that leads out of the project is not read, so its line is not checked, and lineNotChecked names the link. Godot clears every breakpoint in the editor when a debug session opens unless network/debug_adapter/sync_breakpoints is on, which the addon turns on as it loads. An editor where it was turned off again is said so under breakpointsAtRisk, here and in editor_status.",
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
        summary: 'the breakpoints held here under held, and with the editor connected the ones in its gutter',
        requires: [],
      },
    },
  },
  {
    name: 'debug_control',
    title: 'Step the debugger',
    changes: 'Acts on the running game. Writes no file.',
    description:
      'Pauses, continues or steps the debugged game. A step waits for the game to stop again and answers with the stack, or with heldAgain false after ten seconds. pause and step_out are for a game this server started, so hold an editor-played game with a breakpoint.',
    answer:
      "A game the editor plays is moved through the editor's debug adapter, which answers a pause by reporting the game stopped and leaving it running, and implements no stepOut. A game this server started itself has its keeper as its debugger, which does both: pause breaks into the game wherever it is, a script spinning in a loop included, which is how a game hung on its first frame is asked where it is. For such a game a step that ends in gdharness's runtime addon, as one past a function's last line does when the addon's _process runs next, is stepped on to the game's own script as a pause is. Since the engine reports every stop the same way, a step that stops on a line holding a breakpoint says onBreakpoint under held, whether the step ended there or ran into it. A pause waits thirty seconds and past that answers paused false with the request still standing. The game takes it between frames, and in a script every 2048 lines it runs, so a loop that sleeps between few lines can take seconds. Stopped between frames, where no script runs, the game is stepped on to the next line of script it runs, and stopped in the runtime addon, an autoload whose _process runs first in every frame, on to the next line of the game's own script, for up to five seconds. One whose stack is still the addon's after them says so in a note. A pause that reaches a game a breakpoint has just stopped makes the engine print an error, which the run's output keeps as info with raisedBy debug_control pause. step_out runs to the end of the current function and stops at the next line run at its caller's depth: in its caller, or, when the call was the last thing its caller did, wherever script runs next. A function the engine called, such as _process, is stepped through to its end and stops at the next line of script the game runs, which can be the same function on another node.",
    parameters: {},
    requires: [],
    operations: {
      pause: {
        effect: 'additive',
        summary: 'stop a game this server started where it is, answering with the stack',
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
        summary: 'run to the end of the current function. Only for a game this server started',
        requires: [],
      },
    },
  },
  {
    name: 'debug_state',
    title: 'Debugger state',
    description:
      "Where the debugged game is stopped: the stack trace, what is in scope at a frame, an expression evaluated at a frame, or the debugger's console output so far. The errors and warnings a game reported are in editor_output. evaluate runs what the expression calls, so a call that changes something changes the game.",
    answer:
      "For a game this server started, its keeper's debugger answers: each frame names its script as the project spells it under script and on this machine under path, and held says which thread stopped and why. The output is what the game printed. For a game the editor plays, the editor's debug adapter answers. A stop is reported by the editor's adapter only to the sessions connected when it happened, so a server that connected afterwards, which is every server after a reconnect, is shown a thread and no frames about a game still sitting at its breakpoint. That server asks the runtime instead: a held game accepts a connection and never answers, and the refusal then says held rather than running, and that the stack cannot be read from here. debug_control continue lets it go, and the next stop is one this session is told about, with its stack. A function that awaited is resumed with no caller below it, since the call that started it returned at the await, so its frame is the only one. A value inside an array or a dictionary is shown as the engine prints it: a String quoted, a StringName as &\"name\", a NodePath as ^\"path\" and a whole float with .0. In a game this server started, a typed array or dictionary is typed as declared, such as Array[String], and a list or a dictionary shows its first 20 entries and says how many more it holds. An evaluate such as items.slice(20, 40) reads the rest. Members lists the script's variables and not its constants, which an evaluate reads by name. The variables give an object as its class and instance id only, and evaluate reads into it. An evaluate is worked out by the game at a frame, with the frame's locals, the globals and every global class in scope and the frame's instance as self. A frame with no instance, a static function's called on its class, is refused, since the engine lets the game go on rather than evaluate there. The frame below it has one. The compiler's own locals, named with @ such as a for loop's @counter_pos, are left out. A frame the stack no longer holds is refused, and a scope whose values did not arrive in time answers variables null and is named under valuesMissing. An expression that does not parse, or fails as it runs, comes to null with failed saying why, as the engine words it, and a null with no failed is the value. The error the engine prints for it is in the run's output as info with raisedBy debug_state evaluate, and does not count among the run's errors. The engine loads every global class's script for the first evaluate of a run, so the errors of one that does not parse are the evaluate's too. After that load the engine reports the parse error as the held game's stack until the game next stops, so the evaluate's answer says so under note, and stack, variables and evaluate are refused until then. For a game the editor plays, the stack still reads true, and only variables and evaluate are refused. The game's error breaks are held off while its evaluate runs, so an error the evaluate raises does not break the game, and the editor's Ignore Error Breaks setting is back once it answers. For a game the editor plays with no runtime addon, the reason reaches only the editor's Debugger panel, so a null there carries a note saying it may be either. The game reports what an expression raises while it is held inside a runtime_invoke call as raised by that call, and the call's answer says so under errorsNote.",
    parameters: {
      frameId: {
        type: 'number',
        ops: ['variables', 'evaluate'],
        description: 'Which frame, from a stack answer. Default the innermost.',
      },
      expression: {
        type: 'string',
        ops: ['evaluate'],
        description:
          "A GDScript expression with self's members, locals, autoloads and global classes in scope, such as wave.spawned[0] or Ledger.entries.size().",
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
      evaluate: {
        effect: 'destructive',
        summary: 'what an expression comes to at a frame, worked out by the held game',
        requires: ['expression'],
      },
      output: { effect: 'read', summary: 'console output captured through the debug adapter', requires: [] },
    },
    defaultOperation: 'stack',
  },
  {
    name: 'debug_objects',
    title: 'Object snapshots',
    description:
      'Counts the objects the running game holds by class, and compares two snapshots to show what an action kept alive. Each snapshot is kept under the id its answer names. Only for a game this server started, which editor_run start gives with args, engineArgs, env or savesIn, or with no editor serving the project. Needs an engine with debug features.',
    answer:
      "A scripted object is counted under its script's class_name, or under the script's path when it declares none, with its engine class beside it. Objects of inner classes are counted under their native class, as the engine's profiler counts them, and note says how many. kind says whether a class is RefCounted, a Node or neither, and refCounted and nodes total them. The editor's ObjectDB Profiler takes every snapshot a game the editor plays sends, which is why it is only for a game this server started.",
    parameters: {
      before: {
        type: 'string',
        ops: ['diff'],
        description: 'The id of the earlier snapshot, such as s1.',
      },
      after: {
        type: 'string',
        ops: ['diff'],
        description: 'The id of the later snapshot. Default a snapshot taken now, kept and named.',
      },
    },
    requires: [],
    operations: {
      snapshot: {
        effect: 'read',
        summary: 'take a snapshot, keep it and answer its counts by class, most objects first',
        requires: [],
      },
      diff: {
        effect: 'read',
        summary: 'each class whose count changed between two snapshots of the same run, biggest change first',
        requires: ['before'],
      },
    },
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

/** The longest description a client is sent. Claude Code cuts a tool's description beyond it. */
export const MOST_DESCRIPTION_CHARACTERS = 4096;

/** A tool's description as a client is sent it: the prose and its ops. */
function servedDescription(spec: ToolSpec): string {
  return `${spec.description}${describeOperations(spec)}`;
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
  const left = Object.keys(spec.operations ?? {}).filter((op) => !ops.includes(op));
  // Naming the fewer ops says the same and costs less.
  if (left.length < ops.length) {
    return left.length === 1 ? `Not for op ${left[0]}.` : `Not for ops ${left.join(', ')}.`;
  }
  return ops.length === 1 ? `For op ${ops[0]}.` : `For ops ${ops.join(', ')}.`;
}

/** The specs as the protocol carries them. */
export function buildToolDefinitions(): MCPToolDefinition[] {
  return TOOL_SPECS.map((spec) => {
    const properties: Record<string, JSONValue> = {};
    if (spec.operations) {
      properties['op'] = {
        type: 'string',
        enum: Object.keys(spec.operations),
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
