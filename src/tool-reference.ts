/**
 * The tool reference as markdown, rendered from the tool definitions themselves.
 *
 * One renderer, used by the documentation site and by the skill gdharness writes into a project,
 * so neither can describe a tool the server does not have or miss one it does.
 */

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
