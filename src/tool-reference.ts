/**
 * The tool reference as markdown, rendered from the tool definitions themselves.
 *
 * One renderer, used by the documentation site and by the skill gdharness writes into a project,
 * so neither can describe a tool the server does not have or miss one it does.
 */

import { ENGINE_PASSES, HEADLESS_OPERATIONS } from './headless-operations.js';
import { isRecord } from './records.js';
import {
  argumentsOf,
  effectsOf,
  projectPathSentence,
  TOOL_SPECS,
  type ToolSpec,
  theGamePicked,
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
  const items = schema['items'];
  const held = isRecord(items) ? namedType(items['type']) : 'any';
  return named
    .split(' or ')
    .map((kind) => (kind === 'array' && held !== 'any' ? `array of ${held}s` : kind))
    .join(' or ');
}

/**
 * Which calls a push gate can make, listed rather than described.
 *
 * The rest of this page says what each tool does and not what it needs to exist before it can do
 * it, and that is the fact somebody wiring gdharness into CI needs first: an editor is a person's
 * window, so anything that talks to one cannot be part of an automatic check. The split was stated
 * in passing and a reader had to infer it tool by tool.
 *
 * Rendered from the dispatch table rather than written out, so a tool that stops being headless,
 * or a new one that is, cannot leave this paragraph quietly wrong.
 */
function headlessSection(): string[] {
  const everyOp = new Map<string, string[]>();
  for (const table of [HEADLESS_OPERATIONS, ENGINE_PASSES]) {
    for (const [tool, ops] of Object.entries(table)) {
      everyOp.set(tool, [...(everyOp.get(tool) ?? []), ...Object.keys(ops)]);
    }
  }
  const byTool = [...everyOp].map(([tool, ops]) => `\`${tool}\` (${ops.join(', ')})`).toSorted();
  return [
    '## What a gate can call',
    '',
    'These answer from a short-lived headless engine: no editor window, no running game, and no',
    'process or port outliving the answer. They are the only calls an automatic check can make at',
    'all, because every other tool needs an editor somebody has open or a game somebody is running.',
    '',
    ...byTool.map((line) => `- ${line}`),
    '',
    'Needing nothing is not the same as changing nothing, and a gate wants both. Most of these',
    'write to the project because that is what they are for: `script_edit create` writes a file,',
    '`project_settings set` rewrites `project.godot`, `project_import reimport` and `refresh_classes`',
    'write under `.godot`, and `project_import refresh_uids` writes a `.uid` beside each script that',
    'had none. The reading ops are the ones to gate on, and which is which is in each',
    "op's own summary below rather than assumed from this list.",
    '',
    '`scene_create`, `scene_node`, `scene_signal` and `resource_edit` go through the editor when one',
    'serves the project and through a headless engine when none does, so they need nothing open',
    'either. A gate can call them, and the reads among them are the ones to gate on. Everything else',
    'needs the editor (`editor_*`, `debug_*`, `scene_animation` but its reads) or a running game',
    '(`runtime_*`).',
    '',
    'One of these can be pointed the other way: `project_settings get` takes `from: "editor"` to ask',
    'the open editor instead of the file, which is a different reading and costs no engine start. A',
    'gate leaves it alone, because there is no editor on a build machine and the call is refused',
    'rather than answered from the file.',
    '',
  ];
}

/**
 * The sentence behind the hints a client is sent, naming the ops that make a tool destructive:
 * the hint is per tool, and `scene_node get` is not the call a client asks about.
 */
function whatItCanChange(tool: ToolSpec): string {
  if (effectsOf(tool).every((effect) => effect === 'read')) {
    return 'Changes nothing.';
  }
  const destroying = Object.entries(tool.operations ?? {})
    .filter(([, op]) => op.effect === 'destructive')
    .map(([name]) => `\`${name}\``);
  if (destroying.length === 0) {
    return 'Adds or starts things, and overwrites and removes nothing itself.';
  }
  return `Can overwrite, remove or end what is there, through ${listed(destroying)}.`;
}

/** [items] as prose: "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  const last = items.at(-1) ?? '';
  return items.length === 1 ? last : `${items.slice(0, -1).join(', ')} and ${last}`;
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
    `${TOOL_SPECS.length} tools, named \`domain_verb\`. A tool that does several related things takes an`,
    '`op`. An unknown op or argument is refused with the valid set listed. Generated from the server.',
    '',
    `${projectPathSentence()}: the \`runtime_*\` and \`debug_*\` ones pick between running games`,
    'instead, and the others answer about the editor on this server. The pick, when a call names',
    `neither \`projectPath\` nor \`pid\`: ${theGamePicked()}. An argument a tool does not`,
    'declare is refused rather than ignored. Answers are read from the engine after the change, not',
    'echoed from the request. Engine stderr comes back under `engine_messages`.',
    '',
    ...headlessSection(),
  ];

  for (const tool of TOOL_SPECS) {
    lines.push(`## ${tool.name}`, '', `${tool.title}. ${whatItCanChange(tool)}`, '', tool.description, '');
    if (tool.answer !== undefined) {
      lines.push(`The answer: ${tool.answer}`, '');
    }

    const operations = Object.entries(tool.operations ?? {});
    if (operations.length > 0) {
      for (const [op, spec] of operations) {
        const needs = [...tool.requires, ...spec.requires];
        const isDefault = tool.defaultOperation === op ? ' (default)' : '';
        const wants = needs.length > 0 ? ` Needs: ${needs.map((name) => `\`${name}\``).join(', ')}.` : '';
        // What else the op will take, because an argument meant for another op is refused. The
        // list below says which ops each argument belongs to. This says it the way round somebody
        // writing one call wants it.
        const spare = argumentsOf(tool, op).filter((name) => !needs.includes(name) && name !== 'projectPath');
        const takes = spare.length > 0 ? ` Takes: ${spare.map((name) => `\`${name}\``).join(', ')}.` : '';
        lines.push(`- \`op: ${op}\`${isDefault}: ${spec.summary}.${wants}${takes}`);
      }
      lines.push('');
    } else if (tool.requires.length > 0) {
      lines.push(`Needs: ${tool.requires.map((name) => `\`${name}\``).join(', ')}.`, '');
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
  }
  return lines.join('\n');
}
