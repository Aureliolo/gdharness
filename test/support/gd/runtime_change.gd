extends SceneTree
## Writes and calls on declarations the engine describes less than fully:
## - a script class with no `class_name`, which it names by the engine class the script extends
## - a slot declared as Variant, which takes anything
## - a map keyed by numbers
## - a method given the wrong number of arguments.
## Each refusal is checked beside the write or call that works, so a check that refused everything
## fails.

const Checked = preload("checked.gd")
const GdhRead = preload("res://addons/gdharness_runtime/reading.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
const WALKER_SCRIPT: String = "res://change_walker.gd"
const MOODS_SCRIPT: String = "res://change_moods.gd"
const HOLDER_SOURCE: String = """extends Node

const Walker = preload("res://change_walker.gd")

var squad: Array[Walker] = []
var by_name: Dictionary[String, Walker] = {}
var parts: Array[Part] = [Part.new()]
var quarrel: Walker = null
var loose: Variant = null
var shifting: Variant = 3
var counted: int = 3
var nodes: Array[Node] = [null]
var by_id: Dictionary = {3: "three", 4.5: "four and a half", Vector2i(1, 2): "a pair"}
var counts: Dictionary[int, int] = {68: 6}
var weights: Dictionary[float, String] = {2.0: "two"}
var tagged: Dictionary[StringName, int] = {&"gold": 3}
var stock: Dictionary[String, int] = {"base:water": 1, "base:sand": 2, 'say "hi"': 3, "pick(1)": 4}
var named_stock: Dictionary = {&"base:water": 5}
var spare: RefCounted = RefCounted.new()
var spot: Vector2 = Vector2.ZERO
var area: Rect2 = Rect2()
var tint: Color = Color.WHITE
var trail: Array[Vector2] = []
var marks: Dictionary[String, Vector2] = {}
var path_points: PackedVector2Array = PackedVector2Array()
var ids: PackedInt32Array = PackedInt32Array()
var whole_counts: Array[int] = [1]
var health: int = 10:
	set(value):
		if value < 0:
			push_error("health cannot go below zero")
			return
		health = value
var level: int = 0:
	set(value):
		if value > 9:
			push_warning("level is high")
		level = value

enum Mood { CALM, ANGRY, SLEEPY = 5 }


func press(point: Vector2, forward: bool) -> bool:
	return forward and point == Vector2(140, 300)


func take(given: Walker) -> String:
	return "took " + str(given.name)


func pair(a: int, b: int = 2) -> int:
	return a + b


func many(first: int, ...rest: Array) -> int:
	return first + rest.size()


func length_of(points: PackedVector2Array) -> float:
	var length: float = 0.0
	for at: int in range(1, points.size()):
		length += points[at - 1].distance_to(points[at])
	return length


func sum_ids(given: PackedInt32Array) -> int:
	var sum: int = 0
	for one: int in given:
		sum += one
	return sum


func add_counts(more: Array[int]) -> int:
	return more.size()


func feel(how: Mood) -> int:
	return how


func mode_of(mode: Node.ProcessMode) -> int:
	return mode


func noisy() -> int:
	push_error("noisy said so")
	push_warning("noisy only warned")
	return 1


func _get_property_list() -> Array[Dictionary]:
	return [{"name": "mood", "type": TYPE_NIL, "usage": PROPERTY_USAGE_DEFAULT | PROPERTY_USAGE_NIL_IS_VARIANT}]


func _get(property: StringName) -> Variant:
	if property == &"mood":
		return 3
	return null


func _set(property: StringName, _value: Variant) -> bool:
	return property == &"mood"


class Part:
	extends RefCounted
"""

var failures: Array[String] = []
var node: Runtime
var directory: String
var holder: Node


func _init() -> void:
	var file: FileAccess = FileAccess.open(WALKER_SCRIPT, FileAccess.WRITE)
	Checked.worked(file.store_string("extends Node3D\n"), "writing the walker script")
	file.close()
	directory = OS.get_temp_dir().path_join("gdharness-change-%d" % OS.get_process_id())
	OS.set_environment("GDHARNESS_RUNTIME_DIR", directory)
	node = Runtime.new()
	root.add_child(node)
	Checked.done(
		process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame"
	)


func _run() -> void:
	_build()
	await _check_a_script_class_without_a_name()
	await _check_the_argument_count()
	await _check_a_slot_that_takes_anything()
	await _check_an_element_declared_as_an_object()
	await _check_a_map_keyed_by_numbers()
	await _check_maps_typed_by_key()
	await _check_a_key_holding_a_colon()
	await _check_a_value_given_by_its_fields()
	await _check_packed_lists_enums_and_setters()
	node._cleanup()
	# Not checked: both are gone either way by the time the fixture tears itself down.
	var _took_directory: Error = DirAccess.remove_absolute(directory)
	var _took_script: Error = DirAccess.remove_absolute(
		ProjectSettings.globalize_path(WALKER_SCRIPT)
	)
	var _took_moods: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(MOODS_SCRIPT))

	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _build() -> void:
	var walker_script: Script = load(WALKER_SCRIPT)
	var other: GDScript = GDScript.new()
	other.source_code = "extends Node3D\n"
	Checked.worked(other.reload() == OK, "compiling the other script")
	for named: String in ["Plain", "Walker", "Other"]:
		var made: Node3D = Node3D.new()
		made.name = named
		if named == "Walker":
			made.set_script(walker_script)
		elif named == "Other":
			made.set_script(other)
		root.add_child(made)
	var holding: GDScript = GDScript.new()
	holding.source_code = HOLDER_SOURCE
	Checked.worked(holding.reload() == OK, "compiling the holder")
	holder = Node.new()
	holder.name = "Holder"
	holder.set_script(holding)
	root.add_child(holder)
	var squad: Array = holder.get("squad")
	squad.append(root.get_node("Walker"))


