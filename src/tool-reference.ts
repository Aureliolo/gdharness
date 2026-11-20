/**
 * The tool reference as markdown, rendered from the tool definitions themselves.
 *
 * One renderer, used by the documentation site and by the skill gdharness writes into a project,
 * so neither can describe a tool the server does not have or miss one it does.
 */

import { ENGINE_PASSES, HEADLESS_OPERATIONS, HEADLESS_TOOLS } from './headless-operations.js';
import { isRecord } from './records.js';
import {
  ALSO_SAVED,
  argumentsOf,
  CLASSES_REBUILT,
  effectsOf,
  listed,
  projectPathSentence,
  requiredSetsSaid,
  TOOL_SPECS,
  type ToolSpec,
  theGamePicked,
  WITHOUT_AN_EDITOR,
} from './tool-definitions.js';

/** What a schema's `type` is called in prose, for the one argument or two that take either. */
export function namedType(declared: unknown): string {
  if (typeof declared === 'string') {
    return declared;
  }
  if (Array.isArray(declared) && declared.every((kind) => typeof kind === 'string')) {
    return declared.join(' or ');
  }
  return 'any';
}

/**
 * What an argument takes, in prose: its type, with what an array holds. A list of suite files was
 * accepted by `path` and read as "string or array" in the reference and as the bare name in a
 * refusal, and a session that guessed `suites` found the form only in its own earlier transcript.
 */
export function argumentShape(schema: Readonly<Record<string, unknown>>): string {
  const named = namedType(schema['type']);
  const values = schema['enum'];
  // Half the enums leave a value out of their description, and a caller cannot guess the spelling.
  if (
    named === 'string' &&
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((v) => typeof v === 'string')
  ) {
    return `one of ${values.join(', ')}`;
  }
  const items = schema['items'];
  const held = isRecord(items) ? namedType(items['type']) : 'any';
  return named
    .split(' or ')
    .map((kind) => (kind === 'array' && held !== 'any' ? `array of ${held}s` : kind))
    .join(' or ');
}

/**
 * Which calls a CI job can make, listed rather than described.
 *
 * The rest of this page says what each tool does and not what it needs to exist before it can do
 * it, and that is the fact somebody wiring gdharness into CI needs first: an editor is a person's
 * window, so anything that talks to one cannot be part of an automatic check. The split was stated
 * in passing and a reader had to infer it tool by tool.
 *
 * Rendered from the dispatch table rather than written out, so a tool that stops being headless,
 * or a new one that is, cannot leave this paragraph quietly wrong.
 */
export function headlessSection(): string[] {
  const everyOp = new Map<string, string[]>();
  const tables = [
    ...Object.entries(HEADLESS_OPERATIONS).map(([tool, ops]): [string, string[]] => [tool, Object.keys(ops)]),
    ...Object.entries(ENGINE_PASSES).map(([tool, ops]): [string, string[]] => [tool, [...ops]]),
  ];
  for (const [tool, ops] of tables) {
    everyOp.set(tool, [...(everyOp.get(tool) ?? []), ...ops]);
  }
  const byTool = [
    ...[...everyOp].map(([tool, ops]) => `\`${tool}\` (${ops.join(', ')})`),
    ...Object.keys(HEADLESS_TOOLS).map((tool) => `\`${tool}\``),
  ].toSorted();
  return [
    '## Calls a CI job can make',
    '',
    'These answer from a short-lived headless engine: no editor window, no running game, and no',
    'process or port outliving the answer.',
    '',
    ...byTool.map((line) => `- ${line}`),
    '',
    'Most of these still write to the project, so a CI job checks with the reading ops.',
    '',
    '`scene_create`, `scene_node`, `scene_signal`, `scene_animation`, `scene_tree` and `resource_edit`',
    'go through the editor when one serves the project and through a headless engine when none does.',
    '`project_info`, `project_search`, `project_test` and `script_diagnostics` need no editor either.',
    'A CI job can call all of them, and checks with the reads among them. `editor_run check` boots the',
    'project in a headless engine of its own, so a CI job can call it too. The other `editor_*`',
    'calls, and the `debug_*` and `runtime_*` ones, act on an editor or a running game.',
    '`editor_run start` starts a game with no editor open. `debug_breakpoint` holds breakpoints until',
    'a game runs.',
    '',
    '`project_settings get` with `from: "editor"` asks the open editor instead of the file and',
    'starts no engine. A CI job leaves it alone, because there is no editor on a build machine and',
    'the call is refused rather than answered from the file.',
    '`scene_create save` with `from` set to "editor" saves the editor\'s copy of a scene and is refused the same way.',
    '',
  ];
}

/**
 * Paragraphs several tools' descriptions share, each stated once under its own heading.
 *
 * The tool list a client loads has no headings, so each description there carries the paragraph
 * whole. On this page it would be the same paragraph three or four times, so each copy becomes a
 * link to the one here. `detail` is what the section adds that the list has no room for.
 */
