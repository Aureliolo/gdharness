/**
 * The first line of a script a test hands to `node -e` or writes out for Node to run, when that
 * script starts processes of its own: `spawnHidden` and `spawnSyncHidden` as `src/spawn.ts` defines
 * them, for code that cannot import it. A stand-in started without a console gives every child it
 * starts a console window of its own on the desktop in use, as the server would.
 */
export const HIDDEN_SPAWN_PRELUDE =
  "const { spawnHidden, spawnSyncHidden } = ((started) => ({ spawnHidden: (command, args, options = {}) => started.spawn(command, args, { ...options, windowsHide: true }), spawnSyncHidden: (command, args, options = {}) => started.spawnSync(command, args, { ...options, windowsHide: true }) }))(require('node:child_process'));";
