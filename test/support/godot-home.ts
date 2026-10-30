/**
 * Points this test process, and every engine it starts, at a Godot data home of its own for the
 * whole suite, as a side effect of being imported.
 *
 * Godot keeps a project's user data and the editor's settings under the user's application data,
 * shared by every editor of a version on the machine. A suite's editors rewrote the editor settings
 * the owner's own editors and other sessions read, the debugger port among them, and left a folder
 * under app_userdata for every project name a fixture uses. Set on this process rather than handed
 * to each start, because fixtures start engines in a dozen ways and the one that forgets is the one
 * that writes there. macOS reads only HOME, which carries far more than Godot's folders, so it is
 * left alone there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

if (process.platform !== 'darwin') {
  const home = mkdtempSync(join(tmpdir(), 'gdharness-test-godot-home-'));
  if (process.platform === 'win32') {
    process.env['APPDATA'] = home;
  } else {
    process.env['XDG_DATA_HOME'] = join(home, 'data');
    process.env['XDG_CONFIG_HOME'] = join(home, 'config');
  }
  process.once('exit', () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // An engine still running holds files in it, and the temporary folder is swept later.
    }
  });
}
