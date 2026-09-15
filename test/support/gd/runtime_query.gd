extends SceneTree

## The questions an agent asks of a running tree without dumping it: which nodes match, where
## one is on screen, and what a node-valued property points at. All against a small tree built
## here, with the answers checked against what was built. Nothing is in the tree until the
## main loop starts, so the checks run on the first frame rather than in _init.

const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
const HERO_SCRIPT: String = "res://query_hero.gd"

## What the hero carries, which is the shape a game keeps everything in: objects hanging off a
## node rather than properties of it. Two deep, because one is the easy case and a guild's clock
## speed is two.
const HERO_SOURCE: String = """extends Node2D


class Deeper:
	extends Resource
	var depth: int = 7

	func deepen(by: int) -> int:
		depth += by
		return depth


class Kept:
	extends Resource
	var inner: Resource = Deeper.new()


var held: Kept = Kept.new()
"""

var failures: Array[String] = []
var node: Runtime
var directory: String


func _init() -> void:
	var file: FileAccess = FileAccess.open(HERO_SCRIPT, FileAccess.WRITE)
	file.store_string(HERO_SOURCE)
	file.close()

	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine.
	directory = OS.get_temp_dir().path_join("gdharness-query-%d" % OS.get_process_id())
	OS.set_environment("GDHARNESS_RUNTIME_DIR", directory)
	node = Runtime.new()
	root.add_child(node)
	process_frame.connect(_run, CONNECT_ONE_SHOT)


func _run() -> void:
	await _check()
	node._cleanup()
	DirAccess.remove_absolute(directory)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(HERO_SCRIPT))

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _paths(reply: Dictionary) -> Array[String]:
	var paths: Array[String] = []
	var nodes: Array = reply.get("nodes", [])
	for entry: Dictionary in nodes:
		paths.append(str(entry.get("path", "")))
	return paths


## What a person reading the screen would read, which is what a caller asking about a panel wants
## and what it could not have: a find answers off hidden nodes too, and a panel keeps its empty
## state in the tree beside its rows.
func _check_reading_the_screen(panel: Panel) -> void:
	var heading: Label = Label.new()
	heading.text = "  Your guild  "
	panel.add_child(heading)
	# Below its heading in the tree, and read in that order.
	var quiet: Label = Label.new()
	quiet.text = "Nothing posted"
	quiet.visible = false
	panel.add_child(quiet)
	var blank: Label = Label.new()
	panel.add_child(blank)
	# A button reads the same as a label, and the one above this panel already holds is nameless:
	# a node that says nothing is not a blank line on the screen.
	var press: Button = Button.new()
	press.text = "Sign"
	panel.add_child(press)
	# The number in a form, which a player reads off the screen like anything else. The engine
	# builds the field inside the box and leaves it out of `get_children()`, so a screen of forms
	# read as every label on it and none of the values in it.
	var grade: SpinBox = SpinBox.new()
	grade.max_value = 9.0
	grade.value = 4.0
	panel.add_child(grade)
	# And a menu nobody has opened, which is drawn nowhere: its own items are not children, but
	# what a popup holds is, and a closed one reading as part of the screen would be worse than
	# silence.
	var choices: OptionButton = OptionButton.new()
	choices.add_item("Everything")
	choices.add_item("A client would not pay")
	panel.add_child(choices)
	await process_frame

	var said: Dictionary = await node._execute_command("read_text", {"root": "/root/Panel"})
	var lines: Array = Array(said.get("lines", []))
	if lines != ["Your guild", "Sign", "4", "Everything"]:
		_fail("the screen should read as what is drawn on it, in order: %s" % str(said))
	if said.get("count") != 4 or said.get("truncated") != false:
		_fail("and say how many lines that was: %s" % str(said))

	# The first few lines rather than all of them, which is how the top of a screen is read
	# without the room under it. It was named in the schema, taken by the call and thrown away.
	var few: Dictionary = await node._execute_command("read_text", {"root": "/root/Panel", "limit": 2})
	if Array(few.get("lines", [])) != ["Your guild", "Sign"]:
		_fail("a limit should be the first lines and no more: %s" % str(few))
	if few.get("count") != 2 or few.get("truncated") != true:
		_fail("and should say there was more left: %s" % str(few))

	# And a limit the screen exactly fits is a screen that was read whole, which is the reason the
	# walk goes one line further rather than comparing the count it came back with.
	var exactly: Dictionary = await node._execute_command("read_text", {"root": "/root/Panel", "limit": 4})
	if exactly.get("count") != 4 or exactly.get("truncated") != false:
		_fail("a limit nothing overran should not read as cut short: %s" % str(exactly))

	var everything: Dictionary = await node._execute_command(
		"read_text", {"root": "/root/Panel", "include_hidden": true}
	)
	if not Array(everything.get("lines", [])).has("Nothing posted"):
		_fail("and hidden text should be there for the asking: %s" % str(everything))

	var nowhere: Dictionary = await node._execute_command("read_text", {"root": "/root/Nowhere"})
	if nowhere.get("type") != "error":
		_fail("a read from a root that is not there is refused: %s" % str(nowhere))

	heading.free()
	quiet.free()
	blank.free()
	press.free()
	grade.free()
	choices.free()


