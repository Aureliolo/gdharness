extends Node

## The runtime autoload: a TCP server inside the running game that the gdharness server asks
## about the scene tree, drives with input, and captures. This file is the server and the
## command table; what each command does lives in a sibling module.
##
## The port is whatever the operating system hands out, and the game announces it by writing
## one file named after its process id into a directory the server derives the same way. Two
## games can therefore run at once, and a headless operation never takes the port a game
## wanted. Both directions of the socket carry one JSON object per line. Every request names an
## id and the reply carries it back.

const Capture = preload("runtime_capture.gd")
const InputCommands = preload("runtime_input.gd")
const Queries = preload("runtime_queries.gd")
const Read = preload("reading.gd")
const Values = preload("runtime_values.gd")
const Waits = preload("runtime_waits.gd")

const PROTOCOL: int = 2
const DEFAULT_BIND_ADDRESS: String = "127.0.0.1"
const BIND_ADDRESS_SETTING: String = "gdharness/runtime/bind_address"
## 0 asks the operating system for a free port, which is the default and what the server
## expects. A fixed port is for a client that cannot read the announcement.
const PORT_SETTING: String = "gdharness/runtime/port"

## How the engine is told to run a script instead of the game: `godot -s thing.gd`.
const SCRIPT_FLAGS: PackedStringArray = ["-s", "--script"]

## Serve a script run anyway, for somebody driving a `-s` script rather than a game.
const SCRIPT_RUNS_SETTING: String = "gdharness/runtime/serve_script_runs"

## The variable the editor addon puts into its own environment, which every game the editor plays
## inherits: it says which editor played this game, so a server can tell the editor's game from
## another of the same project that some other server started. Kept in step with
## `EDITOR_PID_VARIABLE` in the editor addon's bridge client.
const EDITOR_PID_VARIABLE: String = "GDHARNESS_EDITOR_PID"

var values: Values = Values.new()

# The modules are members and not locals of _init, because a Callable holds its object by id
# rather than by reference, and a module referenced only by the Callables in the command table
# would be freed on the way out of _init, leaving every command "unknown".
var _queries: Queries = Queries.new(self, values)
var _input: InputCommands = InputCommands.new(self, values)
var _capture: Capture = Capture.new(self)
var _waits: Waits = Waits.new(self, values)

var _server: TCPServer
var _clients: Array[StreamPeerTCP] = []
## Bytes received from each client that do not yet end in a newline, keyed by the peer.
var _pending: Dictionary = {}
## Bytes owed to each client that the socket has not taken yet, keyed by the peer.
##
## A reply is queued rather than written, because the write happens on the main thread and
## `put_data` blocks until every byte is gone. A client that asked a large question and then
## stopped reading, which is exactly what our own server does when a call times out, leaves that
## write with nowhere to go: the frame never ends, the game freezes, and the listener never
## accepts again, so every later request times out too. One timeout would take the game with it.
var _outgoing: Dictionary = {}
var _port: int = 0
var _enabled: bool = true
var _announcement: String = ""
## Every command, by the name a request uses, as the module method that answers it.
var _commands: Dictionary = {}


func _init() -> void:
	_commands = {
		"ping": _ping,
		"get_tree": _queries.get_tree,
		"find_nodes": _queries.find_nodes,
		"read_text": _queries.read_text,
		"get_rect": _queries.get_rect,
		"get_property": _queries.get_property,
		"set_property": _queries.set_property,
		"call_method": _queries.call_method,
		"get_metrics": _queries.get_metrics,
		"capture_screenshot": _capture.capture_screenshot,
		"capture_viewport": _capture.capture_viewport,
		"inject_action": _input.inject_action,
		"inject_key": _input.inject_key,
		"inject_text": _input.inject_text,
		"inject_mouse_click": _input.inject_mouse_click,
		"inject_mouse_motion": _input.inject_mouse_motion,
		"click": _input.click,
		"choose": _input.choose,
		"wait_frames": _waits.wait_frames,
		"wait_signal": _waits.wait_signal,
		"wait_until": _waits.wait_until,
	}


func _ready() -> void:
	name = "GdharnessRuntime"
	# The TCP control loop runs in _process. With the default PROCESS_MODE_INHERIT it stops
	# while the tree is paused, so the runtime silently goes unreachable and the game cannot
	# even be un-paused over the socket. A debug server has to stay responsive while the game
	# is frozen, to inspect, capture, inject or resume it.
	process_mode = Node.PROCESS_MODE_ALWAYS
	_start_server()


func _exit_tree() -> void:
	_cleanup()


