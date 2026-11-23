/**
 * A suite that needs a window, which sends input through gdUnit4's scene runner and writes what its
 * window and its scene saw. Several of them run at once in separate engines, each waiting at a
 * barrier until every peer has started, so what each engine reports is what it sees while the others
 * draw too. The scene runner feeds its input to the engine's own viewport, never through the
 * operating system, so the input counts show that a suite's simulated input still arrives beside
 * other windows, not that the windows keep the system's input apart.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What one engine saw of its window and the input it sent itself. */
export interface ProbeSaw {
  /** Presses of `A` the scene received. */
  readonly keys: number;
  /** Presses of the left mouse button the scene received. */
  readonly clicks: number;
  /** Presses of `ui_accept` the scene received. */
  readonly actions: number;
  /** Whether the window had focus once every peer had started. */
  readonly focused: boolean;
  /** Notifications of the window gaining and losing focus, and of the application doing so. */
  readonly focusEvents: {
    readonly windowIn: number;
    readonly windowOut: number;
    readonly appIn: number;
    readonly appOut: number;
  };
  /** The size of the window and of the root viewport. */
  readonly window: readonly [number, number];
  readonly viewport: readonly [number, number];
  /** The name of the display server, which is `headless` only when no window was made. */
  readonly display: string;
  /** Frames drawn a second over three seconds. */
  readonly fps: number;
  /** How many peers had started when this one passed the barrier. */
  readonly peers: number;
}

/** The scene's script: it counts the input and focus notifications it receives. */
const SCENE_SCRIPT = [
  'extends Control',
  '',
  'var keys: int = 0',
  'var clicks: int = 0',
  'var actions: int = 0',
  'var window_in: int = 0',
  'var window_out: int = 0',
  'var app_in: int = 0',
  'var app_out: int = 0',
  '',
  '',
  'func _input(event: InputEvent) -> void:',
  '\tif event is InputEventKey and (event as InputEventKey).pressed:',
  '\t\tkeys += 1',
  '\tif event is InputEventMouseButton and (event as InputEventMouseButton).pressed:',
  '\t\tclicks += 1',
  '\tif event is InputEventAction and event.is_action_pressed("ui_accept"):',
  '\t\tactions += 1',
  '',
  '',
  'func _notification(what: int) -> void:',
  '\tif what == NOTIFICATION_WM_WINDOW_FOCUS_IN:',
  '\t\twindow_in += 1',
  '\telif what == NOTIFICATION_WM_WINDOW_FOCUS_OUT:',
  '\t\twindow_out += 1',
  '\telif what == NOTIFICATION_APPLICATION_FOCUS_IN:',
  '\t\tapp_in += 1',
  '\telif what == NOTIFICATION_APPLICATION_FOCUS_OUT:',
  '\t\tapp_out += 1',
  '',
].join('\n');

const SCENE = [
  '[gd_scene load_steps=2 format=3]',
  '',
  '[ext_resource type="Script" path="res://windowed_probe.gd" id="1"]',
  '',
  '[node name="Probe" type="Control"]',
  'script = ExtResource("1")',
  '',
].join('\n');

