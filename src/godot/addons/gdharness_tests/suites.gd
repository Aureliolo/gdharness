extends Node

## gdUnit4 suites run inside a played scene, which the engine's script profiler sees and a script
## run with `-s` never does. `editor_run start` given `suites` plays this scene with
## [constant RUNNER] naming the runner `gdharness test` uses, where the server ships it, followed by
## that runner's own arguments. The runner is loaded from there rather than kept in this addon,
## since it extends gdUnit4's classes and a project without gdUnit4 must still compile the addon.

const RUNNER: String = "--gdh-runner"


func _ready() -> void:
	var asked: PackedStringArray = OS.get_cmdline_user_args()
	var at: int = asked.find(RUNNER)
	var path: String = asked[at + 1] if at >= 0 and at + 1 < asked.size() else ""
	var listed: GDScript = null
	if not path.is_empty() and FileAccess.file_exists(path):
		listed = load(path) as GDScript
	if listed == null:
		push_error(
			(
				(
					"gdharness suites: no runner at '%s'. This scene is played by editor_run start with suites,"
					+ " which names the runner after %s; it does nothing played any other way."
				)
				% [path, RUNNER]
			)
		)
		get_tree().quit(1)
		return
	var runner: Node = listed.call("started", asked.slice(at + 2))
	# The runner holds its own script past the engine's shutdown by this path.
	runner.set("own_path", path)
	add_child(runner)