## A name with no wildcard in it, which is the shape a caller writes when they mean "contains".
##
## [method String.matchn] answers nothing to it, and nothing is also what a name that is not in the
## tree answers, so an empty find was the one answer that could not be told apart from having asked
## the wrong question. The note says how many the name was the only thing standing between the find
## and, and only when it would have changed the answer.
func _check_a_name_written_as_a_word() -> void:
	var partial: Dictionary = await node._execute_command("find_nodes", {"name": "ero"})
	if partial.get("count") != 0 or not str(partial.get("note", "")).contains("2 node names"):
		_fail("a name with no wildcard says what a glob would have matched: %s" % str(partial))

	var nowhere: Dictionary = await node._execute_command("find_nodes", {"name": "Dragon"})
	if nowhere.get("count") != 0 or nowhere.has("note"):
		_fail("and a name nothing is near stays a plain nothing: %s" % str(nowhere))

	# Counted past the other filters rather than over the whole tree, or the note offers a glob
	# that would answer nothing either.
	var elsewhere: Dictionary = await node._execute_command(
		"find_nodes", {"name": "ero", "script": "query_hero.gd"}
	)
	if elsewhere.get("count") != 0 or not str(elsewhere.get("note", "")).contains("1 node name contains"):
		_fail("the count is of what every other filter already matched: %s" % str(elsewhere))

	var matched: Dictionary = await node._execute_command("find_nodes", {"name": "Hero"})
	if _paths(matched) != ["/root/Level/Hero"] or matched.has("note"):
		_fail("and a whole name that matches is not a near miss: %s" % str(matched))


## A property that is not a property of any node, which is where a game keeps everything worth
## asking about: a [RefCounted] hanging off a node, holding another one.
##
## Read through colons the way [method Object.get_indexed] does, so the op named after reading
## properties is the one that reads a guild's day or a clock's speed. Both halves are checked: the
## value at the end of a path, and what a path that goes wrong says, since a caller who cannot tell
## a missing step from a null one is back to guessing.
func _check_reading_through_a_path() -> void:
	var through: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Level/Hero", "property": "held:inner:depth"}
	)
	if through.get("type") != "property" or through.get("value") != 7:
		_fail("a property path reads through what it names: %s" % str(through))

	var plain: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Level/Hero", "property": "visible"}
	)
	if plain.get("type") != "property" or plain.get("value") != true:
		_fail("a name with no colon in it is the node's own property: %s" % str(plain))

	var astray: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Level/Hero", "property": "held:nowhere:depth"}
	)
	var said: String = str(astray.get("message", ""))
	if astray.get("type") != "error" or not said.contains("nowhere"):
		_fail("a step that is not there names the step rather than the path: %s" % str(astray))

	var flat: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Level/Hero", "property": "visible:deeper"}
	)
	if flat.get("type") != "error" or not str(flat.get("message", "")).contains("deeper"):
		_fail("a step holding no object says so, naming what could not be read: %s" % str(flat))

	var written: Dictionary = await node._execute_command(
		"set_property", {"path": "/root/Level/Hero", "property": "held:inner:depth", "value": 9}
	)
	if written.get("type") != "property_set" or written.get("new_value") != 9:
		_fail("a path is written through as well, and read back off the same holder: %s" % str(written))

	var found: Dictionary = await node._execute_command(
		"find_nodes", {"name": "Hero", "property": "held:inner:depth"}
	)
	var entries: Array = found.get("nodes", [])
	var first: Dictionary = entries[0] if not entries.is_empty() else {}
	if first.get("has_property") != true or first.get("value") != 9:
		_fail("a find reads a path off everything it matched: %s" % str(found))

	var absent: Dictionary = await node._execute_command(
		"find_nodes", {"name": "Heroine", "property": "held:inner:depth"}
	)
	var missed: Array = absent.get("nodes", [])
	var only: Dictionary = missed[0] if not missed.is_empty() else {}
	if only.get("has_property") != false or only.has("value"):
		_fail("and a path that goes nowhere on one of them is not having it: %s" % str(absent))


