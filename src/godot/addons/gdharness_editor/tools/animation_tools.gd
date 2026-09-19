@tool
extends Node

## Animations and animation trees, edited in the open editor.

const PropertyValues = preload("../property_values.gd")
const Read = preload("../reading.gd")

var _editor_plugin: EditorPlugin = null
var _properties: PropertyValues = PropertyValues.new()


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


# =============================================================================
# Shared helpers
# =============================================================================
func _ensure_res_path(path: String) -> String:
	if not path.begins_with("res://"):
		return "res://" + path
	return path


func _refresh_and_reload(scene_path: String) -> void:
	_refresh_filesystem()
	_reload_scene_in_editor(scene_path)


func _refresh_filesystem() -> void:
	if _editor_plugin:
		EditorInterface.get_resource_filesystem().scan()


func _reload_scene_in_editor(scene_path: String) -> void:
	if not _editor_plugin:
		return
	var edited: Node = EditorInterface.get_edited_scene_root()
	if edited and edited.scene_file_path == scene_path:
		EditorInterface.reload_scene_from_path(scene_path)


func _load_scene(scene_path: String) -> Array:
	if not FileAccess.file_exists(scene_path):
		return [null, {"ok": false, "error": "Scene not found: " + scene_path}]
	var packed: PackedScene = load(scene_path)
	if not packed:
		return [null, {"ok": false, "error": "Failed to load: " + scene_path}]
	var root: Node = packed.instantiate()
	if not root:
		return [null, {"ok": false, "error": "Failed to instantiate: " + scene_path}]
	return [root, {}]


func _save_scene(scene_root: Node, scene_path: String) -> Dictionary:
	var packed: PackedScene = PackedScene.new()
	if packed.pack(scene_root) != OK:
		scene_root.queue_free()
		return {"ok": false, "error": "Failed to pack scene"}
	if ResourceSaver.save(packed, scene_path) != OK:
		scene_root.queue_free()
		return {"ok": false, "error": "Failed to save scene"}
	scene_root.queue_free()
	_refresh_and_reload(scene_path)
	return {}


func _find_node(root: Node, path: String) -> Node:
	if path == "." or path.is_empty():
		return root
	return root.get_node_or_null(path)


## A keyframe value or a method argument, read as whatever it says it is.
##
## No type to read it against, unlike a property write: what a track animates is named by a path
## that has still to be resolved against a scene this tool does not hold. So the tags are what
## decide, which is why they have to be all of them. Three were handled here, and a Quaternion,
## a Rect2 or a Transform2D keyframe was stored as the dictionary it arrived as.
func _parse_value(value: Variant) -> Variant:
	return _properties.parse(value)


func _parse_json_maybe(value: Variant) -> Variant:
	if typeof(value) != TYPE_STRING:
		return value
	var text: String = value
	var parsed: Variant = JSON.parse_string(text)
	if parsed == null and text != "null":
		return value
	return parsed


func _parse_method_args(raw_args: Array) -> Array:
	var parsed_args: Array = []
	for raw_arg: Variant in raw_args:
		var parsed: Variant = _parse_json_maybe(raw_arg)
		parsed_args.append(_parse_value(parsed))
	return parsed_args


func _get_default_animation_library(player: AnimationPlayer) -> AnimationLibrary:
	var anim_lib: AnimationLibrary = player.get_animation_library("")
	if anim_lib:
		return anim_lib
	anim_lib = AnimationLibrary.new()
	var add_lib_err: Error = player.add_animation_library("", anim_lib)
	if add_lib_err != OK:
		return null
	return anim_lib


## The state machine at a slash-separated path of nested state machine names, or null when
## any step of the path is not one. Every node in a tree of state machines is a state machine
## itself, so the walk asks each step for the child by name and refuses anything else.
func _get_state_machine(
	anim_tree: AnimationTree, state_machine_path: String = ""
) -> AnimationNodeStateMachine:
	if not anim_tree:
		return null
	if state_machine_path.is_empty() or state_machine_path == "root":
		return anim_tree.tree_root as AnimationNodeStateMachine

	var current: AnimationNodeStateMachine = anim_tree.tree_root as AnimationNodeStateMachine
	for segment: String in state_machine_path.split("/", false):
		if segment.is_empty():
			continue
		if current == null or not current.has_node(StringName(segment)):
			return null
		current = current.get_node(StringName(segment)) as AnimationNodeStateMachine
	return current


