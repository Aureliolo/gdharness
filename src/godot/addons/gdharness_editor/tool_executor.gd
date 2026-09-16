@tool
extends Node

## Routes each command the server sends to the tool module that answers it. The modules are
## preloaded rather than looked up on disk at runtime, so a missing one fails to parse here
## instead of leaving a command silently unanswered.

const SceneTools = preload("tools/scene_tools.gd")
const ResourceTools = preload("tools/resource_tools.gd")
const AnimationTools = preload("tools/animation_tools.gd")
const PlayTools = preload("tools/play_tools.gd")
const ClassTools = preload("tools/class_tools.gd")

var _editor_plugin: EditorPlugin = null

var _scene_tools: SceneTools = null
var _resource_tools: ResourceTools = null
var _animation_tools: AnimationTools = null
var _play_tools: PlayTools = null
var _class_tools: ClassTools = null

var _tool_map: Dictionary = {}
var _initialized: bool = false


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin
	_init_tools()
	_scene_tools.set_editor_plugin(plugin)
	_resource_tools.set_editor_plugin(plugin)
	_animation_tools.set_editor_plugin(plugin)
	_play_tools.set_editor_plugin(plugin)
	_class_tools.set_editor_plugin(plugin)


func _init_tools() -> void:
	if _initialized:
		return
	_initialized = true

	_scene_tools = SceneTools.new()
	_scene_tools.name = "SceneTools"
	add_child(_scene_tools)

	_resource_tools = ResourceTools.new()
	_resource_tools.name = "ResourceTools"
	add_child(_resource_tools)

	_animation_tools = AnimationTools.new()
	_animation_tools.name = "AnimationTools"
	add_child(_animation_tools)

	_play_tools = PlayTools.new()
	_play_tools.name = "PlayTools"
	add_child(_play_tools)

	_class_tools = ClassTools.new()
	_class_tools.name = "ClassTools"
	add_child(_class_tools)

	_tool_map = {
		# Scene tools
		"create_scene": [_scene_tools, "create_scene"],
		"list_scene_nodes": [_scene_tools, "list_scene_nodes"],
		"add_node": [_scene_tools, "add_node"],
		"delete_node": [_scene_tools, "delete_node"],
		"duplicate_node": [_scene_tools, "duplicate_node"],
		"reparent_node": [_scene_tools, "reparent_node"],
		"set_node_properties": [_scene_tools, "set_node_properties"],
		"get_node_properties": [_scene_tools, "get_node_properties"],
		"save_scene": [_scene_tools, "save_scene"],
		"connect_signal": [_scene_tools, "connect_signal"],
		"disconnect_signal": [_scene_tools, "disconnect_signal"],
		"list_connections": [_scene_tools, "list_connections"],
		"rescan_filesystem": [_scene_tools, "rescan_filesystem"],
		"global_classes": [_class_tools, "global_classes"],
		# Resource tools
		"create_resource": [_resource_tools, "create_resource"],
		"modify_resource": [_resource_tools, "modify_resource"],
		"create_shader": [_resource_tools, "create_shader"],
		"create_tileset": [_resource_tools, "create_tileset"],
		"set_tilemap_cells": [_resource_tools, "set_tilemap_cells"],
		"set_theme_color": [_resource_tools, "set_theme_color"],
		"set_theme_font_size": [_resource_tools, "set_theme_font_size"],
		# Animation tools
		"play_scene": [_play_tools, "play_scene"],
		"restart_editor": [_play_tools, "restart_editor"],
		"quit_editor": [_play_tools, "quit_editor"],
		"stop_playing": [_play_tools, "stop_playing"],
		"playing_status": [_play_tools, "playing_status"],
		"create_animation": [_animation_tools, "create_animation"],
		"add_animation_track": [_animation_tools, "add_animation_track"],
		"add_animation_state": [_animation_tools, "add_animation_state"],
		"connect_animation_states": [_animation_tools, "connect_animation_states"],
	}


func execute_tool(tool_name: String, args: Dictionary) -> Dictionary:
	if not _tool_map.has(tool_name):
		return {"ok": false, "error": "Unknown tool: " + tool_name}

	var handler: Array = _tool_map[tool_name]
	var node: Node = handler[0]
	var method: String = handler[1]

	if not node.has_method(method):
		return {"ok": false, "error": "Tool method not found: %s.%s" % [node.name, method]}

	var result: Variant = node.call(method, args)
	if result is Dictionary:
		return result

	return {"ok": false, "error": "Invalid tool result from: " + tool_name}