/** The suite, named by [param name], which writes `probe_out/<name>.json` once its scene has had its input. */
function suiteText(): string {
  return [
    'extends GdUnitTestSuite',
    '',
    'const GDHARNESS_NEEDS_WINDOW: bool = true',
    '',
    '',
    'func test_probe() -> void:',
    '\tvar out: String = ProjectSettings.globalize_path("res://probe_out")',
    '\tDirAccess.make_dir_recursive_absolute(out)',
    '\tvar peers: int = int(FileAccess.get_file_as_string("res://probe_peers.txt"))',
    '\tvar mine: String = (get_script() as Script).resource_path.get_file().get_basename()',
    '\tFileAccess.open(out.path_join(mine + ".ready"), FileAccess.WRITE).close()',
    '\tvar looked: int = 0',
    '\tvar present: int = 0',
    '\twhile looked < 600:',
    '\t\tpresent = DirAccess.get_files_at(out).size()',
    '\t\tif present >= peers:',
    '\t\t\tbreak',
    '\t\tlooked += 1',
    '\t\tawait get_tree().create_timer(0.1).timeout',
    '\tvar runner: GdUnitSceneRunner = scene_runner("res://windowed_probe.tscn")',
    '\tvar probe: Control = runner.scene() as Control',
    '\tawait runner.await_input_processed()',
    '\tvar focused: bool = DisplayServer.window_is_focused()',
    '\trunner.simulate_key_pressed(KEY_A)',
    '\tawait runner.await_input_processed()',
    '\trunner.simulate_mouse_button_pressed(MOUSE_BUTTON_LEFT)',
    '\tawait runner.await_input_processed()',
    '\trunner.simulate_action_pressed("ui_accept")',
    '\tawait runner.await_input_processed()',
    '\tvar drawn: int = Engine.get_frames_drawn()',
    '\tvar began: int = Time.get_ticks_msec()',
    '\tawait get_tree().create_timer(3.0).timeout',
    '\tvar seconds: float = float(Time.get_ticks_msec() - began) / 1000.0',
    '\tvar saw: Dictionary = {',
    '\t\t"keys": probe.get("keys"),',
    '\t\t"clicks": probe.get("clicks"),',
    '\t\t"actions": probe.get("actions"),',
    '\t\t"focused": focused,',
    '\t\t"focusEvents": {',
    '\t\t\t"windowIn": probe.get("window_in"),',
    '\t\t\t"windowOut": probe.get("window_out"),',
    '\t\t\t"appIn": probe.get("app_in"),',
    '\t\t\t"appOut": probe.get("app_out"),',
    '\t\t},',
    '\t\t"window": [DisplayServer.window_get_size().x, DisplayServer.window_get_size().y],',
    '\t\t"viewport": [get_tree().root.size.x, get_tree().root.size.y],',
    '\t\t"display": DisplayServer.get_name(),',
    '\t\t"fps": float(Engine.get_frames_drawn() - drawn) / seconds,',
    '\t\t"peers": present,',
    '\t}',
    '\tvar written: FileAccess = FileAccess.open(out.path_join(mine + ".json"), FileAccess.WRITE)',
    '\twritten.store_string(JSON.stringify(saw))',
    '\twritten.close()',
    '',
  ].join('\n');
}

/** The files of the probe: the scene, its script and a suite for each of [param names]. */
export function probeTree(names: readonly string[]): Record<string, string> {
  return {
    'windowed_probe.gd': SCENE_SCRIPT,
    'windowed_probe.tscn': SCENE,
    ...Object.fromEntries(names.map((name) => [`tests/${name}_test.gd`, suiteText()])),
  };
}

/** Readies [param project] for a run of [param peers] probe suites at once: no earlier files, the count written. */
export function readyProbe(project: string, peers: number): void {
  rmSync(join(project, 'probe_out'), { recursive: true, force: true });
  mkdirSync(join(project, 'probe_out'));
  writeFileSync(join(project, 'probe_peers.txt'), String(peers));
}

/** What each probe suite wrote, by suite name (as its file, `<name>_test`). */
export function probesSaw(project: string): Record<string, ProbeSaw> {
  const out = join(project, 'probe_out');
  if (!existsSync(out)) {
    return {};
  }
  return Object.fromEntries(
    readdirSync(out)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const saw: unknown = JSON.parse(readFileSync(join(out, file), 'utf8'));
        if (!isProbeSaw(saw)) {
          throw new Error(`${file} does not say what a probe saw: ${JSON.stringify(saw)}`);
        }
        return [file.slice(0, -'_test.json'.length), saw];
      }),
  );
}

/** Whether [param value] has every field of [type ProbeSaw]. */
function isProbeSaw(value: unknown): value is ProbeSaw {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const fields = new Map(Object.entries(value));
  return (
    ['keys', 'clicks', 'actions', 'fps', 'peers'].every((name) => typeof fields.get(name) === 'number') &&
    typeof fields.get('focused') === 'boolean' &&
    typeof fields.get('display') === 'string' &&
    Array.isArray(fields.get('window')) &&
    Array.isArray(fields.get('viewport')) &&
    typeof fields.get('focusEvents') === 'object'
  );
}
