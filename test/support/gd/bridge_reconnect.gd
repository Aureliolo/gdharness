extends SceneTree

## The editor's end of the bridge against a server that is not listening yet: it keeps asking,
## and it is connected once something answers.
##
## A refused connection never opens, so the socket reaches CLOSED without passing through the
## disconnect path. An editor opened a moment before its server then sat there for the rest of
## the session with the bridge listening the whole time and nothing left to ask again.

const BridgeClient = preload("res://addons/gdharness_editor/bridge_client.gd")

## Past the point where the socket gives up, which is what the client has to survive. Measured
## on Windows: a peer pointed at a port nothing listens on sits in CONNECTING for thirty seconds
## before it reaches CLOSED, and until it does there is no defect to catch. The editor that
## started this was thirty-five seconds ahead of its server.
const SILENCE_MSEC: int = 33000
const DEADLINE_MSEC: int = 120000

var _client: BridgeClient
var _server: TCPServer = TCPServer.new()
var _peer: WebSocketPeer = null
var _port: int = 0
var _started: int = 0
var _listening: bool = false
var _connected: bool = false


func _initialize() -> void:
	_port = _free_port()
	if _port == 0:
		_stop("the fixture could not find a free port to keep shut")
		return

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

	if not _listening and waited >= SILENCE_MSEC:
		if _client.is_connected_to_server():
			_stop("the client reported a connection with nothing listening")
			return true
		if _server.listen(_port, "127.0.0.1") != OK:
			_stop("the fixture could not listen on %d" % _port)
			return true
		_listening = true

	if _listening and _peer == null and _server.is_connection_available():
		_peer = WebSocketPeer.new()
		if _peer.accept_stream(_server.take_connection()) != OK:
			_stop("the fixture could not accept the socket the client opened")
			return true

	if _peer != null:
		_peer.poll()

	if not _connected:
		return false

	print(JSON.stringify({"ok": true, "waited_msec": waited, "silence_msec": SILENCE_MSEC}))
	_finish(0)
	return true


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


func _stop(message: String) -> void:
	printerr(message)
	_finish(1)


func _finish(code: int) -> void:
	if _client != null:
		_client.disconnect_from_server()
	_server.stop()
	quit(code)
