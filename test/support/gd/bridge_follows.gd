extends SceneTree

## The editor's end of the bridge goes where the project says the bridge is, and moves when that
## changes.
##
## The port was a constant, so every project wanted the same one and only the first server to ask
## got it: a second project's editor had no bridge at all, and a harness reconnect left the server
## it replaced holding the port and answering, with the editor no reason to look elsewhere. A
## server that knows its project says where it landed, inside that project, and this is the half
## that reads it.

const BridgeClient = preload("res://addons/gdharness_editor/bridge_client.gd")
const ANNOUNCEMENT: String = "res://.godot/gdharness-bridge.json"
const PROTOCOL: int = 1

## Past the client's own look-again interval, with room for a loaded runner.
const DEADLINE_MSEC: int = 30000

var failures: Array[String] = []

var _client: BridgeClient
var _first: TCPServer = TCPServer.new()
var _second: TCPServer = TCPServer.new()
var _peer: WebSocketPeer = null
var _on_second: bool = false
var _arrivals: int = 0
var _started: int = 0
var _moved_at: int = 0


func _initialize() -> void:
	var first_port: int = _listen(_first)
	if first_port == 0:
		_stop("the fixture could not listen anywhere")
		return

	_announce(first_port)
	_client = BridgeClient.new()
	root.add_child(_client)
	# No address, so it works one out for itself, which is the thing being tested.
	_client.connect_to_server()
	_started = Time.get_ticks_msec()


func _process(_delta: float) -> bool:
	if Time.get_ticks_msec() - _started > DEADLINE_MSEC:
		_stop("the client never reached the second server in %d ms" % DEADLINE_MSEC)
		return true

	_take_the_connection()
	if _peer != null:
		_peer.poll()
		_read_arrival()

	if _arrivals < 2:
		return false
	_finish(0)
	return true


## Whichever server is expecting somebody: the first until the announcement moves, then the
## second, so the peer read below is always the connection that matters.
func _take_the_connection() -> void:
	var waiting: TCPServer = _second if _on_second else _first
	if _peer != null or not waiting.is_connection_available():
		return
	_peer = WebSocketPeer.new()
	if _peer.accept_stream(waiting.take_connection()) != OK:
		_stop("the fixture could not accept the socket the client opened")


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
		if _arrivals == 1:
			_move_the_bridge()
			return


## What a second server starting looks like from the project: a new announcement, naming a port
## the old one is not on. The first server keeps listening, the way an abandoned one does.
func _move_the_bridge() -> void:
	var second_port: int = _listen(_second)
	if second_port == 0:
		_stop("the fixture could not listen a second time")
		return
	_on_second = true
	_moved_at = Time.get_ticks_msec() - _started
	_peer = null
	_announce(second_port)


func _listen(server: TCPServer) -> int:
	if server.listen(0, "127.0.0.1") != OK:
		return 0
	return server.get_local_port()


func _announce(port: int) -> void:
	# The server makes this directory when it announces. A project that has never been opened in
	# the editor has not got one, and this fixture is run against exactly such a project.
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(ANNOUNCEMENT).get_base_dir())
	var file: FileAccess = FileAccess.open(ANNOUNCEMENT, FileAccess.WRITE)
	if file == null:
		_fail("the fixture could not write the announcement")
		return
	file.store_string(
		JSON.stringify(
			{
				"protocol": PROTOCOL,
				"host": "127.0.0.1",
				"port": port,
				"pid": OS.get_process_id(),
				"version": "fixture",
				"startedAt": Time.get_datetime_string_from_system(true)
			}
		)
	)
	file.close()


func _fail(message: String) -> void:
	failures.append(message)


func _stop(message: String) -> void:
	_fail(message)
	_finish(1)


func _finish(code: int) -> void:
	if _client != null:
		_client.disconnect_from_server()
	_first.stop()
	_second.stop()
	DirAccess.remove_absolute(ProjectSettings.globalize_path(ANNOUNCEMENT))
	if not failures.is_empty():
		printerr("\n".join(failures))
		quit(1)
		return
	print(JSON.stringify({"ok": true, "arrivals": _arrivals, "moved_at_msec": _moved_at}))
	quit(code)