func _write(property: String, value: Variant) -> Dictionary:
	return await node._execute_command(
		"set_property", { "path": "/root/Holder", "property": property, "value": value }
	)


func _invoke(method: String, args: Array) -> Dictionary:
	return await node._execute_command(
		"call_method", { "path": "/root/Holder", "method": method, "args": args }
	)


## A typed list of a script with no global name, which the engine hands over as Node3D and the
## script. A Node3D with no script, or another script, passed the class and the engine then dropped
## it from the list, so the game's list came out empty behind an answer of success.
func _check_a_script_class_without_a_name() -> void:
	var walker: Node = root.get_node("Walker")
	for stranger: String in ["/root/Plain", "/root/Other"]:
		var refused: Dictionary = await _write("squad", [stranger])
		var said: String = str(refused.get("message", ""))
		if (
			refused.get("type") != "error"
			or not said.contains("not an instance of %s" % WALKER_SCRIPT)
		):
			_fail(
				(
					"a list of Walker refuses %s by its script: %s"
					% [stranger, JSON.stringify(refused)]
				)
			)
		if holder.get("squad") != [walker]:
			_fail("and the game's list is as it was: %s" % str(holder.get("squad")))
	# The guard behind that check: a resolver that lets any object through, so the engine drops the
	# element while building the list, and the list that comes back shorter is refused, not written.
	var lax: Callable = func(_given: Variant, _declared: String, _script: Script) -> Dictionary:
		return { "object": root.get_node("Plain") }
	var built: Dictionary = node.values.call(
		&"typed_like", ["/root/Plain"], holder.get("squad"), lax
	)
	if not str(built.get("message", "")).contains("would not take its elements"):
		_fail("a typed list the engine builds shorter is refused: %s" % str(built))
	var built_map: Dictionary = node.values.call(
		&"typed_like", { "a": "/root/Plain" }, holder.get("by_name"), lax
	)
	if not str(built_map.get("message", "")).contains("would not take its entries"):
		_fail("and so is a typed map: %s" % str(built_map))
	var taken: Dictionary = await _write("squad", ["/root/Walker", "null"])
	if taken.get("type") != "property_set" or holder.get("squad") != [walker, null]:
		_fail("a list of Walker takes a Walker: %s" % JSON.stringify(taken))

	var mapped: Dictionary = await _write("by_name", { "a": "/root/Plain" })
	if (
		mapped.get("type") != "error"
		or not str(mapped.get("message", "")).contains("not an instance of")
	):
		_fail("a map of Walker refuses a Node3D by its script: %s" % JSON.stringify(mapped))
	var mapped_right: Dictionary = await _write("by_name", { "a": "/root/Walker" })
	var by_name: Dictionary = holder.get("by_name")
	if mapped_right.get("type") != "property_set" or by_name.get("a") != walker:
		_fail("and takes a Walker: %s" % JSON.stringify(mapped_right))

	# An inner class has no global name and no file either.
	var parts: Array = holder.get("parts")
	var part: Object = parts[0]
	var inner: Dictionary = await _write("parts", ["/root/Holder:spare"])
	if (
		inner.get("type") != "error"
		or not str(inner.get("message", "")).contains("not an instance of an inner class")
	):
		_fail("a list of an inner class refuses another RefCounted: %s" % JSON.stringify(inner))
	if holder.get("parts") != [part]:
		_fail("and keeps the part it held: %s" % str(holder.get("parts")))

	# A single slot and a parameter, where the declaration is only the engine class: the write is
	# refused by what it reads back, and the call by the engine, each saying what the class may be.
	var slot: Dictionary = await _write("quarrel", "/root/Plain")
	var slot_said: String = str(slot.get("message", ""))
	if slot.get("type") != "error" or not slot_said.contains("script class with no class_name"):
		_fail(
			(
				"a Walker slot given a plain Node3D says why it may be refused: %s"
				% JSON.stringify(slot)
			)
		)
	var slot_right: Dictionary = await _write("quarrel", "/root/Walker")
	if slot_right.get("type") != "property_set" or holder.get("quarrel") != walker:
		_fail("and takes a Walker: %s" % JSON.stringify(slot_right))
	var call_wrong: Dictionary = await _invoke("take", ["/root/Plain"])
	var call_said: String = str(call_wrong.get("message", ""))
	if (
		call_wrong.get("type") != "error"
		or not call_said.contains("did not run: the engine refused the call")
	):
		_fail(
			(
				"a call the engine refuses is not answered as one that returned null: %s"
				% JSON.stringify(call_wrong)
			)
		)
	if not call_said.contains("script class with no class_name"):
		_fail("and says the parameter may be a script class: %s" % call_said)
	if call_said.contains(".."):
		_fail("in one sentence ending once: %s" % call_said)
	var call_right: Dictionary = await _invoke("take", ["/root/Walker"])
	if call_right.get("type") != "method_result" or call_right.get("result") != "took Walker":
		_fail("the same call with a Walker runs: %s" % JSON.stringify(call_right))


