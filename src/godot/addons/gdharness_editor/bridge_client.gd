@tool
extends Node

## The editor's end of the bridge: one WebSocket to the gdharness server, reconnected on its
## own when it drops, carrying tool requests in and their results out.

signal connected
signal disconnected
signal tool_requested(request_id: String, tool_name: String, args: Dictionary)

const DEFAULT_URL: String = "ws://127.0.0.1:6505/godot"
## Written beside the addon by the install, so it names the version this copy came from.
const VERSION_MARKER: String = "res://addons/gdharness_editor/.gdharness-version"
const RECONNECT_DELAY: float = 3.0
const MAX_RECONNECT_DELAY: float = 30.0

var socket: WebSocketPeer = WebSocketPeer.new()
var server_url: String = DEFAULT_URL
var _is_connected: bool = false
var _reconnect_timer: Timer
var _current_reconnect_delay: float = RECONNECT_DELAY
## Nothing reconnects until somebody has asked to connect once.
var _should_reconnect: bool = false
var _project_path: String
var _initialized: bool = false


func _ready() -> void:
	_project_path = ProjectSettings.globalize_path("res://")

	_reconnect_timer = Timer.new()
	_reconnect_timer.one_shot = true
	_reconnect_timer.timeout.connect(_on_reconnect_timer)
	add_child(_reconnect_timer)

	set_process(true)
	_initialized = true


func _process(_delta: float) -> void:
	if not _initialized:
		return

	if socket.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		if _is_connected:
			_handle_disconnect()
		elif _should_reconnect and _reconnect_timer.is_stopped():
			# A connection refused never opened, so it reaches CLOSED without passing through
			# _handle_disconnect and nothing would ask again. An editor opened before the server
			# is the ordinary way that happens, and it then sat there for the rest of the day.
			_schedule_reconnect()
		return

	socket.poll()

	match socket.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if not _is_connected:
				_handle_connect()

			while socket.get_available_packet_count() > 0:
				var packet: PackedByteArray = socket.get_packet()
				_handle_message(packet.get_string_from_utf8())

		WebSocketPeer.STATE_CLOSING:
			pass

		WebSocketPeer.STATE_CLOSED:
			if _is_connected:
				_handle_disconnect()


func connect_to_server(url: String = "") -> void:
	server_url = _resolve_server_url(url)
	_should_reconnect = true
	_current_reconnect_delay = RECONNECT_DELAY
	_attempt_connection()


func _resolve_server_url(explicit_url: String) -> String:
	if explicit_url != "":
		return explicit_url

	# The same variable the server reads, so the two agree on the port by construction.
	var raw: String = OS.get_environment("GDHARNESS_BRIDGE_PORT")
	if raw != "":
		if raw.is_valid_int() and int(raw) >= 1 and int(raw) <= 65535:
			return "ws://127.0.0.1:%d/godot" % int(raw)
		push_error("GDHARNESS_BRIDGE_PORT is %s, not a port; using %s" % [raw, DEFAULT_URL])

	return DEFAULT_URL


func disconnect_from_server() -> void:
	_should_reconnect = false
	if _reconnect_timer:
		_reconnect_timer.stop()
	if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		socket.close()
	_is_connected = false


func _attempt_connection() -> void:
	if socket.get_ready_state() != WebSocketPeer.STATE_CLOSED:
		socket.close()

	var err: Error = socket.connect_to_url(server_url)
	if err != OK:
		push_error("[gdharness] Failed to connect to %s: %s" % [server_url, error_string(err)])
		_schedule_reconnect()


func _handle_connect() -> void:
	_is_connected = true
	_current_reconnect_delay = RECONNECT_DELAY

	# The version reported is the one this editor loaded at startup, not the one on disk: an
	# upgrade replaces the files under a running editor, which goes on serving the old code until
	# somebody restarts it, and nothing else can tell the two apart.
	# The process id with it, because a restarted editor is a different process from the one
	# whoever started it is holding, and nothing else says which one is now on the other end.
	_send_message(
		{
			"type": "godot_ready",
			"project_path": _project_path,
			"addon_version": _loaded_version(),
			"editor_pid": OS.get_process_id()
		}
	)

	connected.emit()


## The version marker beside this addon, or "" when the copy was not installed by gdharness.
func _loaded_version() -> String:
	if not FileAccess.file_exists(VERSION_MARKER):
		return ""
	var file: FileAccess = FileAccess.open(VERSION_MARKER, FileAccess.READ)
	if file == null:
		return ""
	var text: String = file.get_as_text().strip_edges()
	file.close()
	return text


func _handle_disconnect() -> void:
	_is_connected = false
	disconnected.emit()

	if _should_reconnect:
		_schedule_reconnect()


func _schedule_reconnect() -> void:
	if _reconnect_timer == null:
		return
	_reconnect_timer.start(_current_reconnect_delay)
	_current_reconnect_delay = min(_current_reconnect_delay * 2.0, MAX_RECONNECT_DELAY)


func _on_reconnect_timer() -> void:
	_attempt_connection()


func _handle_message(json_string: String) -> void:
	var parsed: Variant = JSON.parse_string(json_string)
	if not parsed is Dictionary:
		push_error("[gdharness] The server sent something that is not a message: %s" % json_string)
		return
	var message: Dictionary = parsed

	match message.get("type", ""):
		"ping":
			_send_message({"type": "pong"})

		"tool_invoke":
			var request_id: String = message.get("id", "")
			var tool_name: String = message.get("tool", "")
			var args: Dictionary = message.get("args", {})
			tool_requested.emit(request_id, tool_name, args)

		_:
			pass


func send_tool_result(request_id: String, success: bool, result: Variant = null, error: String = "") -> void:
	var response: Dictionary = {"type": "tool_result", "id": request_id, "success": success}

	if success:
		response["result"] = result
	else:
		response["error"] = error

	_send_message(response)


func _send_message(message: Dictionary) -> void:
	if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		socket.send_text(JSON.stringify(message))


func is_connected_to_server() -> bool:
	return _is_connected
