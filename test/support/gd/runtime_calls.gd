extends SceneTree

## A step written as a call in a path is a read. A find with property "queue_free()" freed every
## node it matched, and a wait on a method that advances the game called it once a frame and then
## said the game had reached the state the wait drove it to. The engine marks its reading methods
## const; a game's own methods are judged by what they declare they return.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

const GAME_SOURCE: String = """extends Node

var day: int = 0


func advance() -> void:
	day += 1


func settled() -> bool:
	return day > 0


@warning_ignore("untyped_declaration")
func loose():
	return day
"""

var failures: Array[String] = []
var node: Runtime
var game: Node


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR", OS.get_temp_dir().path_join("gdharness-calls-%d" % OS.get_process_id())
	)
	node = Runtime.new()
	root.add_child(node)

	var script: GDScript = GDScript.new()
	script.source_code = GAME_SOURCE
	Checked.done(script.reload(), "compiling the game script")
	game = Node.new()
	game.name = "Game"
	game.set_script(script)
	root.add_child(game)

	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _fail(message: String) -> void:
	failures.append(message)


func _run() -> void:
	await _check_only_reads_are_called()

	node._cleanup()
	# Not checked: the directory is gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _check_only_reads_are_called() -> void:
	var freeing: Dictionary = await node._execute_command(
		"find_nodes", {"name": "Game", "property": "queue_free()"}
	)
	await process_frame
	if not is_instance_valid(game):
		_fail("a find reading queue_free() freed the node it matched: %s" % str(freeing))
		return
	var entries: Array = freeing.get("nodes", []) if freeing.get("nodes") is Array else []
	var entry: Dictionary = entries[0] if not entries.is_empty() and entries[0] is Dictionary else {}
	if entry.get("has_property") != false:
		_fail("and the engine method that changes a node is not a reading of it: %s" % str(freeing))

	var advancing: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Game", "property": "advance()"}
	)
	var said: String = str(advancing.get("message", ""))
	if advancing.get("type") != "error" or not said.contains("is declared -> void"):
		_fail("a game method declared void is refused as doing rather than reading: %s" % str(advancing))
	var waited: Dictionary = await node._execute_command(
		"wait_until", {"path": "/root/Game", "property": "advance()", "value": null, "timeout_ms": 200}
	)
	if waited.get("type") != "error":
		_fail("and a wait on it is refused rather than driving it every frame: %s" % str(waited))
	if game.get("day") != 0:
		_fail("so the game was not advanced by reading it: day %s" % str(game.get("day")))

	var answered: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Game", "property": "settled()"}
	)
	if answered.get("type") != "property" or answered.get("value") != false:
		_fail("a game method that returns a value is read: %s" % str(answered))
	var untyped: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Game", "property": "loose()"}
	)
	if untyped.get("type") != "property" or untyped.get("value") != 0:
		_fail("an untyped game method cannot be told apart, and is read: %s" % str(untyped))
	var engine_read: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Game", "property": "get_viewport():get_visible_rect()"}
	)
	if engine_read.get("type") != "property":
		_fail("an engine method the engine marks as reading is called: %s" % str(engine_read))