## What a game does hangs off its nodes the same way its state does, so the op that calls a method
## reaches through the same colons the op that writes one does. Reading a guild's day while being
## unable to ask it for the next one is half of what a node holds.
##
## Read back afterwards off the same holder, because a call that answered a number nobody can find
## again would be a call to something else that happened to return one.
func _check_calling_through_a_path() -> void:
	var before: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Level/Hero", "property": "held:inner:depth"}
	)
	var was: int = int(before.get("value", 0))

	var called: Dictionary = await node._execute_command(
		"call_method", {"path": "/root/Level/Hero", "method": "held:inner:deepen", "args": [3]}
	)
	if called.get("type") != "method_result" or called.get("result") != was + 3:
		_fail("a method path calls what it names, with its arguments: %s" % str(called))

	var after: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Level/Hero", "property": "held:inner:depth"}
	)
	if after.get("value") != was + 3:
		_fail("and it lands on the holder the path walked to: %s" % str(after))

	var astray: Dictionary = await node._execute_command(
		"call_method", {"path": "/root/Level/Hero", "method": "held:nowhere:deepen"}
	)
	if astray.get("type") != "error" or not str(astray.get("message", "")).contains("nowhere"):
		_fail("a step that is not there names the step rather than the path: %s" % str(astray))

	var unknown: Dictionary = await node._execute_command(
		"call_method", {"path": "/root/Level/Hero", "method": "held:inner:shallow"}
	)
	var said: String = str(unknown.get("message", ""))
	if unknown.get("type") != "error" or not said.contains("held:inner has no method shallow"):
		_fail("and a method the holder has not got names the holder it looked on: %s" % str(unknown))


