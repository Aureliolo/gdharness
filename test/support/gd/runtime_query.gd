extends SceneTree

## The questions an agent asks of a running tree without dumping it: which nodes match, where
## one is on screen, and what a node-valued property points at. All against a small tree built
## here, with the answers checked against what was built. Nothing is in the tree until the
## main loop starts, so the checks run on the first frame rather than in _init.

const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
const HERO_SCRIPT: String = "res://query_hero.gd"

var failures: Array[String] = []
var node: Runtime
var directory: String


func _init() -> void:
	var file: FileAccess = FileAccess.open(HERO_SCRIPT, FileAccess.WRITE)
	file.store_string("extends Node2D\n")
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
	var by_group: Dictionary = await node._execute_command(
		"find_nodes", {"group": "heroes", "name": "Heroine"}
	)
	if _paths(by_group) != ["/root/Level/Heroine"]:
		_fail("filters combine: %s" % str(by_group))
	var limited: Dictionary = await node._execute_command("find_nodes", {"class": "Node", "limit": 2})
	if limited.get("count") != 2 or limited.get("truncated") != true:
		_fail("a limit truncates and says so: %s" % str(limited))
	var nothing: Dictionary = await node._execute_command("find_nodes", {})
	if nothing.get("type") != "error":
		_fail("a find with no filter is refused: %s" % str(nothing))
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
