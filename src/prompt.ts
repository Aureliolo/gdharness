/**
 * Asking the person running the command, when there is a person to ask.
 *
 * Consent for writing a config is either a flag on the command line or an answer typed here.
 * Anything else, a pipe, a CI job, an agent reading our output, gets the default and no question,
 * because a prompt nobody can answer is a command that hangs forever.
 */

import process from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';

/** Whether there is somebody at a terminal to answer. */
export function interactive(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export class Ask {
  private line: Interface | undefined;

  /** Yes or no, with the default taken when there is nobody to ask or the answer is empty. */
  async confirm(question: string, fallback: boolean): Promise<boolean> {
    if (!interactive()) {
      return fallback;
    }
    this.line ??= createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await this.line.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim();
    return answer === '' ? fallback : answer.toLowerCase().startsWith('y');
  }

  close(): void {
    this.line?.close();
    this.line = undefined;
  }
}