func _process(_delta: float) -> void:
	if not _enabled or _server == null:
		return

	if _server.is_connection_available():
		var client: StreamPeerTCP = _server.take_connection()
		if client:
			_clients.append(client)
			_send_welcome(client)

	var gone: Array[StreamPeerTCP] = []
	for client: StreamPeerTCP in _clients:
		# A poll that fails is a client that has already gone, which the status check below is
		# about to find; the answer is read so it is not dropped, not because it adds anything.
		var polled: Error = client.poll()
		if polled != OK or client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			gone.append(client)
			continue
		var available: int = client.get_available_bytes()
		if available > 0:
			var received: Array = client.get_data(available)
			var bytes: PackedByteArray = received[1]
			_receive(client, bytes)
		if not _drain(client):
			gone.append(client)

	for client: StreamPeerTCP in gone:
		_clients.erase(client)
		# Dictionary.erase answers with whether the key was there, and underscore-prefixed locals
		# are how GDScript says an answer is deliberately unwanted: a client that had nothing
		# pending or owed is as forgotten as one that had both.
		var _had_pending: bool = _pending.erase(client)
		var _had_outgoing: bool = _outgoing.erase(client)


## Hands the socket as much of what it is owed as it will take, and says whether it is still worth
## talking to. Reading comes first in the frame, so a client that asked and left is noticed here
## rather than blocking on a write that can never finish.
func _drain(client: StreamPeerTCP) -> bool:
	var owed: PackedByteArray = _outgoing.get(client, PackedByteArray())
	if owed.is_empty():
		return true
	var sent: Array = client.put_partial_data(owed)
	if sent[0] != OK:
		return false
	_outgoing[client] = owed.slice(Read.as_int(sent[1]))
	return true


## Bytes arrive in whatever pieces the socket makes of them, so a request is only handled once
## its newline has arrived, and two that arrive together are handled one after the other.
func _receive(client: StreamPeerTCP, bytes: PackedByteArray) -> void:
	var buffered: PackedByteArray = _pending.get(client, PackedByteArray())
	buffered.append_array(bytes)
	var start: int = 0
	var newline: int = buffered.find(10, start)
	while newline != -1:
		var line: String = buffered.slice(start, newline).get_string_from_utf8().strip_edges()
		start = newline + 1
		newline = buffered.find(10, start)
		if not line.is_empty():
			# Through a Callable and not awaited: a request that waits on the game must not stop
			# the others being read, and the analyser would otherwise insist on the await.
			_handle_message.call(client, line)
	_pending[client] = buffered.slice(start)


func _start_server() -> void:
	# The command set includes call_method, set_property and input injection, none of it
	# authenticated, so a release export must not serve it.
	if not OS.is_debug_build():
		_enabled = false
		return

	# And a script run has nothing to serve. Autoloads come up for `godot -s` as well, so a test
	# tier or a batch tool binds a loopback port and writes an announcement under the project's
	# own path: a gate that starts sixteen engines at once announces sixteen games that are not
	# games, and a client asking the runtime anything while they run can be answered by whichever
	# of them replies first. Measured on two projects before it was written here.
	if _script_run() and not Read.as_bool(ProjectSettings.get_setting(SCRIPT_RUNS_SETTING, false)):
		_enabled = false
		return

	_server = TCPServer.new()
	# listen() defaults bind_address to "*", which exposes the game to the whole network.
	var bind_address: String = str(ProjectSettings.get_setting(BIND_ADDRESS_SETTING, DEFAULT_BIND_ADDRESS))
	var wanted_port: int = Read.as_int(ProjectSettings.get_setting(PORT_SETTING, 0))
	var error: Error = _server.listen(wanted_port, bind_address)
	if error != OK:
		# A warning, not an error: callers treat any ERROR line on stderr as a failed
		# operation, and a game without a runtime server is a handled condition.
		push_warning(
			"[gdharness] runtime port %d is unavailable (%s), running without a server" % [wanted_port, error]
		)
		_enabled = false
		return

	_port = _server.get_local_port()
	_announce(bind_address)
	print("[gdharness] runtime listening on %s:%d, announced at %s" % [bind_address, _port, _announcement])


## Whether the engine was told to run a script rather than the game.
func _script_run() -> bool:
	var given: PackedStringArray = OS.get_cmdline_args()
	for flag: String in SCRIPT_FLAGS:
		if given.has(flag):
			return true
	return false


## Where the announcement goes. The server derives the same path with the same precedence, so
## the two only meet if this stays in step with `runtimeDirectory` in src/runtime-client.ts.
func _announcement_directory() -> String:
	var explicit: String = OS.get_environment("GDHARNESS_RUNTIME_DIR")
	if not explicit.is_empty():
		return explicit
	var per_user: String = OS.get_environment("XDG_RUNTIME_DIR")
	var base: String = per_user if not per_user.is_empty() else OS.get_temp_dir()
	return base.path_join("gdharness")


