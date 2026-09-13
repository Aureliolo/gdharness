#!/usr/bin/env bun

import { defectReport } from './issues.js';
import { runGodotServer } from './server.js';

// Nothing about starting a stdio server depends on the project or the engine, so a failure here
// is never the caller's: it is this program not doing what it says it does.
await runGodotServer().catch((error: unknown) => {
  console.error(defectReport('gdharness server startup', error));
  process.exit(1);
});
