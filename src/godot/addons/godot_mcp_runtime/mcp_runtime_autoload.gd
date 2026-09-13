extends Node

## MCP Runtime Autoload
## This singleton runs in the game and provides runtime inspection capabilities.
## It starts a TCP server that the MCP server can connect to.

signal client_connected
signal client_disconnected
signal command_received(command: String, params: Dictionary)

const DEFAULT_PORT: int = 7777
const DEFAULT_BIND_ADDRESS: String = "127.0.0.1"
const BIND_ADDRESS_SETTING: String = "godot_mcp/runtime/bind_address"
const PROTOCOL_VERSION: String = "1.0"

# What each Godot type becomes on the wire, keyed on typeof() rather than written as a chain of
# `is` tests whose order has to be trusted: Resource had to be tested before Object, or every
# resource came back as a bare class name with its path dropped.
#
# Method names rather than Callables or lambdas: a lambda spanning more than one line inside a
# dictionary literal is where gdformat loses track of every comment in the file and writes them
# all again into the lambda body, on every run.
const SERIALISERS: Dictionary = {
	TYPE_NIL: "_serialize_nil",
	TYPE_VECTOR2: "_serialize_vector2",
	TYPE_VECTOR3: "_serialize_vector3",
	TYPE_VECTOR2I: "_serialize_vector2i",
	TYPE_VECTOR3I: "_serialize_vector3i",
	TYPE_COLOR: "_serialize_color",
	TYPE_NODE_PATH: "_serialize_node_path",
	TYPE_ARRAY: "_serialize_array",
	TYPE_RECT2: "_serialize_rect2",
	TYPE_TRANSFORM2D: "_serialize_transform2d",
	TYPE_DICTIONARY: "_serialize_dictionary",
	TYPE_OBJECT: "_serialize_object",
}

var _server: TCPServer
var _clients: Array[StreamPeerTCP] = []
var _port: int = DEFAULT_PORT
var _enabled: bool = true
var _watched_signals: Dictionary = {}  # { "node_path:signal_name": callable }


func _ready() -> void:
	name = "MCPRuntime"
	# The TCP control loop runs in _process. With the default PROCESS_MODE_INHERIT it stops
	# while the tree is paused, so the runtime silently goes unreachable and the game cannot
	# even be un-paused over the socket. A debug server has to stay responsive while the game
	# is frozen, to inspect, capture, inject or resume it.
	process_mode = Node.PROCESS_MODE_ALWAYS
	_start_server()
	print("[MCP Runtime] Autoload ready, server starting on port %d" % _port)


func _process(_delta: float) -> void:
	if not _enabled or _server == null:
		return

	# Accept new connections
	if _server.is_connection_available():
		var client: StreamPeerTCP = _server.take_connection()
		if client:
			_clients.append(client)
			print("[MCP Runtime] Client connected")
			client_connected.emit()
			_send_welcome(client)

	# Process client messages
	var clients_to_remove: Array[StreamPeerTCP] = []
	for client: StreamPeerTCP in _clients:
		if client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			clients_to_remove.append(client)
			continue

		client.poll()
		if client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			clients_to_remove.append(client)
			continue
		var available: int = client.get_available_bytes()
		if available > 0:
			var data: String = client.get_utf8_string(available)
			_handle_message(client, data)

	# Remove disconnected clients
	for client: StreamPeerTCP in clients_to_remove:
		_clients.erase(client)
		print("[MCP Runtime] Client disconnected")
		client_disconnected.emit()


func _start_server() -> void:
	# The command set includes call_method, set_property and input injection, none of it
	# authenticated, so a release export must not serve it.
	if not OS.is_debug_build():
		_enabled = false
		return

	_server = TCPServer.new()
	# listen() defaults bind_address to "*", which exposes the game to the whole network.
	var bind_address: String = str(ProjectSettings.get_setting(BIND_ADDRESS_SETTING, DEFAULT_BIND_ADDRESS))
	var error: Error = _server.listen(_port, bind_address)
	if error != OK:
		# A warning, not an error. The usual cause is that another instance of this project
		# already owns the port, which happens every time a tool runs a headless operation
		# while the game is open. This instance carries on without a runtime server, which
		# is what it wants anyway, and callers treat any ERROR line on stderr as a failed
		# operation, so reporting a handled condition as one breaks working tools.
		push_warning("[MCP Runtime] Port %d is unavailable (%s), running without a server" % [_port, error])
		_enabled = false
	else:
		print("[MCP Runtime] Server listening on port %d" % _port)