## Too few and too many arguments, refused before the call, beside the counts that run, and what the
## method reported on its way through, carried with the result.
func _check_the_argument_count() -> void:
	var cases: Array = [
		["pair", [], "takes 1 to 2 arguments and was given 0"],
		["pair", [1, 2, 3], "takes 1 to 2 arguments and was given 3"],
		["many", [], "takes at least 1 argument and was given 0"],
		["take", [], "takes 1 argument and was given 0"],
	]
	for case: Array in cases:
		var method: String = case[0]
		var args: Array = case[1]
		var refused: Dictionary = await _invoke(method, args)
		if (
			refused.get("type") != "error"
			or not str(refused.get("message", "")).ends_with(str(case[2]))
		):
			_fail("%s with %s is refused: %s" % [method, str(args), JSON.stringify(refused)])
	for case: Array in [
		["pair", [1], 3], ["pair", [1, 5], 6], ["many", [1], 1], ["many", [1, 7, 7, 7], 4],
	]:
		var method: String = case[0]
		var args: Array = case[1]
		var ran: Dictionary = await _invoke(method, args)
		if ran.get("type") != "method_result" or ran.get("result") != case[2]:
			_fail("%s with %s runs: %s" % [method, str(args), JSON.stringify(ran)])
		if ran.has("errors"):
			_fail("and reports nothing it did not raise: %s" % JSON.stringify(ran))
	var noisy: Dictionary = await _invoke("noisy", [])
	var raised: Array = noisy.get("errors", [])
	if noisy.get("type") != "method_result" or noisy.get("result") != 1:
		_fail(
			(
				"a method that reports an error still answers what it returned: %s"
				% JSON.stringify(noisy)
			)
		)
	if raised.size() != 1 or not str(raised[0]).contains("noisy said so"):
		_fail(
			(
				"with the error it reported, and no warning among the errors: %s"
				% JSON.stringify(noisy)
			)
		)
	var warned: Array = noisy.get("warnings", [])
	if warned.size() != 1 or str(warned[0]) != "noisy only warned":
		_fail("and the warning under warnings: %s" % JSON.stringify(noisy))


