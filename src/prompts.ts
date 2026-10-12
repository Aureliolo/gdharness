/**
 * The workflows a client offers a person as prompts (slash commands in some), each written as the
 * tool calls it takes so that a test can hold every argument it names against the tool table: a
 * prompt telling an agent to pass an argument the tool refuses would start every use with a
 * refusal.
 */

import {
  type GetPromptResult,
  type Prompt,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import type { ProtocolServer } from './server-types.js';

/** One call a prompt asks for: the tool, its op, the arguments to pass, and what it is for. */
interface PromptStep {
  readonly tool: string;
  readonly op?: string;
  /** Prompt arguments passed through under the same name, when the person gave them. */
  readonly passes: readonly string[];
  /** Arguments given a fixed value, written as JSON. */
  readonly fixed?: Readonly<Record<string, unknown>>;
  readonly why: string;
}

export interface PromptSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly arguments: readonly {
    readonly name: string;
    readonly description: string;
    readonly required: boolean;
  }[];
  readonly steps: readonly PromptStep[];
  readonly report: string;
}

const PROJECT_PATH = {
  name: 'projectPath',
  description: 'The directory holding project.godot.',
  required: true,
} as const;

export const PROMPT_SPECS: readonly PromptSpec[] = [
  {
    name: 'run_and_check',
    title: 'Run the game and check it',
    description: 'Run the project from the editor, let the run end, and report every error it raised.',
    arguments: [
      PROJECT_PATH,
      {
        name: 'scene',
        description: 'A scene to run instead of the main one, as res:// or project-relative.',
        required: false,
      },
    ],
    steps: [
      { tool: 'editor_status', passes: [], why: 'see whether an editor is connected and its addon matches' },
      { tool: 'editor_run', op: 'start', passes: ['projectPath', 'scene'], why: 'start the run' },
      {
        tool: 'editor_run',
        op: 'wait',
        passes: ['projectPath'],
        why: 'wait for it to end; for a game that never quits on its own, editor_run stop instead once it has run long enough',
      },
      { tool: 'editor_output', op: 'run', passes: [], why: 'read what it printed, with the clean verdict' },
    ],
    report:
      'Report the clean verdict, then every error and warning with its backtrace and the script and line it points at, most serious first.',
  },
  {
    name: 'diagnose_project',
    title: 'Diagnose the project',
    description:
      'Check the editor connection, the project health report, export validation and the import state.',
    arguments: [PROJECT_PATH],
    steps: [
      { tool: 'editor_status', passes: [], why: 'see whether an editor is connected and its addon matches' },
      {
        tool: 'project_info',
        passes: ['projectPath'],
        fixed: { include: ['health', 'validation'] },
        why: 'read the health report and export validation',
      },
      {
        tool: 'project_import',
        op: 'status',
        passes: ['projectPath'],
        why: 'find resources that are outdated or failed to import',
      },
    ],
    report:
      'Report what is wrong, most serious first, naming the file and line or setting for each, and what would fix it.',
  },
  {
    name: 'run_tests',
    title: 'Run the tests',
    description: "Run the project's test suites and report the failures.",
    arguments: [
      PROJECT_PATH,
      {
        name: 'path',
        description: 'A suite file or directory to run instead of every suite.',
        required: false,
      },
    ],
    steps: [{ tool: 'project_test', passes: ['projectPath', 'path'], why: 'run the suites' }],
    report:
      'Report how many passed and failed, then each failure with its suite, case, file and line and the assertion message.',
  },
];

/** The prompts as `prompts/list` carries them. */
function listedPrompts(): Prompt[] {
  return PROMPT_SPECS.map((spec) => ({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    arguments: spec.arguments.map((argument) => ({ ...argument })),
  }));
}

/**
 * [spec] with [given] filled in, as the one user message `prompts/get` answers with, or the reason
 * it cannot be: an argument it needs is missing, or one it does not take was given.
 */
function renderedPrompt(
  spec: PromptSpec,
  given: Readonly<Record<string, string>>,
): { ok: true; result: GetPromptResult } | { ok: false; reason: string } {
  const takes = new Set(spec.arguments.map((argument) => argument.name));
  const unknown = Object.keys(given).filter((name) => !takes.has(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `${spec.name} does not take ${unknown.join(', ')}; it takes ${[...takes].join(', ')}.`,
    };
  }
  const missing = spec.arguments.filter((argument) => argument.required && !given[argument.name]);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${spec.name} needs ${missing.map((argument) => argument.name).join(', ')}.`,
    };
  }
  const lines = spec.steps.map((step, index) => {
    const call = step.op === undefined ? step.tool : `${step.tool} ${step.op}`;
    const passed = step.passes
      .filter((name) => given[name])
      .map((name) => `${name}: ${JSON.stringify(given[name])}`);
    const fixed = Object.entries(step.fixed ?? {}).map(
      ([name, value]) => `${name}: ${JSON.stringify(value)}`,
    );
    const withArguments = [...passed, ...fixed];
    const arguments_ = withArguments.length > 0 ? ` with ${withArguments.join(', ')}` : '';
    return `${index + 1}. Call ${call}${arguments_}, to ${step.why}.`;
  });
  const text = [spec.description, '', ...lines, '', spec.report].join('\n');
  return {
    ok: true,
    result: { description: spec.description, messages: [{ role: 'user', content: { type: 'text', text } }] },
  };
}

export function setupPromptHandlers(server: ProtocolServer): void {
  server.setRequestHandler('prompts/list', () => ({ prompts: listedPrompts() }));
  server.setRequestHandler('prompts/get', (request) => {
    const spec = PROMPT_SPECS.find((one) => one.name === request.params.name);
    if (spec === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `No prompt is named ${request.params.name}. Prompts: ${PROMPT_SPECS.map((one) => one.name).join(', ')}.`,
      );
    }
    const rendered = renderedPrompt(spec, request.params.arguments ?? {});
    if (!rendered.ok) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, rendered.reason);
    }
    return rendered.result;
  });
}
