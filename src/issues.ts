/**
 * What this project says when the thing to do is tell its maintainer.
 *
 * Two occasions, and they are not the same. A defect is a failure nobody modelled: every other
 * failure here is a refusal that names what to do instead, so a call that fell through to this
 * one did nothing wrong and repeating it changes nothing. A gap is the opposite, a tool that
 * should exist and does not, which only whoever is driving the harness can notice.
 *
 * Nothing is sent from here. Both produce text and a link, and an issue is opened by a person
 * who has read what it would contain, or not at all: a machine reporting on somebody's project
 * without them seeing it first puts their scene names and paths in a public tracker.
 */

import { createHash } from 'node:crypto';
import process from 'node:process';
import { errorMessage } from './errors.js';
import { SERVER_VERSION } from './server-version.js';

const NEW_ISSUE = 'https://github.com/Aureliolo/gdharness/issues/new';

/** The link an agent is handed when a gap is worth writing down. */
export const ENHANCEMENT_URL = `${NEW_ISSUE}?template=feature_request.md`;

/**
 * The block an answer carries when it is time to ask about the tool that is missing.
 *
 * JSON like every other block an answer can grow, so a reader that parses answers sees one more
 * field rather than prose it has to guess at the shape of.
 */
export function feedbackNotice(): string {
  return JSON.stringify(
    {
      gdharness_feedback: {
        what_to_do:
          'If this session has run into something gdharness cannot do, or a tool that should ' +
          'exist and does not, tell the user what is missing and offer to open an enhancement ' +
          'issue for them. Only if they say yes, and only for a real gap: a call you got wrong ' +
          'is not one. If you cannot open an issue yourself, give them the link and what to ' +
          'write in it.',
        enhancement_url: ENHANCEMENT_URL,
      },
    },
    null,
    2,
  );
}

/** Whichever runtime is actually running this, since either one can be. */
function runtime(): string {
  // Bun's own types declare versions.bun as always present, which it is not under Node.
  const versions: Readonly<Record<string, string | undefined>> = process.versions;
  const bun = versions['bun'];
  return bun === undefined ? `node ${process.versions.node}` : `bun ${bun}`;
}

/**
 * A short, stable id for the same defect seen twice.
 *
 * Two machines hitting one bug should arrive with one id, so what differs between machines comes
 * out first: paths, numbers, casing. A dedupe aid in a title and nothing else, which is why eight
 * characters is enough and why nothing depends on it being unique.
 */
export function defectSignature(where: string, message: string): string {
  const normalised = `${where}\n${message}`
    .toLowerCase()
    .replaceAll('\\', '/')
    .replaceAll(/(?:[a-z]:)?(?:\/+[\w.-]+){2,}/gu, '<path>')
    .replaceAll(/\d+/gu, '0');
  return createHash('sha256').update(normalised).digest('hex').slice(0, 8);
}

/** What the report says about the machine, in the order the issue template asks for it. */
function facts(where: string, message: string, godotVersion?: string): readonly (readonly string[])[] {
  return [
    ['Where', where],
    ['Error', message],
    ['Version', `gdharness ${SERVER_VERSION}`],
    ['Runtime', `${runtime()}, ${process.platform} ${process.arch}`],
    ['Godot', godotVersion ?? 'not known at the point this failed'],
    ['Signature', defectSignature(where, message)],
  ];
}

/** The issue body, already answering every question the bug template asks that a machine can. */
function filledTemplate(where: string, message: string, godotVersion?: string): string {
  return [
    `**gdharness version**: ${SERVER_VERSION}`,
    `**Godot version**: ${godotVersion ?? ''}`,
    `**Bun version**: ${runtime()}`,
    `**OS**: ${process.platform} ${process.arch}`,
    '**MCP client**:',
    '',
    '## What you did',
    '',
    where,
    '',
    '## What you expected',
    '',
    'The call to answer, or to refuse with a reason.',
    '',
    '## What happened',
    '',
    'gdharness failed in a way it does not model.',
    '',
    '```text',
    message,
    '```',
    '',
    `Signature: \`${defectSignature(where, message)}\``,
    '',
    '## Anything that makes it reproducible',
    '',
  ].join('\n');
}

/**
 * The whole of what a failed call says about itself.
 *
 * Written for whoever reads it next, which is usually an agent: it says the retry is pointless
 * before it says anything else, because the alternative is three wasted turns of the same call.
 * Then it hands over the decision, which is not the agent's to take.
 */
export function defectReport(where: string, error: unknown, godotVersion?: string): string {
  const message = errorMessage(error);
  const title = `Defect ${defectSignature(where, message)}: ${where}`;
  const url =
    `${NEW_ISSUE}?template=bug_report.md&title=${encodeURIComponent(title)}` +
    `&body=${encodeURIComponent(filledTemplate(where, message, godotVersion))}`;
  const width = Math.max(...facts(where, message, godotVersion).map(([label]) => (label ?? '').length));

  return [
    'gdharness failed in a way it does not model. This is a defect in gdharness rather than',
    'anything about the call: the arguments did not cause it, and sending it again will not',
    'change it.',
    '',
    ...facts(where, message, godotVersion).map(
      ([label, value]) => `  ${(label ?? '').padEnd(width)}  ${value ?? ''}`,
    ),
    '',
    'Do not open an issue on your own initiative. Tell the person whose machine this is what',
    'broke, and ask whether you may report it to gdharness on their behalf. What the report',
    'carries is the lines above and nothing else, and whether that goes into a public tracker',
    'is theirs to decide.',
    '',
    'If they say yes, this link carries the report already filled in:',
    url,
    '',
    'If they say yes and you have no way to open an issue yourself, give them that link and',
    'those lines, and stay with them while they file it.',
  ].join('\n');
}
