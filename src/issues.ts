/**
 * What this project says when the thing to do is tell its maintainer.
 *
 * Two occasions, and they are not the same. A defect is a failure nobody modelled: every other
 * failure here is a refusal that names what to do instead, so a call that fell through to this
 * one did nothing wrong. Whether repeating it changes anything is a separate question and not one
 * this can answer from the call, since a rare event reaches the same line as a settled state. One
 * that turns out to have been the project's or the environment's doing after all is still worth
 * hearing about, because it means a failure this program knows about arrived dressed as one it does
 * not. A gap is the other occasion: a tool that should exist and does not, which only whoever
 * drives the harness sees.
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
    'If the real cause turned out to be the project, the environment or the call, say so here:',
    'reaching you as a defect rather than as a refusal naming what would have worked is then the',
    'thing to fix.',
    '',
    '## Anything that makes it reproducible',
    '',
  ].join('\n');
}

/**
 * How many times each unmodelled failure has already been answered with.
 *
 * What separates a lock that had cleared by the next call from a state that will answer the same
 * way for ever is whether it comes back, and only something that outlives one call can see both
 * attempts. Keyed by signature, which is the same eight characters the report prints under
 * `Signature`, so "this exact failure" means the line the reader is looking at rather than a
 * sameness they have to take on trust.
 */
export class DefectsSeen {
  private readonly counts = new Map<string, number>();

  /** How many times this failure has already been reported, counting this one in for next time. */
  before(where: string, message: string): number {
    const signature = defectSignature(where, message);
    const seen = this.counts.get(signature) ?? 0;
    this.counts.set(signature, seen + 1);
    return seen;
  }
}

/** What the caller knows about a defect that the report itself cannot work out. */
export interface DefectContext {
  /** The engine's version, when whatever failed had already learned it. */
  readonly godotVersion?: string | undefined;
  /**
   * How many times this process has already answered with this same signature.
   *
   * Zero is the first time, which is the only state where a retry is worth a turn.
   */
  readonly seenBefore?: number | undefined;
}

/**
 * The whole of what a failed call says about itself.
 *
 * Written for whoever reads it next, which is usually an agent, so what it says about trying again
 * decides three turns either way. It used to say a retry would change nothing, reasoning that every
 * failure this program models is a refusal and so anything reaching here was a state rather than an
 * event. That holds for the failures nobody modelled *because* they cannot happen twice differently,
 * and not for the ones nobody modelled because they are rare: a file the editor had open, a socket
 * that dropped mid-call. Windows against a live editor produces the first kind routinely, and an
 * agent told the retry was pointless went and interrupted somebody over a lock that had already
 * cleared.
 *
 * So the advice is taken off something known rather than assumed. The same failure twice in one
 * process is a state and says so; the first time is an event until it is not, and one retry settles
 * which. The paragraph after it hands over the decision, which is not the agent's to take.
 */
export function defectReport(where: string, error: unknown, context: DefectContext = {}): string {
  const { godotVersion, seenBefore = 0 } = context;
  const message = errorMessage(error);
  const title = `Defect ${defectSignature(where, message)}: ${where}`;
  const url =
    `${NEW_ISSUE}?template=bug_report.md&title=${encodeURIComponent(title)}` +
    `&body=${encodeURIComponent(filledTemplate(where, message, godotVersion))}`;
  const width = Math.max(...facts(where, message, godotVersion).map(([label]) => (label ?? '').length));

  return [
    'gdharness failed in a way it does not model. Whatever went wrong underneath, it reached you',
    'as a crash rather than as a refusal naming what would have worked, and that much is a defect',
    'in gdharness however the rest of it turns out.',
    '',
    ...(seenBefore === 0
      ? [
          'Send the call once more before anything else. Some of what reaches this line is a file',
          'another process had open, or a connection that dropped, and those are gone by the next',
          'attempt. If the same Signature comes back, it is not one of those, and repeating it',
          'further only spends turns.',
        ]
      : [
          `You have had this exact failure ${seenBefore === 1 ? 'once' : `${seenBefore} times`} in this session already, so it is a`,
          'state rather than a passing one, and sending the call again will not change it.',
        ]),
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
    '',
    'Worth reporting either way. If you can see that what actually went wrong was the project,',
    'the environment or the call, then this message is the defect: a failure gdharness knows',
    'about is meant to arrive as a refusal naming what would have worked, not as this. Say that',
    'in the report and it is the more useful of the two.',
  ].join('\n');
}