export const SHARED_PARAGRAPHS: readonly {
  readonly heading: string;
  readonly text: string;
  readonly detail: string;
}[] = [
  {
    heading: 'Editor or headless engine',
    text: WITHOUT_AN_EDITOR,
    detail:
      'The headless engine runs every script of the file, where the editor runs only tool scripts. What a script changes as the file loads or as a property is set is put back before anything is saved. A file where that cannot be done, such as a scene whose script does not compile, is refused with nothing written. Each file the written one refers to is named by its uid, as the editor names it. A file the uid cache has no uid for yet, such as one made since the last scan, is named by path. namedByPath lists it with the call that scans it. An editor of the project that is running and has not reached this server yet is waited for.',
  },
  {
    heading: 'What a scene write also saves',
    text: ALSO_SAVED,
    detail:
      'One property can set others as it loads: anchors_preset gives a centred Control both grow directions. alsoSaved lists each line as {node, property, was, saved}, on any node the scene held, those inside an instance included. It has no was where the file set nothing, and no saved where it now sets nothing. What a set moved on its own node is under alsoChanged instead. A node the call adds and the format lines (header uid, load_steps, unique_id, an ext_resource uid) are not listed. The scene loads as it did, and only its text changed.',
  },
  {
    heading: 'What a headless engine also does',
    text: CLASSES_REBUILT,
    detail:
      'classesRebuiltFirst names the classes added, and is left out when none was missing. The autoloads start once the call has answered.',
  },
];

/** The tools whose description or answer carries [shared], by name. */
function toolsSharing(shared: string): string[] {
  return TOOL_SPECS.filter((tool) => `${tool.description}${tool.answer}`.includes(shared)).map(
    (tool) => tool.name,
  );
}

/**
 * [text] with each shared paragraph taken out, since its section says it once and names the tools
 * it applies to. A link in its place was a sentence that said nothing.
 */