func _send_welcome(client: StreamPeerTCP) -> void:
	var welcome: Dictionary = {
		"type": "welcome",
		"protocol_version": PROTOCOL_VERSION,
		"godot_version": Engine.get_version_info(),
		"project_name": ProjectSettings.get_setting("application/config/name", "Unknown")
	}
	_send_response(client, welcome)


func _handle_message(client: StreamPeerTCP, data: String) -> void:
	var json := JSON.new()
	var error: Error = json.parse(data)
	if error != OK:
		_send_error(client, "Invalid JSON: " + json.get_error_message())
		return

	var message: Variant = json.get_data()
	if not message is Dictionary:
		_send_error(client, "Message must be an object")
		return

	var fields: Dictionary = message
	var command: String = str(fields.get("command", ""))
	var params: Variant = fields.get("params", {})
	if not params is Dictionary:
		_send_error(client, "params must be an object")
		return
	var request_id: Variant = fields.get("id", null)

	command_received.emit(command, params)

	var result: Dictionary = _execute_command(command, params)
	if request_id != null:
		result["id"] = request_id

	_send_response(client, result)


func _execute_command(command: String, params: Dictionary) -> Dictionary:
	var handler: Callable = _command_handlers().get(command, Callable())
	if not handler.is_valid():
		return {"type": "error", "message": "Unknown command: " + command}
	return handler.call(params)


## The command table. A dictionary rather than a match arm per command, so the set of commands
## is one list that can be read, counted and answered with, instead of a branch each.
func _command_handlers() -> Dictionary:
	return {
		"ping": _cmd_ping,
		"get_tree": _cmd_get_tree,
		"get_node": _cmd_get_node,
		"set_property": _cmd_set_property,
		"call_method": _cmd_call_method,
		"get_metrics": _cmd_get_metrics,
		"capture_screenshot": _cmd_capture_screenshot,
		"capture_viewport": _cmd_capture_viewport,
		"inject_action": _cmd_inject_action,
		"inject_key": _cmd_inject_key,
		"inject_mouse_click": _cmd_inject_mouse_click,
		"inject_mouse_motion": _cmd_inject_mouse_motion,
		"watch_signal": _cmd_watch_signal,
		"unwatch_signal": _cmd_unwatch_signal,
	}


func _cmd_ping(_params: Dictionary) -> Dictionary:
	return {"type": "pong", "timestamp": Time.get_unix_time_from_system()}


