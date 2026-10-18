import { SERVER_VERSION } from '../../src/server-version.js';
import { shippedEditorDigest } from '../../src/setup.js';

/**
 * The greeting an editor on this release's addon sends, for a stand-in editor to send.
 *
 * Every field, because a greeting short of one is another release's and the bridge asks that
 * editor nothing but to quit. [param overrides] replaces fields, and a field set to undefined is
 * left out, which is how a case sends a greeting this release would not.
 */
export function greeting(
  projectPath: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const full: Record<string, unknown> = {
    type: 'godot_ready',
    project_path: projectPath,
    addon_version: SERVER_VERSION,
    addon_digest: shippedEditorDigest(),
    editor_pid: process.pid,
    lsp_port: 0,
    dap_port: 0,
    debug_port: 0,
    syncs_breakpoints: true,
    opened_by_a_server: false,
    started_by_an_editor: false,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(full).filter(([, value]) => value !== undefined));
}
