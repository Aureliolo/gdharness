@tool
extends Node
## Routes each command the server sends to the tool module that answers it. The modules are
## preloaded rather than looked up on disk at runtime, so a missing one fails to parse here
## instead of leaving a command silently unanswered.

const GdhSceneFile = preload("scene_file.gd")
const GdhSceneTools = preload("tools/scene_tools.gd")
const GdhSignalTools = preload("tools/signal_tools.gd")
const GdhResourceTools = preload("tools/resource_tools.gd")
const GdhTilesetTools = preload("tools/tileset_tools.gd")
const GdhAnimationStates = preload("tools/animation_states.gd")
const GdhAnimationTools = preload("tools/animation_tools.gd")
const GdhAnimationTracks = preload("tools/animation_tracks.gd")
const GdhPlayTools = preload("tools/play_tools.gd")
const GdhClassTools = preload("tools/class_tools.gd")
const GdhSettingsTools = preload("tools/settings_tools.gd")
const GdhFilesystemTools = preload("tools/filesystem_tools.gd")
const GdhProfileTools = preload("tools/profile_tools.gd")
const GdhViewTools = preload("tools/view_tools.gd")

var _editor_plugin: EditorPlugin = null
var _scene_tools: GdhSceneTools = null
var _signal_tools: GdhSignalTools = null
var _resource_tools: GdhResourceTools = null
var _tileset_tools: GdhTilesetTools = null
var _animation_states: GdhAnimationStates = null
var _animation_tools: GdhAnimationTools = null
var _animation_tracks: GdhAnimationTracks = null
var _play_tools: GdhPlayTools = null
var _class_tools: GdhClassTools = null
var _settings_tools: GdhSettingsTools = null
var _filesystem_tools: GdhFilesystemTools = null
var _profile_tools: GdhProfileTools = null
var _view_tools: GdhViewTools = null
var _tool_map: Dictionary = {}
var _initialized: bool = false


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin
	_init_tools()
	_scene_tools.set_editor_plugin(plugin)
	_resource_tools.set_editor_plugin(plugin)
	_tileset_tools.set_editor_plugin(plugin)
	_animation_tools.set_editor_plugin(plugin)
	_animation_states.set_editor_plugin(plugin)
	_animation_tracks.set_editor_plugin(plugin)
	_play_tools.set_editor_plugin(plugin)
	_class_tools.set_editor_plugin(plugin)
	_filesystem_tools.set_editor_plugin(plugin)
	_profile_tools.set_editor_plugin(plugin)
	_view_tools.set_editor_plugin(plugin)


