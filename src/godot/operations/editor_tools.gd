extends RefCounted

## The editor addon's scene and resource tools, run by a headless engine for a project no editor
## serves.
##
## They are the editor's own scripts, loaded from beside these operations in the package, so a write
## made here passes the same checks and answers in the same shape. What the engine does that an
## editor does not, running every script, is put back in scene_file.gd and headless_check.gd.

const ResourceTools = preload("../addons/gdharness_editor/tools/resource_tools.gd")
const SceneTools = preload("../addons/gdharness_editor/tools/scene_tools.gd")

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


## Runs the tool [code]command[/code] names with [code]arguments[/code], answering what it answers.
static func run(params: Dictionary) -> Dictionary:
	var command: String = str(params.get("command", ""))
	var given: Variant = params.get("arguments", {})
	if not given is Dictionary:
		return {"ok": false, "error": "arguments must be an object."}
	var arguments: Dictionary = given
	var tools: Node = null
	if command in SCENE_COMMANDS:
		tools = SceneTools.new()
	elif command in RESOURCE_COMMANDS:
		tools = ResourceTools.new()
	else:
		return {"ok": false, "error": "No editor tool runs headless as " + command}
	var answer: Variant = tools.call(command, arguments)
	tools.free()
	if answer is Dictionary:
		return answer
	return {
		"ok": false, "error": "%s answered %s rather than an object." % [command, type_string(typeof(answer))]
	}
