extends RefCounted

## The editor addon's scene and resource tools, run by a headless engine for a project no editor
## serves.
##
## They are the editor's own scripts, loaded from beside these operations in the package, so a write
## made here passes the same checks and answers in the same shape. What the engine does that an
## editor does not, running every script, is put back in scene_file.gd and headless_check.gd.

const GdhAnimationTools = preload("../addons/gdharness_editor/tools/animation_tools.gd")
const GdhResourceTools = preload("../addons/gdharness_editor/tools/resource_tools.gd")
const GdhSceneTools = preload("../addons/gdharness_editor/tools/scene_tools.gd")
const GdhSceneFile = preload("../addons/gdharness_editor/scene_file.gd")

const SCENE_COMMANDS: Array[String] = [
	"create_scene",
	"save_scene",
	"add_node",
	"get_node_properties",
	"set_node_properties",
	"duplicate_node",
	"reparent_node",
	"delete_node",
	"connect_signal",
	"disconnect_signal",
	"list_connections",
]
const RESOURCE_COMMANDS: Array[String] = [
	"set_tilemap_cells",
	"create_resource",
	"modify_resource",
	"create_shader",
	"create_tileset",
	"set_theme_color",
	"set_theme_font_size",
]
const ANIMATION_COMMANDS: Array[String] = [
	"create_animation",
	"add_animation_track",
	"set_animation",
	"rename_animation",
	"remove_animation",
	"add_animation_state",
	"connect_animation_states",
]


## Runs the tool [code]command[/code] names with [code]arguments[/code], answering what it answers.
static func run(params: Dictionary) -> Dictionary:
	var command: String = str(params.get("command", ""))
	var given: Variant = params.get("arguments", {})
	if not given is Dictionary:
		return {"ok": false, "error": "arguments must be an object."}
	var arguments: Dictionary = given
	var tools: Node = null
	if command in SCENE_COMMANDS:
		tools = GdhSceneTools.new()
	elif command in RESOURCE_COMMANDS:
		tools = GdhResourceTools.new()
	elif command in ANIMATION_COMMANDS:
		tools = GdhAnimationTools.new()
	else:
		return {"ok": false, "error": "No editor tool runs headless as " + command}
	var answer: Variant = tools.call(command, arguments)
	tools.free()
	if answer is Dictionary:
		var answered: Dictionary = answer
		if not GdhSceneFile.by_path.is_empty():
			answered["namedByPath"] = (
				(
					"%s %s named by path rather than by uid. A uid in a file's own header is resolved "
					+ "through the project's uid cache, which holds none for %s yet, as with a file "
					+ "made since the project was last scanned, and a uid it does not hold would warn "
					+ "on every load. project_import refresh_uids scans the project, and writes after "
					+ "it name %s by uid."
				)
				% [
					", ".join(GdhSceneFile.by_path),
					"is" if GdhSceneFile.by_path.size() == 1 else "are",
					"it" if GdhSceneFile.by_path.size() == 1 else "them",
					"it" if GdhSceneFile.by_path.size() == 1 else "them",
				]
			)
		return answered
	return {
		"ok": false, "error": "%s answered %s rather than an object." % [command, type_string(typeof(answer))]
	}
