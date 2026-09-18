extends SceneTree

## The runtime's server against a real socket: it takes the port it is given, announces
## itself where the server will look, greets a client, answers requests by id however the
## bytes arrive, refuses what it cannot read, drops a client that hangs up without the engine
## printing an error about it, serves everybody else while one of them has stopped reading, and
## takes its announcement down with it.
##
## This file is itself the case the runtime refuses to serve: it is a `-s` run, so everything below
## holds only because it asks for one, which is the other half of what is checked here.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
const DEADLINE_MSEC: int = 5000

## Comfortably past any socket buffer, so one reply cannot go out in a single write however the
## platform happens to be tuned.
const BLOB_BYTES: int = 4 * 1024 * 1024

var failures: Array[String] = []
# A member rather than a local, because a lambda cannot assign to a captured local.
var lines: Array[String] = []
var received: PackedByteArray = PackedByteArray()
var second_lines: Array[String] = []
var second_received: PackedByteArray = PackedByteArray()


func _init() -> void:
	var directory: String = OS.get_temp_dir().path_join("gdharness-fixture-%d" % OS.get_process_id())
	OS.set_environment("GDHARNESS_RUNTIME_DIR", directory)

	_check_a_script_run_serves_nobody(directory)

	ProjectSettings.set_setting(Runtime.SCRIPT_RUNS_SETTING, true)
	var node: Runtime = Runtime.new()
	_check(node, directory)
	node.free()

	var busy: Runtime = Runtime.new()
	_check_a_client_that_stopped_reading(busy)
	busy._cleanup()
	busy.free()

	# Not checked: the directory is gone either way by the time this runs.
	var _removed: Error = DirAccess.remove_absolute(directory)

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
		Checked.done(client.poll(), "polling the client")
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


## The same, for the second client of the pair, which needs a buffer of its own.
func _drain_second(client: StreamPeerTCP) -> void:
	var available: int = client.get_available_bytes()
	if available > 0:
		var chunk: Array = client.get_data(available)
		var bytes: PackedByteArray = chunk[1]
		second_received.append_array(bytes)
	var newline: int = second_received.find(10)
	while newline != -1:
		second_lines.append(second_received.slice(0, newline).get_string_from_utf8())
		second_received = second_received.slice(newline + 1)
		newline = second_received.find(10)


func _reply(index: int) -> Dictionary:
	if index >= lines.size():
		return {}
	var parsed: Variant = JSON.parse_string(lines[index])
	return parsed if parsed is Dictionary else {}


## A client that asks a large question and then stops reading must not take the game with it.
##
## The reply goes out from the frame loop, and `put_data` blocks until the socket has taken every
## byte, so a peer that has stopped reading freezes that loop: the listener never accepts again
## and every later request times out, for the rest of the run. Our own server is that peer, since
## it destroys its socket when a call times out, so one slow answer cost the whole session. Seen
## on a real game: one query, then nothing ever answered again, ping included.
func _check_a_client_that_stopped_reading(node: Runtime) -> void:
	node._start_server()
	if node._port <= 0:
		_fail("the second runtime should have been given a port, got %d" % node._port)
		return

	var quiet: StreamPeerTCP = StreamPeerTCP.new()
	if quiet.connect_to_host("127.0.0.1", node._port) != OK:
		_fail("could not start connecting the client that will stop reading")
		return
	if not _pump(node, quiet, func() -> bool: return node._clients.size() == 1):
		_fail("the runtime never accepted the first of the two clients")
		return

	# Queued rather than written, which is the whole of the fix: nothing reaches the socket until
	# the frame loop hands over as much as it will take.
	var peer: StreamPeerTCP = node._clients[0]
	node._send_response(peer, {"type": "blob", "data": "x".repeat(BLOB_BYTES)})
	var owed: PackedByteArray = node._outgoing.get(peer, PackedByteArray())
	if owed.size() < BLOB_BYTES:
		_fail("a reply should be queued for the frame loop rather than written where it can block")
		return

	var talker: StreamPeerTCP = StreamPeerTCP.new()
	if talker.connect_to_host("127.0.0.1", node._port) != OK:
		_fail("could not start connecting the second of the two clients")
		return
	if not _pump(node, talker, func() -> bool: return node._clients.size() == 2):
		_fail("the runtime never accepted the second client, with the first one not reading")
		return
	var asked: PackedByteArray = (
		(JSON.stringify({"id": 1, "command": "ping", "params": {}}) + "\n").to_utf8_buffer()
	)
	Checked.done(talker.put_data(asked), "asking over the socket")

	# The welcome, then the pong. The first client never reads a byte of its four megabytes.
	var answered: Callable = func() -> bool:
		_drain_second(talker)
		return second_lines.size() >= 2
	if not _pump(node, talker, answered):
		_fail("a client that stopped reading stopped the others: %s" % str(second_lines))
		return
	var parsed: Variant = JSON.parse_string(second_lines[1])
	if not parsed is Dictionary:
		_fail("the second client's answer should be an object: %s" % second_lines[1])
		return
	var pong: Dictionary = parsed
	if pong.get("type") != "pong":
		_fail("the second client should have been answered with a pong: %s" % second_lines[1])

	# And the client goes away mid-reply, which is what our server does to a call it has given up
	# on: it destroys the socket. The bytes still owed have nowhere to go, and the runtime has to
	# notice rather than keep offering them.
	quiet.disconnect_from_host()
	var dropped: Callable = func() -> bool: return node._clients.size() == 1
	if not _pump(node, talker, dropped):
		_fail("a client that left while owed a reply was never dropped")
		return
	if node._outgoing.has(peer):
		_fail("the bytes owed to a client that left should go with it")
	Checked.done(talker.put_data(asked), "asking over the socket")
	var answered_again: Callable = func() -> bool:
		_drain_second(talker)
		return second_lines.size() >= 3
	if not _pump(node, talker, answered_again):
		_fail("the runtime stopped answering after a client left mid-reply: %s" % str(second_lines))


## A `-s` run is not a game, and every engine that starts one announces itself under the project's
## own path. Sixteen of them at once is a test tier, and a client asking the runtime anything while
## they run gets whichever answers first: a process with no game in it, from a path identical to the
## real one. So it stays quiet unless the project asks, which is what everything below relies on.
func _check_a_script_run_serves_nobody(directory: String) -> void:
	ProjectSettings.set_setting(Runtime.SCRIPT_RUNS_SETTING, false)
	var quiet: Runtime = Runtime.new()
	quiet._start_server()

	if quiet._enabled:
		_fail("a script run should not have served: %s" % str(OS.get_cmdline_args()))
	if quiet._port != 0:
		_fail("a script run took port %d" % quiet._port)
	var announcement: String = directory.path_join("runtime-%d.json" % OS.get_process_id())
	if FileAccess.file_exists(announcement):
		_fail("a script run announced itself at %s" % announcement)

	quiet._cleanup()
	quiet.free()


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
	Checked.done(client.put_data(batch.to_utf8_buffer()), "sending the batch")
	var split: PackedByteArray = (
		(JSON.stringify({"id": 9, "command": "ping", "params": {}}) + "\n").to_utf8_buffer()
	)
	Checked.done(client.put_data(split.slice(0, 10)), "sending the first half")
	var three_answered: Callable = func() -> bool:
		_drain(client)
		return lines.size() >= 4
	if not _pump(node, client, three_answered):
		_fail("the batch was not answered: %s" % str(lines))
		return
	Checked.done(client.put_data(split.slice(10)), "sending the second half")
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
