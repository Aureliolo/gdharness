extends Node
## Brings gdharness's runtime up in a debug build that has its addon, and does nothing anywhere else.
##
## `project.godot` names this file rather than the addon's script. `addons/` is often not committed
## and exports leave it out, so an entry naming the addon boots a fresh clone or an exported build
## with a missing script. `gdharness setup` writes this file, and `gdharness doctor` says when it is
## not the one that gdharness ships. The runtime refuses a `-s` script run by itself unless
## `gdharness/runtime/serve_script_runs` is on, so that is left to it.

## Loaded by path as it runs rather than preloaded: a preload resolves when this script is parsed,
## and in a build without the addon that is the missing script this file is here to avoid.
const RUNTIME: String = "res://addons/gdharness_runtime/runtime_autoload.gd"


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