func _check() -> void:
	var level: Node2D = Node2D.new()
	level.name = "Level"
	root.add_child(level)

	var hero: Node2D = Node2D.new()
	hero.name = "Hero"
	hero.set_script(load(HERO_SCRIPT))
	hero.add_to_group("heroes")
	hero.position = Vector2(40, 60)
	level.add_child(hero)

	var heroine: Node2D = Node2D.new()
	heroine.name = "Heroine"
	heroine.add_to_group("heroes")
	level.add_child(heroine)

	var panel: Panel = Panel.new()
	panel.name = "Panel"
	panel.position = Vector2(10, 20)
	panel.size = Vector2(200, 100)
	root.add_child(panel)

	var button: Button = Button.new()
	button.name = "Go"
	button.position = Vector2(30, 40)
	button.size = Vector2(80, 30)
	panel.add_child(button)

	# Away from the panel, whose contents are what the reading checks below count. What matters
	# here is that it carries words rather than what sort of control it is: a label, a button and a
	# field all answer the same question about themselves.
	var docket: Label = Label.new()
	docket.name = "Docket"
	docket.text = "Sign the docket"
	level.add_child(docket)

	var by_class: Dictionary = await node._execute_command(
		"find_nodes", {"class": "Node2D", "root": "/root/Level"}
	)
	if _paths(by_class) != ["/root/Level", "/root/Level/Hero", "/root/Level/Heroine"]:
		_fail("find by class: %s" % str(by_class))
	var by_subclass: Dictionary = await node._execute_command("find_nodes", {"class": "BaseButton"})
	if _paths(by_subclass) != ["/root/Panel/Go"]:
		_fail("find by a base class should match subclasses: %s" % str(by_subclass))
	var by_script: Dictionary = await node._execute_command("find_nodes", {"script": "query_hero.gd"})
	if _paths(by_script) != ["/root/Level/Hero"]:
		_fail("find by script, with or without res://: %s" % str(by_script))
	var by_name: Dictionary = await node._execute_command("find_nodes", {"name": "hero*"})
	if _paths(by_name) != ["/root/Level/Hero", "/root/Level/Heroine"]:
		_fail("find by name glob, case-insensitive: %s" % str(by_name))
	await _check_a_name_written_as_a_word()
	var by_group: Dictionary = await node._execute_command(
		"find_nodes", {"group": "heroes", "name": "Heroine"}
	)
	if _paths(by_group) != ["/root/Level/Heroine"]:
		_fail("filters combine: %s" % str(by_group))
	# The word on a control, which is what a caller is actually looking at. A screen built in code
	# is @Button@1412 all the way down, and reaching one meant listing every button on it and
	# reading them back one at a time to find the one saying "Post".
	var by_words: Dictionary = await node._execute_command("find_nodes", {"says": "sign THE"})
	if _paths(by_words) != ["/root/Level/Docket"]:
		_fail("find by what a node says, in part and whatever the case: %s" % str(by_words))
	var unsaid: Dictionary = await node._execute_command("find_nodes", {"says": "turn away"})
	if unsaid.get("count") != 0:
		_fail("and nothing at all when nothing says it: %s" % str(unsaid))
	var its_own: Dictionary = await node._execute_command("find_nodes", {"says": "sign the", "name": "Level"})
	if its_own.get("count") != 0:
		_fail("what a node says is its own, not what is said under it: %s" % str(its_own))
	var limited: Dictionary = await node._execute_command("find_nodes", {"class": "Node", "limit": 2})
	if limited.get("count") != 2 or limited.get("truncated") != true:
		_fail("a limit truncates and says so: %s" % str(limited))
	var nothing: Dictionary = await node._execute_command("find_nodes", {})
	if nothing.get("type") != "error" or not str(nothing.get("message", "")).contains("says"):
		_fail("a find with no filter is refused, naming every filter there is: %s" % str(nothing))
	var missing: Dictionary = await node._execute_command(
		"find_nodes", {"class": "Node", "root": "/root/Nowhere"}
	)
	if missing.get("type") != "error":
		_fail("a find from a root that is not there is refused: %s" % str(missing))

	await _check_reading_the_screen(panel)

	var rect: Dictionary = await node._execute_command("get_rect", {"path": "/root/Panel/Go"})
	var canvas: Dictionary = rect.get("canvas", {})
	var canvas_position: Dictionary = canvas.get("position", {})
	if rect.get("type") != "rect" or canvas_position.get("x") != 40.0 or canvas_position.get("y") != 60.0:
		_fail("a Control's rect is its global rect: %s" % str(rect))
	var point: Dictionary = await node._execute_command("get_rect", {"path": "/root/Level/Hero"})
	var hero_canvas: Dictionary = point.get("canvas", {})
	if point.get("type") != "point" or hero_canvas.get("x") != 40.0 or hero_canvas.get("y") != 60.0:
		_fail("a Node2D's place is its global position: %s" % str(point))
	var placeless: Dictionary = await node._execute_command("get_rect", {"path": "/root"})
	if placeless.get("type") != "error":
		_fail("a node with no place on screen is refused: %s" % str(placeless))

	await _check_reading_through_a_path()
	await _check_calling_through_a_path()

	var serialised: Variant = node.values.serialize(hero)
	if serialised != {"_type": "Node", "class": "Node2D", "path": "/root/Level/Hero"}:
		_fail("a node in the tree serialises with its path: %s" % str(serialised))
	var loose: Node = Node.new()
	var loose_serialised: Variant = node.values.serialize(loose)
	if loose_serialised != {"_type": "Object", "class": "Node"}:
		_fail("a node outside the tree has no path to give: %s" % str(loose_serialised))
	loose.free()

	panel.free()
	level.free()