# =============================================================================
# create_animation
# =============================================================================
func create_animation(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var loop_mode_name: String = str(args.get("loopMode", "none"))

	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if animation_name.strip_edges().is_empty():
		return {"ok": false, "error": "Missing animationName"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var scene_root: Node = loaded[0]
	var player: AnimationPlayer = _find_node(scene_root, player_node_path) as AnimationPlayer
	if not player:
		scene_root.queue_free()
		return {"ok": false, "error": "AnimationPlayer not found at: " + player_node_path}

	var anim_lib: AnimationLibrary = _get_default_animation_library(player)
	if not anim_lib:
		scene_root.queue_free()
		return {"ok": false, "error": "Failed to create default AnimationLibrary"}
	if anim_lib.has_animation(StringName(animation_name)):
		scene_root.queue_free()
		return {"ok": false, "error": "Animation already exists: " + animation_name}

	var loop_mode: Animation.LoopMode = Animation.LOOP_NONE
	match loop_mode_name:
		"linear":
			loop_mode = Animation.LOOP_LINEAR
		"pingpong":
			loop_mode = Animation.LOOP_PINGPONG
		_:
			loop_mode_name = "none"
			loop_mode = Animation.LOOP_NONE

	var anim: Animation = Animation.new()
	anim.length = Read.as_float(args.get("length", 1.0), 1.0)
	anim.loop_mode = loop_mode
	anim.step = Read.as_float(args.get("step", 0.1), 0.1)

	var add_err: Error = anim_lib.add_animation(StringName(animation_name), anim)
	if add_err != OK:
		scene_root.queue_free()
		return {"ok": false, "error": "Failed to add animation: " + error_string(add_err)}

	var save_err: Dictionary = _save_scene(scene_root, scene_path)
	if not save_err.is_empty():
		return save_err

	return {
		"ok": true,
		"animationName": animation_name,
		"length": anim.length,
		"loopMode": loop_mode_name,
	}


# =============================================================================
# add_animation_track
# =============================================================================
func add_animation_track(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var track: Dictionary = args.get("track", {})

	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if animation_name.strip_edges().is_empty():
		return {"ok": false, "error": "Missing animationName"}
	if track.is_empty():
		return {"ok": false, "error": "Missing track"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var scene_root: Node = loaded[0]
	var player: AnimationPlayer = _find_node(scene_root, player_node_path) as AnimationPlayer
	if not player:
		scene_root.queue_free()
		return {"ok": false, "error": "AnimationPlayer not found at: " + player_node_path}

	var anim_lib: AnimationLibrary = player.get_animation_library("")
	if not anim_lib:
		scene_root.queue_free()
		return {"ok": false, "error": "Default AnimationLibrary not found"}

	var anim: Animation = anim_lib.get_animation(StringName(animation_name))
	if not anim:
		scene_root.queue_free()
		return {"ok": false, "error": "Animation not found: " + animation_name}

	var track_type: String = str(track.get("type", ""))
	var track_idx: int = -1
	var keyframes: Array = track.get("keyframes", [])

	match track_type:
		"property":
			var node_path_str: String = str(track.get("nodePath", ""))
			var prop_name: String = str(track.get("property", ""))
			if prop_name.is_empty():
				scene_root.queue_free()
				return {"ok": false, "error": "track.property is required for property track"}
			track_idx = anim.add_track(Animation.TYPE_VALUE)
			anim.track_set_path(track_idx, NodePath(node_path_str + ":" + prop_name))
			for entry: Variant in keyframes:
				if typeof(entry) != TYPE_DICTIONARY:
					continue
				var keyframe: Dictionary = entry
				var raw_value: Variant = keyframe.get("value")
				var parsed_value: Variant = (
					_parse_json_maybe(raw_value) if typeof(raw_value) == TYPE_STRING else raw_value
				)
				var placed: int = anim.track_insert_key(
					track_idx, Read.as_float(keyframe.get("time", 0.0)), _parse_value(parsed_value)
				)
				if placed < 0:
					push_error("gdharness: could not key " + prop_name + " on " + node_path_str)

		"method":
			var method_node_path: String = str(track.get("nodePath", ""))
			var method_name: String = str(track.get("method", ""))
			if method_name.is_empty():
				scene_root.queue_free()
				return {"ok": false, "error": "track.method is required for method track"}
			track_idx = anim.add_track(Animation.TYPE_METHOD)
			anim.track_set_path(track_idx, NodePath(method_node_path))
			for entry: Variant in keyframes:
				if typeof(entry) != TYPE_DICTIONARY:
					continue
				var keyframe: Dictionary = entry
				var given: Variant = keyframe.get("args", [])
				var arguments: Array = given if given is Array else []
				var invocation: Dictionary = {"method": method_name, "args": _parse_method_args(arguments)}
				var placed: int = anim.track_insert_key(
					track_idx, Read.as_float(keyframe.get("time", 0.0)), invocation
				)
				if placed < 0:
					push_error("gdharness: could not key " + method_name + " on " + method_node_path)

		_:
			scene_root.queue_free()
			return {"ok": false, "error": "Unsupported track.type: " + track_type}

	var save_err: Dictionary = _save_scene(scene_root, scene_path)
	if not save_err.is_empty():
		return save_err

	return {"ok": true, "trackType": track_type, "trackIndex": track_idx}


# =============================================================================
# add_animation_state
# =============================================================================
func add_animation_state(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var anim_tree_path: String = str(args.get("animTreePath", ""))
	var state_name: String = str(args.get("stateName", ""))
	var animation_name: String = str(args.get("animationName", ""))
	var state_machine_path: String = str(args.get("stateMachinePath", ""))

	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if anim_tree_path.is_empty():
		return {"ok": false, "error": "Missing animTreePath"}
	if state_name.is_empty():
		return {"ok": false, "error": "Missing stateName"}
	if animation_name.is_empty():
		return {"ok": false, "error": "Missing animationName"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var scene_root: Node = loaded[0]
	var anim_tree: AnimationTree = _find_node(scene_root, anim_tree_path) as AnimationTree
	if not anim_tree:
		scene_root.queue_free()
		return {"ok": false, "error": "AnimationTree not found at: " + anim_tree_path}

	var sm: AnimationNodeStateMachine = _get_state_machine(anim_tree, state_machine_path)
	if not sm:
		scene_root.queue_free()
		return {"ok": false, "error": "AnimationNodeStateMachine not found"}

	var anim_node: AnimationNodeAnimation = AnimationNodeAnimation.new()
	anim_node.animation = StringName(animation_name)
	sm.add_node(StringName(state_name), anim_node)

	var save_err: Dictionary = _save_scene(scene_root, scene_path)
	if not save_err.is_empty():
		return save_err

	return {"ok": true, "stateName": state_name, "animationName": animation_name}


# =============================================================================
# connect_animation_states
# =============================================================================
func connect_animation_states(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var anim_tree_path: String = str(args.get("animTreePath", ""))
	var from_state: String = str(args.get("fromState", ""))
	var to_state: String = str(args.get("toState", ""))
	var transition_type: String = str(args.get("transitionType", "immediate"))
	var state_machine_path: String = str(args.get("stateMachinePath", ""))
	var advance_condition: String = str(args.get("advanceCondition", ""))

	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if anim_tree_path.is_empty():
		return {"ok": false, "error": "Missing animTreePath"}
	if from_state.is_empty() or to_state.is_empty():
		return {"ok": false, "error": "Missing fromState or toState"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var scene_root: Node = loaded[0]
	var anim_tree: AnimationTree = _find_node(scene_root, anim_tree_path) as AnimationTree
	if not anim_tree:
		scene_root.queue_free()
		return {"ok": false, "error": "AnimationTree not found at: " + anim_tree_path}

	var sm: AnimationNodeStateMachine = _get_state_machine(anim_tree, state_machine_path)
	if not sm:
		scene_root.queue_free()
		return {"ok": false, "error": "AnimationNodeStateMachine not found"}

	var transition: AnimationNodeStateMachineTransition = AnimationNodeStateMachineTransition.new()
	match transition_type:
		"sync":
			transition.switch_mode = AnimationNodeStateMachineTransition.SWITCH_MODE_SYNC
		"at_end":
			transition.switch_mode = AnimationNodeStateMachineTransition.SWITCH_MODE_AT_END
		"immediate":
			transition.switch_mode = AnimationNodeStateMachineTransition.SWITCH_MODE_IMMEDIATE
		_:
			scene_root.queue_free()
			return {"ok": false, "error": "Unsupported transitionType: " + transition_type}

	if not advance_condition.is_empty():
		transition.advance_condition = StringName(advance_condition)

	sm.add_transition(StringName(from_state), StringName(to_state), transition)

	var save_err: Dictionary = _save_scene(scene_root, scene_path)
	if not save_err.is_empty():
		return save_err

	return {"ok": true, "from": from_state, "to": to_state}
