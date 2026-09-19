/**
 * The tool reference as markdown, rendered from the tool definitions themselves.
 *
 * One renderer, used by the documentation site and by the skill gdharness writes into a project,
 * so neither can describe a tool the server does not have or miss one it does.
 */

import { ENGINE_PASSES, HEADLESS_OPERATIONS } from './headless-operations.js';
import { argumentsOf, TOOL_SPECS } from './tool-definitions.js';

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
  const byTool = [...everyOp].map(([tool, ops]) => `\`${tool}\` (${ops.join(', ')})`).sort();
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
    'Everything else needs the editor (`editor_*`, `debug_*`, `scene_*`, `resource_*`) or a running',
    'game (`runtime_*`).',
    '',
    'One of these can be pointed the other way: `project_settings get` takes `from: "editor"` to ask',
    'the open editor instead of the file, which is a different reading and costs no engine start. A',
    'gate leaves it alone, because there is no editor on a build machine and the call is refused',
    'rather than answered from the file.',
    '',
  ];
}

export function renderToolsMarkdown(): string {
  const lines: string[] = [
    '# Tools',
    '',
    `${TOOL_SPECS.length} tools, named \`domain_verb\`. A tool that does several related things takes an`,
    '`op`. An unknown op or argument is refused with the valid set listed. Generated from the server.',
    '',
    'Every call takes `projectPath`, except the `runtime_*` and `debug_*` tools, where it picks',
    'between running games. Answers are read from the engine after the change, not echoed from the',
    'request. Engine stderr comes back under `engine_messages`.',
    '',
    ...headlessSection(),
  ];

  for (const tool of TOOL_SPECS) {
    lines.push(`## ${tool.name}`, '', tool.description, '');

    const operations = Object.entries(tool.operations ?? {});
    if (operations.length > 0) {
      for (const [op, spec] of operations) {
        const needs = [...tool.requires, ...spec.requires];
        const isDefault = tool.defaultOperation === op ? ' (default)' : '';
        const wants = needs.length > 0 ? ` Needs: ${needs.map((name) => `\`${name}\``).join(', ')}.` : '';
        // What else the op will take, because an argument meant for another op is refused. The
        // list below says which ops each argument belongs to; this says it the way round somebody
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
        const type = namedType(schema['type']);
        const note = typeof schema['description'] === 'string' ? ` ${schema['description']}` : '';
        lines.push(`- \`${name}\` (${type}):${note}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