## A Vector2 given as its fields with no tag, the way scene_node and resource_edit take one, is
## read as a Vector2 by a call and a write, and a nested one inside a Rect2 too. The tagged form
## still works beside it, and one missing a field is refused naming the shape that is read.
func _check_a_value_given_by_its_fields() -> void:
	for point: Variant in [{ "x": 140, "y": 300 }, { "_type": "Vector2", "x": 140, "y": 300 }]:
		var pressed: Dictionary = await _invoke("press", [point, true])
		if pressed.get("type") != "method_result" or pressed.get("result") != true:
			_fail(
				"press takes %s as a Vector2: %s" % [JSON.stringify(point), JSON.stringify(pressed)]
			)
	var moved: Dictionary = await _write("spot", { "x": 1.5, "y": -2 })
	if moved.get("type") != "property_set" or holder.get("spot") != Vector2(1.5, -2):
		_fail(
			(
				"a write takes a Vector2 as its fields: %s, holding %s"
				% [JSON.stringify(moved), holder.get("spot")]
			)
		)
	var framed: Dictionary = await _write(
		"area", { "position": { "x": 1, "y": 2 }, "size": { "x": 3, "y": 4 } }
	)
	if framed.get("type") != "property_set" or holder.get("area") != Rect2(1, 2, 3, 4):
		_fail(
			(
				"and a Rect2 with its vectors as fields: %s, holding %s"
				% [JSON.stringify(framed), holder.get("area")]
			)
		)
	var short: Dictionary = await _invoke("press", [{ "x": 140 }, true])
	var said: String = str(short.get("message", ""))
	if (
		short.get("type") != "error"
		or not said.ends_with('A Vector2 is sent as {"x": ..., "y": ...}.')
	):
		_fail("one missing a field is refused naming the shape: %s" % JSON.stringify(short))
	var shape: String = 'A Vector2 is sent as {"x": ..., "y": ...}.'
	var deep: Dictionary = await _write("spot", { "x": 7, "y": 8, "z": 9 })
	var deep_said: String = str(deep.get("message", ""))
	if not deep_said.ends_with(
		'A Vector2 has no field called "z", so the value is not read as one. ' + shape
	):
		_fail(
			"one carrying a field a Vector2 has not is refused naming it: %s" % JSON.stringify(deep)
		)
	var deeper: Dictionary = await _write("spot", { "x": 7, "y": 8, "z": 9, "w": 1 })
	if not str(deeper.get("message", "")).contains(
		'A Vector2 has no fields called "z" or "w", so the value'
	):
		_fail("and two of them both: %s" % JSON.stringify(deeper))
	if holder.get("spot") != Vector2(1.5, -2):
		_fail("and the slot keeps what it held: %s" % holder.get("spot"))
	var named: Dictionary = await _write("spot", { "type": "Vector2", "x": 7, "y": 8 })
	var named_said: String = str(named.get("message", ""))
	if not (
		named_said
		. contains(
			(
				'A Vector2 has no field called "type", so the value is not read as one: a value '
				+ 'names its type under "_type". '
			)
		)
	):
		_fail("a type named under type is refused saying where it goes: %s" % JSON.stringify(named))
	var tagged: Dictionary = await _invoke(
		"press", [{ "_type": "Vector2", "x": 1, "y": 2, "w": 3 }, true]
	)
	if not str(tagged.get("message", "")).contains(
		'A Vector2 has no field called "w", so the value is not'
	):
		_fail("and an argument tagged as one: %s" % JSON.stringify(tagged))
	var unshaped: Dictionary = await _write("spot", "east")
	if not str(unshaped.get("message", "")).ends_with('A Vector2 is sent as {"x": ..., "y": ...}.'):
		_fail("and so is a write of a word: %s" % JSON.stringify(unshaped))
	var counted: Dictionary = await _write("counted", "many")
	if str(counted.get("message", "")).contains("is sent as"):
		_fail("a number names no shape: %s" % JSON.stringify(counted))
	var coded: Dictionary = await _write("tint", "#00ff0080")
	if coded.get("type") != "property_set" or holder.get("tint") != Color.html("#00ff0080"):
		_fail(
			(
				"a colour takes its html code: %s, holding %s"
				% [JSON.stringify(coded), holder.get("tint")]
			)
		)
	var alpha: Dictionary = await _write("tint", { "r": 1, "g": 0, "b": 0, "alpha": 0.5 })
	var colour_shape: String = (
		'A Color is sent as {"r": ..., "g": ..., "b": ..., "a": ...} or as its html code'
	)
	if not str(alpha.get("message", "")).contains(
		'A Color has no field called "alpha", so the value is not read as one. ' + colour_shape
	):
		_fail(
			(
				"one naming its alpha otherwise is refused with the key it goes under: %s"
				% JSON.stringify(alpha)
			)
		)
	var uncoded: Dictionary = await _write("tint", "#00ff0")
	if uncoded.get("type") != "error" or holder.get("tint") != Color.html("#00ff0080"):
		_fail("and a word that is no html code is refused: %s" % JSON.stringify(uncoded))

	# An element of a typed list or map is fitted as a single value is, so its refusal names the
	# field too: item 0 below has the keys item 1 has but one, and is taken.
	var unread: String = (
		'which cannot become Vector2. A Vector2 has no field called "z", so the value'
	)
	var listed: Dictionary = await _write("trail", [{ "x": 1, "y": 2 }, { "x": 3, "y": 4, "z": 5 }])
	var listed_said: String = str(listed.get("message", ""))
	if not listed_said.contains("element 1 is ") or not listed_said.contains(unread):
		_fail("an element of a typed list carrying a field it has not is told it: %s" % listed_said)
	if not listed_said.ends_with(shape):
		_fail("and ends on the shape, with one full stop: %s" % listed_said)
	var keyed: Dictionary = await _write("marks", { "a": { "x": 3, "y": 4, "z": 5 } })
	var keyed_said: String = str(keyed.get("message", ""))
	if not keyed_said.contains("the value under a is ") or not keyed_said.contains(unread):
		_fail("and so is a value of a typed map: %s" % JSON.stringify(keyed))
	var traced: Dictionary = await _write("trail", [{ "x": 1, "y": 2 }])
	if traced.get("type") != "property_set" or holder.get("trail") != [Vector2(1, 2)]:
		_fail(
			(
				"while a list of points is taken: %s, holding %s"
				% [JSON.stringify(traced), holder.get("trail")]
			)
		)


