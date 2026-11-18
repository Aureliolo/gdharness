/**
 * A process that takes one engine slot the way a server does and holds it until it is ended, for a
 * test that kills a gdharness holding a delegate command's grant. It prints `granted <lock>` once
 * it holds the slot. Run it with Bun.
 */
import process from 'node:process';
import { slotForCall } from '../../src/engine-slots.js';

const slot = await slotForCall(false, process.env['HOLD_PROJECT']);
console.log(`granted ${slot.lock}`);
setInterval(() => undefined, 1000);
