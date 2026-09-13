extends SceneTree

## The runtime's server against a real socket: it takes the port it is given, announces
## itself where the server will look, greets a client, answers requests by id however the
## bytes arrive, refuses what it cannot read, drops a client that hangs up without the engine
## printing an error about it, and takes its announcement down with it.

const Runtime = preload("res://addons/godot_mcp_runtime/mcp_runtime_autoload.gd")
const DEADLINE_MSEC: int = 5000

var failures: Array[String] = []
# A member rather than a local, because a lambda cannot assign to a captured local.
var lines: Array[String] = []
var received: PackedByteArray = PackedByteArray()


func _init() -> void:
	var directory: String = OS.get_temp_dir().path_join("gdharness-fixture-%d" % OS.get_process_id())
	OS.set_environment("GDHARNESS_RUNTIME_DIR", directory)

	var node: Runtime = Runtime.new()
	_check(node, directory)
	node.free()
	DirAccess.remove_absolute(directory)

	if failures.is_empty():
		print(JSON.stringify({"ok": true, "temp_dir": OS.get_temp_dir()}))
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


## Reads whatever the client holds and appends each complete line to `lines`.
func _drain(client: StreamPeerTCP) -> void:
	var available: int = client.get_available_bytes()
	if available > 0:
		var chunk: Array = client.get_data(available)
		var bytes: PackedByteArray = chunk[1]
		received.append_array(bytes)
	var newline: int = received.find(10)
	while newline != -1:
		lines.append(received.slice(0, newline).get_string_from_utf8())
		received = received.slice(newline + 1)
		newline = received.find(10)


func _reply(index: int) -> Dictionary:
	if index >= lines.size():
		return {}
	var parsed: Variant = JSON.parse_string(lines[index])
	return parsed if parsed is Dictionary else {}


func _check(node: Runtime, directory: String) -> void:
	node._start_server()
	if node._port <= 0:
		_fail("the runtime should have been given a port, got %d" % node._port)
		return

	var announcement: String = directory.path_join("runtime-%d.json" % OS.get_process_id())
	if not FileAccess.file_exists(announcement):
		_fail("no announcement at %s" % announcement)
		return
	var announced: Variant = JSON.parse_string(FileAccess.get_file_as_string(announcement))
	if not announced is Dictionary:
		_fail("the announcement is not an object")
		return
	var fields: Dictionary = announced
	if fields.get("protocol") != 2:
		_fail("the announcement should name protocol 2: %s" % str(fields))
	if fields.get("pid") != OS.get_process_id():
		_fail("the announcement should carry this process id: %s" % str(fields))
	if fields.get("port") != node._port:
		_fail("the announcement should carry the port the runtime took: %s" % str(fields))
	var project: Dictionary = fields.get("project", {})
	if project.get("path", "") != ProjectSettings.globalize_path("res://").rstrip("/"):
		_fail("the announcement should carry the project directory: %s" % str(fields))

	var client: StreamPeerTCP = StreamPeerTCP.new()
	if client.connect_to_host("127.0.0.1", node._port) != OK:
		_fail("could not start connecting")
		return

	if not _pump(node, client, func() -> bool: return node._clients.size() == 1):
		_fail("the runtime never accepted the client")
		return

	var greeted: Callable = func() -> bool:
		_drain(client)
		return lines.size() >= 1
	if not _pump(node, client, greeted):
		_fail("no welcome arrived")
		return
	var welcome: Dictionary = _reply(0)
	if welcome.get("type") != "welcome" or welcome.get("protocol") != 2:
		_fail("the first line should be a protocol 2 welcome: %s" % lines[0])
	var commands: Array = welcome.get("commands", [])
	if not commands.has("ping") or not commands.has("get_tree"):
		_fail("the welcome should list the commands: %s" % lines[0])

	# Two requests in one write, one of them for a command that does not exist, then one with
	# no id at all, then one request split across two writes.
	var batch: String = (
		JSON.stringify({"id": 7, "command": "ping", "params": {}})
		+ "\n"
		+ JSON.stringify({"id": 8, "command": "nonesuch", "params": {}})
		+ "\n"
		+ JSON.stringify({"command": "ping", "params": {}})
		+ "\n"
	)
	client.put_data(batch.to_utf8_buffer())
	var split: PackedByteArray = (
		(JSON.stringify({"id": 9, "command": "ping", "params": {}}) + "\n").to_utf8_buffer()
	)
	client.put_data(split.slice(0, 10))
	var three_answered: Callable = func() -> bool:
		_drain(client)
		return lines.size() >= 4
	if not _pump(node, client, three_answered):
		_fail("the batch was not answered: %s" % str(lines))
		return
	client.put_data(split.slice(10))
	var fourth_answered: Callable = func() -> bool:
		_drain(client)
		return lines.size() >= 5
	if not _pump(node, client, fourth_answered):
		_fail("the split request was not answered: %s" % str(lines))
		return

	if _reply(1).get("type") != "pong" or _reply(1).get("id") != 7:
		_fail("the ping should be answered with a pong carrying its id: %s" % lines[1])
	var unknown: Dictionary = _reply(2)
	if unknown.get("type") != "error" or unknown.get("id") != 8:
		_fail("an unknown command should be an error carrying its id: %s" % lines[2])
	elif not str(unknown.get("message", "")).contains("ping"):
		_fail("the error should name the commands that exist: %s" % lines[2])
	var missing: Dictionary = _reply(3)
	if missing.get("type") != "error" or missing.get("id", 0) != null:
		_fail("a request without an id should be refused with a null id: %s" % lines[3])
	if _reply(4).get("id") != 9:
		_fail("a request split across writes should be answered once whole: %s" % lines[4])

	client.disconnect_from_host()
	if not _pump(node, client, func() -> bool: return node._clients.is_empty()):
		_fail("a client that hung up was never dropped")

	node._cleanup()
	if FileAccess.file_exists(announcement):
		_fail("the announcement should be gone once the runtime stops")
