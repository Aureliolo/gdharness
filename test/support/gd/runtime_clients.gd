extends SceneTree

## The runtime's client loop against a real socket: a message in gets an answer out, and a
## client that hangs up is dropped without the engine printing an error about it. A peer's
## status only changes on poll(), and asking a closed socket how many bytes it holds is what
## printed an ERROR line every frame the runtime kept a dead client around.

const Runtime = preload("res://addons/godot_mcp_runtime/mcp_runtime_autoload.gd")
const DEADLINE_MSEC: int = 5000

var failures: Array[String] = []
# A member rather than a local, because a lambda cannot assign to a captured local.
var frames: Array[String] = []


func _init() -> void:
	var node: Runtime = Runtime.new()
	_check(node)
	node.free()

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


## Spins the runtime's frame loop and the client's poll until `done` answers true.
func _pump(node: Runtime, client: StreamPeerTCP, done: Callable) -> bool:
	var deadline: int = Time.get_ticks_msec() + DEADLINE_MSEC
	while Time.get_ticks_msec() < deadline:
		node._process(0.0)
		client.poll()
		if done.call():
			return true
		OS.delay_msec(10)
	return false


func _check(node: Runtime) -> void:
	var server: TCPServer = TCPServer.new()
	if server.listen(0, "127.0.0.1") != OK:
		_fail("could not listen on an ephemeral port")
		return

	var client: StreamPeerTCP = StreamPeerTCP.new()
	if client.connect_to_host("127.0.0.1", server.get_local_port()) != OK:
		_fail("could not start connecting")
		return

	node._server = server
	if not _pump(node, client, func() -> bool: return node._clients.size() == 1):
		_fail("the runtime never accepted the client")
		return
	if client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_fail("the client never saw the connection open")
		return
	# The welcome arrives first and the reply to the ping after it, each as one length-prefixed
	# frame, which is what get_utf8_string reads when given no size.
	client.put_data(JSON.stringify({"command": "ping", "id": 7}).to_utf8_buffer())
	var answered: Callable = func() -> bool:
		while client.get_available_bytes() >= 4:
			frames.append(client.get_utf8_string())
		return frames.size() >= 2
	if not _pump(node, client, answered):
		_fail("no reply to ping: %s" % str(frames))
		return
	var reply: Variant = JSON.parse_string(frames[1])
	if not reply is Dictionary:
		_fail("the reply should be an object: %s" % frames[1])
	else:
		var fields: Dictionary = reply
		if fields.get("id", null) != 7:
			_fail("the reply should carry the request id: %s" % frames[1])

	client.disconnect_from_host()
	if not _pump(node, client, func() -> bool: return node._clients.is_empty()):
		_fail("a client that hung up was never dropped")
	server.stop()