## A slot declared as Variant takes what it is given, as the engine does. One declared as a number
## still refuses a word. The text null empties a Variant slot holding nothing, as a wait on it
## reads.
func _check_a_slot_that_takes_anything() -> void:
	var numbered: Dictionary = await _write("shifting", 7)
	if numbered.get("type") != "property_set" or typeof(holder.get("shifting")) != TYPE_INT:
		_fail("a Variant slot holding an int keeps a number an int: %s" % JSON.stringify(numbered))
	var worded: Dictionary = await _write("shifting", "idle")
	if worded.get("type") != "property_set" or holder.get("shifting") != "idle":
		_fail("and takes a word: %s" % JSON.stringify(worded))
	var back: Dictionary = await _write("shifting", 5)
	if (
		back.get("type") != "property_set"
		or typeof(holder.get("shifting")) not in [TYPE_INT, TYPE_FLOAT]
	):
		_fail("and a number back as a number, not its text: %s" % JSON.stringify(back))
	# One that ignores every write, holding a number and given a word it cannot be compared with, is
	# still refused by what it reads back.
	var ignored: Dictionary = await _write("mood", "cheerful")
	if (
		ignored.get("type") != "error"
		or not str(ignored.get("message", "")).contains("reads 3 afterwards")
	):
		_fail(
			(
				"a write the property ignores is refused whatever its kind: %s"
				% JSON.stringify(ignored)
			)
		)
	var counted: Dictionary = await _write("counted", "idle")
	if (
		counted.get("type") != "error"
		or not str(counted.get("message", "")).contains("cannot become one")
	):
		_fail("an int slot still refuses a word: %s" % JSON.stringify(counted))

	var emptied: Dictionary = await _write("loose", "null")
	if (
		emptied.get("type") != "property_set"
		or holder.get("loose") != null
		or typeof(holder.get("loose")) != TYPE_NIL
	):
		_fail(
			(
				"the text null leaves a Variant slot holding nothing, not the word: %s"
				% JSON.stringify(emptied)
			)
		)
	var worded_loose: Dictionary = await _write("loose", "idle")
	if worded_loose.get("type") != "property_set" or holder.get("loose") != "idle":
		_fail("and any other word is stored as the word: %s" % JSON.stringify(worded_loose))
	var met: Dictionary = await node._execute_command(
		"wait_until",
		{ "path": "/root/Holder", "property": "loose", "value": "idle", "timeout_ms": 1000 }
	)
	if met.get("met") != true:
		_fail("a wait reads the same slot the same way: %s" % JSON.stringify(met))

	# A slot that turns into something the value waited for cannot be compared with, a word to a
	# number, ends the wait with what it holds. Comparing them is an error raised inside the game.
	holder.set("loose", "waiting")
	var turn: Callable = func() -> void: holder.set("loose", 3)
	Checked.done(
		process_frame.connect(turn, CONNECT_ONE_SHOT) as Error, "turning the slot mid-wait"
	)
	var turned: Dictionary = await node._execute_command(
		"wait_until",
		{ "path": "/root/Holder", "property": "loose", "value": "done", "timeout_ms": 3000 }
	)
	if (
		turned.get("met") != false
		or turned.get("value") != 3
		or GdhRead.as_int(turned.get("elapsed_ms"), 0) >= 3000
	):
		_fail("a wait on a slot that turns into a number ends there: %s" % JSON.stringify(turned))