func _cmd_get_tree(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var max_depth: int = int(params.get("depth", 3))
	var include_properties: bool = bool(params.get("include_properties", false))

	var root: Node = get_tree().root.get_node_or_null(root_path)
	if root == null:
		return {"type": "error", "message": "Node not found: " + root_path}

	return {"type": "tree", "root": _serialize_node_tree(root, 0, max_depth, include_properties)}


func _cmd_get_node(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	return {"type": "node", "data": _serialize_node(node, true)}


func _cmd_set_property(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var value: Variant = params.get("value")

	if node_path.is_empty() or property.is_empty():
		return {"type": "error", "message": "Node path and property required"}

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	var old_value: Variant = node.get(property)
	node.set(property, _as_type(value, typeof(old_value)))

	return {
		"type": "property_set",
		"path": node_path,
		"property": property,
		"old_value": _serialize_value(old_value),
		"new_value": _serialize_value(node.get(property))
	}


func _cmd_call_method(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var method: String = str(params.get("method", ""))
	var args: Array = params.get("args", [])

	if node_path.is_empty() or method.is_empty():
		return {"type": "error", "message": "Node path and method required"}

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	if not node.has_method(method):
		return {"type": "error", "message": "Method not found: " + method}

	var deserialized_args: Array = []
	for index: int in args.size():
		deserialized_args.append(_as_type(args[index], _parameter_type(node, method, index)))

	var result: Variant = node.callv(method, deserialized_args)

	return {"type": "method_result", "path": node_path, "method": method, "result": _serialize_value(result)}


func _cmd_get_metrics(params: Dictionary) -> Dictionary:
	var metrics: Array = params.get("metrics", [])
	var result: Dictionary = {"type": "metrics", "data": {}}

	# Always include basic metrics
	result["data"]["fps"] = Engine.get_frames_per_second()
	result["data"]["frame_time"] = Performance.get_monitor(Performance.TIME_PROCESS)
	result["data"]["physics_time"] = Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS)

	# Memory metrics
	result["data"]["memory_static"] = Performance.get_monitor(Performance.MEMORY_STATIC)
	result["data"]["memory_static_max"] = Performance.get_monitor(Performance.MEMORY_STATIC_MAX)

	# Object counts
	result["data"]["object_count"] = Performance.get_monitor(Performance.OBJECT_COUNT)
	result["data"]["object_resource_count"] = Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT)
	result["data"]["object_node_count"] = Performance.get_monitor(Performance.OBJECT_NODE_COUNT)
	result["data"]["object_orphan_node_count"] = Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT)

	# Render metrics
	result["data"]["render_total_objects"] = Performance.get_monitor(
		Performance.RENDER_TOTAL_OBJECTS_IN_FRAME
	)
	result["data"]["render_total_primitives"] = Performance.get_monitor(
		Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME
	)
	result["data"]["render_total_draw_calls"] = Performance.get_monitor(
		Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME
	)

	# A caller that names metrics gets those and no others, and hears about a name that is
	# not one rather than getting everything back as if the list had not been sent.
	if not metrics.is_empty():
		var all: Dictionary = result["data"]
		var unknown: Array = []
		var selected: Dictionary = {}
		for metric: Variant in metrics:
			if all.has(metric):
				selected[metric] = all[metric]
			else:
				unknown.append(metric)
		if not unknown.is_empty():
			return {
				"type": "error",
				"message": "Unknown metrics: %s. Available: %s" % [", ".join(unknown), ", ".join(all.keys())]
			}
		result["data"] = selected

	return result


func _cmd_capture_screenshot(params: Dictionary) -> Dictionary:
	var viewport: Viewport = get_viewport()
	if viewport == null:
		return {"type": "error", "message": "No viewport available"}
	return _capture_viewport_image(viewport, params)


func _cmd_capture_viewport(params: Dictionary) -> Dictionary:
	var viewport_path: String = String(params.get("viewportPath", params.get("viewport_path", "")))
	if viewport_path.is_empty():
		return _cmd_capture_screenshot(params)

	var node: Node = get_tree().root.get_node_or_null(viewport_path)
	if node == null:
		return {"type": "error", "message": "Viewport not found: " + viewport_path}
	if not node is Viewport:
		return {"type": "error", "message": "Node is not a Viewport: " + viewport_path}
	return _capture_viewport_image(node as Viewport, params)


func _capture_viewport_image(viewport: Viewport, params: Dictionary) -> Dictionary:
	var viewport_texture: ViewportTexture = viewport.get_texture()
	if viewport_texture == null:
		return {"type": "error", "message": "No viewport texture available"}

	var image: Image = viewport_texture.get_image()
	if image == null:
		return {"type": "error", "message": "Failed to capture viewport image"}

	var width: int = int(params.get("width", 0))
	var height: int = int(params.get("height", 0))
	if width > 0 and height > 0:
		image.resize(width, height)

	var requested_path: String = String(params.get("output_path", params.get("outputPath", "")))
	if requested_path.is_empty():
		var png_bytes: PackedByteArray = image.save_png_to_buffer()
		if png_bytes.is_empty():
			return {"type": "error", "message": "Failed to encode screenshot as PNG"}

		return {
			"type": "screenshot",
			"format": "png",
			"encoding": "base64",
			"width": image.get_width(),
			"height": image.get_height(),
			"data": Marshalls.raw_to_base64(png_bytes)
		}

	var screenshot_path: String = requested_path
	if screenshot_path.begins_with("user://") or screenshot_path.begins_with("res://"):
		screenshot_path = ProjectSettings.globalize_path(screenshot_path)
	var save_error: Error = image.save_png(screenshot_path)
	if save_error != OK:
		return {"type": "error", "message": "Failed to save screenshot as PNG: " + str(save_error)}

	return {
		"type": "screenshot_file",
		"format": "png",
		"encoding": "file",
		"width": image.get_width(),
		"height": image.get_height(),
		"path": screenshot_path
	}


func _cmd_inject_action(params: Dictionary) -> Dictionary:
	var action: String = String(params.get("action", ""))
	var pressed: bool = bool(params.get("pressed", true))
	var strength: float = float(params.get("strength", 1.0))

	if action.is_empty():
		return {"type": "error", "message": "Action name required"}

	if not InputMap.has_action(action):
		return {"type": "error", "message": "Action not found: " + action}

	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	event.strength = strength
	Input.parse_input_event(event)

	return {"type": "input_injected", "input_type": "action", "action": action, "pressed": pressed}


func _cmd_inject_key(params: Dictionary) -> Dictionary:
	var keycode_raw: Variant = params.get("keycode", 0)
	var pressed: bool = bool(params.get("pressed", true))
	var key_label: String = String(params.get("key_label", ""))

	if keycode_raw is String:
		var named: String = keycode_raw
		if not named.is_empty() and key_label.is_empty():
			key_label = named
	var keycode: int = 0 if keycode_raw is String else int(keycode_raw)

	var event := InputEventKey.new()
	event.pressed = pressed

	if not key_label.is_empty():
		event.keycode = OS.find_keycode_from_string(key_label)
		if event.keycode == KEY_NONE:
			return {"type": "error", "message": "Invalid key_label: " + key_label}
	elif keycode > 0:
		event.keycode = keycode as Key
	else:
		return {"type": "error", "message": "keycode or key_label required"}

	# A key event from a real keyboard carries all three, and InputMap consults whichever one
	# the bound event declares: keycode first, then physical_keycode, then key_label. An
	# injected event with only keycode set can therefore never match an action bound by
	# physical key, which is how a rebinding UI normally stores one, so inject_key silently
	# did nothing for those actions.
	event.physical_keycode = event.keycode
	event.key_label = event.keycode

	event.shift_pressed = bool(params.get("shift", false))
	event.ctrl_pressed = bool(params.get("ctrl", false))
	event.alt_pressed = bool(params.get("alt", false))

	Input.parse_input_event(event)

	return {
		"type": "input_injected",
		"input_type": "key",
		"keycode": event.keycode,
		"physical_keycode": event.physical_keycode,
		"shift": event.shift_pressed,
		"ctrl": event.ctrl_pressed,
		"alt": event.alt_pressed,
		"pressed": pressed
	}


## A point the tool schema sends as two flat numbers, or the older form of one [x, y] value.
## Answers a Vector2, or the String that says what was wrong with it.
func _read_point(params: Dictionary, x_key: String, y_key: String, pair_key: String) -> Variant:
	if params.has(x_key) and params.has(y_key):
		return Vector2(float(params[x_key]), float(params[y_key]))
	var raw: Variant = params.get(pair_key, Vector2.ZERO)
	if raw is Vector2:
		return raw
	if raw is Array:
		var pair: Array = raw
		if pair.size() < 2:
			return "%s array must contain [x, y]" % pair_key
		return Vector2(float(pair[0]), float(pair[1]))
	return "%s must be Vector2 or [x, y]" % pair_key


func _cmd_inject_mouse_click(params: Dictionary) -> Dictionary:
	var point: Variant = _read_point(params, "x", "y", "position")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	var pressed: bool = bool(params.get("pressed", true))

	var event := InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button as MouseButton
	event.pressed = pressed
	Input.parse_input_event(event)

	return {
		"type": "input_injected",
		"input_type": "mouse_click",
		"position": [position.x, position.y],
		"button": button,
		"pressed": pressed
	}


func _cmd_inject_mouse_motion(params: Dictionary) -> Dictionary:
	var point: Variant = _read_point(params, "x", "y", "position")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var movement: Variant = _read_point(params, "relativeX", "relativeY", "relative")
	if movement is String:
		return {"type": "error", "message": movement}
	var relative: Vector2 = movement

	var event := InputEventMouseMotion.new()
	event.position = position
	event.global_position = position
	event.relative = relative
	Input.parse_input_event(event)

	return {
		"type": "input_injected",
		"input_type": "mouse_motion",
		"position": [position.x, position.y],
		"relative": [relative.x, relative.y]
	}


func _cmd_watch_signal(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var signal_name: String = str(params.get("signal", ""))

	if node_path.is_empty() or signal_name.is_empty():
		return {"type": "error", "message": "Node path and signal name required"}

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	if not node.has_signal(signal_name):
		return {"type": "error", "message": "Signal not found: " + signal_name}

	var key: String = node_path + ":" + signal_name
	if _watched_signals.has(key):
		return {"type": "error", "message": "Signal already being watched"}

	var callable: Callable = func(args: Array = []) -> void:
		_broadcast_signal_event(node_path, signal_name, args)

	node.connect(signal_name, callable)
	_watched_signals[key] = callable

	return {"type": "signal_watched", "path": node_path, "signal": signal_name}


func _cmd_unwatch_signal(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var signal_name: String = str(params.get("signal", ""))

	var key: String = node_path + ":" + signal_name
	if not _watched_signals.has(key):
		return {"type": "error", "message": "Signal not being watched"}

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node != null:
		node.disconnect(signal_name, _watched_signals[key])

	_watched_signals.erase(key)

	return {"type": "signal_unwatched", "path": node_path, "signal": signal_name}


func _broadcast_signal_event(node_path: String, signal_name: String, args: Array) -> void:
	var event: Dictionary = {"type": "signal_event", "path": node_path, "signal": signal_name, "args": []}
	for arg: Variant in args:
		event["args"].append(_serialize_value(arg))

	for client: StreamPeerTCP in _clients:
		if client.get_status() == StreamPeerTCP.STATUS_CONNECTED:
			_send_response(client, event)


func _serialize_node_tree(node: Node, depth: int, max_depth: int, include_properties: bool) -> Dictionary:
	var result: Dictionary = _serialize_node(node, include_properties)

	if depth < max_depth:
		var children: Array = []
		for child: Node in node.get_children():
			children.append(_serialize_node_tree(child, depth + 1, max_depth, include_properties))
		result["children"] = children

	return result


func _serialize_node(node: Node, include_properties: bool) -> Dictionary:
	var result: Dictionary = {"name": node.name, "type": node.get_class(), "path": str(node.get_path())}

	var script: Variant = node.get_script()
	if script is Script:
		result["script"] = (script as Script).resource_path

	if include_properties:
		result["properties"] = {}
		for prop: Dictionary in node.get_property_list():
			if prop["usage"] & PROPERTY_USAGE_STORAGE:
				var property_name: String = prop["name"]
				if not property_name.begins_with("_"):
					result["properties"][property_name] = _serialize_value(node.get(property_name))

	return result


## Converts a Godot value into something JSON can carry. A type with no entry in the table
## passes through as itself, which is what the JSON-native ones want.
func _serialize_value(value: Variant) -> Variant:
	var serialiser: String = SERIALISERS.get(typeof(value), "")
	return call(serialiser, value) if not serialiser.is_empty() else value


func _serialize_nil(_value: Variant) -> Variant:
	return null


func _serialize_vector2(value: Vector2) -> Dictionary:
	return {"_type": "Vector2", "x": value.x, "y": value.y}


func _serialize_vector3(value: Vector3) -> Dictionary:
	return {"_type": "Vector3", "x": value.x, "y": value.y, "z": value.z}


func _serialize_vector2i(value: Vector2i) -> Dictionary:
	return {"_type": "Vector2i", "x": value.x, "y": value.y}


func _serialize_vector3i(value: Vector3i) -> Dictionary:
	return {"_type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}


func _serialize_color(value: Color) -> Dictionary:
	return {"_type": "Color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}


func _serialize_node_path(value: NodePath) -> Dictionary:
	return {"_type": "NodePath", "path": str(value)}


func _serialize_array(value: Array) -> Array:
	return value.map(_serialize_value)


func _serialize_rect2(value: Rect2) -> Dictionary:
	return {
		"_type": "Rect2", "position": _serialize_value(value.position), "size": _serialize_value(value.size)
	}


func _serialize_transform2d(value: Transform2D) -> Dictionary:
	return {
		"_type": "Transform2D",
		"origin": _serialize_value(value.origin),
		"x": _serialize_value(value.x),
		"y": _serialize_value(value.y)
	}


func _serialize_dictionary(value: Dictionary) -> Dictionary:
	var serialised: Dictionary = {}
	for key: Variant in value:
		serialised[str(key)] = _serialize_value(value[key])
	return serialised


## The one case that genuinely needs the class hierarchy, since a Resource is also an Object and
## its path is the half worth having.
func _serialize_object(value: Object) -> Dictionary:
	if value is Resource:
		var resource: Resource = value
		return {"_type": "Resource", "path": resource.resource_path, "class": resource.get_class()}
	return {"_type": "Object", "class": value.get_class()}


func _deserialize_value(value: Variant) -> Variant:
	if value == null:
		return null
	if value is Array:
		var arr: Array = []
		for item: Variant in value:
			arr.append(_deserialize_value(item))
		return arr
	if not value is Dictionary:
		return value

	var fields: Dictionary = value
	if not fields.has("_type"):
		var dict: Dictionary = {}
		for key: Variant in fields:
			dict[key] = _deserialize_value(fields[key])
		return dict

	match fields["_type"]:
		"Vector2":
			return Vector2(fields.get("x", 0), fields.get("y", 0))
		"Vector3":
			return Vector3(fields.get("x", 0), fields.get("y", 0), fields.get("z", 0))
		"Vector2i":
			return Vector2i(fields.get("x", 0), fields.get("y", 0))
		"Vector3i":
			return Vector3i(fields.get("x", 0), fields.get("y", 0), fields.get("z", 0))
		"Color":
			return Color(fields.get("r", 0), fields.get("g", 0), fields.get("b", 0), fields.get("a", 1))
		"NodePath":
			return NodePath(fields.get("path", ""))
	return value


func _parameter_type(node: Object, method: String, index: int) -> int:
	for entry: Dictionary in node.get_method_list():
		if entry.get("name", "") != method:
			continue
		var params: Array = entry.get("args", [])
		if index < 0 or index >= params.size():
			return TYPE_NIL
		return int(params[index].get("type", TYPE_NIL))
	return TYPE_NIL


func _as_type(value: Variant, type: int) -> Variant:
	var fitted: Variant = _deserialize_value(value)
	if type == TYPE_NIL or typeof(fitted) == type:
		return fitted

	var simple: Array[int] = [TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING]
	if not simple.has(type) or not simple.has(typeof(fitted)):
		return fitted

	if fitted is String and type != TYPE_STRING:
		var parsed: Variant = JSON.parse_string(fitted)
		if typeof(parsed) != TYPE_NIL and typeof(parsed) != TYPE_STRING:
			fitted = parsed

	return type_convert(fitted, type)


func _resolve_mouse_button(raw: Variant) -> int:
	if raw is String:
		match (raw as String).to_lower():
			"left":
				return MOUSE_BUTTON_LEFT
			"right":
				return MOUSE_BUTTON_RIGHT
			"middle":
				return MOUSE_BUTTON_MIDDLE
			"wheel_up", "wheelup":
				return MOUSE_BUTTON_WHEEL_UP
			"wheel_down", "wheeldown":
				return MOUSE_BUTTON_WHEEL_DOWN
			_:
				return MOUSE_BUTTON_LEFT
	return int(raw)


func _send_response(client: StreamPeerTCP, data: Dictionary) -> void:
	var json_str: String = JSON.stringify(data) + "\n"
	client.put_utf8_string(json_str)


func _send_error(client: StreamPeerTCP, message: String) -> void:
	_send_response(client, {"type": "error", "message": message})


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_cleanup()


func _cleanup() -> void:
	for client: StreamPeerTCP in _clients:
		client.disconnect_from_host()
	_clients.clear()

	if _server:
		_server.stop()
		_server = null

	print("[MCP Runtime] Cleanup complete")
