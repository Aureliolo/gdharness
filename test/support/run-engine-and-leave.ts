/**
 * Runs one engine start through `runEngine` and leaves the process to end on its own, as a command
 * does once its work is done. Prints the start's exit code and failure as one line of JSON.
 */
import { runEngine } from '../../src/engine-run.js';

const ran = await runEngine('cmd.exe', ['/c', 'exit', '0']);
process.stdout.write(`${JSON.stringify({ exitCode: ran.exitCode, failure: ran.failure })}\n`);
