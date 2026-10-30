extends Node
## Brings gdharness's runtime up in a debug build that has its addon, and does nothing elsewhere.
##
## `project.godot` names this file rather than the addon's script. The addons folder is often not
## committed and exports leave it out, so an entry naming the addon boots a fresh clone or an
## exported build with a missing script. `gdharness setup` writes this file, and `gdharness doctor`
## says when it is not the one that gdharness ships. The runtime refuses a `-s` script run by itself
## unless the project's serve_script_runs setting is on, so that is left to it.

## Loaded by path as it runs rather than preloaded: a preload resolves when this script is parsed,
## and in a build without the addon that is the missing script this file is here to avoid.
const RUNTIME: String = "res://addons/gdharness_runtime/runtime_autoload.gd"

var _runtime: Node


func _ready() -> void:
	if not OS.is_debug_build() or not ResourceLoader.exists(RUNTIME):
		return
	var script: GDScript = load(RUNTIME) as GDScript
	if script == null:
		return
	var made: Object = script.new()
	var runtime: Node = made as Node
	if runtime == null:
		return
	# Under this node rather than beside it: the root refuses a child while it is still adding the
	# autoloads, and a deferred add would bring the runtime up only after the main scene's _ready.
	# Added now, it announces before the main scene runs, as it does when an entry names it.
	add_child(runtime)
	_runtime = runtime


## Whether gdharness's runtime is listening in this engine: false in a script run, an engine without
## the addon and a release build that still carries this node, though it is in every one of them. A
## release export made with the editor addon enabled leaves this node out.
func serving() -> bool:
	if not is_instance_valid(_runtime) or not _runtime.has_method("serving"):
		return false
	var answered: Variant = _runtime.call("serving")
	return answered is bool and answered
