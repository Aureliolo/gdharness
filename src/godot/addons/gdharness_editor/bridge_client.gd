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
## Written by the server that serves this project, saying where its bridge actually is. Kept in
## step with `announcementPath` in src/bridge-announce.ts.
const ANNOUNCEMENT: String = "res://.godot/gdharness-bridge.json"
const ANNOUNCE_PROTOCOL: int = 1
const RECONNECT_DELAY: float = 3.0
const MAX_RECONNECT_DELAY: float = 30.0

## What a server closes with when the editor that said hello belongs to another project. Kept in
## step with `OTHER_PROJECT_CLOSE_CODE` in src/godot-bridge.ts.
const ELSEWHERE_CLOSE_CODE: int = 4001

## Where Godot keeps the three ports an editor serves. None of them is per editor: the settings
## file is one for every editor on the machine, so two open at once want the same three and the
## second one binds nothing.
const LSP_SETTING: String = "network/language_server/remote_port"
const DAP_SETTING: String = "network/debug_adapter/remote_port"
const DEBUGGER_SETTING: String = "network/debug/remote_port"
## What a server that opened this editor put in the environment, matching the ports it named on
## the command line. Kept in step with `editorArguments` in src/launch.ts.
const LSP_ASKED: String = "GDHARNESS_LSP_PORT"
const DAP_ASKED: String = "GDHARNESS_DAP_PORT"

## How long one attempt is given before the address is called a bad one.
##
## A socket pointed at a port nothing holds gives up by itself, in thirty seconds on Windows. One
## pointed at something that accepts and then never speaks WebSocket does not give up at all:
## measured here, still connecting after forty-five seconds, because the peer has no handshake
## timeout of its own in 4.7. A leftover announcement can be either, and a port that has been
## reused by some other program is the second.
const CONNECT_TIMEOUT: float = 10.0

## How often the announcement is read again while connected, so a newer server is moved to
## rather than waited for. A harness reconnect leaves the server it replaced running and holding
## the old port, and an editor with no reason to look elsewhere stayed on it for the session.
const FOLLOW_INTERVAL: float = 5.0

var socket: WebSocketPeer = WebSocketPeer.new()
var server_url: String = DEFAULT_URL

## What this copy was when it loaded, which is what the editor is running until it is restarted.
## See [method _loaded_version] for why it is held rather than read when it is wanted.
var version_at_load: String = ""

var _is_connected: bool = false
var _reconnect_timer: Timer
var _current_reconnect_delay: float = RECONNECT_DELAY
## Nothing reconnects until somebody has asked to connect once.
var _should_reconnect: bool = false
var _project_path: String
var _initialized: bool = false

## Whether the address came from a caller rather than from the project, in which case it is not
## this node's to change.
var _named_by_caller: bool = false
var _since_looked: float = 0.0

## The announced address that did not answer, so the fallback gets a turn. Cleared the moment
## anything connects or the project names a different one.
var _refused_url: String = ""
var _tried_announced: bool = false

## The address this editor has already been told is another project's, so a reconnect loop says it
## once rather than every few seconds for the rest of the session.
var _told_about_url: String = ""
var _connecting_for: float = 0.0


func _ready() -> void:
	_project_path = ProjectSettings.globalize_path("res://")
	version_at_load = _loaded_version()
	_keep_the_ports_this_editor_was_given()

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
			if _tried_announced:
				_refused_url = server_url
			_schedule_reconnect()
		return

	socket.poll()

	match socket.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if not _is_connected:
				_handle_connect()
			_follow_whoever_is_newest(_delta)

			while socket.get_available_packet_count() > 0:
				var packet: PackedByteArray = socket.get_packet()
				_handle_message(packet.get_string_from_utf8())

		WebSocketPeer.STATE_CONNECTING:
			_connecting_for += _delta
			if _connecting_for >= CONNECT_TIMEOUT:
				_give_up_on_this_address()

		WebSocketPeer.STATE_CLOSING:
			pass

		WebSocketPeer.STATE_CLOSED:
			if _is_connected:
				_handle_disconnect()