export function withoutSharedParagraphs(text: string): string {
  return SHARED_PARAGRAPHS.reduce(
    (left, { text: shared }) =>
      left.replaceAll(`${shared} `, '').replaceAll(` ${shared}`, '').replaceAll(shared, ''),
    text,
  )
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

function sharedSections(): string[] {
  return SHARED_PARAGRAPHS.flatMap(({ heading, text, detail }) => [
    `## ${heading}`,
    '',
    `For ${coded(toolsSharing(text))}.`,
    '',
    text,
    '',
    detail,
    '',
  ]);
}

/**
 * The sentence behind the hints a client is sent, naming the ops that make a tool destructive:
 * the hint is per tool, and `scene_node get` is not the call a client asks about.
 */
function whatItCanChange(tool: ToolSpec): string {
  if (tool.changes !== undefined) {
    return tool.changes;
  }
  if (effectsOf(tool).every((effect) => effect === 'read')) {
    return 'Changes nothing.';
  }
  const operations = Object.entries(tool.operations ?? {});
  const destroying = operations.filter(([, op]) => op.effect === 'destructive').map(([name]) => name);
  const sparing = operations.filter(([, op]) => op.effect !== 'destructive').map(([name]) => name);
  // Whichever list is shorter says the same, and thirteen ops of sixteen read as a wall of names.
  if (sparing.length > 0 && sparing.length < destroying.length) {
    return `Can overwrite, remove or end what is there, through every op but ${coded(sparing)}.`;
  }
  return `Can overwrite, remove or end what is there, through ${coded(destroying)}.`;
}

/**
 * The tool reference as markdown, which is what an agent gets pointed at.
 *
 * An agent handed an HTML page pays for the chrome, the navigation and the stylesheet link before
 * it reaches a sentence, so every page of the site has a plain twin and the links written for
 * agents go to those.
 */
export function renderToolsMarkdown(): string {
  const lines: string[] = [
    '# Tools',
    '',
    `${TOOL_SPECS.length} tools, each named for its area and what it works on, such as \`scene_node\`. A tool`,
    'that does several related things takes an `op`. An unknown op or argument is refused with the',
    'valid set listed. Generated from the server.',
    '',
    `${projectPathSentence()}. The \`debug_*\` calls among them answer about the game this server`,
    'started or the editor is playing, and the `editor_*` ones about the editor on this server.',
    '',
    theGamePicked(),
    '',
    'An argument a tool does not declare is refused rather than ignored. Answers are read from the',
    'engine after the change, not echoed from the request. Engine stderr comes back under',
    '`engine_messages`.',
    '',
    ...headlessSection(),
    ...sharedSections(),
  ];

  for (const tool of TOOL_SPECS) {
    lines.push(...toolSection(tool));
  }
  return lines.join('\n');
}

/**
 * The markdown lines of one tool: its description, what it can change, its ops, its arguments and
 * then its answer, which a caller reads after the call rather than before it.
 */
export function toolSection(tool: ToolSpec): string[] {
  const description = withoutSharedParagraphs(tool.description);
  const lines = [
    `## ${tool.name}`,
    '',
    ...(description === '' ? [] : [description, '']),
    whatItCanChange(tool),
    '',
  ];
  const shared = sharedArgumentsLine(tool);
  if (shared !== '') {
    lines.push(shared, '');
  }

  const operations = Object.entries(tool.operations ?? {});
  if (operations.length > 0) {
    lines.push('Operations (`op`):', '');
    for (const [op, spec] of operations) {
      lines.push(operationLine(tool, op, spec));
    }
    lines.push('');
  }

  const parameters = Object.entries(tool.parameters).filter(([name]) => name !== 'projectPath');
  if (parameters.length > 0) {
    lines.push('Arguments:', '');
    for (const [name, schema] of parameters) {
      const type = argumentShape(schema);
      // The colon goes with the description rather than with the name. Ten arguments had none and
      // rendered as a line ending in a colon, in the page and in the skill an agent reads.
      const note = typeof schema['description'] === 'string' ? `: ${schema['description']}` : '';
      lines.push(`- \`${name}\` (${type})${note}`);
    }
    lines.push('');
  }

  const answer = withoutSharedParagraphs(tool.answer);
  if (answer !== '') {
    lines.push(`### ${tool.name} answer`, '', answer, '');
  }
  return lines;
}

/** [names] in backticks, as prose. */
function coded(names: readonly string[]): string {
  return listed(names.map((name) => `\`${name}\``));
}

/**
 * What every op of [tool] needs, and what every op takes on top, said once for the tool so the op
 * lines carry only what tells one op from another. A tool without ops says what its call needs.
 */
function sharedArgumentsLine(tool: ToolSpec): string {
  const { needs, takes } = sharedArguments(tool);
  const count = Object.keys(tool.operations ?? {}).length;
  const subject = count === 0 ? 'The call' : count === 1 ? 'Its op' : 'Every op';
  if (needs.length > 0 && takes.length > 0) {
    return `${subject} needs ${coded(needs)}, and takes ${coded(takes)}.`;
  }
  if (needs.length > 0) {
    return `${subject} needs ${coded(needs)}.`;
  }
  return takes.length > 0 ? `${subject} takes ${coded(takes)}.` : '';
}

/** The arguments every op of [tool] needs, and the others every op takes, in declared order. */
function sharedArguments(tool: ToolSpec): { needs: string[]; takes: string[] } {
  const ops = Object.values(tool.operations ?? {});
  const neededByAll = (name: string): boolean =>
    tool.requires.includes(name) || (ops.length > 0 && ops.every((op) => op.requires.includes(name)));
  const names = [...new Set([...tool.requires, ...Object.keys(tool.parameters)])];
  const needs = names.filter(neededByAll);
  const takes =
    ops.length === 0
      ? []
      : names.filter(
          (name) =>
            !needs.includes(name) &&
            name !== 'projectPath' &&
            Object.keys(tool.operations ?? {}).every((op) => argumentsOf(tool, op).includes(name)),
        );
  return { needs, takes };
}

/**
 * The bullet for op [param op] of [param tool], in the tool list's own form: the op, then in
 * brackets what it needs and what else it takes beyond what every op does, then its summary.
 */
function operationLine(
  tool: ToolSpec,
  op: string,
  spec: { summary: string; requires: readonly string[]; requiresOneOf?: readonly (readonly string[])[] },
): string {
  const shared = sharedArguments(tool);
  const needs = spec.requires.filter((name) => !shared.needs.includes(name));
  const sets = spec.requiresOneOf ?? [];
  // What else the op will take, because an argument meant for another op is refused. The
  // list below says which ops each argument belongs to. This says it the way round somebody
  // writing one call wants it.
  const spare = argumentsOf(tool, op).filter(
    (name) =>
      !needs.includes(name) &&
      !sets.some((set) => set.includes(name)) &&
      !shared.needs.includes(name) &&
      !shared.takes.includes(name) &&
      name !== 'projectPath',
  );
  const needed = [
    ...(needs.length > 0 ? [coded(needs)] : []),
    ...(sets.length > 0 ? [requiredSetsSaid(sets, (name) => `\`${name}\``)] : []),
  ];
  const marks = [
    ...(tool.defaultOperation === op ? ['default'] : []),
    ...(needed.length > 0 ? [`needs ${needed.join(', and ')}`] : []),
    ...(spare.length > 0 ? [`takes ${coded(spare)}`] : []),
  ];
  // Commas, since the page is prose and the words needs and takes already part the lists.
  const bracket = marks.length > 0 ? ` (${marks.join(', ')})` : '';
  const what = spec.summary === '' ? '' : `: ${spec.summary}`;
  return `- \`${op}\`${bracket}${what}.`;
}