func _announce(bind_address: String) -> void:
	var directory: String = _announcement_directory()
	var made: Error = DirAccess.make_dir_recursive_absolute(directory)
	if made != OK and made != ERR_ALREADY_EXISTS:
		push_warning(
			"[gdharness] cannot create %s (%s); the server will not find this game" % [directory, made]
		)
		return
	var path: String = directory.path_join("runtime-%d.json" % OS.get_process_id())
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		push_warning(
			(
				"[gdharness] cannot write %s (%s); the server will not find this game"
				% [path, FileAccess.get_open_error()]
			)
		)
		return
	var announced: bool = file.store_string(JSON.stringify(_identity(bind_address)))
	file.close()
	if not announced:
		push_warning("[gdharness] cannot write %s; the server will not find this game" % path)
		return
	_announcement = path


## What the announcement file and the welcome both carry: enough to pick this game out of
## several and to know whether the server speaks its protocol.
func _identity(bind_address: String) -> Dictionary:
	var identity: Dictionary = {
		"protocol": PROTOCOL,
		"pid": OS.get_process_id(),
		"port": _port,
		"address": bind_address,
		"project":
		{
			"name": str(ProjectSettings.get_setting("application/config/name", "")),
			"path": ProjectSettings.globalize_path("res://").rstrip("/")
		},
		"godot": Engine.get_version_info().get("string", ""),
	}
	var played_by: String = OS.get_environment(EDITOR_PID_VARIABLE)
	if played_by.is_valid_int():
		identity["editor_pid"] = played_by.to_int()
	return identity


func _send_welcome(client: StreamPeerTCP) -> void:
	var welcome: Dictionary = _identity(
		str(ProjectSettings.get_setting(BIND_ADDRESS_SETTING, DEFAULT_BIND_ADDRESS))
	)
	welcome["type"] = "welcome"
	welcome["commands"] = _commands.keys()
	_send_response(client, welcome)


func _handle_message(client: StreamPeerTCP, line: String) -> void:
	var json: JSON = JSON.new()
	if json.parse(line) != OK:
		_send_error(client, null, "Invalid JSON: " + json.get_error_message())
		return

	var message: Variant = json.get_data()
	if not message is Dictionary:
		_send_error(client, null, "A request must be an object")
		return

	var fields: Dictionary = message
	var request_id: Variant = fields.get("id", null)
	if request_id == null:
		_send_error(client, null, "A request must carry an id")
		return

	var command: String = str(fields.get("command", ""))
	var params: Variant = fields.get("params", {})
	if not params is Dictionary:
		_send_error(client, request_id, "params must be an object")
		return
	var arguments: Dictionary = params

	# A command that waits on the game (a frame, a signal, a condition) suspends here and answers
	# when it is done, while _process keeps serving the other clients in the meantime. A client
	# that hung up while its command waited is simply not written to.
	var result: Dictionary = await _execute_command(command, arguments)
	result["id"] = request_id
	if client.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_send_response(client, result)


func _execute_command(command: String, params: Dictionary) -> Dictionary:
	var handler: Callable = _commands.get(command, Callable())
	if not handler.is_valid():
		return {
			"type": "error",
			"message": "Unknown command: %s. Commands: %s" % [command, ", ".join(_commands.keys())]
		}
	var answer: Variant = await handler.call(params)
	return answer


func _ping(_params: Dictionary) -> Dictionary:
	return {"type": "pong", "timestamp": Time.get_unix_time_from_system()}


## One JSON object and a newline, queued for [method _drain] rather than written here.
##
## Raw bytes rather than put_utf8_string, which would prefix them with a length the other side is
## not expecting, and queued rather than put_data, which blocks the frame until the socket has
## taken the lot: see [member _outgoing].
func _send_response(client: StreamPeerTCP, data: Dictionary) -> void:
	var owed: PackedByteArray = _outgoing.get(client, PackedByteArray())
	owed.append_array((JSON.stringify(data) + "\n").to_utf8_buffer())
	_outgoing[client] = owed


## A request that could not be read far enough to find its id is answered with a null one.
func _send_error(client: StreamPeerTCP, request_id: Variant, message: String) -> void:
	_send_response(client, {"type": "error", "message": message, "id": request_id})


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_cleanup()


func _cleanup() -> void:
	for client: StreamPeerTCP in _clients:
		client.disconnect_from_host()
	_clients.clear()
	_pending.clear()
	_outgoing.clear()

	if _server:
		_server.stop()
		_server = null

	# The announcement is what tells the server this game exists, so it goes before the
	# process does. A crash leaves it behind, and the server drops one whose process is gone.
	if not _announcement.is_empty():
		var removed: Error = DirAccess.remove_absolute(_announcement)
		if removed != OK:
			push_warning(
				"[gdharness] cannot remove %s; the server will find a game that is gone" % _announcement
			)
		_announcement = ""