## An element of a typed list of objects: a wait for a number on it is refused as a set of one is,
## rather than waited out, and the text null meets it at once. A record given for an object element
## is told objects go by their path.
func _check_an_element_declared_as_an_object() -> void:
	var impossible: Dictionary = await node._execute_command(
		"wait_until",
		{ "path": "/root/Holder", "property": "nodes:0", "value": 5, "timeout_ms": 3000 }
	)
	if (
		impossible.get("type") != "error"
		or not str(impossible.get("message", "")).contains("declared to hold an object")
	):
		_fail(
			"a wait for a number on an object element is refused: %s" % JSON.stringify(impossible)
		)
	var emptied: Dictionary = await node._execute_command(
		"wait_until",
		{ "path": "/root/Holder", "property": "nodes:0", "value": "null", "timeout_ms": 1000 }
	)
	if emptied.get("met") != true or emptied.get("frames") != 0:
		_fail("and the text null meets the empty element at once: %s" % JSON.stringify(emptied))
	# The record a read answers a node with carries its path, so it names the node.
	var recorded: Dictionary = await _write("nodes", [{ "_type": "Node", "path": "/root/Plain" }])
	var written: Variant = recorded.get("new_value")
	if (
		recorded.get("type") != "property_set"
		or not written is Array
		or JSON.stringify(written).find('"path":"/root/Plain"') == -1
	):
		_fail("a node's record names the node for an element: %s" % JSON.stringify(recorded))
	var identified: Dictionary = await _write(
		"nodes", [{ "_type": "Object", "class": "Node3D", "id": 1 }]
	)
	if (
		identified.get("type") != "error"
		or not str(identified.get("message", "")).contains("named by its path")
	):
		_fail(
			(
				"a record naming an object by its id is told how objects are named: %s"
				% JSON.stringify(identified)
			)
		)
	var _emptied_again: Dictionary = await _write("nodes", ["null"])


## A map typed by its key, stepped into by that key written as text, logs nothing in the game.
##
## A typed map checks the type of every key it is asked about and reports an engine error for one of
## another type, so trying the step as text before the number read the right entry and left the run
## counting errors the game never had: eight for one read, and `clean` false at the stop. The runner
## fails this fixture on any engine error, so each read below is held to logging nothing, beside its
## answer. An absent key is refused the same way, and a write lands under the key's own type.
func _check_maps_typed_by_key() -> void:
	for case: Array in [["counts:68", 6], ["weights:2", "two"], ["tagged:gold", 3]]:
		var read: Dictionary = await node._execute_command(
			"get_property", { "path": "/root/Holder", "property": case[0] }
		)
		if read.get("value") != case[1]:
			_fail("%s reads its entry: %s" % [case[0], JSON.stringify(read)])
	var absent: Dictionary = await node._execute_command(
		"get_property", { "path": "/root/Holder", "property": "counts:1" }
	)
	if absent.get("type") != "error" or not str(absent.get("message", "")).contains("no key 1"):
		_fail("a key a typed map has not got is refused: %s" % JSON.stringify(absent))
	var written: Dictionary = await _write("counts:68", 7)
	var counts: Dictionary = holder.get("counts")
	if written.get("type") != "property_set" or counts.get(68) != 7 or counts.size() != 1:
		_fail(
			"counts:68 is written under the number: %s, %s" % [JSON.stringify(written), str(counts)]
		)


## A key holding a colon, a quote or a bracket, written in double quotes, is one step: read, written
## and waited on through it, and listed that way by the refusal for the path split at its colon, so
## the refusal says how to reach it. Game D keys its stock by namespaced ids, and no path reached
## one, quoted or not.
func _check_a_key_holding_a_colon() -> void:
	var read: Dictionary = await node._execute_command(
		"get_property", { "path": "/root/Holder", "property": 'stock:"base:water"' }
	)
	if read.get("value") != 1:
		_fail('stock:"base:water" reads its entry: %s' % JSON.stringify(read))
	var written: Dictionary = await _write('stock:"base:water"', 2)
	var stock: Dictionary = holder.get("stock")
	if written.get("type") != "property_set" or stock.get("base:water") != 2 or stock.size() != 4:
		_fail(
			(
				'stock:"base:water" is written under its key: %s, %s'
				% [JSON.stringify(written), str(stock)]
			)
		)
	var met: Dictionary = await node._execute_command(
		"wait_until",
		{ "path": "/root/Holder", "property": 'stock:"base:water"', "value": 2, "timeout_ms": 1000 }
	)
	if met.get("met") != true or GdhRead.as_int(met.get("elapsed_ms"), 1000) >= 1000:
		_fail('a wait on stock:"base:water" is met at once: %s' % JSON.stringify(met))
	var split: Dictionary = await node._execute_command(
		"get_property", { "path": "/root/Holder", "property": "stock:base:water" }
	)
	var listed: String = (
		'has no key base. It is keyed by "base:water", "base:sand", "say \\"hi\\"", "pick(1)"'
	)
	if split.get("type") != "error" or not str(split.get("message", "")).contains(listed):
		_fail("the refusal writes each key as the step reaching it: %s" % JSON.stringify(split))
	for case: Array in [
		['stock:"say \\"hi\\""', 3],
		['stock:"pick(1)"', 4],
		['named_stock:"base:water"', 5],
		['by_id:"4.5"', "four and a half"],
	]:
		var reached: Dictionary = await node._execute_command(
			"get_property", { "path": "/root/Holder", "property": case[0] }
		)
		if reached.get("value") != case[1]:
			_fail("%s reads its entry: %s" % [case[0], JSON.stringify(reached)])