## Moves to the server the project now names, when that is not the one this is talking to.
##
## A harness reconnect leaves the server it replaced running, still holding the port it bound and
## still answering: the editor has no reason to notice, and stayed on a server nothing was
## speaking to for the rest of the session. The replacement announces where it landed, so the
## editor can go to it rather than anybody ending a process.
##
## Only while connected by a URL this worked out for itself. A caller that named one is holding
## this to that address, which is what every fixture does.
func _follow_whoever_is_newest(delta: float) -> void:
	if _named_by_caller:
		return
	_since_looked += delta
	if _since_looked < FOLLOW_INTERVAL:
		return
	_since_looked = 0.0

	var announced: String = announced_url()
	if announced == "" or announced == server_url or announced == _refused_url:
		return
	server_url = announced
	# Put down before it is picked up again, because the arrival is what tells a server who this
	# editor is: left standing, the open socket on the new address would never be greeted and the
	# server would report no editor while holding one.
	_is_connected = false
	disconnected.emit()
	_current_reconnect_delay = RECONNECT_DELAY
	_attempt_connection()


func connect_to_server(url: String = "") -> void:
	_named_by_caller = url != ""
	server_url = _resolve_server_url(url)
	_should_reconnect = true
	_current_reconnect_delay = RECONNECT_DELAY
	_attempt_connection()


func _resolve_server_url(explicit_url: String) -> String:
	if explicit_url != "":
		return explicit_url

	var announced: String = announced_url()
	if announced != "" and announced != _refused_url:
		_tried_announced = true
		return announced
	_tried_announced = false

	# The same variable the server reads, so the two agree on the port by construction.
	var raw: String = OS.get_environment("GDHARNESS_BRIDGE_PORT")
	if raw != "":
		if raw.is_valid_int() and int(raw) >= 1 and int(raw) <= 65535:
			return "ws://127.0.0.1:%d/godot" % int(raw)
		push_error("GDHARNESS_BRIDGE_PORT is %s, not a port; using %s" % [raw, DEFAULT_URL])

	return DEFAULT_URL


## Stops waiting on an address that is not answering, and asks again elsewhere.
func _give_up_on_this_address() -> void:
	if _tried_announced:
		_refused_url = server_url
	_connecting_for = 0.0
	socket.close()
	_schedule_reconnect()


## Where the server says its bridge is, or "" when nothing has said.
##
## Written by a server that knows which project it serves, inside that project, so the two sides
## agree by construction rather than by deriving a temporary directory the same way: they do not
## share an environment, and the runtime's own announcement cost a session learning that.
##
## A leftover is found out by trying it rather than by asking whether its process is still there.
## `OS.is_process_running` answers that only for a child of the caller on Unix, where it prints
## "does not exist or is not a child of the calling process" and says no about every server there
## is: it works on Windows and quietly disables the whole thing everywhere else. So an
## announcement that does not answer is set aside, the fallback gets the next turn, and a
## different announcement puts it back in play.
func announced_url() -> String:
	if not FileAccess.file_exists(ANNOUNCEMENT):
		return ""
	var file: FileAccess = FileAccess.open(ANNOUNCEMENT, FileAccess.READ)
	if file == null:
		return ""
	var said: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	if not said is Dictionary:
		return ""

	var announcement: Dictionary = said
	if int(announcement.get("protocol", 0)) != ANNOUNCE_PROTOCOL:
		return ""
	var port: int = int(announcement.get("port", 0))
	if port < 1 or port > 65535:
		return ""
	var host: String = str(announcement.get("host", "127.0.0.1"))
	return "ws://%s:%d/godot" % [host, port]


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

	_connecting_for = 0.0
	var err: Error = socket.connect_to_url(server_url)
	if err != OK:
		push_error("[gdharness] Failed to connect to %s: %s" % [server_url, error_string(err)])
		_schedule_reconnect()


func _handle_connect() -> void:
	_is_connected = true
	_current_reconnect_delay = RECONNECT_DELAY
	_refused_url = ""

	# The version reported is the one this editor loaded at startup, not the one on disk: an
	# upgrade replaces the files under a running editor, which goes on serving the old code until
	# somebody restarts it, and nothing else can tell the two apart.
	# The process id with it, because a restarted editor is a different process from the one
	# whoever started it is holding, and nothing else says which one is now on the other end.
	# The three ports with that, because a server that assumes the defaults talks to whichever
	# editor took them, which on a machine running two is not this one.
	_send_message(
		{
			"type": "godot_ready",
			"project_path": _project_path,
			"addon_version": version_at_load,
			"editor_pid": OS.get_process_id(),
			"lsp_port": _serves(LSP_ASKED, LSP_SETTING),
			"dap_port": _serves(DAP_ASKED, DAP_SETTING),
			"debug_port": _serving(DEBUGGER_SETTING)
		}
	)

	connected.emit()


