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
  /** One line on what the op does, for the description, or '' where the op's name says it all. */
  readonly summary: string;
  readonly effect: Effect;
  /** Arguments the op needs on top of the tool's own. */
  readonly requires: readonly string[];
  /**
   * Sets of arguments of which a call gives at least one whole, for an op whose need is a choice
   * the schema's `required` cannot say. The tool list, the reference and the server's refusal all
   * read it, so none can say the op needs something else.
   */
  readonly requiresOneOf?: readonly (readonly string[])[];
  /**
   * The refusal of a call that gives none of `requiresOneOf` whole, where the plain list of sets
   * leaves out what makes the call work. `said` replaces the sentence and `next` is the next step.
   */
  readonly unmet?: { readonly said?: string; readonly next?: readonly string[] };
}

/** [items] as prose: "a", "a and b", "a, b and c". */
export function listed(items: readonly string[]): string {
  const last = items.at(-1) ?? '';
  return items.length === 1 ? last : `${items.slice(0, -1).join(', ')} and ${last}`;
}

/** An op's `requiresOneOf` as prose, each name passed through [named]: "nodePath and signal, or watch". */
export function requiredSetsSaid(
  sets: readonly (readonly string[])[],
  named: (name: string) => string = (name) => name,
): string {
  return sets.map((set) => listed(set.map(named))).join(', or ');
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
  const rule = "Every call takes `projectPath`, the project folder's absolute path";
  if (without.length === 0) {
    return rule;
  }
  const named = without.map((name) => `\`${name}\``).join(', ');
  return `${rule}, except ${named}, which ${without.length === 1 ? 'takes' : 'take'} none`;
}

/**
 * Which game answers a `runtime_*` or `debug_*` call that names neither `projectPath` nor `pid`.
 *
 * Built once and rendered into the skill and the tool reference, because it was written in each
 * of those separately and each said a different amount of it: the reference said those tools "pick
 * between running games" and stopped, and `projectPath` said "not needed with one game", which says
 * nothing about two. A session with another project's game listed beside its own read both and
 * could not tell what was answering it. What decides is in `chooseRuntime` and in `ownGameAmong`
 * above it, so the sentence is one and the order is theirs. The server instructions carry
 * `THE_GAME_PICKED_IN_SHORT` once, since the tool list is paid for on every call.
 */
export function theGamePicked(): string {
  return (
    'A call naming neither `projectPath` nor `pid` goes to the game this server started or is ' +
    'playing, named under `answeredBy` when others run too. Failing that, it goes to the only game ' +
    'running. Otherwise the call is refused. The refusal names every game and the argument that ' +
    'tells them apart: `pid` within one project, `projectPath` across projects.'
  );
}

/** The order of `theGamePicked` in one sentence, for the server instructions. */
export const THE_GAME_PICKED_IN_SHORT =
  'A runtime_* call without projectPath or pid goes to the game this server started or plays, else to the only game running.';

const PROJECT_PATH: JsonSchema = {
  type: 'string',
  description: 'Absolute project path.',
};
const RUNNING_PROJECT_PATH: JsonSchema = {
  type: 'string',
  description: 'Which game, when several run: its project folder.',
};
const RUNNING_PID: JsonSchema = {
  type: 'number',
  description: 'Which game, when several run from one project: its process id.',
};
const SCENE_PATH: JsonSchema = {
  type: 'string',
  description: 'Scene file, such as "scenes/main.tscn".',
};
/**
 * How the scene and resource tools answer when no editor serves the project. The server's
 * instructions say it once for the tool list, and each of those tools' `answer` carries it.
 */
export const WITHOUT_AN_EDITOR =
  'Goes through the editor when one serves the project, and otherwise through a headless engine. writtenBy (readBy for a read) says which.';
/**
 * What a headless engine does to the project beyond the call, said in the description of each tool
 * that can run one, since both outlast the answer.
 */
export const CLASSES_REBUILT = "Headless, it updates .godot's class list and starts autoloads.";
/** What a scene write says it saved on nodes it was not asked to change. Said as WITHOUT_AN_EDITOR is. */
export const ALSO_SAVED =
  'A scene is saved as the engine holds it once loaded. One not last saved by an editor can gain or lose lines on any node, and alsoSaved lists each.';
/** What a run says about the imports it brought up to date before it started. */
const IMPORTED_FIRST =
  "importedFirst names the files imported before the run because their import was behind, and uidsWrittenFirst the scripts given a .uid. importTookMs is outside the run's time limit.";