## A map keyed by numbers, stepped into by the number written as text, and written back under the
## key it has rather than beside it under the text.
func _check_a_map_keyed_by_numbers() -> void:
	for case: Array in [["3", "three"], ["4.5", "four and a half"]]:
		var read: Dictionary = await node._execute_command(
			"get_property", { "path": "/root/Holder", "property": "by_id:" + str(case[0]) }
		)
		if read.get("value") != case[1]:
			_fail("by_id:%s reads its entry: %s" % [case[0], JSON.stringify(read)])
	var written: Dictionary = await _write("by_id:3", "drei")
	var map: Dictionary = holder.get("by_id")
	if written.get("type") != "property_set" or map.get(3) != "drei" or map.size() != 3:
		_fail("by_id:3 is written under the number: %s, %s" % [JSON.stringify(written), str(map)])
	var paired: Dictionary = await node._execute_command(
		"get_property", { "path": "/root/Holder", "property": "by_id:(1, 2)" }
	)
	var said: String = str(paired.get("message", ""))
	if (
		paired.get("type") != "error"
		or not said.contains("has a key that reads (1, 2), but it is Vector2i")
	):
		_fail("a key a step cannot spell is named by its type: %s" % JSON.stringify(paired))


## A packed list fitted element by element, an element of a typed list held to what a single value
## is, an enum argument given by name, and a setter's own report beside the write it refused.
func _check_packed_lists_enums_and_setters() -> void:
	var walked: Dictionary = await _invoke("length_of", [[{ "x": 0, "y": 0 }, { "x": 3, "y": 4 }]])
	if walked.get("result") != 5.0:
		_fail("a packed list of points takes each as its fields: %s" % JSON.stringify(walked))
	var stray: Dictionary = await _invoke("length_of", [[{ "x": 0, "y": 0 }, "east"]])
	if (
		str(stray.get("message", ""))
		!= (
			'/root/Holder.length_of takes PackedVector2Array as argument 1: element 1 is "east", '
			+ 'which cannot become Vector2. A Vector2 is sent as {"x": ..., "y": ...}.'
		)
	):
		_fail("and names the element that is no point: %s" % JSON.stringify(stray))
	var summed: Dictionary = await _invoke("sum_ids", [[1, 2]])
	if summed.get("result") != 3:
		_fail("a packed list of whole numbers is summed: %s" % JSON.stringify(summed))
	var cut: Dictionary = await _invoke("sum_ids", [[1, 2.5]])
	if not str(cut.get("message", "")).ends_with(
		"element 1 is 2.5, which an int cannot hold without changing it."
	):
		_fail("and a fraction in one is refused, not cut: %s" % JSON.stringify(cut))
	var counted: Dictionary = await _invoke("add_counts", [[4.5]])
	if (
		str(counted.get("message", ""))
		!= (
			"/root/Holder.add_counts takes a typed list as argument 1: element 0 is 4.5, which an "
			+ "int cannot hold without changing it."
		)
	):
		_fail("a fraction in a typed list of ints is refused: %s" % JSON.stringify(counted))
	var whole: Dictionary = await _invoke("add_counts", [[4, 5]])
	if whole.get("result") != 2:
		_fail("while whole numbers are taken: %s" % JSON.stringify(whole))
	var written_cut: Dictionary = await _write("whole_counts", [2.5])
	if not str(written_cut.get("message", "")).ends_with(
		"element 0 is 2.5, which an int cannot hold without changing it."
	):
		_fail("and so is one written into a typed list: %s" % JSON.stringify(written_cut))
	var drawn: Dictionary = await _write("path_points", [{ "x": 1, "y": 2 }])
	if (
		drawn.get("type") != "property_set"
		or holder.get("path_points") != PackedVector2Array([Vector2(1, 2)])
	):
		_fail("a packed list written takes points as their fields: %s" % JSON.stringify(drawn))
	var worded: Dictionary = await _write("ids", [1, "x"])
	if (
		str(worded.get("message", ""))
		!= ('/root/Holder.ids holds PackedInt32Array: element 1 is "x", which cannot become int.')
	):
		_fail("and refuses a word among whole numbers: %s" % JSON.stringify(worded))
	if holder.get("ids") != PackedInt32Array():
		_fail("leaving the list as it was: %s" % str(holder.get("ids")))

	for given: Array in [["ANGRY", 1], ["sleepy", 5], [5, 5]]:
		var felt: Dictionary = await _invoke("feel", [given[0]])
		if felt.get("result") != given[1] or felt.has("outside_declared"):
			_fail(
				"an enum argument takes %s: %s" % [JSON.stringify(given[0]), JSON.stringify(felt)]
			)
	var misspelt: Dictionary = await _invoke("feel", ["ANGRYY"])
	if (
		str(misspelt.get("message", ""))
		!= (
			"/root/Holder.feel takes the enum Mood as argument 1, and ANGRYY is none of its "
			+ "values: send CALM (0), ANGRY (1), SLEEPY (5) by name or by number. The nearest is "
			+ "ANGRY."
		)
	):
		_fail("a name the enum has not is refused naming its values: %s" % JSON.stringify(misspelt))
	var past: Dictionary = await _invoke("feel", [7])
	if (
		past.get("result") != 7
		or (
			past.get("outside_declared")
			!= (
				"argument 1, 7, is none of the values Mood declares: CALM (0), ANGRY (1), "
				+ "SLEEPY (5)."
			)
		)
	):
		_fail("a number the enum has not runs and is said: %s" % JSON.stringify(past))
	var mode: Dictionary = await _invoke("mode_of", ["PROCESS_MODE_DISABLED"])
	if mode.get("result") != Node.PROCESS_MODE_DISABLED:
		_fail("an engine enum takes its constant's name: %s" % JSON.stringify(mode))

	var below: Dictionary = await _write("health", -1)
	if not str(below.get("message", "")).ends_with(
		"both look like. While it was written the game reported: health cannot go below zero"
	):
		_fail("a setter keeping its value says what it reported: %s" % JSON.stringify(below))
	var healed: Dictionary = await _write("health", 5)
	if healed.get("type") != "property_set" or healed.has("errors") or holder.get("health") != 5:
		_fail("while one it takes reports nothing: %s" % JSON.stringify(healed))
	var huge: Dictionary = await _invoke("add_counts", [[9_007_199_254_740_993.0]])
	var huge_said: String = str(huge.get("message", ""))
	if (
		not huge_said.contains("element 0 is too large to be sure of: ")
		or not huge_said.contains(
			" is 2^53 or more, where a JSON number holds a whole number only to the nearest"
		)
	):
		_fail("a whole number past 2^53 in a typed list is refused: %s" % JSON.stringify(huge))

	# A saved script's enum, and one of a class inside it, which the engine names by the path and
	# the inner class: res://change_moods.gd.Inner.Size.
	var file: FileAccess = FileAccess.open(MOODS_SCRIPT, FileAccess.WRITE)
	var source: PackedStringArray = [
		"extends Node",
		"",
		"enum Mood { CALM, ANGRY }",
		"",
		"",
		"func size_of(s: Inner.Size) -> int:",
		"\treturn s",
		"",
		"",
		"class Inner:",
		"\tenum Size { SMALL, BIG = 9 }",
		"",
	]
	Checked.worked(file.store_string("\n".join(source)), "writing the moods script")
	file.close()
	var moody: Node = Node.new()
	moody.name = "Moody"
	moody.set_script(load(MOODS_SCRIPT))
	root.add_child(moody)
	var sized: Dictionary = await node._execute_command(
		"call_method", { "path": "/root/Moody", "method": "size_of", "args": ["BIG"] }
	)
	if sized.get("result") != 9:
		_fail("an inner class's enum takes its name: %s" % JSON.stringify(sized))
	moody.free()

	var high: Dictionary = await _write("level", 12)
	if high.get("type") != "property_set" or high.get("warnings") != ["level is high"]:
		_fail(
			(
				"and a warning from a setter that took the value is beside it: %s"
				% JSON.stringify(high)
			)
		)
