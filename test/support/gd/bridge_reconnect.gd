extends SceneTree

## The editor's end of the bridge, over two connections: it keeps asking for a server that is not
## listening yet, and it says the same version both times.
##
## A refused connection never opens, so the socket reaches CLOSED without passing through the
## disconnect path. An editor opened a moment before its server then sat there for the rest of
## the session with the bridge listening the whole time and nothing left to ask again.
##
## And what it announces on arrival is the version this copy was when it loaded, not whatever the
## marker beside it says now. An upgrade replaces the addon under a running editor and rewrites
## that marker with it, then ends with the harness reconnecting and the editor reconnecting behind
## it: read at connect time, the second arrival claimed the new version and `addonIsStale`
## reported false over an editor still running the old code.

const BridgeClient = preload("res://addons/gdharness_editor/bridge_client.gd")
const MARKER: String = "res://addons/gdharness_editor/.gdharness-version"

## Past the point where the socket gives up, which is what the client has to survive. Measured
## on Windows: a peer pointed at a port nothing listens on sits in CONNECTING for thirty seconds
## before it reaches CLOSED, and until it does there is no defect to catch. The editor that
## started this was thirty-five seconds ahead of its server.
const SILENCE_MSEC: int = 33000
const DEADLINE_MSEC: int = 120000

const WAS: String = "1.2.3"
const NOW: String = "9.9.9"

var failures: Array[String] = []

var _client: BridgeClient
var _server: TCPServer = TCPServer.new()
var _peer: WebSocketPeer = null
var _port: int = 0
var _started: int = 0
var _listening: bool = false
var _connected: bool = false
var _arrivals: int = 0
var _reached_at: int = 0


func _initialize() -> void:
	_port = _free_port()
	if _port == 0:
		_stop("the fixture could not find a free port to keep shut")
		return

	_write_marker(WAS)
	_client = BridgeClient.new()
	root.add_child(_client)
	_client.connected.connect(_on_connected)
	_client.connect_to_server("ws://127.0.0.1:%d/godot" % _port)
	_started = Time.get_ticks_msec()


func _process(_delta: float) -> bool:
	var waited: int = Time.get_ticks_msec() - _started
	if waited > DEADLINE_MSEC:
		_stop("the client never reached the bridge in %d ms" % DEADLINE_MSEC)
		return true

	if not _listening and waited >= SILENCE_MSEC and not _open_the_door():
		return true
	_take_the_connection()
	if _peer != null:
		_peer.poll()
		_read_arrival()

	if _arrivals < 2:
		return false

	_finish(0)
	return true


## Starts listening, once the client has had long enough to be refused and give up. Answers
## whether the fixture can carry on.
func _open_the_door() -> bool:
	if _client.is_connected_to_server():
		_stop("the client reported a connection with nothing listening")
		return false
	if _server.listen(_port, "127.0.0.1") != OK:
		_stop("the fixture could not listen on %d" % _port)
		return false
	_listening = true
	return true


func _take_the_connection() -> void:
	if not _listening or _peer != null or not _server.is_connection_available():
		return
	_peer = WebSocketPeer.new()
	if _peer.accept_stream(_server.take_connection()) != OK:
		_stop("the fixture could not accept the socket the client opened")


## Reads whatever the client said on arrival, which is one `godot_ready` per connection.
func _read_arrival() -> void:
	while _peer.get_available_packet_count() > 0:
		var said: Variant = JSON.parse_string(_peer.get_packet().get_string_from_utf8())
		if not said is Dictionary:
			_stop("the client said something that is not a message")
			return
		var message: Dictionary = said
		if str(message.get("type", "")) != "godot_ready":
			continue
		_arrivals += 1
		if str(message.get("addon_version", "")) != WAS:
			_fail(
				(
					"arrival %d should carry the version this copy loaded: %s"
					% [_arrivals, str(message.get("addon_version", ""))]
				)
			)
		if _arrivals == 1:
			# And out, because the peer this is reading goes with it.
			_upgrade_underneath_it()
			return


## What an upgrade does to a running editor: the files are replaced and the marker goes with
## them, and then the connection drops and the client comes back.
func _upgrade_underneath_it() -> void:
	_reached_at = Time.get_ticks_msec() - _started
	_write_marker(NOW)
	_peer.close()
	_peer = null


func _on_connected() -> void:
	_connected = true


## A port the operating system says is free and that nothing then listens on, which is what an
## editor started ahead of its server is talking to.
func _free_port() -> int:
	var probe: TCPServer = TCPServer.new()
	if probe.listen(0, "127.0.0.1") != OK:
		return 0
	var port: int = probe.get_local_port()
	probe.stop()
	return port


func _write_marker(version: String) -> void:
	var file: FileAccess = FileAccess.open(MARKER, FileAccess.WRITE)
	if file == null:
		_fail("the fixture could not write the version marker")
		return
	file.store_string("%s\n" % version)
	file.close()


func _fail(message: String) -> void:
	failures.append(message)


func _stop(message: String) -> void:
	_fail(message)
	_finish(1)


func _finish(code: int) -> void:
	if _client != null:
		_client.disconnect_from_server()
	_server.stop()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(MARKER))
	if not failures.is_empty():
		printerr("\n".join(failures))
		quit(1)
		return
	print(
		JSON.stringify(
			{"ok": true, "waited_msec": _reached_at, "silence_msec": SILENCE_MSEC, "arrivals": _arrivals}
		)
	)
	quit(code)
