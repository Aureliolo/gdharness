extends SceneTree
## The editor's end of the bridge tells a person when the server turned it away, and finds a server
## announced on an IPv6 host.

const GdhBridgeClient = preload("res://addons/gdharness_editor/bridge_client.gd")
const URL: String = "ws://127.0.0.1:6505/godot"
## Long enough for a loaded runner to dial its own loopback.
const DEADLINE_MSEC: int = 10000

var failures: Array[String] = []
var _server: TCPServer = TCPServer.new()
var _peer: WebSocketPeer = WebSocketPeer.new()
var _started: int = 0
var _waiting: bool = false


func _process(_delta: float) -> bool:
	if not _waiting:
		return false
	_peer.poll()
	if _server.is_connection_available():
		_waiting = false
		_finish()
		return true
	if Time.get_ticks_msec() - _started > DEADLINE_MSEC:
		_waiting = false
		_fail("nothing reached the server on ::1 in %d ms" % DEADLINE_MSEC)
		_finish()
		return true
	return false


func _initialize() -> void:
	_check_notes()
	_check_addresses()
	if _server.listen(0, "::1") != OK:
		_fail("the fixture could not listen on ::1")
		_finish()
		return
	var address: String = GdhBridgeClient.server_address("::1", _server.get_local_port())
	var dialled: Error = _peer.connect_to_url(address)
	if dialled != OK:
		_fail("%s could not be dialled: %s" % [address, error_string(dialled)])
		_finish()
		return
	_started = Time.get_ticks_msec()
	_waiting = true


func _check_notes() -> void:
	var taken: String = GdhBridgeClient.refusal_note(GdhBridgeClient.TAKEN_CLOSE_CODE, URL, "")
	if not taken.contains(URL) or not taken.contains("already serves another editor"):
		_fail("a server holding another editor is said so: %s" % taken)
	var elsewhere: String = GdhBridgeClient.refusal_note(
		GdhBridgeClient.ELSEWHERE_CLOSE_CODE, URL, "this server serves another project"
	)
	var named: bool = elsewhere.contains("another project's server")
	if not named or not elsewhere.contains("serves another"):
		_fail("another project's server is said so, with its reason: %s" % elsewhere)
	for code: int in [1000, 1006, GdhBridgeClient.ONE_SHOT_CLOSE_CODE]:
		var note: String = GdhBridgeClient.refusal_note(code, URL, "")
		if note != "":
			_fail("close code %d is no refusal to tell a person about: %s" % [code, note])


func _check_addresses() -> void:
	var expected: Dictionary[String, String] = {
		"127.0.0.1": "ws://127.0.0.1:7000/godot",
		"localhost": "ws://localhost:7000/godot",
		"::1": "ws://[::1]:7000/godot",
		"[::1]": "ws://[::1]:7000/godot",
		"fe80::1": "ws://[fe80::1]:7000/godot",
	}
	for host: String in expected:
		var got: String = GdhBridgeClient.server_address(host, 7000)
		if got != expected[host]:
			_fail("%s gives %s, not %s" % [host, got, expected[host]])


func _fail(message: String) -> void:
	failures.append(message)


func _finish() -> void:
	_peer.close()
	_server.stop()
	if not failures.is_empty():
		printerr("\n".join(failures))
		quit(1)
		return
	print(JSON.stringify({ "ok": true }))
	quit(0)