const SCRIPT_PATH: JsonSchema = {
  type: 'string',
  description: 'Script file inside the project, such as "scripts/player.gd".',
};
const RESOURCE_FILE = 'File inside the project, such as "sprites/hero.png" or "materials/steel.tres".';
/** What a move of a file leaves unrewritten, said where resource_edit moves one. */
const PATHS_LEFT =
  'A relative path stays as written in text, tooltip_text, placeholder_text, resource_name, node names, groups, ; comment lines and .import files. A GDScript comment stays whole.';
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
  description:
    'Properties to set, keyed by Godot name. Vectors are {"x": 1, "y": 2} or, as a read answers, {"_type": "Vector2", "x": 1, "y": 2}. A colour may be "#ff8000", an enum takes its name, "position:x" sets one component. A node property takes a path such as "../Player", a Resource property a res:// path or {"_type": "CircleShape2D", "radius": 8}. A map keyed by anything but text is {"_type": "Dictionary", "entries": [[key, value]]}. A whole number of 2^53 or more is {"_type": "int", "value": "9007199254740993"}. A "metadata/" key adds metadata, and null takes it off. A slash path such as "sources/0/0:0/0/probability" writes inside a built-in resource.',
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
  description: 'add_track: the track to add. remove_track: the track to take out, as read answers it.',
  properties: {
    type: {
      type: 'string',
      description: 'add_track: property or method. remove_track: any of these types.',
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
    update: {
      type: 'string',
      enum: ['continuous', 'discrete', 'capture'],
      description:
        'Default: as the RESET track, else continuous for a whole float, vector, colour or transform property, else discrete, position:x too.',
    },
    interpolation: {
      type: 'string',
      enum: ['nearest', 'linear', 'cubic', 'linear_angle', 'cubic_angle'],
      description: 'Default: linear, or as the RESET track. An existing track keeps its own.',
    },
    loopWrap: {
      type: 'boolean',
      description: 'Blend the last key into the first. Default true, or as the RESET track.',
    },
    method: {
      type: 'string',
      description:
        'Method tracks: the method to call. A missing method or args that do not fit are written too, with methodFound or argumentsFit false. remove_track: only the keys calling it.',
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
        description:
          'Variables: the inspector group, such as "Stats/Loot", or "" for none. Without it, an export joins the group open below the last variable.',
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
  description: 'Atlas sources, one per texture. A resourcePath that already exists is refused.',
  items: {
    type: 'object',
    properties: {
      texture: {
        type: 'string',
        description: 'A texture file inside the project, such as "sprites/tiles.png".',
      },
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
    description: `The project name, main scene and Godot version, with counts of its scenes, scripts and assets. include adds sections. ${CLASSES_REBUILT}`,
    answer:
      'Assets are images, fonts, sound, models, video and shaders, and other counts every remaining file. No count includes the .import and .uid files beside others, or the addons gdharness installed. Nor does one include a file in a folder holding a .gdignore or its own project.godot, or one behind a link out of the project. ' +
      "classes lists each class_name with its script, read from the files. Those an addon declares are counted per addon under inAddons, unless addonClasses names the addon. input_actions lists the project's actions with their events, and an engine ui_ action only when the project rebinds it, as engineAction. export_presets marks as runnable the one preset of its platform the editor's one-click deploy uses. " +
      'health and validation name each script that fails with its first error, and each missing file a scene, resource or script refers to. They name each input action a script reads by a literal name that nothing defines, with every line reading it. They name each scene connection whose method or signal the node at its end lacks, or whose argument count does not fit. ' +
      'health answers a score out of 100 and a grade, and a failed check can still grade A. Notes such as TODO under addons/ are left out.',
    parameters: {
      projectPath: PROJECT_PATH,
      include: {
        type: 'array',
        items: { type: 'string', enum: [...PROJECT_INFO_SECTIONS] },
        description:
          'Extra sections. health and validation compile every script and report broken scripts, missing files, unknown input actions, broken connections and export problems.',
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
        description: 'full adds what to do about each validation finding. Needs validation in include.',
      },
    },
    requires: ['projectPath'],
  },
  {
    name: 'project_settings',
    title: 'Project settings',
    description:
      'project.godot and the audio bus layout. A write with an editor open on the project goes through the editor.',
    answer: [
      "get answers exists, true for any setting the engine knows. at_default is true when the value is the engine's own default and so has no line in project.godot. default_value is that default, given when the value is not at it. overrides is the value each feature's override holds. Each setting under prefix carries at_default too, and default_value when it is not at it.",
      "get of a setting with no engine default, such as an input action the project added, has no at_default. An override answers override_of, its base setting. One project.godot does not set answers exists false with holds, the base setting's value. A setting an override file sets is answered with the project's value and overridden_in, the file and the value a run reads.",
      "set answers old_value and new_value. was_new is true when project.godot did not set the setting before. was_default is true when what it held was the engine's own default, which old_value then is. It adds overrides with overridesNote when a feature's override still replaces the setting, and overriddenNote when an override file does. A set that writes nothing answers unchanged true and saved false.",
      "unset answers removed, old_value and default_value, the value that holds now. default_value is null for a setting the engine does not declare. unset of an override, such as name.feature, also answers override_of and holds, the base setting's value that builds with the feature now read. On a setting the file does not set, unset answers removed false. Its note names the nearest settings when the engine does not declare it either.",
      'add_input_action on an existing action replaces its events, and its deadzone when one is given, and answers was_new false with old_events and old_deadzone. add_autoload on a name already registered replaces its entry and answers action updated with old_path.',
      'rename_audio_bus answers resent, the buses sending to the old name. rewritten lists the scene and resource lines giving a node the old bus. namedInScripts lists the scripts naming it in a string, which are left as they are. add_audio_bus lists every bus after the new one moves.',
      "Every write changes only the lines of the settings it names, apart from the header comment and config_version. An enabled plugin's code loads on the editor's next start. editorNote, on any write, is an editor that could not take the write, or one on another release's addon that was not asked. That editor still holds the old values until editor_launch restart.",
    ].join('\n\n'),
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
          'The value, fitted to the registered type: an enum takes its name or number, vectors are {"x": 1, "y": 2}, a colour may be "#ff8000". Infinity is {"_type": "float", "value": "inf"}, and "" writes an empty string. An undeclared setting is written as given, so a packed array is tagged {"_type": "PackedStringArray", "value": ["res://a/"]}.',
      },
      name: {
        type: 'string',
        ops: ['add_autoload', 'remove_autoload'],
        description: "The autoload's name. add_autoload replaces one already registered.",
      },
      path: {
        type: 'string',
        ops: ['add_autoload'],
        description: "The autoload's script or scene.",
      },
      enabled: {
        type: 'boolean',
        ops: ['add_autoload', 'set_audio_bus_effect'],
        description:
          'set_audio_bus_effect: whether the effect is on, a kept one too. Default true. add_autoload refuses false.',
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
        description: 'The bus, by name. add_audio_bus: the new one.',
      },
      newBusName: {
        type: 'string',
        ops: ['rename_audio_bus'],
        description:
          'The name the bus takes. Buses sending to it follow, and every scene and resource line giving a node the old bus is rewritten. A script naming it in a string is left as it is and listed under namedInScripts.',
      },
      sendTo: {
        type: 'string',
        ops: ['set_audio_bus_send'],
        description: 'The bus to send to, by name. It must come before this bus.',
      },
      parentBusIndex: {
        type: 'number',
        ops: ['add_audio_bus'],
        description:
          'Index of the bus the new bus sends to. Default 0, Master. The new bus goes right after it, so every later bus moves one along.',
      },
      busIndex: {
        type: 'number',
        ops: ['set_audio_bus_effect', 'set_audio_bus_volume', 'set_audio_bus_send'],
        description: 'The audio bus, by index.',
      },
      effectIndex: {
        type: 'number',
        ops: ['set_audio_bus_effect'],
        description:
          'Slot on the bus, where an effect of another class is replaced and one of the same class stays with its settings. One past the last adds one.',
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
        description: 'Solo the bus. Buses not soloed are silent.',
      },
      bypassEffects: {
        type: 'boolean',
        ops: ['set_audio_bus_volume'],
        description: "Skip the bus's effects.",
      },
    },
    requires: ['projectPath'],
    operations: {
      // Neither is required because either will do, and which one is missing is a better refusal
      // than a list of both: the engine answers that, since it is what reads them.
      get: { effect: 'read', summary: 'read one setting, or every setting under prefix', requires: [] },
      set: { effect: 'destructive', summary: '', requires: ['setting', 'value'] },
      unset: {
        effect: 'destructive',
        summary: 'take a setting out, so the engine default holds',
        requires: ['setting'],
      },
      add_autoload: {
        effect: 'additive',
        summary: '',
        requires: ['name', 'path'],
      },
      remove_autoload: { effect: 'destructive', summary: '', requires: ['name'] },
      set_main_scene: {
        effect: 'destructive',
        summary: '',
        requires: ['scenePath'],
      },
      add_input_action: {
        effect: 'destructive',
        summary: 'register an input action and its events, or rebind one that exists',
        requires: ['actionName', 'events'],
      },
      remove_input_action: {
        effect: 'destructive',
        summary: '',
        requires: ['actionName'],
      },
      enable_plugin: { effect: 'destructive', summary: '', requires: ['pluginName'] },
      disable_plugin: { effect: 'destructive', summary: '', requires: ['pluginName'] },
      add_audio_bus: { effect: 'additive', summary: '', requires: ['busName'] },
      remove_audio_bus: {
        effect: 'destructive',
        summary: 'remove a bus, sending what sent to it on to where it sent',
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
        summary: '',
        requires: ['busIndex', 'sendTo'],
      },
    },
  },
  {
    name: 'project_search',
    title: 'Search the project',
    effect: 'read',
    description:
      'Searches project files for text or a regular expression, one entry per matching line. It skips dot names, addons gdharness installed, and folders holding a .gdignore or their own project.godot.',
    answer:
      'total_matches counts the matching lines, however often each holds the query. Past maxResults truncated is true, and the summary still counts the whole search. A line cut to the 400 characters around its first match carries shownFrom, the column they start at. Its lineLength is the length of the whole line. not_searched names each skipped folder or link the search passed. Among them are a link out of the project and one to a folder the search is inside. A path naming a skipped folder is searched as asked, and note says the whole-project search steps over it. When no file searched has one of fileTypes, note names the extensions there are.',
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
    answer: [
      "forward lists each file this one loads or names by its path. Its kind is ext_resource, extends, preload, load or include. It is path for a path only written in a string, which the file may never load. A reference closing a cycle is marked circular, with the cycle under circular_references. A script's dependencies include every script whose class_name it uses, marked by_class, and the script of every autoload it names, marked by_autoload.",
      "forward follows an ext_resource whose uid names another file than its path to that file, as the engine loads it, with the path under stale_path. One whose uid names no file is followed by its path, with the uid under unknown_uid. A load or preload of an unknown uid is listed under that uid as missing. A shader's #include is followed relative to the shader.",
      "forward marks a file the depth stops at with beyond_depth, how many files it names that were not walked. A file's dependencies are listed at its first entry, and later entries carry dependencies_listed_above. summary.total_dependencies counts each file reached once, and total_references counts the entries in the tree. missing names each file referenced that does not exist, with the files referring to it.",
      'reverse lists every file that refers to this one and how, for a file that is gone too, answered with exists: false. A file claiming the same uid is listed under shares_uid, since the engine loads only one file per uid. summary.in_code counts only the kinds below that are uses, which is the number to read when asking whether anything still uses this.',
      'reverse kinds that are uses: ext_resource, extends, preload, load, include and path by path, with stale_path or unknown_uid as forward has them. setting, plugin, export_preset and import mark one in project.godot, a plugin.cfg, export_presets.cfg or an import sidecar. class_name and autoload mark a use of the declared name.',
      'reverse kinds that are not uses: doc, a name in a ## comment, and comment, one in ordinary prose. stale_path is not a use either, an ext_resource naming it by a path the engine does not load.',
    ].join('\n\n'),
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
        description: 'forward: levels to follow. Default unlimited, which can be very large. Try 2 or 3.',
      },
      includeBuiltin: {
        type: 'boolean',
        description:
          'forward: also list files whose path starts res://., such as those under .godot. Default false.',
      },
      fileTypes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'reverse: extensions of the files to read, such as ["gd", "tscn"]. "godot" is project.godot. Default every kind that names a resource.',
      },
    },
    requires: ['projectPath', 'resourcePath'],
  },
  {
    name: 'project_import',
    title: 'Asset imports',
    description:
      'reimport and set_options import every file that is behind, not only resourcePath. An open editor scans the project first.',
    answer: [
      "options answers remap, deps and params as the .import file holds them, so an enum option such as compress/mode is its number. Godot's documentation of the importer says what each number means.",
      'reimport is answered from a second status read. reimported lists what is current now, and notReimported what is not. Each has one entry per status and reason, with the paths sharing them. via says which of the two did the work. When nothing needed reimporting, the two lists are empty, a note says so, and there is no via.',
      "importedByTheScan names what the editor's scan imported first. On a reimport of one resourcePath, alsoImported names the others it imported. wroteInProject names, by source, what an import wrote into the project itself rather than under .godot. An example is the .translation a CSV gives each language, which version control sees and internationalization/locale/translations names.",
      "The import gives every script without a .uid sidecar one, as the editor's scan does. uidsWritten names those scripts. uidsWrittenInAddons counts the ones inside an addon, per addon. A whole-project reimport also answers missingSource, the .import files whose source is not beside them. It is there even when nothing needed reimporting, empty when there are none. One resourcePath leaves it out. stillImporting is an editor that had not finished within timeoutMs.",
      'status judges by content, with the checks the editor makes before a reimport. It finds a sidecar changed since its import, or one with no uid or written for another file. It finds an output under .godot/imported that is gone (missing_outputs) or changed, and a source whose hash differs from the recorded one. A glTF scene built before an image it names was imported is named under imported_without. failed is an import that failed, which the editor never retries on its own.',
      'set_options answers changed, each option written as {was, now}, and unchanged_options, the ones already holding the value. Nothing is written or reimported when none changed. Its reimport is answered under reimport as op reimport answers. A dictionary option keyed by numbers takes its keys as strings of digits. A font\'s opentype_features also takes a four-letter OpenType tag, so {"opentype_features": {"liga": 0}} turns ligatures off.',
      "refresh_classes answers added. For a running editor it also answers three lists. unseenByEditor is a class it cannot resolve, and heldBehindInEditor one it holds from an older text. lostSinceLastRebuild is one the editor's own save dropped from the cache, until it restarts. staleInThisEngine names a class the rebuild added that the autoloads' engine did not know.",
      "refresh_classes's twiceDeclared names a class several scripts declare, so rename it in all but one. unreadableList says the old list could not be read and every class was added.",
      'refresh_uids names under uidsCreated the sidecars it made, and under uidsCached the files the cache newly took. stillWithoutUid names the ones the engine would not import. It writes no scene and no script.',
    ].join('\n\n'),
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
        description:
          'Import options keyed as the .import file spells them, {"compress/mode": 1}. Number keys are digit strings, and opentype_features also takes a tag: {"opentype_features": {"liga": 0}}.',
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
        summary: 'which resources are outdated or failed, and why',
        requires: [],
      },
      options: { effect: 'read', summary: 'the import options of one resource', requires: ['resourcePath'] },
      set_options: {
        effect: 'destructive',
        summary: 'change import options or the importer, then reimport',
        requires: ['resourcePath'],
      },
      reimport: {
        effect: 'destructive',
        summary: 'what status says is outdated or failed, or resourcePath',
        requires: [],
      },
      uid: {
        effect: 'read',
        summary: 'the UID of one file, or null',
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
      "A secret option is never answered. set_preset writes one to .godot/export_credentials.cfg, and remove_preset takes the preset's out of it. Removing the runnable preset makes the next of its platform runnable.",
    answer:
      "add_preset writes the keys the editor's Project > Export writes for a new preset. It writes every option a new preset of its platform shows, at its default. It makes it the platform's runnable preset when the platform has none. set_preset answers under changed what each value held before and holds now, and under unchanged what already held the value given. saved is false when nothing changed, and nothing is written when any of it is refused. Option names are the exporter's own, as the Export dialog's Options tab shows them, such as binary_format/embed_pck. An enum takes the name the dialog shows or its number. Some options show only while another is on, such as codesign/identity behind codesign/enable. Such an option is taken when the preset has that one on or the same call turns it on. A secret option, such as a signing password, is written to .godot/export_credentials.cfg, where the editor keeps secrets out of the committed file. A file an option names that is not there is written and listed under missing_files, or for a secret under secretsNamingNoFile. " +
      "exportFilter's dependencies are what the engine counts as them. A file named only in a string, such as a scene path in an exported property, is left out of the export. So is a script reached only by its class_name, though project_dependencies lists both. " +
      "remove_preset names under runnableNow the next preset of the platform that becomes runnable, or null, and takes a secret the preset held with it. A preset op answers where this engine's export templates belong and whether the preset's platform has them, and list says so for every preset. An editor open on the project does not see a preset added this way until it restarts. " +
      'run names under importedFirst what it imported first. A preset with shader_baker/enabled on, whose platform draws with Forward+ or Mobile, is exported by an editor. That editor draws with the renderer the platform uses, named under bakedWith, since a headless one bakes no shader. On Windows that editor draws out of sight. Elsewhere its window shows, which showWindow allows. run answers bytes, the size of the output. alsoWritten is what the export wrote beside it, such as the .pck a Windows or Linux build needs. Its entries are the newest two hundred distinct errors and warnings it printed. One printed more than once carries times, and errors and warnings count them. exported is true only when this run wrote the output and printed no error.',
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
        description:
          'Inside the project. run: where the export is written, and a missing folder is created. add_preset, set_preset: the path the preset stores.',
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
        description:
          'What the preset exports. All but all_resources use files. scenes and resources leave out a file named only in a string or by class_name.',
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
        description:
          'Platform options by name, such as {"binary_format/embed_pck": true}. An enum takes the name the dialog shows, or its number.',
      },
    },
    requires: ['projectPath'],
    operations: {
      list: { effect: 'read', summary: 'the presets in export_presets.cfg', requires: [] },
      run: {
        effect: 'destructive',
        summary: 'import what changed, then export with a preset',
        requires: ['preset', 'outputPath'],
      },
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
        summary: '',
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
      "Runs the project's gdUnit4 suites and answers with every case that did not pass. Needs gdUnit4 under addons/gdUnit4. It first updates .godot's class list and imports what is behind. The run's user:// is its own and is deleted after, but on macOS it is the player's. A suite needing a window shows one on Linux and macOS.",
    answer: [
      'passed is the verdict to read. failed has one entry per case that did not pass, with its first report as message and detail. failures counts the cases that failed an assertion, and errors the cases that hit an error. A case that did both counts in both. suites lists only the suites with something to say, and suitesPassed counts the rest.',
      'A case in failed with more than one report has them all under reports, in the order the case met them. A case can fail several assertions and then stop on a runtime error, which makes its status error. Identical reports fold into one with times. At most twenty different ones are kept, and reportsLeftOut counts the rest. Past a million characters the largest cases keep only their first message (failedWithoutDetail).',
      'A suite has something to say when a case failed, erred or was skipped, a hook failed, it left orphans, or an error was undeclared or declared and not printed. hookFailures is a before() or after() that failed, with its suite, line and whole message. failures and errors count cases and leave it out, so the verdict names it as failed hooks. The cases after a failed before() still run and are counted.',
      "exitCode is the engine's own exit, gdUnit4's code for what it saw (100 a case failed, 101 only warnings, 105 script errors it detected). It is 0 beside passed false when the run is failed for something gdUnit4 does not judge, such as an engine error no suite declared. leakedAtExit is the engine's lines saying it exited still holding objects, resources, memory pages or a server's RIDs, which fail the run too. Its note names any script of the project Godot itself never frees. On a run with engineArgs [\"--verbose\"] it names what the engine held.",
      "A run whose every case passed is still not called passed when it printed a script error no case failed on. gdUnit4 fails a case only on the script errors its logger sees, and it cannot see a stack overflow. uncaughtScriptErrors lists those errors, which are under engineEntries too, by index with detailUnder. It lists twenty at most, and uncaughtScriptErrorsOmitted counts the rest. One raised inside assert_error(...).is_runtime_error is the test's own and is not listed. None are when the project turns off gdUnit4's report/godot/script_error setting, and a suite declares them all the same.",
      "engineEntries holds each engine message once, with times saying how often it was printed. One that points at a project script has its script, line and function, as editor_output's entries have. An engine message keeps the frames above gdUnit4, not the twenty inside it. In a backtrace that repeats, as a recursion's does, each repeated frame or cycle of frames is written once. It names the frames it covers and how many times.",
      'undeclaredErrors lists each engine error no suite declared in its GDHARNESS_EXPECTED_ERRORS constant, with the suite and the case that printed it. An engine warning missing from GDHARNESS_EXPECTED_WARNINGS is listed too, marked warning true. An undeclared error or warning fails the run, whether or not gdUnit4 failed the case. With report/godot/push_error on, gdUnit4 also fails the case on each one, declared or not, and the note names those cases. One printed inside assert_error(...).is_push_error(...) or is_push_warning(...) passes there, and is declared all the same.',
      'declaredNotPrinted lists each declared error or warning its case did not print. A declared text must be the whole line after ERROR: or WARNING: and its space. A longer line its case printed holding the text is named under printedInstead. Either fails the run, and each suite holding one is listed with its count. engineErrors is every engine error the run printed but those a suite declared.',
      'orphans is the total of the orphan nodes gdUnit4 counted. Each suite that left some has its count, and a warning saying how to free them, under warnings. left names each case that left some and the nodes, by class, name and script. A hook\'s are under before or after, or the one value "before or after" where no case began. gdUnit4 decides its verdict on orphans and keeps them out of its report, so they are read off what it printed.',
      'scriptErrors holds the errors in full of a script that did not load, or of an autoload that did not compile. A script that does not load stops gdUnit4 before any suite runs, and an autoload that does not compile stops the run at once. The scripts that failed only because one they depend on did are listed by path under failedThroughDependency.',
      'A script in failedThroughDependency can fail on a class whose own script has a parser error, which gdUnit4 never names. Then the engine checks that script, and its error comes first, with the class it declares under declares. followFromUnresolved keeps apart the errors a script has only because that class did not resolve, which the engine reads as Variant.',
      "time is gdUnit4's own sum of the seconds its cases took, from its report. tookMs is the whole call in milliseconds, from the class rebuild to the engine's exit. tookMsBy splits it into the class rebuild (classes), the import after it (import) and the engine running the suites (engine). Each holds any wait for an engine slot or the editor's scan. Within engine, engineStart is what the engine spent before its first suite, and engineCompile the part of it compiling the suites, which no case's time holds.",
      'gdharness test judges a run the same way. A call that waited a second or more for engine slots in all has an engine_slot_wait block giving waitedMs and who held them. A run that ends without a report, at its timeout or otherwise, answers suitesFinished, suitesFailing with their failed cases, and suiteRunning, the one it was in. A suite that prints more than the 128 MiB a log may hold ends the engine, and the verdict names that suite. printedCapped names the lists read from a bounded window, when a run printed more distinct lines than an answer keeps. previousRunCut is a run a client cut off, kept in the project and carried by the next project_test there.',
      "classes is the class rebuild's answer. The classes each addon declares are counted under addedInAddons and changedInAddons rather than named. classes.lostSinceLastRebuild names a class the rebuild puts back that the cache had after the last rebuild. The editor loses it by writing its shorter list over the file on every save until restarted. uidsMissing names each suite the run ran with no .uid beside it, with uidsNote.",
      `engineNote names the engine the run used and its version, when it was not this server's. A project other than the server's own runs the engine its harness config names under GODOT_PATH. ${IMPORTED_FIRST}`,
      "A user:// of its own is made for the run on Windows and Linux and goes when the run ends. On macOS the engine reads user:// off HOME, so the run writes to the player's own, and savesNote says so. A client sending a progress token is told as each suite finishes, and at least every twenty seconds.",
      'A suite needs a window when it declares const GDHARNESS_NEEDS_WINDOW: bool = true, when a class constant of that name is true, or when it calls scene_runner and declares nothing. One declaring const GDHARNESS_ACCESSIBILITY: bool = true needs one too, and its engine starts with --accessibility always. A run holding one has a window, at the size project.godot gives its viewport and with no sound, and windowed is true. On Windows the window is on a desktop of its own. On a machine with no display such a run is headless, windowed is false, and windowNote says so.',
      'windowNote names the suites that needed a window. It also names any suite saying it runs headless whose every case was left out of a run that had a window. engines is 2 when the set mixed windowed and headless suites and ran as two engines, the windowed one first. The answer then has the counts and lists of both, and arguments the command line of each engine under windowed and headless. hung and timedOut are true when either engine was, and an engine that wrote no report has its explanation as a text part before the answer.',
      'timeoutMs is one limit for the whole call, so the second engine gets what the first left of it. With under 5000 ms of it left the second engine is not started, suitesNotRun names its suites, and engines is 1. The verdict gives the milliseconds left and the 5000 an engine needs to start. The note says the windowed suites ran and the headless ones were not started. A call cut off keeps for previousRunCut the suites the windowed engine finished and the suites not yet run.',
      'An entry of path that is not there is left out and named under missing, and such a run is never called passed. A script that declares test_ functions and does not extend GdUnitTestSuite is refused when named, and named under notSuites in a directory run whole. A case asked for by name in a script that is no suite is answered as not run. With GDHARNESS_SUITE_FILES_ONLY set, a directory is refused with the suite files under it.',
      'A case declared in a suite that passed and that gdUnit4 never ran comes back under testsNotRun. A row it skipped for data that does not fit the case comes back under rowsMismatched. A case it cannot run as declared (a parameter nothing fills, or a fuzzer after a setting) comes back under casesUnrunnable. Each has the reason gdUnit4 gave.',
      'An ignore entry that named a case which ran all the same comes back under ignoreNotApplied, with the form that would have left the case out. Every case the list left out comes back under ignored as suite_name:test_name, and every row as suite_name:test_name:N. An entry naming no suite, case or row under path comes back under ignoreUnmatched.',
      'A run killed at the limit answers timedOut and silentForMs, how long it had printed nothing. It is called hung only when that was half the limit, or thirty seconds of a longer one. Otherwise it was still running and wants a longer timeoutMs or a narrower path. The limit is counted from the engine starting, and the class rebuild and any import before it are outside it, though tookMs counts them.',
      'With failFast the counts cover only what ran, and notRun counts the cases left. printed holds the lines matched, ignoring case, in the text and the backtrace, at most 200, the newest kept. printedOmitted counts the rest.',
    ].join('\n\n'),
    parameters: {
      projectPath: PROJECT_PATH,
      path: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'A test directory or suite file, or a list of them. Default tests and test. "tests/suite.gd:test_name" runs one case.',
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
          'Run only these cases of the suites under path: "test_name", or "suite:test_name" with suite the file name without .gd.',
      },
      engineArgs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Engine flags, such as ["--verbose"].',
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
        description:
          'Also answer with the lines the run printed that contain this, ignoring case, under printed.',
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
    description: `Scene files. create makes any missing folder of the path. ${CLASSES_REBUILT}`,
    answer:
      `${WITHOUT_AN_EDITOR} ${ALSO_SAVED} ` +
      "create names a folder it made under madeFolder. It names the root as scene_node get names a node. rootNodeType is its engine class, scriptClass its class_name, and script the script it carries. A root made from a class_name is made as that script's base with the script attached. With inherits, the root is an instance of that scene, so changes there reach it. The answer names the scene under inherits. A save of a scene open in the editor saves the editor's copy, unsaved changes included. save with from editor opens a closed scene in the editor, and gives its @tool scripts and layout their frames. It then saves and closes it, and says so under openedFirst, or stillOpen when it could not close it.",
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
          'editor opens a closed scene in the editor and saves it from there. Left out, a closed scene is saved as the file loads.',
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
    description: `The nodes of a scene file: names, classes and hierarchy, with properties when asked. Needs no editor. For the nodes of a running game, runtime_inspect tree. ${CLASSES_REBUILT}`,
    answer:
      'type is the engine class, and a node whose script declares a class_name names it under scriptClass. The nodes listed under an instance come from its file. Its editableChildren says whether this scene, or one it inherits, keeps values of its own for them. One saved as a placeholder answers placeholder true, with InstancePlaceholder as its type. The root of an inheriting scene names the scene under inherits. Every node that scene or one further down makes names its file under inheritedFrom. A node in any group answers groups, sorted, from this file and every scene it comes from. The engine stops reading at a node instancing a scene it cannot load, and notRead lists that node and every one after it. A node at the last level that has children says how many under childrenNotListed. With properties, defaultsLeftOut counts the defaults left out, and on a node another scene makes setHere names the properties this file sets. A TileMapLayer or TileMap whose cells the file sets answers cellCount and cellsListedBy, the scene_node get call that lists them. An editor serving the project answers and says whether it holds unsaved changes to the scene. With none, a headless engine reads the file without making its nodes, so no script of theirs runs.',
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
          'List every stored property, defaults included. A Control has about 80. Turns includeProperties on.',
      },
    },
    requires: ['projectPath', 'scenePath'],
  },
  {
    name: 'scene_node',
    title: 'Scene nodes',
    description: `One node in a scene file. A set with properties {"name": "Boss"} renames a node. A rename or a reparent rewrites the paths naming the node, here and in the scenes instancing or inheriting this one. That saves an animation library kept in a .tres of its own. A delete rewrites none. ${CLASSES_REBUILT}`,
    answer: [
      WITHOUT_AN_EDITOR,
      "get answers nodeType, the node's engine class, with scriptClass when its script declares a class_name. nodePath is its path from the root however it was named, and setHere the properties this scene's own file sets on it. valuesFrom is the scene every value outside setHere comes from, when another scene makes the node. An instance of another scene also answers instanceOf, editableChildren and placeholder. groupsHere is the groups this file puts it in, when another scene puts it in others.",
      "get's layers gives each layer mask (collision_layer, collision_mask, visibility_layer) as the layers it holds, {layer, name}, with the name project.godot gives the layer. placement is a Node3D's position, rotation_degrees and scale from its transform. Each list is answered only when it names anything. groups lists, sorted, every group a node is in, on a get, an add that gave addGroups and every set that changes them.",
      'add and set answer each property given under properties as the node holds it once written. set answers each one unset under unset, and unsetNote names the scene an unset value now follows. An add with instancePath saves the node as an instance of that file, as Instantiate Child Scene does, and properties set its root.',
      'add and set leave out of the file a value the node has without it, as the editor does. That is what the scene it comes from gives, or its default. notStored names it, and notStoredNote says what it follows now.',
      'properties takes more forms than the listed ones. "script" is attached before the rest. An enum takes its number or its name, such as Add or BLEND_MODE_ADD. A map keyed by anything but text, such as Dictionary[Vector2i, int], takes {"_type": "Dictionary", "entries": [[key, value], ...]}. A "metadata/" key that is not there is added, and null takes it off, named under metadataRemoved.',
      'Each value is read back once set, and one the engine changed or refused is refused with what it holds. A key reaching into a built-in resource, "sources/0/0:0/0/probability" on a TileSet or "lines/1/text" on a list of resources, writes inside it. Writing to the next element of a list the engine keeps by index makes it.',
      "Every write answers alsoChanged, the other properties the engine changed in step, as {was, now}, such as a Control's offsets with its size. It also gives those a reparent changed to keep the node where it is drawn, or that the new parent sets. namesNoNode gives each node path written naming no node. sharedWith gives, for a property written through a resource built into the scene, each other {node, property} holding it, which changed too.",
      "Every write answers setByScript, what a script that is not a tool set as a headless write ran, which the file does not hold. loadsAs gives a value the node's own script changes as the scene loads. outsideDeclared names a value outside the declared range, enum or flags, a file its filter does not take, or an alpha on a colour declared without one. Each is written as given.",
      'A rename and a reparent rewrite the NodePath values and animation tracks naming the node, here and in the scenes instancing or inheriting this one. retargeted lists each rewrite and notRetargeted each one left, with the reason. followed names the other scenes rewritten, and notFollowed those left as they were, with why. A Node3D kept in place under a parent scaled unevenly ends up sheared, said under sheared.',
      'scriptsNaming lists each script line that reads a node by the old path a rename, a reparent or a delete took. Each is {scenePath, nodePath, script, line, from, to}, with to the path that reaches it now. Scripts are left as they were, as the editor leaves them, so each line listed fails until it is changed. It reads $Path, %Unique, and a string handed to get_node, get_node_or_null or has_node. A path built at run time is not seen.',
      "delete answers deletedWithIt, each node of this scene's own that went with it. stillNaming lists each node path and track that named a deleted node, here and in the scenes instancing or inheriting this one. A node-typed value that held one now holds null, marked cleared: true. connectionsRemoved lists each connection from or to a deleted node, as {sourceNodePath, signalName, targetNodePath, methodName}.",
      'delete takes from a scene instancing or inheriting this one what it kept for a deleted node. dropped lists it as {scenePath, nodePath, entry}, entry being values, node, connection or editable. That scene is named under followed.',
      'duplicate answers connectionsCopied, the connections its copy got, in the shape a delete gives. notUnique lists each copy of a node with a unique name, which the original keeps.',
      'change_type answers nodeType and wasType, with scriptClass when nodeType named a class_name. dropped names each value the new class lacks, and connectionsRemoved each connection it has no signal or method for. cleared names each node value typed so it cannot hold the new class, now null, as {nodePath, property}.',
      "save_branch writes the node and its children to newScenePath, .tscn when it has no extension. They keep their values, built-in resources, groups and the connections among them. The instance put in its place keeps the node's name, place among its siblings, position, rotation, scale and unique_id. It answers nodePath, newScenePath and index.",
      "save_branch's connectionsLost lists each connection from inside the new scene to outside it that the file cannot hold. namesOutside lists each node path or node in the new scene that reaches a node outside it, as {nodePath, property, path, names}. A path reaches it only where the scene is instanced as here, and a node is cleared (cleared: true). A %unique path across the branch edge is written as the plain path, under retargeted, and scriptsNaming gives each script line naming a node that way. A scene that instances or inherits this one and keeps values below the branch gets the instance marked editable there, named under followed.",
      'set_tilemap_cells answers placed and erased. They count the cells as they end.',
      "bake_navigation answers polygons, vertices and savedTo, the polygon's file. made is true when the region had none and was given one. A note says why when none came out, and meshesNote gives the engine's mesh warning. A 2D bake that read no obstacle says in its note that all its outlines enclose is walkable. It names the nodes giving obstacles that sit under no region.",
      "A node this scene inherits takes values of this scene's own. So does a node inside an instance once that instance's editableChildren is true. editableChildren false answers the nodes whose values went under droppedValues and the added nodes under droppedNodes. unset of a shader parameter is written back at the shader's default by an editor with a renderer on its next save.",
      ALSO_SAVED,
    ].join('\n\n'),
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
        description: 'The node class, such as "CharacterBody2D", or a declared class_name.',
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
          'Properties to remove from this scene\'s file, such as "modulate". Each then takes the value its source gives. An editor\'s next save writes an unset shader parameter back.',
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
          "Default true: the node stays where it is drawn, as in the editor, and a Control keeps its position only. false keeps the node's own transform.",
      },
      index: {
        type: 'integer',
        minimum: 0,
        ops: ['add', 'duplicate', 'reparent'],
        description:
          "Where the node goes among the parent's children, 0 for first. Default last, or right after the original for a copy under its parent.",
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
        summary: 'a node of class nodeType, or an instance of the scene at instancePath',
        requires: ['nodeName'],
      },
      get: {
        effect: 'read',
        summary: "read a node's class, properties and where its values come from, and a TileMap's cells",
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
      delete: { effect: 'destructive', summary: '', requires: ['nodePath'] },
      change_type: {
        effect: 'destructive',
        summary: 'make a node another class that keeps its name, children, script and matching values',
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
        summary:
          "bake a NavigationRegion2D or 3D from the geometry under it, into the scene or the navigation resource's own file, which every scene using it shares",
        requires: ['nodePath'],
      },
    },
  },
  {
    name: 'scene_signal',
    title: 'Scene signals',
    description: `Signal connections in a scene file. A connect to a method the target lacks, or one that cannot take what the signal passes, is written, with methodFound or argumentsFit false. A missing method is refused with binds or unbinds. A write puts back each connection the engine dropped on load, under unmadeConnections. ${CLASSES_REBUILT}`,
    answer:
      `${WITHOUT_AN_EDITOR} ${ALSO_SAVED} ` +
      'Each connection answers its flags as the number and as flagNames, binds and unbinds only when it has them. persist is on every connection, since a scene saves no other kind, and is added to flags either way. A read can name inherited, 32, on a connection an instanced scene makes. A connect of a pair already connected says alreadyConnected, and keeps what the call does not give. flagsBefore, bindsBefore and unbindsBefore show what it changed. Until a method a connect names exists, the signal fails each time it is emitted. A method may not take what the signal passes, with its unbinds, binds and appended source. Such a connection is written too, and answers argumentsFit false with misfit saying why. list gives each connection its methodFound, and misfit when it has one. It marks editable false on a connection a scene this one instances or inherits makes, and names that scene under madeIn. A file can hold a connection the engine loads the scene without. It binds to a missing method, or its source no longer declares its signal, or its node is gone. Any tool writing the scene, this one included, puts each back as the file held it and names it in its answer under unmadeConnections.',
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
          "The values passed after the signal's own. [] removes the connection's binds. Default: those it has.",
      },
      unbinds: {
        type: 'integer',
        minimum: 0,
        ops: ['connect'],
        description:
          "How many of the signal's own arguments are dropped from the end. 0 removes the connection's unbinds. Default: what it has.",
      },
      nodePath: { type: 'string', ops: ['list'], description: 'Only connections involving this node.' },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      connect: {
        effect: 'additive',
        summary: '',
        requires: ['sourceNodePath', 'signalName', 'targetNodePath', 'methodName'],
      },
      disconnect: {
        effect: 'destructive',
        summary: '',
        requires: ['sourceNodePath', 'signalName', 'targetNodePath', 'methodName'],
      },
      list: { effect: 'read', summary: 'every connection in the scene', requires: [] },
    },
  },
  {
    name: 'scene_animation',
    title: 'Animations',
    description: `Animations in an AnimationPlayer and states in an AnimationTree state machine. scene_node add puts the player or tree in the scene first, and autoplay is scene_node set. ${CLASSES_REBUILT}`,
    answer:
      `${WITHOUT_AN_EDITOR} ${ALSO_SAVED} read and read_states need no editor. ` +
      'add_track on an existing track adds keys to it. remove_track takes out every matching track, or with a method only the keys calling it. ' +
      "read without animationName lists the animations, each with the number of its tracks under tracks. add_track on a path the animation already has a track of that type for answers existingTrack true, and keysAdded beside keys, the track's count. replaceKeys names each key it replaced under keysReplaced, its time and the value it held, and keysAdded then counts only the new times. A key written past the animation's end, by add_track or by a set that shortens it, is kept. pastLength names it, since it never plays. To move a key, remove it with times and add it at the new time. create names a library it made under libraryMade, an empty name being the player's default library. rename renames the player's autoplay and every state playing the animation, named under autoplay and statesFollowed. remove clears the player's autoplay when it named the animation. statesPlayingNothing names the states that played it, which stay until remove_state takes them out. " +
      'read_states gives each state that plays an animation animationFound, and animationMissing saying why when the player lacks it. add_state writes a state for an animation the player lacks all the same, and answers animationFound false. It puts the state right of the rightmost state in the graph, answered under position. remove_state names the transitions it took out under transitionsRemoved. Every state machine has Start and End, which cannot be added or removed. A transition from Start sets the first state. An immediate auto transition with no advanceCondition leaves its state the frame the state is reached. advanceMode defaults to auto for a transition leaving Start, since a machine leaves Start only through an auto one.',
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
        description: 'Seconds of the keys to remove. The rest of the track stays. Default every key.',
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
        description: 'The state the transition leaves. One from Start sets the first state.',
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
          'auto advances by itself, enabled only by travel(), disabled never. Default auto with advanceCondition or from Start, otherwise enabled.',
      },
    },
    requires: ['projectPath', 'scenePath'],
    operations: {
      read: {
        effect: 'read',
        summary: 'the animations of a player, or one with its tracks in the shape add_track takes',
        requires: ['playerNodePath'],
      },
      read_states: {
        effect: 'read',
        summary: 'the states and transitions of a state machine',
        requires: ['animTreePath'],
      },
      create: {
        effect: 'additive',
        summary: 'a new animation, and its library when the player lacks it',
        requires: ['playerNodePath', 'animationName'],
      },
      add_track: {
        effect: 'additive',
        summary: 'a property or method track',
        requires: ['playerNodePath', 'animationName', 'track'],
      },
      remove_track: {
        effect: 'destructive',
        summary: 'every matching track, or some of its keys, and a track left with no key goes',
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
        summary: "an animation, clearing the player's autoplay when it named it",
        requires: ['playerNodePath', 'animationName'],
      },
      add_state: {
        effect: 'additive',
        summary: 'a state playing an animation, written even when the player lacks it',
        requires: ['animTreePath', 'stateName', 'animationName'],
      },
      remove_state: {
        effect: 'destructive',
        summary: 'a state and its transitions',
        requires: ['animTreePath', 'stateName'],
      },
      connect_states: {
        effect: 'additive',
        summary: '',
        requires: ['animTreePath', 'fromState', 'toState'],
      },
      disconnect_states: {
        effect: 'destructive',
        summary: '',
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
      "GDScript files. To change an existing line, edit the file's text. Read a rename's leftAlone before calling the rename done. create writes a .uid and puts its class_name in the class list, and an open editor then scans and reloads the changed scripts. ok false after a write leaves the files changed. A rename's lists past 300 lines go to a file under .godot.",
    answer: [
      'Each write is loaded and answered with parses. modify makes every addition or none, and rename writes every file or none.',
      "create answers the extends and class_name the engine read (class_name null for a script declaring none). It writes the .uid beside the script and answers it under uid. A class_name is put in the project's class list, and registered says whether it is there. An editor serving the project scans for it (editorRescanned).",
      'create refuses a class_name another script or an engine class holds, or an extends naming no class, with nothing written. parses is false for a script that fails only because a script it depends on does, and dependencies_with_errors names those.',
      "modify refuses additions that would stop a script that parses from parsing, and changes nothing. It gives the engine's reasons and the line each addition is on. With an editor serving the project it reloads the script there too (editorReloaded). editorNote says when it could not, or when a script tab holds unsaved edits that saving would write over the file.",
      'rename renames a class or a member wherever the engine uses it. A class_name is renamed from the files and needs no editor. That covers every bare use in code, the declaration, and the script_class a .tres records. It covers doc links such as [Told] and [method Told.say] too.',
      "rename of anything else, an inner class and an enum value included, works from what the editor's language server resolves to it, so it needs the editor open on this project. A method is renamed together with every override of it in the classes inheriting it. Doc links naming the member through any class inheriting it are renamed too. So is a scene's or resource's saved value of a variable on a node or resource whose script inherits it. So is a connection naming the signal on its emitter or the method on its receiver.",
      'rename refuses a new name already taken, with nothing written. For a member, that includes a new name a class inheriting it already uses in code. changed lists each file with its changed lines as they now read.',
      'leftAlone lists every other whole-word occurrence of the old name with what the tokenizer makes of it. That is code, string, comment, doc, nodePath, scene, text, or ignored for a file under a .gdignore directory. Where it is not plain, it says why. One case is a string that is the old name whole. Others are a node named like the class, and a call on a value whose type the analyser could not tell.',
      "Nothing renames or compiles such a string, such as find_children's type or a call's method name. A comment, documentation line, string or text file line with nothing more to say is under leftAloneInProse by file, kind and line. Code that is certainly another symbol of the same name is under leftAloneOtherSymbols. summary.leftAlone counts each of the three lists beside the total.",
      "Past 300 lines the two grouped lists are written with each line's text to a file under the project's .godot directory. leftAloneDetail names the file. The newest ten such files are kept. Nothing in them was changed.",
      'A member rename answers under languageServer how many requests it made and how long they took. Afterwards an open editor scans the changed files and reloads every changed script, under editor. With no editor the class cache is rebuilt and the changed scripts compiled in a fresh engine, under classCache and compiled.',
      'written is true once the files are written. ok is false when what came after the write failed. The files are then left changed, and note says so.',
      'newScriptPath also rewrites every string that names the moved script by path, in the style it was written (res:// or relative). It rewrites the relative paths in the moved script itself too. A relative string stays as written where resource_edit move leaves one.',
    ].join('\n\n'),
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
        description:
          'Also move the declaring script here, with its .uid. The paths naming it are rewritten as resource_edit move rewrites them.',
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
      modify: {
        effect: 'additive',
        summary: 'add functions, variables, signals, constants or enums to an existing script',
        requires: ['modifications'],
      },
      rename: {
        effect: 'destructive',
        summary: 'rename a class or a member wherever the engine uses it',
        requires: ['symbol', 'newName'],
      },
    },
  },
  {
    name: 'script_info',
    title: 'Script info',
    description:
      'What a script contains. It reads .gd files only. For where a class, member or signal is used, project_search.',
    answer:
      'structure gives each parameter\'s default as the source text after its =, so = null reads "null". A parameter with none gives null. Static variables are marked is_static. A variable written with := has the type of a literal or built-in constructor it is given, marked inferred, as a constant always does. An export in an inspector group names it under group, as "Stats/Loot" for a subgroup. Each enum has its members under values and their numbers under numbers, counted as the engine counts and left out from one given an expression. inner_classes gives each with its name, line and extends, and its own members in the same fields. It also answers class_name, extends, is_abstract and line_count. dependencies are the paths the script loads or preloads as written, by a constant too, and the paths it or an inner class extends by. Then come the scripts declaring each project class_name its code uses, which classes_used names with the class. autoloads_used names each autoload the code uses, with its script. A member or inner class with a ## comment directly above it carries the text as doc. The script\'s own comment above class_name or extends comes back as class_doc. With includeInherited each inherited member carries inherited_from, the file declaring it. The answer gains inherits_from, the chain walked, and a name the script overrides is listed at both its lines. ' +
      'symbols gives each symbol its kind, the line and column of its name, and lastLine, the end of its declaration. detail is the language server\'s own text, which writes a default through the engine (Callable() as "null::null") and leaves out a signal\'s argument types. completion is narrowed to the part of a name written before the position. symbols, completion and hover name under unseenByEditor each project class the editor cannot see yet, with unseenNote. The language server reads such a class as nothing. A completion after self. in a script extending one comes back empty. editor_rescan brings it in.',
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: SCRIPT_PATH,
      includeInherited: {
        type: 'boolean',
        ops: ['structure'],
        description:
          "Also list what the script inherits through the project's other scripts. A native base class is read with editor_classes info.",
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
        summary: "the language server's completions at a position, at most 100",
        requires: ['line', 'character'],
      },
      hover: {
        effect: 'read',
        summary: "the language server's hover text at a position",
        requires: ['line', 'character'],
      },
    },
    defaultOperation: 'structure',
  },
  {
    name: 'script_diagnostics',
    title: 'Script diagnostics',
    effect: 'read',
    description: `Errors and warnings for a script or several, from the editor's language server, and whether each is clean. With no editor open, a headless engine compiles instead and checkedBy says engine. Lines and columns count from 1. If staleAnalysis appears, editor_rescan first. ${CLASSES_REBUILT}`,
    answer:
      'Each diagnostic carries its severity, its message, and line, column, endLine and endColumn as the editor shows them. One script is answered on its own. Several are answered together, each named by its res:// path. A script with nothing to report is named in nothingReported. Every other is answered under scripts, and a script that could not be read is named with why. A folder skips what the engine skips and the addons gdharness installed. A script named under a folder holding a .gdignore is checked as asked and listed under underGdignore. One under a folder holding its own project.godot is listed under inNestedProject. A class the class cache lacks is put in it first, under classesRebuiltFirst. ' +
      'The engine, with no editor, answers every error up to the first syntax error, at its line with no column. It answers the warnings at the levels the project sets, and warnings is null when it could not. A method or property another class lacks is not a compile error, since the object may be a subclass that has it. dependenciesWithErrors names the other scripts that failed while it loaded. typesMissingFromTheClassCache names a project class the engine could not resolve because the cache lacks it. A language server that stops answering partway leaves the rest to the engine. checkedBy then says language server, then engine, and checkedByLanguageServer counts the scripts it answered. ' +
      'A diagnostic the files disprove is named rather than passed on. A member the class cache or a project class it extends declares comes back under contradictedByTheFile, with the declaring script. A project class the diagnostic could not resolve comes back under typesTheEditorHasNotLoaded, with inTheClassCache. staleAnalysis names the remedy, usually editor_rescan. For an enum member, constant or static function of a global class, the remedy is editor_rescan with reloadScript on the declaring script. After a scan that left the class cache shorter than the files, the remedy is editor_launch restart. A class missing from the cache is mended by project_import refresh_classes.',
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
    description: `Resource files. create makes a .tres of any engine resource class, a Material class for a material. read answers in the form modify takes. A Theme item is a property named like \`Button/colors/font_color\`. move and read need no editor. A modify drops the lines read lists under notLoaded. move with no editor writes .uid and .import files, and leaves paths in .scn and .res files (leftAlone). ${PATHS_LEFT} ${CLASSES_REBUILT}`,
    answer: [
      WITHOUT_AN_EDITOR,
      'create and modify answer each property given under properties as the file holds it once saved. modify answers each one unset under unset. A property given its default is left out of a .tres file and named under notStored. alsoChanged names what the engine changed in step with a given property. alsoSaved names what the save changed, added or dropped in the main resource, as {property, was, saved}.',
      'create and modify name under loadsAs and setByScript (with setByScriptNote) what a script of the resource changes as the file loads. When a headless engine writes a resource whose script is not a tool, what that script changes is put back before the save. One where that cannot be done is refused with the file left as it was.',
      'A resource built into a scene becomes a file of its own in two calls. First create it with its _type and the rest of what a read answers for it as properties. Then set the property to the new file.',
      'read lists under notLoaded the lines the engine does not load, which a modify drops. read of a shader says whether it compiles under compiles, with compileErrors. A Curve reads as the inspector shows it (point_count, point_0/position). A file never imported is refused with the reimport that imports it.',
      'create_tileset gives a wholly transparent cell no tile and lists it under leftBlank. It describes a strip no whole tile reaches under notInAnyTile. It answers tileSize, the size the first source sets. A custom data layer written with modify after it takes a type name such as "int". create_shader answers compiles, and compileErrors with each error\'s line.',
      "set_theme_color and set_theme_font_size set a controlType that is no Control or Window class as a type variation, with a note saying so. A colorName or fontSizeName the engine's theme gives the class none by is set, and its note names the nearest one the theme has. remove_theme_item without item takes the type with every item, and its base_type when it is a variation. The answer names each one removed.",
      'move rewrites every path naming what moved in a scene, resource, script, project.godot or other text file. It keeps the style each was written in, res:// or relative. It rewrites the relative paths inside a moved file too. leftAlone answers what this cannot rewrite: a .scn or .res file, and a string naming it any other way, such as the start of a path built at run time. A preview is refused when the move would be.',
      'move leaves a relative string as written in the text, tooltip_text, placeholder_text and resource_name of a scene or resource. So does one in node names and groups, on a ; comment line and in a .import file. A GDScript comment stays whole.',
      "move with an editor open brings it up to date as after a move in the FileSystem dock. With none, an import pass rebuilds the uid cache. uidTable says whether it ran, and writtenByImport names the .uid and .import files it gave. A directory's answer names each file moved.",
    ].join('\n\n'),
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
      properties: {
        ...PROPERTIES,
        ops: ['create', 'modify'],
        description: 'Properties to set, keyed by Godot name, in the forms scene_node properties takes.',
      },
      unset: {
        type: 'array',
        items: { type: 'string' },
        ops: ['modify'],
        description:
          'Properties to remove from the file, keyed as in properties, such as "shader_parameter/tint". An editor\'s next save writes an unset shader parameter back.',
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
          'The theme type, a Control or Window class such as "Button", or the name of a type variation. A name that is no class is set as a variation.',
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
          'The item to take out, such as `colors/font_color`. Without it, every item of controlType goes, with its base_type when it is a variation.',
      },
    },
    requires: ['projectPath', 'resourcePath'],
    operations: {
      read: { effect: 'read', summary: 'the properties a resource file sets', requires: [] },
      create: { effect: 'destructive', summary: '', requires: ['resourceType'] },
      modify: {
        effect: 'destructive',
        summary: 'set or unset properties on an existing resource',
        requires: [],
      },
      create_shader: { effect: 'destructive', summary: 'a .gdshader file', requires: ['shaderType'] },
      create_tileset: {
        effect: 'destructive',
        summary: 'a TileSet from texture atlases, whose layers and tile data modify writes after it',
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
        summary: 'move or rename a file or a directory, and the paths in the project naming it',
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
      'editor_status says which editor is connected. open and close save project.godot, which drops a key set on purpose to its default value. close and restart save the open scenes. A restart of an editor this server opened is a quit and then a launch. Ending this server between them, as a reconnect does, leaves no editor. close stops the process of an editor this server opened that has not connected yet. A game a visible editor plays opens a window.',
    answer: [
      'close answers settingsDropped, what its save took out of project.godot. It is left out when the save took nothing. settingsNote says when the file could not be read to tell. An editor stopped before it connected is answered with beforeConnecting.',
      'close and restart name under savedScenes the open scenes that had unsaved changes and were saved on the way out. The list is empty when none had. A scene that would not save refuses the close or restart and leaves the editor running. Both answer tookMs, how long the editor took to go or to come back.',
      'restart answers with the version that came back, and hidden, whether it came back with no window. Since it waits for the editor to return, it also says under settingsDropped which keys its save dropped. An open answers as soon as the process exists, and the save happens during the import minutes later. editor_status carries that reading once the editor has connected. Nothing else will say a key went until something depends on one.',
      "restart answers lspListening and dapListening once the editor's servers are up. When either came back without its port, serversSaid gives the lines the editor's log panel has about its servers. That is the one place Godot says why a port would not bind. When it was the debug adapter, the editor that came back binds it again, and debugAdapterRebound says whether that took.",
      "rebind ends the debug adapter's sessions and answers rebound, with lspListening and dapListening. Its serversSaid holds the lines that rebind made the panel print.",
      "A restart that a server's end interrupted shows as restartInterrupted in editor_status. The open that finishes it says so under finishesRestart. An editor a server opened is started again by the server as it was started, once the old one has gone. It waits 90 seconds for that, or GDHARNESS_EDITOR_RESTART_TIMEOUT_MS. One opened by hand restarts itself and comes back with a window, so one with no window is refused unless hidden: false accepts one.",
      'open starts an ordinary visible editor on the desktop in use, shown on Windows without being activated. hidden: true opens it out of sight. On Windows that is a desktop of its own that still draws its views for editor_capture. On Linux and macOS it is headless, and editor_capture refuses it. A hidden editor serves the bridge, the language server and the debug adapter as a visible one does.',
      "A game a visible editor plays opens as a window on the desktop in use. open refuses while an editor of the project is already running and has not reached this server, and names its pid. It refuses when the editor it would start could never reach this server. That is a project other than the one this server serves, or one without the gdharness editor addon installed and enabled. It is also a project whose editor a restart is already bringing back, or one whose editor addon on disk is another release's.",
    ].join('\n\n'),
    // open alone: a restart is of the editor already connected, which names its own project, and
    // an argument that is accepted and then ignored is one a caller can be wrong about for ever.
    parameters: {
      projectPath: { ...PROJECT_PATH, ops: ['open'] },
      hidden: {
        type: 'boolean',
        ops: ['open', 'restart'],
        description: `Open the editor out of sight. Default false on open, and on restart how the editor was started. A hidden editor quits after ${String(IDLE_CLOSE_MINUTES)} minutes with no call. The setting ${IDLE_CLOSE_SETTING} changes that, and 0 turns it off.`,
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
      open: {
        effect: 'additive',
        summary: 'open the editor on a project, answering before it connects',
        requires: ['projectPath'],
      },
      restart: {
        effect: 'destructive',
        summary: 'restart the connected editor and wait for it, which puts a gdharness upgrade into effect',
        requires: [],
      },
      close: {
        effect: 'destructive',
        summary: 'quit the connected editor and wait for it to go',
        requires: [],
      },
      rebind: {
        effect: 'destructive',
        summary: "end the connected editor's debug sessions and restart its debug adapter in place",
        requires: [],
      },
    },
    defaultOperation: 'open',
  },
  {
    name: 'editor_run',
    title: 'Run the game',
    description:
      'A scene that prints an answer and quits is start, then wait. A start says under runtime whether the runtime_* tools can reach the game. One server keeps one run. A start ends a run of the same project first. start and check first import what changed on disk since its import.',
    parameters: {
      // start and check need telling which project. The ops about the run already going take it
      // too, because a call copied from the start carries it, and they check it rather than ignore
      // it: the one thing it can say is which project's run is meant.
      projectPath: {
        ...PROJECT_PATH,
        ops: ['start', 'check', 'stop', 'wait', 'profile'],
        description: 'Absolute project path. stop, wait, profile: optional, the project whose run is meant.',
      },
      scene: {
        type: 'string',
        ops: ['start', 'check'],
        description:
          "A scene to run instead of the main scene. A script is no scene: put it on a scene's root.",
      },
      suites: {
        type: ['string', 'array'],
        items: { type: 'string' },
        ops: ['start'],
        description:
          "gdUnit4 suites to play instead of a scene: a suite file or test directory, or a list. Needs gdUnit4 and this release's tests addon in the project.",
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
          'Engine flags, such as ["--verbose"] or ["--max-fps", "60"]. --fixed-fps lets a headless game run faster than the clock.',
      },
      headless: {
        type: 'boolean',
        ops: ['start'],
        description: 'true runs with no window, false forces one. Default a window where there is a display.',
      },
      visible: {
        type: 'boolean',
        ops: ['start'],
        description: `Show the window on the desktop in use. By default on Windows it goes on a desktop of its own, with --disable-vsync and --max-fps ${String(HIDDEN_WINDOW_FPS)}. On Linux and macOS the window shows either way.`,
      },
      silent: {
        type: 'boolean',
        ops: ['start'],
        description:
          "Default true: this server starts a windowed game with no sound. false lets a connected editor play it. A headless run is silent already, and an editor plays it only when the project's main_run_args hold --headless. args, engineArgs, env, savesIn, godot or executable make this server start it either way. debug_* cannot reach an executable.",
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
        description:
          "An absolute directory to hold this run's user://, whose path runtime.userDir answers. macOS ignores it, so the run writes the player's own saves.",
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
          "How long to wait for the game to announce its runtime. Default half as long again as the slowest of that scene's last five boots, from 5000 to 60000. 0 does not wait.",
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
        description:
          "Time the run's GDScript from its start, for op profile to read. Needs an engine built with debugging.",
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
          'A game of this project that no server here keeps, as editor_status lists it under runtimes.',
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
        summary: 'wait for the run to end, stop in its debugger or crash, then answer as editor_output does',
        requires: [],
      },
      profile: {
        effect: 'read',
        summary: 'where the run spends its time, by GDScript function',
        requires: [],
      },
    },
    answer: [
      "start answers through, gdharness for a game this server started itself and editor for one the editor plays. scene is the scene the game started in, the project's main scene when none was given. runtime says whether the game is listening and on which port. When it is not, mayYetAnnounce says whether that is final. false is a runtime that is not coming, and true a game still on its way up, which editor_status will see and runtimeWaitMs waits longer for.",
      "start ends a game whose engine could not create a renderer on the hidden desktop, with mayYetAnnounce false and a note naming the failure. runtime carries addonIsStale and staleNote when the game announced on a runtime addon other than this server's. No runtime_* call is then sent to it, and staleNote says what brings it into step. refreshedClasses names the class_name declarations on disk that the engine's class cache was missing, added before the game started. transcript is the file both the run's streams are written to, so a watch on it can be armed off the start.",
      'A start ends a run of the same project first, and is refused while a run of another project is held. This server starts the game itself unless a connected editor plays it, as silent says. Its debugger is then the keeper holding it, and the debug_* tools answer for it all the same. args put after the separator, so a flag the engine reads goes to the game instead, and argsNote says so.',
      "The editor plays a game headless only when the project's editor/run/main_run_args holds --headless. So this server starts a headless run of a project whose editor plays with a window. A game that restarts itself with OS.set_restart_on_exit stays one run. editor_output and editor_status follow the process it restarted into, and name those before it under restartedFrom.",
      `${IMPORTED_FIRST} An exported build carries its own imports and is not asked. A silent windowed run has --audio-driver Dummy in its arguments.`,
      'A windowed run this server starts on the hidden desktop has no display to wait on, so it is given --disable-vsync and --max-fps ' +
        String(HIDDEN_WINDOW_FPS) +
        ". engineArgs, the project's editor/run/main_run_args or its application/run/max_fps can cap its frames instead. A game that turns vsync on as it runs slows to two frames a second again. A headless run with --fixed-fps runs faster than the clock, and its start says so under framesNote. --accessibility always has the game build the tree runtime_inspect accessibility reads.",
      "--write-movie takes an absolute path outside the project ending in .avi or .png, and a run with headless: false. Its directory must exist, with nothing it would write already there. It records at the project's editor/movie_writer/fps unless --fixed-fps says otherwise. A check given --verbose answers with everything printed rather than only errors and warnings.",
      'savesIn need not exist. The engine makes Godot/app_userdata/<project> under it, and runtime.userDir names the directory user:// is. On macOS the engine ignores it, and savesNote says so.',
      "stop answers endedPid, for a run the editor plays the pid its game announced under, read at the stop. A pid can be reused, so it can equal the previous game's. exitedBeforeStop is true when the run was already over when the stop came, so nothing was ended. exitCode is then the one it ended with, when anything collected it.",
      'stop answers stopped false in two cases. With the pid under notSignalled, the pid no longer answered as the process the run was started as, so nothing was signalled. The note names the property it failed on. With the pid under stillGoing, what was told to end was still running ten seconds later.',
      [
        'endedThrough says how the stop ended a run that was going:',
        '',
        '- close: the game was asked to close and exited, so exitCode is its own.',
        '- keeper: the process that started the game ended it through the handle it holds.',
        '- signal: its pid was signalled once shown to still be the run.',
        '- editor: the editor playing it was asked.',
      ].join('\n'),
      'A start that ends the run before it says how under endedPreviousRunThrough, with the same values. One that refused to signal that run names the property it failed on under previousRunLeftBecause. notClosedBecause (previousRunNotClosedBecause on a start) says why a graceful close did not end the game. It has no runtime listening, refuses the close, or does not answer within three seconds, as a game held at a breakpoint does not. GDHARNESS_CLOSE_WAIT_MS sets another ten seconds.',
      "andChildren ends processes announced as games of this project, or this project's engine run with --path on it, and identifiedBy says which. Any other process under the run is left and named under childrenLeft. childrenUnknown is true when nothing could be listed. A pid is ended only when it announced itself for this project, and the operating system describes it as this project's engine run. That is --path on the project and no editor flag, started before it announced.",
      "check answers hung for a run killed at timeoutMs. errors and warnings count what it printed, which comes back under entries with repeats folded together. printed holds the ordinary lines the run printed, the newest 50 kept, and printedLinesNotShown counts those left out. arguments is the engine command line the check ran, and durationMs runs from that engine's start to the check's answer. A check keeps no run for editor_output to read afterwards, so editor_run start then editor_output reads everything.",
      "check calls an engine crash an error whatever it prints after. The crash handler's report is the entry, and the engine version and the native and GDScript backtraces are its detail. So a crashed run is never booted or clean. A crash that printed no report is an error entry, read off its exit code or signal.",
      'start and check wait first for a scan the open editor is running, and for the class cache it writes just after, since a game booted in between resolves no global class. waitedForEditorScanMs and scanNote say how long, and when a scan ran past thirty seconds. They are left out when no scan was waited for.',
      "profile answers a row per function with its script and the function (Class.name when the script declares a class_name). Each row has the line its body's first statement is on, and for a lambda the named function it is written in (within). It has calls, and self and total milliseconds. A property's get and set blocks are named Class.@name_getter and Class.@name_setter, and their rows carry property.",
      "profile adds functionsCounted, scriptMs (the self time of them all) and coveredMs. The functions of gdharness's own runtime are not among them. Their self time is runtimeAddonMs, over runtimeAddonFunctions functions.",
      "complete is true when the engine's own totals arrived, which it sends only when the profiler is switched off. The runtime addon does that as a game quits, so a scene that does its work in _ready and quits is covered whole. Otherwise the answer is the frames summed so far and the note says what that misses.",
      "frames counts the frames of the profile that arrived. The engine's totals also hold the work after the last of them, so once complete a function run every frame can show a call more than frames. firstFrame and lastFrame are the game's own numbers, counted from 0, in a run this server started. A firstFrame above 0 is frames run before the profiler came on, and a gap between the two is frames that never arrived.",
      "Self time leaves out calls to other script functions. With engineCalls: true it also leaves out calls through an engine method, such as callv, emit_signal or any Node method, which are the caller's engineMs, absent when 0. Calls to built-in types and utility functions such as print stay in self time. selfIncludesSuper marks a row that also counts a super call, which the overridden function's row counts again. overheadMs marks a row with at least half its selfMs spent on the profiler's own timing, with perCallOverheadUs measured each run.",
      'The times are wall time summed over every thread, so scriptMs can exceed coveredMs. Compare two profiles taken under the same load. A game the editor plays that was not started with profile: true says it was profiled from the moment it was asked. A run this server started without profile: true is refused, since its debugger is fixed as it starts.',
      'engineCalls crashes the game or corrupts strings when any script runs off the main thread. That is through WorkerThreadPool, a Thread, a node processing on a sub-thread or threaded loading. On Linux and macOS it does so too when a script frees an object through an untyped call. profile alone is safe.',
      "callersOf lists under callers each place, forty at most, with its script, line and the named function it is written in (within). called says whether the function is called there or passed on as a Callable. Each place has the profile's calls, self and total milliseconds for the function it is in. A function called through a string, and a parameter, local or class variable of the same name, are not listed. A property's blocks are asked about by their profile name or by the property's, and each place then says whether it writes the property (access write) or reads it (access read).",
      'A profile with mark answers marked: true, and one with since answers since: "mark" and markSetMsAgo. The mark is kept beside the run\'s profile, so a server that replaces this one reads it too. Setting it again moves it, and since counts from the mark before it moves. lessThanAtMark counts the functions left out for reading less than at the mark.',
    ].join('\n\n'),
    defaultOperation: 'start',
  },
  {
    name: 'editor_output',
    title: 'Game and editor output',
    description:
      'What a game or the editor has printed, each entry with a severity. Op run also answers counts, and clean, true when no error was reported. clean is absent when the console was lost, or when a game the editor played left no runtime report (errorsUnread true). A run that has quit still answers until the next one starts.',
    answer:
      "For a run the editor plays the reports come from the game itself, through the runtime addon. A played game without the runtime addon answers with its prints alone, with errorsUnread true and no clean. A run ended by a signal has no exit code, and exitSignal names the signal. endedBy says whether gdharness ended the run. A transcript that has stopped growing is a run between prints rather than a run that is over. startedAt is when the run began and elapsedMs how long it has been going. For a run that is over, endedAt is when it ended and elapsedMs how long it ran. Both are left out when nobody saw the end. running is asked of the operating system whenever there is a process to ask about. For an editor-played run that never announced, running is the editor's answer, which can lag.\n\n" +
      "An entry with lines under its headline has them as detail. When one of them names a project script, script, line and function say where. That is the at: line when it names one, otherwise the innermost frame of the backtrace that does. A push_error or push_warning has the engine's own push_error as its at: line, so its script and line are the game's call that raised it. Each entry's source says where it was read. transcript is a line of the run's transcript file, which holds both its streams and is how every run with one is read. stdout or stderr is a line of that stream of a run with no transcript. An example is an editor-played run picked up after a reconnect whose first server left no note. debugger is what the editor's debug adapter reported and the game never printed, such as the script error a game stopped on. A printerr line is info: it prints to stderr, and the engine reports no error for it.\n\n" +
      'op editor answers counts with no clean, since an editor neither passes nor fails. It answers the entries in the order they were printed. Beside them, repeated gives each message shape several lines share. Each shape has how many, what varied in each slot of it and how many different values stood there. It also has the first occurrence, and the ordinary lines above the group. It covers the whole session from the editor\'s first line, because an editor gdharness opened is asked for a log file as it starts. An editor somebody opened by hand has no console here and is refused. With no editor connected, connected is false. editorRunning says whether the editor whose console it is still runs. editorNote says whether this server closed it, or it went without a close, as a crash does. The next editor gdharness opens on the project starts a new console. With none connected and none ever opened here on the project, there is no console, and the refusal says so. Op editor leaves out the "Path to node is invalid" error Godot prints when gdharness loads a scene holding a ViewportTexture. The same error from a project\'s own script stays.',
    parameters: {
      projectPath: {
        type: 'string',
        description:
          'The project whose output you mean. Refused when it is not the project of the run or editor this server keeps.',
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
        summary: 'what the game started by editor_run has printed',
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
      'Whether the editor addon is connected, which Godot answers, whether the editor is playing, and which games with the runtime addon are reachable on the machine. connected false with mayYetConnect true can mean not reached yet.',
    answer: [
      'When connected is false, mayYetConnect false is an editor that is not there, and true one that may yet dial in. editorCannotConnect is a project without the gdharness editor addon installed or enabled, and its remedies say how to fix that. restartInterrupted means an earlier server quit the editor and never relaunched it, and editor_launch open finishes it. restartUnderway is a restart in progress, so open no other editor.',
      'closedHere says this server closed the editor, and quitUnused that a hidden editor quit after its idle minutes. Each comes with the scenes the next call reopens. awaitingLaunchedEditor names the pid of an editor this server opened that has not connected yet. editorsNotYetConnected names any other editor of the project running and not yet connected.',
      'greeting is an editor that has connected and not yet said who it is, and other calls wait up to ten seconds for it. settingsDropped appears once when the editor this server opened took a key out of project.godot as it saved. identifying is an engine that loaded the editor addon still being told apart from the editor. turnedAway is the last one-job run, such as an import or an export, that was not taken as the editor.',
      "serverVersion is this server's gdharness version, and server names its pid. projectIs, when present, is the version of the project's addons, which differs from this server's (project_info says which to move). configIs is the version the project's MCP config starts.",
      "runtimeConnected counts the games of this server's project on this release's runtime addon. runtimes lists every game on the machine, with ofThisProject saying which are this project's, since another project's game is reached only by naming its projectPath. Each has userDir, the directory its user:// is. A game held at a breakpoint is listed as unreachable. A game the editor played names the editor under editorPid, and so does whatever that game started.",
      'Each game names the runtime addon it loaded under addonVersion, null when it cannot say. addonIsStale is true when that code is not what this server ships. staleNote says what brings it into step: the gdharness upgrade command for the project, a restart for the game, or a reconnect for this server. A second checkout, such as a git worktree, has addons of its own. A runtime_* call to a stale game is refused with the staleNote.',
      'A game speaking a protocol this server does not is listed under unreadable, with which half is older. No tool reaches it until the halves match.',
      'play.play counts the plays the editor has started since it opened, whoever started them, and play.editorPid is the editor. Two reads with different pairs are two plays even when both say playing. game.run names the run editor_output and editor_run stop answer for, with its pid and its project. adopted is true when this server took it over from another server.',
      'game.run stays named after the run ends, beside processActive false, and is null when there is no run. startedAt and endedAt say when it began and ended. heldAt says whether the run is held, as editor_output says it.',
      'editor.lspListening and editor.dapListening say whether anything accepts connections on lspPort and dapPort, once an editor has connected. A false comes with serversNote. editor_launch rebind binds the debug adapter again, and editor_launch restart the language server.',
      'editor.scan says whether the editor is scanning or importing, and how long ago its last scan finished (finishedMsAgo). It is null when the editor did not answer. editor.openScenes lists the scenes open in its tabs, and editor.editedScene the one it shows. editor.unsavedScenes lists those with changes not on disk, an empty entry being a scene never saved. All three come with scan.',
      "addonIsStale of the editor is judged by the editor addons' code, not their version. So an editor whose code an upgrade left alone is not stale, and addonNote says so. A stale editor is refused every call but a quit, with staleNote. startedByAnEditor is an editor started by Godot's own restart or the project manager, without the arguments a server gives, and startedByAnEditorNote says what that costs. openedByAServer says a gdharness server started it, and hidden that it has no window.",
      "port is the editor bridge's port, with portWanted and portNote when it is not the one configured. bridgeHandover is this server waiting a few seconds to take the port from the server it replaces. bridgeAvailable says the bridge is listening, and startupError why it is not, with retryingBridge while it tries again.",
    ].join('\n\n'),
    parameters: {},
    requires: [],
  },
  {
    name: 'editor_rescan',
    title: 'Rescan the project',
    effect: 'additive',
    changes: 'Writes under `.godot` and adds `.uid` files. Changes no script or scene.',
    description:
      'Makes the running editor scan for files written outside it. Call it again when another tool names a class_name under unseenByEditor. editor_launch restart does it too. Needs the editor connected. A scan rewrites the class list in .godot, writes missing .uid files, and reloads scripts naming a class it brings in.',
    answer: [
      'waitedMs is the whole call. waitedForEditorScanMs is the part spent waiting out a scan or an import already running, given only then. waitedForEditorAnswerMs is given when an idle editor took a second or more to say so, and is how long that took. Such an editor is busy on the thread that answers with an earlier request rather than scanning. So the time is added to timeoutMs rather than taken from it, and the note says so.',
      'stillWorking is true when a scan was still running at the end of the wait. The scan the call started is looked at once even when the wait has run out. So stillWorking is never said of a scan nothing looked at. A hidden editor imports on the thread that answers. So a large addon install can leave the rescan itself unanswered, and when the wait runs out first the answer is stillWorking.',
      'reloadScript: reloadProblem says why a script was not reloaded. A list is answered under reloads, one entry per script with its own ok and reloadProblem.',
      "uidsReread names each file whose .uid names a UID the editor does not hold for it. Such a file is read again before scanning, since the editor's walk passes over a file whose .uid alone changed. uidsDuplicatedOnDisk names files on disk naming one UID between them, which reading again cannot settle. project_import refresh_classes does not touch what the editor holds. A script or shader written outside the editor has no .uid sidecar until something imports it, and the scan writes one beside it.",
      'Every script naming a brought-in class is reloaded, since what the editor compiled from it without the class stays compiled that way otherwise. One that would not reload is named under dependentsNotReloaded, and the call is not ok. Nor is it ok when the script named in reloadScript was not reloaded. A script can fail to compile against scripts the editor holds behind their files. Those are reloaded first, named under reloadedFirst, and the script is tried again.',
      'The classes the editor could not see before a scan are noted in the project. The next editor_rescan of the same editor, from any server, names them under broughtIn and reloads what names them.',
      'If the scan drops classes from the class cache, cacheLost names them and cacheRestored names what was rebuilt. The note says to restart an editor that lost classes before scanning again. A class the editor still holds for a script that was renamed or deleted is left out of the rebuilt cache. cacheDropped names it, and every scan until the editor restarts ends in that rebuild.',
    ].join('\n\n'),
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
          'A script to recompile in the editor after the scan, or a list recompiled in order. A @tool script or one that does not compile is not reloaded. One with unsaved edits in a script tab is reloaded from the file, and saving the tab writes them back over it.',
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
        description: 'Scale to this width. Height follows unless given.',
      },
      height: {
        type: 'integer',
        minimum: 1,
        description: 'Scale to this height. Width follows unless given.',
      },
      outputPath: {
        type: 'string',
        description:
          'Also save a PNG here. Absolute path outside the project, to a file that does not exist.',
      },
      inline: {
        type: 'boolean',
        description:
          'Send the picture back in the answer. Default true, as a JPEG when smaller than the PNG and nothing is transparent. false needs outputPath.',
      },
    },
    requires: ['projectPath', 'scenePath'],
  },
  {
    name: 'editor_classes',
    title: 'Engine classes',
    description: `The engine's classes and those the project's scripts declare. info reads engine classes only, and script_info structure reads a project class. ${CLASSES_REBUILT}`,
    answer:
      "The project's classes are read from the scripts on disk, so one written a moment ago is there before any scan. query and inheritance answer them under project_classes, project_children and project_descendants, each with its path, what it extends and whether it is abstract. filtered_count, direct_children_count and all_descendants_count count the engine classes in the lists beside them. instantiableOnly leaves out an engine class that cannot be instantiated and a project class that is @abstract or built on one that cannot be, and keeps a class extending an @abstract one. info gives each property of a class that can be made its default, the value a new one holds. includeInherited gives one entry per ancestor, nearest first, with the names of what it declares, and member reads any inherited member in full, looked for on the class and every ancestor. The whole of Control is about a hundred thousand characters.",
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
          'One member by name, with its signature and the class that declares it. Cheaper than a whole class.',
      },
    },
    requires: ['projectPath'],
    operations: {
      query: {
        effect: 'read',
        summary: 'classes matching a filter or category',
        requires: [],
      },
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
    description: 'Reads the running game.',
    answer: [
      'tree marks a node at the last level that has children with children_not_shown, their count, instead of children. property names a step of its path that is not there, with what was there instead.',
      'text answers lines, count, and under omitted how many lines the limit left behind. out_of_view counts the lines left out for being drawn outside the viewport or a ScrollContainer, and a note says so. A line drawn as a copy under a node saying the same words, as an outline or a glow is, reads once. copies counts those.',
      "text reads every line as drawn. That is rich text without tags, text only as far as it is typed out, and a translation rather than its key. An upper-case label reads in capitals and a secret field as its mask. Tab titles, menu bar titles, list items, a tree's column titles and rows read a line each. So do an open menu's items and the titles of its separators.",
      'find answers nodes and count. hidden counts the matches left out because the engine would not draw them. out_of_view counts those left out as drawn out of view. A note says so of each. A match drawn under a matching node drawing the same words names that node under copyOf. distinct counts the rest.',
      'find with a glob that finds nothing says under note how many nodes it would find open at both ends. A bare word that names contain says how many do and what glob would have found them. A label with a line break is matched with the break in the words. A backslash followed by n counts as one.',
      "rect answers canvas, the node's own viewport, and window, where it is drawn in the game's window, through any embedded dialog or SubViewport. A 2D node answers where it stands. A sprite, collision shape, polygon or line also answers the rectangle it covers under covers. A 3D node answers the point to aim at, the middle of what it draws. It also answers the rectangle it covers, the camera that drew it, and behind_camera when it is not in front of one.",
      'rect of a Control answers visible and in_view. in_view is false when it is drawn wholly outside its viewport or a ScrollContainer holding it. drawn_over names what a pointer at its centre would reach instead, such as a dialog over the screen. What a ScrollContainer holds out of its sight is not in the tree until it is scrolled to.',
      'metrics answers frame_time, the mean wall time of up to the last 120 frames (frames_timed). It includes the game, physics and the wait for the display. frame_time_max is the slowest. Both are in seconds, and null before a frame has passed. vsync says whether a frame waits for the display, and max_fps is the frame-rate cap, 0 for none.',
      "metrics counts frames and physics steps since the start under process_frames and physics_frames. physics_steps_per_second falls below physics_ticks_per_second when a frame needs more than max_physics_steps_per_frame or the editor's Game view slows it. fps, process_time_max and physics_time are the engine's monitors over the last second. memory_static is the engine's CPU-side allocation in bytes. render_video_mem_used, render_texture_mem_used and render_buffer_mem_used are the renderer's GPU memory in bytes.",
      'accessibility answers windows, each element with its role, name, value, description and placeholder. role is text for static text, button, check_box, or group for a control holding others. value_text is a range\'s spoken words, such as "75%". bounds is in the window\'s pixels. actions lists what a reader is offered (click, focus, toggle, set_value, select, expand_collapse, scroll_into_view), and focused marks the focused one.',
      'accessibility names under node the node that made each element. A part a node made of itself has part_of, the node drawn around it that holds its words, or part_of_candidates where several are. part: announcement marks the text a window announces through. An empty name reads as nothing. Static text takes its name from accessibility_update_set_value, and _note counts the text elements on screen with none.',
      "accessibility answers tooltip, the node's tooltip_text, which a Windows reader is not told. With nothing focused, the engine calls GdharnessRuntime focused. A read stopped at its deadline says which step it had reached.",
      'accessibility with nodePath keeps only the elements that node and those below it made, whether as node or part_of. Each window keeps the outermost of them with what they hold, and matched counts them. A screen whose dialog sits under a long list reads with omitted greater than zero. Then raise limit or point nodePath at the dialog. The answer is not yet what is on screen.',
    ].join('\n\n'),
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
          'The property to read, or a script constant. A colon path reads through what a node holds: "_game:clock:speed", "_game:run:roster:0:traits", "size:x". A step written as a call, "get_viewport():gui_get_focus_owner()", calls an engine method marked as only reading, with literal arguments, \'get_theme_constant("separation")\'. It also calls a game method taking no arguments unless declared -> void, even one that changes the game, and runtime_wait until calls it every frame. A negative index counts from the end, and a key holding a colon is quoted, \'stock:"base:water"\'.',
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
          'The words a node shows, as drawn, case-insensitive. A bare word matches anywhere in the text. * or ? makes a glob over the whole text. | splits alternatives. accessibility: filters elements by name, value or value_text.',
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
          'How long to wait before answering pending with a requestId, which runtime_invoke op result collects. Default 10000, accessibility 75000.',
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
        summary: 'every line of text under nodePath in reading order, as drawn, without what is hidden',
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
          'what the game tells a screen reader, in a windowed Windows run started with engineArgs ["--accessibility", "always"] or accessibility_support at Always Active',
        requires: [],
      },
    },
    defaultOperation: 'tree',
  },
  {
    name: 'runtime_invoke',
    title: 'Set or call in the running game',
    description:
      'Sets a property or calls a method on a node, or on an engine singleton nodePath names, in the running game. A call that takes longer than timeoutMs is not cancelled: the answer is pending with a requestId, and op result collects it.',
    answer: [
      'Errors raised meanwhile come back under errors and warnings. When ended_by_error_at is given, result is not a value the method returned. At most 20 errors and warnings are given, with errors_not_shown and warnings_not_shown counting the rest.',
      'A game this server started that its debugger holds is said so, with where, before a call. heldAt, the object editor_output gives, says when a call reached a breakpoint.',
      'call names under result_named the result of a method declared to return an enum, such as PROCESS_MODE_INHERIT. An Error is named as the engine words it, such as Unavailable for 2. A path that reaches no object, or an object of another class than the parameter declares, is refused. So are too few or too many arguments.',
      "call checks a parameter typed as a script class without class_name as the class it extends. An object of another script passes the check and the engine refuses the call. The answer then says the method did not run, with the engine's reason.",
      'set refuses a write a setter kept from changing anything, with what it reported. A write of the value the property already holds, at its own precision, answers unchanged: true. A number past the range a property is exported with, or one none of its enum values has, is written. The answer says so under outside_declared.',
    ].join('\n\n'),
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
        description:
          'The value, fitted to the property\'s type. Vectors are {"x": 140, "y": 300}, a colour may be "#ff8000", an enum takes its name or number. An object property takes a path to one the game holds, or the text null to empty it, and a resource its res:// path.',
      },
      method: {
        type: 'string',
        ops: ['call'],
        description:
          'The method, or a colon path through what a node holds, "_game:run:advance". Change a list or map with set. A 2D physics query is "get_world_2d():direct_space_state:intersect_point".',
      },
      args: {
        type: 'array',
        ops: ['call'],
        description:
          'The arguments, fitted to the parameter types. An object parameter takes a path to one the game holds, "/root/Main/Hud", or a resource\'s res:// path. Another engine object is {"_type": its class, and its properties}.',
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
        summary: 'set a property',
        requires: ['nodePath', 'property', 'value'],
      },
      call: {
        effect: 'destructive',
        summary: 'call a method and return its result',
        requires: ['nodePath', 'method'],
      },
      result: {
        effect: 'read',
        summary: 'collect the reply to any runtime_* call that answered pending, by its requestId',
        requires: ['requestId'],
      },
    },
  },
  {
    name: 'runtime_capture',
    title: 'Capture the screen',
    description:
      "A picture of the running game: the whole screen, one region or node of it at full resolution, or one viewport. The screen is the game's window with its dialogs and popups laid over it. Needs the game running with a window. A capture before the first frame is drawn waits for it.",
    answer: [
      "A region partly outside the window is cut to it and answered clipped. The answer names the region captured in window pixels. drawnAt is given when the project draws at its own size and stretches it to the window, so the picture has the game's pixels.",
      "nodePath captures what runtime_inspect rect answers for the node: a Control's rectangle, what a 3D node's geometry covers, or what a Sprite2D draws. zoom makes each pixel a square of pixels rather than blending it. An inline picture may be a JPEG, and the text says so. outputPath saves a lossless PNG, and the answer says where.",
    ].join('\n\n'),
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
        description: 'Scale to this width. Height follows unless given.',
      },
      height: {
        type: 'integer',
        minimum: 1,
        description: 'Scale to this height. Width follows unless given.',
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
        description:
          'Also save a PNG here. Absolute path outside the project, to a file that does not exist.',
      },
      inline: {
        type: 'boolean',
        description:
          'Send the picture back in the answer. Default true, as a JPEG when smaller than the PNG and nothing is transparent. false needs outputPath.',
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
    description:
      'Input to the running game. Works headless. A control hidden in a ScrollContainer is scrolled to first. After a lone wheel press, every click lands on the control that took it.',
    answer: [
      "On the hidden desktop the run's first pointer_note says why that matters. A native window no real pointer has entered gets no hover from Godot, so the runtime supplies it and the answers say hover_supplied.",
      'click answers what was under the pointer, and what became of the control: in_tree, removed or freed. A button answers pressed_signal, whether its pressed signal fired during the click. A control is scrolled into view first, each container out from it a frame after the one inside. scrolled_into_view says whether a scroll value changed.',
      'click by says answers found, the match it pressed. found.index is the index argument that presses the same match again. found.item names the tab, list entry, tree row or menu bar title pressed, with its kind, its says, and its index in its own control. For a row it gives the column of the cell saying the words.',
      'found.pressedOn is "the words" for words in a RichTextLabel pressed where they are drawn. It is "the middle of the label", with a note, when they could not be placed. found.picked says why a match was picked. found.partOf names a match saying the words only as part of more.',
      'A partOf match is refused when another control says exactly the words. It is refused too when hidden, off the screen or covered. So is one on screen taking clicks without being a button, or letting the pointer through to what is under it. Words found only inside longer words ("away" in "Faraway") rank after every other match and are refused unless index is given. Words starting a longer word count.',
      'An empty field says its placeholder, and a control with no text of its own says its accessibility name. A disabled tab, list entry or row is refused. On a rich label link_pressed says whether the press reached a link, with link_meta giving the meta the label reports clicked, an empty one included.',
      'A button in toggle mode, a CheckBox or CheckButton included, answers pressed with before and after, its button_pressed either side of the click. The same value twice is a click the game undid, and after is null when the click freed it. A refusal for a pointer turned off names where mouse_behavior_recursive was set.',
      'On a 3D node landed says the interface did not swallow the press. No control under the pointer stopped it, a control letting the pointer pass included. Every viewport on the way out from the room had the pointer over what shows the room. A disabled button, a control that does not process and one mouse_behavior_recursive turned off are refused, since the press would do nothing.',
      'choose answers what was chosen, read before the press, which is heard rather than assumed. A menu is opened rather than clicked, because its items are drawn rather than built. The item is looked for as the menu stands once open, since a game can fill a menu as it opens.',
      'choose also answers what became of the control named: in_tree, removed or freed, since a game can rebuild its screen on the pick. It answers what the button in front of the menu shows now, when it is still there. A disabled or hidden button in front of the menu is refused, and so is a press the menu did not take.',
      'action, key, mouse_click and joypad_button answer the event as it was sent. whole says whether the press was let go of again. pressed says whether it is left held down (true only after pressed true). A key gives the keycode, physical_keycode and unicode it carried. A controller button gives its number, its name and the device.',
      'A held press answers held_frames. Under held_for it answers the seconds the hold lasted and the physics_frames that ran in it. A process frame is no set time, and a headless game runs them far faster than the sixty physics ticks a second that _physics_process sees.',
      "mouse_motion answers the position and the relative movement sent, and mouse_drag from, to, motions sent and relative_total. touch answers the finger's index, the position, whole and pressed as a mouse_click has them, and emulates_mouse. touch_drag answers what mouse_drag answers, with index and emulates_mouse. joypad_motion answers the axis by number and name, the value and the device.",
      "In the game's window the engine makes mouse events from the first finger down where emulate_mouse_from_touch is on. They carry DEVICE_ID_EMULATION.",
      'key, mouse_click, click, joypad_button and joypad_motion answer actions, the InputMap actions the event also presses. For a motion, those are the ones its direction reaches past their deadzone, and none for one inside it. mouse_click, mouse_motion and mouse_drag answer hovered, the control under the pointer once the events are handled, or null over none. The other events are aimed at nothing.',
      'mouse_click with a press, and mouse_drag, answer press_went_to, read before the press. It is the path of what the press went to, a control or a window embedded over the point. It is null when nothing there takes the pointer.',
      "Given nodePath naming a Control, landed says whether what the press went to is the control or inside it. A click that did not land on a control whose mouse_filter is ignore, as a Label's is, says so under why_not_landed. One on a control with something drawn over it names that, and a window stacked above the one the control is in counts.",
      "An action, a key, a joypad_button or a joypad_motion answers focused, the path of the Control holding the keyboard focus when it went in. A focused Control gets the event before the game's _unhandled_input, so Space or Enter on a focused button presses the button. Where the press moved the focus, focused_after names the Control holding it once the event was handled, or null when nothing does. A click and a mouse_click answer focused_after too, read in the viewport holding what was clicked.",
      "A key that a focused LineEdit or TextEdit took as typing names that field under typed_into, and what it holds under holds. A field being edited keeps the key from the game's _unhandled_input. editing_ended true, on a key or on text, is a LineEdit that stopped being edited, as Enter does by submitting it. It keeps the focus, and nothing typed into it lands until it is clicked again. text with the focus on a control that is no LineEdit or TextEdit answers holds null and a note saying so.",
      "A mouse_click, mouse_motion or mouse_drag given nodePath answers it under path. Its points are in the pixels of the window they went to, and window names that window when it is not the game's own. One with a point outside the viewport it went to says so under outside_viewport, with the viewport's rectangle, and no control there receives it. A wheel button is always a whole step, as a mouse sends one. A lone wheel press holds the viewport on the control that took it, so every later click lands there.",
      'key is not for a menu a click has opened, so use choose there. An OptionButton or PopupMenu pops up as a window of its own that a key never reaches. So arrows move nothing and Enter closes it unchosen. An embedded dialog whose owner reads keys in _input gets them.',
      'An engine dialog is not answered by action. AcceptDialog reads the Escape key itself and never asks the InputMap, so ui_cancel goes in and the question stays up. action answers shortcuts, the buttons it was sent to as their Shortcut. shortcut_pressed is the one pressed, null when none took it. At most one button takes it, the last in the tree that does, passing over one that is disabled, hidden or outside its shortcut context.',
      'text answers what it landed in and what the field then holds (a secret field as its mask), a character at a time. With a dialog focused the field is that dialog\'s focus, where the keys go. replace false types at the caret, so a field reading 2.1 typed "0.3" at reads 2.10.3. A joypad axis stays where a motion puts it until another motion moves it, and holdFrames needs a value other than 0.',
    ].join('\n\n'),
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      nodePath: {
        type: 'string',
        ops: ['click', 'choose', 'mouse_click', 'mouse_motion', 'mouse_drag', 'touch', 'touch_drag'],
        description:
          'click: the Control or 3D node. With says, where to look. choose: the PopupMenu, OptionButton or MenuButton. Pointer ops: the node whose space x and y are in, default the window.',
      },
      says: {
        type: 'string',
        ops: ['click'],
        description:
          'The words on the control to click, matched as runtime_inspect matches says. The best match is pressed, and index picks among equals.',
      },
      action: {
        type: 'string',
        ops: ['action'],
        description:
          'The InputMap action name. A button whose Shortcut holds it is pressed too. ui_cancel does not close an AcceptDialog.',
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
        description:
          'true writes over what the field says, and with text "" empties it. Default false types at the caret.',
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
          'Mouse: left, right, middle, wheel_up, wheel_down or a button number. Default left. Joypad: a name such as a, start, dpad_up or left_shoulder, or a JoyButton number.',
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
        summary: 'take an item out of a menu, by its words in text or its place in index',
        requires: ['nodePath'],
      },
      action: { effect: 'additive', summary: 'press an action, or hold it', requires: ['action'] },
      key: {
        effect: 'additive',
        summary: 'press a key, or hold it, not for an open menu',
        requires: ['keycode'],
      },
      text: {
        effect: 'additive',
        summary: 'type into the field being edited',
        requires: ['text'],
      },
      mouse_click: {
        effect: 'additive',
        summary: '',
        requires: ['x', 'y'],
      },
      mouse_motion: {
        effect: 'additive',
        summary: '',
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
      'Waits on the running game. Arm a watch, then send the call that sets a change off. A watch records a change over before your next call. A call sent beside a wait can run during it, noted in ranAlongside. A game held by its debugger answers nothing until it resumes.',
    answer: [
      'until answers met, and value, the last reading of the property when the wait answered, whatever the wait asked for. A wait that was not met also answers waited_for, the value it compared against. elapsed_ms and frames say how long it waited.',
      'until with == or != answers outside_declared when the value waited for is not one the property declares. A number no value of an enum has, or one past an export range, is waited for all the same. A game may store one.',
      'until with says counts the frames the wait spanned and the looks it took. looking_ms and longest_hold_ms say how long the looks took. A wait that runs out while a hidden node holds the words says so under unseen_note. What is drawn over a node is not looked at, so words under a dialog or a panel count either way.',
      'signal with a watch answers at once, with fired_before_wait, when the signal fired after the watch was armed, and otherwise waits for it. times counts how often it fired, and args is what the first carried. fired_after_ms is the milliseconds from the arming to the first, and elapsed_ms how long the wait itself took. A watch that never fired says that one fired before the arming is not counted. The watch goes with the answer either way.',
      'recorded answers changes, each with value and frame, the process frames since the watch was armed, 0 for the reading at arming. elapsed_ms is the wall-clock milliseconds since the arming. game_time is the seconds of process time the game was given since the arming, scaled by Engine.time_scale as a tween is.',
      'Use game_time as the clock, since a headless game runs process frames far faster than 60 a second. A property that changes every frame records one change a frame up to 1000, an answer of tens of thousands of characters. frames and elapsed_ms say how long it recorded.',
      'recorded answers calls, each runtime_invoke set or call and runtime_input sent while it recorded, in order. Each has call (the tool and op) and what it was given of path, method, property, action, keycode, button, pressed and says. Its frame is the last reading taken before it ran. So what it changed shows from the next reading at the earliest. Two calls sent one after the other arrive frames apart, which frame tells apart from a delay in the game itself.',
      'calls_dropped counts any call past 1000. dropped says so when more than 1000 changes came. ended says recording stopped before it was collected: the node was freed, the path stopped reading, or 120000 ms passed.',
    ].join('\n\n'),
    parameters: {
      projectPath: RUNNING_PROJECT_PATH,
      pid: RUNNING_PID,
      frames: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        ops: ['frames'],
        description: 'How many to let pass.',
      },
      seconds: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: 120,
        ops: ['seconds'],
        description: "The game's own time to let pass, scaled by Engine.time_scale.",
      },
      nodePath: {
        type: 'string',
        ops: ['signal', 'watch', 'until'],
        description:
          'The node, such as "/root/Main/Player" or "%Player". With op until and says, it defaults to /root.',
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
          'The number an earlier op watch answered, used up by the answer. signal takes it in place of nodePath and signal.',
      },
      property: {
        type: 'string',
        ops: ['until', 'watch'],
        description:
          'watch: the property to record every frame. until: the property name or a colon path as runtime_inspect reads one.',
      },
      value: {
        ops: ['until'],
        blank: true,
        description:
          "The value to wait for, fitted to the property's type and compared at its precision. An enum takes a name or a number, and an object property the text null.",
      },
      compare: {
        type: 'string',
        enum: ['==', '!=', '>=', '<=', '>', '<'],
        ops: ['until'],
        description:
          'How the property is compared with value. Default ==. Use >= or <= for a counter that steps.',
      },
      says: {
        type: 'string',
        ops: ['until'],
        description:
          'Wait for these words to appear instead of for a property, matched as runtime_inspect matches says. Not with property.',
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
        description: 'How long to wait before answering anyway. Default 5000.',
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
        summary: 'wait for the signal and answer with what it carried, at once if the watch saw it fire',
        requires: [],
        requiresOneOf: [['nodePath', 'signal'], ['watch']],
        unmet: {
          said: 'runtime_wait signal needs nodePath and signal, or the watch an earlier runtime_wait watch answered.',
        },
      },
      watch: {
        effect: 'read',
        summary: 'record a signal or a property, answering the number signal or recorded takes as watch',
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
        summary: 'wait for property to read as value, or for the words in says to appear under nodePath',
        // A wait for words has a node to default to, and a wait for a property does not. The game
        // refuses a property wait missing property or value.
        requires: [],
        requiresOneOf: [['nodePath'], ['says']],
        unmet: {
          said: 'runtime_wait until needs nodePath to wait for a property: the property belongs to that node.',
          next: ['With says instead of property, nodePath can be left out and the whole game is searched'],
        },
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
      "A breakpoint set before editor_run is in place from the game's first frame. The set is kept in the project until removed. The addon turns on network/debug_adapter/sync_breakpoints. A game this server started does not stop on a script error.",
    answer: [
      'Every answer lists the whole set under held. With an editor of this project connected, the ones set in its gutter are under setInEditor. A set on a line the engine never stops on is refused. The refusal names the next line it does stop on. A set on a script behind a link that leads out of the project is not read, so its line is not checked. lineNotChecked names the link.',
      "With an editor of this project connected a set goes through the editor's debug adapter. With none, or with an editor that has another project open, it is held here. editor_run start starts the game itself unless silent: false lets a connected editor play it.",
      'A game this server started is handed every breakpoint held here as it starts, and one set while it runs reaches it too. The set answers once the game has taken it, which it does between frames. So a call made after the answer stops there (runningGame says so).',
      'A game this server started does not stop on a script error, so a run that meets one carries on past it. editor_output has the error with where it happened, and a breakpoint on that line stops the game before the line runs.',
      "The editor keeps a breakpoint set through its adapter for one play. So every breakpoint this server holds is sent again before each play editor_run starts, and the start answer lists them under breakpoints. The set is also kept in the project, for the server that comes after a reconnect. A breakpoint stays until it is removed here, whichever server set it. Setting one here never takes the ones set in the editor's gutter away.",
      'Removing a line here clears it whoever set it. A remove takes any line. With no editor connected it answers removed false when none was held there, and says why.',
      'breakpointsAtRisk names an editor whose network/debug_adapter/sync_breakpoints was turned off, here and in editor_status, since Godot then clears breakpoints when a debug session opens.',
    ].join('\n\n'),
    parameters: {
      projectPath: PROJECT_PATH,
      scriptPath: { ...SCRIPT_PATH, ops: ['set', 'remove'] },
      line: { type: 'integer', minimum: 1, ops: ['set', 'remove'], description: 'One-based line.' },
    },
    requires: ['projectPath'],
    operations: {
      set: { effect: 'additive', summary: '', requires: ['scriptPath', 'line'] },
      remove: {
        effect: 'destructive',
        summary: "remove a breakpoint, whoever set it, the editor's gutter included",
        requires: ['scriptPath', 'line'],
      },
      list: {
        effect: 'read',
        summary:
          "held breakpoints under held, and if this project's editor is connected its gutter under setInEditor",
        requires: [],
      },
    },
  },
  {
    name: 'debug_control',
    title: 'Step the debugger',
    changes: 'Acts on the running game. Writes no file.',
    description:
      'A step waits for the game to stop again and answers with the stack, or with heldAgain false after ten seconds. pause and step_out need a game this server started. To stop an editor-played game, set a breakpoint.',
    answer: [
      "A game the editor plays is moved through the editor's debug adapter. It answers a pause by reporting the game stopped while leaving it running, and implements no stepOut. A game this server started itself has its keeper as its debugger, which does both.",
      'pause breaks into the game wherever it is, a script spinning in a loop included. That is how a game hung on its first frame is asked where it is. A pause answers paused false after thirty seconds, with the request still standing. A loop that runs few lines between sleeps can take seconds to stop.',
      "A pause or step that lands between frames or in the runtime addon is stepped on to the game's next script line. Stepping on lasts up to five seconds. A stack still in the addon says so in a note. A step that stops on a line holding a breakpoint says onBreakpoint under held, whether the step ended there or ran into it.",
      "A pause that reaches a game a breakpoint has just stopped makes the engine print an error. The run's output keeps it as info with raisedBy debug_control pause.",
      "step_out runs to the end of the current function and stops at the next line run at its caller's depth. That is in its caller, or wherever script runs next when the call was the last thing its caller did. A function the engine called, such as _process, is stepped through to its end. It stops at the next line of script the game runs, which can be the same function on another node.",
    ].join('\n\n'),
    parameters: {},
    requires: [],
    operations: {
      pause: {
        effect: 'additive',
        summary: 'stop the game where it is and answer with the stack',
        requires: [],
      },
      continue: { effect: 'additive', summary: 'resume after a breakpoint', requires: [] },
      step_over: { effect: 'additive', summary: 'run the current line', requires: [] },
      step_into: {
        effect: 'additive',
        summary: 'run the current line and stop inside whatever it calls',
        requires: [],
      },
      step_out: {
        effect: 'additive',
        summary: 'run to the end of the current function',
        requires: [],
      },
    },
  },
  {
    name: 'debug_state',
    title: 'Debugger state',
    description:
      'Where the debugged game is stopped. The errors and warnings a game reported are in editor_output. evaluate runs what the expression calls, so a call that changes something changes the game.',
    answer: [
      "For a game this server started, this server's own debugger answers. held says which thread stopped and why, and output is what the game printed. A typed array or dictionary is typed as declared, such as Array[String]. A list or a dictionary shows its first 20 entries and says how many more it holds. An evaluate such as items.slice(20, 40) reads the rest.",
      "For a game the editor plays, the editor's debug adapter answers. After a reconnect a game still at its breakpoint shows a thread and no frames, and the refusal says held rather than running. debug_control continue lets it go, and the next stop carries its stack. With no runtime addon, the reason an evaluate failed reaches only the editor's Debugger panel. So a null there carries a note saying it may be either.",
      "stack names each frame's script as the project spells it under script and on this machine under path. A function that awaited is resumed with no caller below it, so its frame is the only one.",
      "variables lists members, the script's variables and not its constants, which an evaluate reads by name. An object is given as its class and instance id only, and evaluate reads into it. The compiler's own locals, named with @ such as a for loop's @counter_pos, are left out. A frame the stack no longer holds is refused. A scope whose values did not arrive in time answers variables null and is named under valuesMissing.",
      "evaluate is worked out by the game at the frame, with the frame's instance as self. The frame's locals, the globals and every global class are in scope. A frame with no instance, a static function's called on its class, is refused, and the frame below it has one. An error the expression raises does not break the game.",
      "evaluate of an expression that does not parse, or fails as it runs, comes to null with failed saying why. A null with no failed is the value. The error the engine prints for it is in the run's output as info with raisedBy debug_state evaluate. It does not count among the run's errors.",
      'A global class that does not parse makes the first evaluate of a run fail, and the answer says so under note. stack, variables and evaluate are then refused until the game next stops. For a game the editor plays, the stack still reads true, and only variables and evaluate are refused.',
      "An expression evaluated while the game is held inside a runtime_invoke call reports what it raises as raised by that call. The call's answer says so under errorsNote.",
    ].join('\n\n'),
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
        summary:
          'what an expression evaluates to at a frame, run in the stopped game, the first loading every global class',
        requires: ['expression'],
      },
      output: { effect: 'read', summary: 'console output from the debug adapter', requires: [] },
    },
    defaultOperation: 'stack',
  },
  {
    name: 'debug_objects',
    title: 'Object snapshots',
    description:
      'Counts the objects the running game holds by class, and compares two snapshots to show what an action kept alive. Only for a game this server started, whose editor_run start answered through gdharness. Needs an engine with debug features.',
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
        summary: 'count the objects by class, most first, and keep the counts under an id',
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
    const needed = [
      ...(operation.requires.length > 0 ? [operation.requires.join(', ')] : []),
      ...(operation.requiresOneOf === undefined ? [] : [requiredSetsSaid(operation.requiresOneOf)]),
    ];
    const needs = needed.length > 0 ? ` (needs ${needed.join(', and ')})` : '';
    return operation.summary === '' ? `${op}${needs}` : `${op}${needs}: ${operation.summary}`;
  });
  const fallback = spec.defaultOperation ? ` Default ${spec.defaultOperation}.` : '';
  return `Operations: ${lines.join('; ')}.${fallback}`;
}

/** The longest description a client is sent. Claude Code cuts a tool's description beyond it. */
export const MOST_DESCRIPTION_CHARACTERS = 4096;

/** A tool's description as a client is sent it: the prose and its ops. */
function servedDescription(spec: ToolSpec): string {
  return [spec.description, describeOperations(spec)].filter((part) => part !== '').join(' ');
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