func _init_tools() -> void:
	if _initialized:
		return
	_initialized = true

	_scene_tools = GdhSceneTools.new()
	_scene_tools.name = "SceneTools"
	add_child(_scene_tools)

	_signal_tools = GdhSignalTools.new()
	_signal_tools.name = "SignalTools"
	add_child(_signal_tools)

	_resource_tools = GdhResourceTools.new()
	_resource_tools.name = "ResourceTools"
	add_child(_resource_tools)

	_tileset_tools = GdhTilesetTools.new()
	_tileset_tools.name = "TilesetTools"
	add_child(_tileset_tools)

	_animation_tools = GdhAnimationTools.new()
	_animation_tools.name = "AnimationTools"
	add_child(_animation_tools)

	_animation_states = GdhAnimationStates.new()
	_animation_states.name = "AnimationStates"
	add_child(_animation_states)

	_animation_tracks = GdhAnimationTracks.new()
	_animation_tracks.name = "AnimationTracks"
	add_child(_animation_tracks)

	_play_tools = GdhPlayTools.new()
	_play_tools.name = "PlayTools"
	add_child(_play_tools)

	_class_tools = GdhClassTools.new()
	_class_tools.name = "ClassTools"
	add_child(_class_tools)

	_settings_tools = GdhSettingsTools.new()
	_settings_tools.name = "SettingsTools"
	add_child(_settings_tools)

	_filesystem_tools = GdhFilesystemTools.new()
	_filesystem_tools.name = "FilesystemTools"
	add_child(_filesystem_tools)

	_profile_tools = GdhProfileTools.new()
	_profile_tools.name = "ProfileTools"
	add_child(_profile_tools)

	_view_tools = GdhViewTools.new()
	_view_tools.name = "ViewTools"
	add_child(_view_tools)

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
		"bake_navigation": [_scene_tools, "bake_navigation"],
		"save_scene": [_scene_tools, "save_scene"],
		"connect_signal": [_signal_tools, "connect_signal"],
		"disconnect_signal": [_signal_tools, "disconnect_signal"],
		"list_connections": [_signal_tools, "list_connections"],
		"rescan_filesystem": [_filesystem_tools, "rescan_filesystem"],
		"scan_status": [_filesystem_tools, "scan_status"],
		"reimport_files": [_filesystem_tools, "reimport_files"],
		"files_moved": [_filesystem_tools, "files_moved"],
		"global_classes": [_class_tools, "global_classes"],
		"reload_script": [_class_tools, "reload_script"],
		"scripts_behind": [_class_tools, "scripts_behind"],
		# Settings, for a caller that asked the editor rather than the file on disk
		"get_project_setting": [_settings_tools, "get_project_setting"],
		"adopt_project_settings": [_settings_tools, "adopt_project_settings"],
		"adopt_audio_bus_layout": [_settings_tools, "adopt_audio_bus_layout"],
		# Resource tools
		"create_resource": [_resource_tools, "create_resource"],
		"modify_resource": [_resource_tools, "modify_resource"],
		"read_resource": [_resource_tools, "read_resource"],
		"create_shader": [_resource_tools, "create_shader"],
		"create_tileset": [_tileset_tools, "create_tileset"],
		"set_tilemap_cells": [_tileset_tools, "set_tilemap_cells"],
		"set_theme_color": [_resource_tools, "set_theme_color"],
		"set_theme_font_size": [_resource_tools, "set_theme_font_size"],
		"remove_theme_item": [_resource_tools, "remove_theme_item"],
		"play_scene": [_play_tools, "play_scene"],
		"restart_editor": [_play_tools, "restart_editor"],
		"quit_editor": [_play_tools, "quit_editor"],
		"editor_servers": [_play_tools, "editor_servers"],
		"stop_playing": [_play_tools, "stop_playing"],
		"playing_status": [_play_tools, "playing_status"],
		# The script profiler on a game the editor plays
		"profile_start": [_profile_tools, "profile_start"],
		"profile_read": [_profile_tools, "profile_read"],
		"capture_editor_view": [_view_tools, "capture_editor_view"],
		# Animation tools
		"read_animations": [_animation_tools, "read_animations"],
		"read_animation_states": [_animation_tools, "read_animation_states"],
		"create_animation": [_animation_tools, "create_animation"],
		"add_animation_track": [_animation_tracks, "add_animation_track"],
		"remove_animation_track": [_animation_tracks, "remove_animation_track"],
		"set_animation": [_animation_tools, "set_animation"],
		"rename_animation": [_animation_tools, "rename_animation"],
		"remove_animation": [_animation_tools, "remove_animation"],
		"add_animation_state": [_animation_states, "add_animation_state"],
		"connect_animation_states": [_animation_states, "connect_animation_states"],
		"remove_animation_state": [_animation_states, "remove_animation_state"],
		"disconnect_animation_states": [_animation_states, "disconnect_animation_states"],
	}


## Whether a capture is waiting for the editor to draw, which another call must not move it from.
func capturing() -> bool:
	return _view_tools != null and _view_tools.capturing


func execute_tool(tool_name: String, args: Dictionary) -> Dictionary:
	if not _tool_map.has(tool_name):
		return { "ok": false, "error": "Unknown tool: " + tool_name }

	var handler: Array = _tool_map[tool_name]
	var node: Node = handler[0]
	var method: String = handler[1]

	if not node.has_method(method):
		return { "ok": false, "error": "Tool method not found: %s.%s" % [node.name, method] }

	GdhSceneFile.also_saved.clear()
	GdhSceneFile.unmade_note = ""
	# Awaited for the tools that wait for the editor to draw. The rest answer at once.
	var result: Variant = await node.call(method, args)
	if result is Dictionary:
		var answered: Dictionary = result
		if not GdhSceneFile.also_saved.is_empty():
			answered["alsoSaved"] = GdhSceneFile.also_saved.duplicate(true)
			GdhSceneFile.also_saved.clear()
		if not GdhSceneFile.unmade_note.is_empty():
			answered["unmadeConnections"] = GdhSceneFile.unmade_note
			GdhSceneFile.unmade_note = ""
		return answered

	return { "ok": false, "error": "Invalid tool result from: " + tool_name }