## Writes the ports this editor was started on into the settings it reads them from.
##
## The command line moved the language server and the debug adapter for this run and the engine
## keeps that override to itself: the setting still reads whatever it read before, so an editor
## that restarts itself comes back on the old number and lands on top of whichever editor holds
## it. Writing it here is what makes the move survive a restart, and what leaves one place either
## side has to read.
func _keep_the_ports_this_editor_was_given() -> void:
	if not Engine.is_editor_hint():
		return
	_keep_port(LSP_ASKED, LSP_SETTING)
	_keep_port(DAP_ASKED, DAP_SETTING)


func _keep_port(variable: String, setting: String) -> void:
	var port: int = _asked_for(variable)
	if port < 1 or port == _serving(setting):
		return
	var settings: EditorSettings = EditorInterface.get_editor_settings()
	if settings != null:
		settings.set_setting(setting, port)


## What this editor serves: what it was told to when a server opened it, and what its settings
## say otherwise. The first is the one that counts, because the settings are the thing the command
## line was overriding.
func _serves(variable: String, setting: String) -> int:
	var asked: int = _asked_for(variable)
	return asked if asked > 0 else _serving(setting)


## The port this variable names, or 0 for anything that is not one.
static func _asked_for(variable: String) -> int:
	var said: String = OS.get_environment(variable)
	if not said.is_valid_int():
		return 0
	var port: int = int(said)
	return port if port >= 1 and port <= 65535 else 0


## What the settings say this editor serves on, or 0 when there is nothing to ask.
func _serving(setting: String) -> int:
	if not Engine.is_editor_hint():
		return 0
	var settings: EditorSettings = EditorInterface.get_editor_settings()
	if settings == null or not settings.has_setting(setting):
		return 0
	return int(settings.get_setting(setting))


## The version marker beside this addon, or "" when the copy was not installed by gdharness.
##
## Read once, when this copy loads, and never again: an upgrade replaces the files under a
## running editor and rewrites the marker with them, so reading it at connect time answers with
## the version on disk rather than the one in memory. That is the wrong answer at the one moment
## it matters. An upgrade ends with the harness reconnecting, the editor reconnecting behind it,
## and `addonIsStale` reporting false over an editor still running the old code, which is exactly
## what it exists to catch.
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
	_said_elsewhere()
	disconnected.emit()

	if _should_reconnect:
		_schedule_reconnect()


## Says so when the server turned this editor away as another project's.
##
## The fallback address is tried by every project whose own server has not run yet and so has
## announced nothing, which means any server holding it took the connection and served it. It is
## refused now, and the refusal is worth a person's attention rather than a quiet backoff: nothing
## about waiting reaches a server that is not this project's, and the answer is to start one.
##
## Said once per address. This is a reconnect loop, and a line every few seconds for the rest of
## the session is a line nobody reads.
func _said_elsewhere() -> void:
	if socket.get_close_code() != ELSEWHERE_CLOSE_CODE:
		return
	if _told_about_url == server_url:
		return
	_told_about_url = server_url
	var said: String = (
		"[gdharness] %s is another project's server, so this editor is not connected: %s."
		+ " Start this project's own server, or point it at one with GDHARNESS_BRIDGE_PORT."
	)
	push_warning(said % [server_url, socket.get_close_reason()])


func _schedule_reconnect() -> void:
	if _reconnect_timer == null:
		return
	_reconnect_timer.start(_current_reconnect_delay)
	_current_reconnect_delay = min(_current_reconnect_delay * 2.0, MAX_RECONNECT_DELAY)


func _on_reconnect_timer() -> void:
	# Asked again rather than remembered: the reason a connection dropped is often that its server
	# did, and the one that replaced it has said where it is since.
	if not _named_by_caller:
		server_url = _resolve_server_url("")
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
