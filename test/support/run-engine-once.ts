/**
 * Runs one engine start through `runEngine` in a process of its own, so the folder the helper is
 * kept in can be this process's TEMP. Prints the start's exit code and failure as one line of JSON.
 */
import { runEngine } from '../../src/engine-run.js';

const ran = await runEngine(process.execPath, ['-e', '']);
process.stdout.write(`${JSON.stringify({ exitCode: ran.exitCode, failure: ran.failure })}\n`);
process.exit(0);
