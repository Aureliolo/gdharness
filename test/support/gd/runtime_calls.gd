extends SceneTree

## A step written as a call in a path is a read. A find with property "queue_free()" freed every
## node it matched, and a wait on a method that advances the game called it once a frame and then
## said the game had reached the state the wait drove it to. The engine marks its reading methods
## const; a game's own methods are judged by what they declare they return.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

const GAME_SOURCE: String = """extends Node

class Charter:
	extends RefCounted

	var dead_allowed: bool = true
	var title: String = "royal"
	var terms: Array = ["first"]


var day: int = 0
var roster: Array = [1, 2]
var _entries: Dictionary = {"royal": Charter.new()}


func advance() -> void:
	day += 1


func settled() -> bool:
	return day > 0


func charged(by: int) -> int:
	day += by
	return day


func boosted(by: int = 1) -> int:
	day += by
	return day


func fetch(key: String) -> Charter:
	return _entries[key]


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
	await _check_reading_calls_take_literal_arguments()
	await _check_a_returned_object_is_read()

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


func _read(path: String, property: String) -> Dictionary:
	return await node._execute_command("get_property", {"path": path, "property": property})


## #896: an engine method that reads takes literal arguments in a path, so a control's theme is read
## where it is drawn. A game's method is given none, since nothing marks one as only reading, and an
## engine method that changes what it is called on is refused with arguments as without.
func _check_reading_calls_take_literal_arguments() -> void:
	var card: PanelContainer = PanelContainer.new()
	card.name = "Card"
	var box: StyleBoxFlat = StyleBoxFlat.new()
	box.content_margin_top = 7
	card.add_theme_stylebox_override("panel", box)
	root.add_child(card)
	var column: VBoxContainer = VBoxContainer.new()
	column.name = "Column"
	column.add_theme_constant_override("separation", 9)
	root.add_child(column)
	await process_frame

	var margin: Dictionary = await _read("/root/Card", 'get_theme_stylebox("panel"):content_margin_top')
	if margin.get("type") != "property" or margin.get("value") != 7.0:
		_fail("a theme box is read through a call given its name: %s" % str(margin))
	var spacing: Dictionary = await _read("/root/Column", 'get_theme_constant("separation")')
	if spacing.get("type") != "property" or spacing.get("value") != 9:
		_fail("a theme constant is read the same way: %s" % str(spacing))
	# A colon inside a quoted argument is part of the argument, not a step: a node path with a
	# property after it, which get_node resolves by its names alone.
	var named: Dictionary = await _read("/root/Game", 'get_node("/root/Card:size"):name')
	if named.get("type") != "property" or str(named.get("value")) != "Card":
		_fail("a quoted argument holding a colon is one argument: %s" % str(named))
	var watched: Dictionary = {
		"path": "/root/Column",
		"property": 'get_theme_constant("separation")',
		"value": 9,
		"timeout_ms": 500,
	}
	var waited: Dictionary = await node._execute_command("wait_until", watched)
	if waited.get("type") != "condition" or waited.get("met") != true:
		_fail("a wait reads a call with arguments as a read does: %s" % str(waited))

	var refusals: Dictionary[String, String] = {
		"charged(1)": "is the game's own",
		# Its argument is optional, so only the rule about a game method given arguments refuses it.
		"boosted(2)": "is the game's own",
		'set("day", 5)': "changes what it is called on",
		'set_name("Renamed")': "changes what it is called on",
		"/root/Column:get_theme_constant(separation)": "literal arguments only",
		"/root/Column:get_theme_constant()": "takes 1 to 2 arguments and the path gives it 0",
		"roster:size(1)": "calls size() on one with no arguments",
	}
	for asked: String in refusals:
		var at: String = asked.get_slice(":", 0) if asked.begins_with("/") else "/root/Game"
		var answer: Dictionary = await _read(at, asked.trim_prefix(at + ":"))
		if answer.get("type") != "error" or not str(answer.get("message", "")).contains(refusals[asked]):
			_fail("%s is refused, saying %s: %s" % [asked, refusals[asked], str(answer)])
	if game.get("day") != 0 or game.name != "Game":
		_fail("and none of them ran: day %s, named %s" % [str(game.get("day")), game.name])
	card.queue_free()
	column.queue_free()
	await process_frame


## #897: a call answering an object reads it in the same answer when asked, every variable its
## script declares or the paths named, and says what it could not read rather than refusing.
func _check_a_returned_object_is_read() -> void:
	var whole: Dictionary = await node._execute_command(
		"call_method", {"path": "/root/Game", "method": "fetch", "args": ["royal"], "properties": true}
	)
	var expected: Dictionary = {"dead_allowed": true, "title": "royal", "terms": ["first"]}
	if whole.get("type") != "method_result" or whole.get("result_properties") != expected:
		_fail("a returned object's script variables come back with it: %s" % str(whole))
	var named_paths: Dictionary = {
		"path": "/root/Game",
		"method": "fetch",
		"args": ["royal"],
		"properties": ["dead_allowed", "terms:0", "nope"],
	}
	var some: Dictionary = await node._execute_command("call_method", named_paths)
	var missing: Array = some.get("result_properties_missing", [])
	if (
		some.get("result_properties") != {"dead_allowed": true, "terms:0": "first"}
		or missing.size() != 1
		or not str(missing[0]).contains("has no property nope")
	):
		_fail("named paths are read off it, and one not there is listed: %s" % str(some))
	var plain: Dictionary = await node._execute_command(
		"call_method", {"path": "/root/Game", "method": "settled", "properties": true}
	)
	if not str(plain.get("properties_note", "")).contains("which has no properties to read"):
		_fail("a result that is not an object says so: %s" % str(plain))
	var bare: Dictionary = await node._execute_command(
		"call_method", {"path": "/root/Game", "method": "fetch", "args": ["royal"]}
	)
	if bare.has("result_properties") or bare.get("type") != "method_result":
		_fail("and without asking, the answer is as it was: %s" % str(bare))
	var bracketed: Dictionary = await node._execute_command(
		"call_method", {"path": "/root/Game", "method": 'fetch("royal")'}
	)
	if not str(bracketed.get("message", "")).contains("takes its arguments under args"):
		_fail("arguments in the brackets of the method called are refused: %s" % str(bracketed))
