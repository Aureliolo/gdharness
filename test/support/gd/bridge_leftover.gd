extends SceneTree

## An announcement that does not answer is set aside, and the editor falls back to the port it
## was configured with.
##
## A server killed outright leaves its file behind, so the project can name a bridge that is not
## there. The first version of this asked `OS.is_process_running` about the pid in the file, which
## is a Windows answer: on Unix it reports only on children of the caller, so it said no about
## every server there is and printed an error each time it was asked. Found by CI, on the two
## platforms this was not written on.
##
## What is left is the only test that works everywhere, which is to try it. The announced address
## here accepts the connection and never completes the handshake, because that is a leftover that
## takes the longest to find out about: a port nobody holds at all is refused sooner.

const BridgeClient = preload("res://addons/gdharness_editor/bridge_client.gd")
const ANNOUNCEMENT: String = "res://.godot/gdharness-bridge.json"
const PROTOCOL: int = 1

const DEADLINE_MSEC: int = 60000

var failures: Array[String] = []

var _client: BridgeClient
var _stuck: TCPServer = TCPServer.new()
var _configured: TCPServer = TCPServer.new()
## The sockets the stuck server accepted, held open so the client waits on a handshake rather than
## seeing its connection dropped.
var _holding: Array[StreamPeerTCP] = []
var _peer: WebSocketPeer = null
var _arrived: bool = false
var _started: int = 0


func _initialize() -> void:
	var stuck_port: int = _listen(_stuck)
	var configured_port: int = _listen(_configured)
	if stuck_port == 0 or configured_port == 0:
		_stop("the fixture could not listen")
		return

	OS.set_environment("GDHARNESS_BRIDGE_PORT", str(configured_port))
	_announce(stuck_port)

	_client = BridgeClient.new()
	root.add_child(_client)
	_client.connect_to_server()
	_started = Time.get_ticks_msec()


func _process(_delta: float) -> bool:
	if Time.get_ticks_msec() - _started > DEADLINE_MSEC:
		_stop("the client never fell back in %d ms" % DEADLINE_MSEC)
		return true

	while _stuck.is_connection_available():
		_holding.append(_stuck.take_connection())

	if _peer == null and _configured.is_connection_available():
		_peer = WebSocketPeer.new()
		if _peer.accept_stream(_configured.take_connection()) != OK:
			_stop("the fixture could not accept the socket the client opened")
			return true

	if _peer != null:
		_peer.poll()
		_read_arrival()

	if not _arrived:
		return false
	_finish(0)
	return true


func _read_arrival() -> void:
	while _peer.get_available_packet_count() > 0:
		var said: Variant = JSON.parse_string(_peer.get_packet().get_string_from_utf8())
		if not said is Dictionary:
			_stop("the client said something that is not a message")
			return
		var message: Dictionary = said
		if str(message.get("type", "")) == "godot_ready":
			_arrived = true
			return


func _listen(server: TCPServer) -> int:
	if server.listen(0, "127.0.0.1") != OK:
		return 0
	return server.get_local_port()


func _announce(port: int) -> void:
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
	_stuck.stop()
	_configured.stop()
	_holding.clear()
	OS.unset_environment("GDHARNESS_BRIDGE_PORT")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(ANNOUNCEMENT))
	if not failures.is_empty():
		printerr("\n".join(failures))
		quit(1)
		return
	print(JSON.stringify({"ok": true, "fell_back_after_msec": Time.get_ticks_msec() - _started}))
	quit(code)
