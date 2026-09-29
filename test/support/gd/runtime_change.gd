extends SceneTree

## Writes and calls on declarations the engine describes less than fully: a script class with no
## `class_name`, which it names by the engine class the script extends; a slot declared as Variant,
## which takes anything; a map keyed by numbers; a method given the wrong number of arguments. Each
## refusal is checked beside the write or call that works, so a check that refused everything fails.

const Checked = preload("checked.gd")
const Read = preload("res://addons/gdharness_runtime/reading.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
const WALKER_SCRIPT: String = "res://change_walker.gd"
const HOLDER_SOURCE: String = """extends Node

const Walker = preload("res://change_walker.gd")

var squad: Array[Walker] = []
var by_name: Dictionary[String, Walker] = {}
var gears: Array[Gear] = [Gear.new()]
var quarrel: Walker = null
var loose: Variant = null
var shifting: Variant = 3
var counted: int = 3
var nodes: Array[Node] = [null]
var by_id: Dictionary = {3: "three", 4.5: "four and a half", Vector2i(1, 2): "a pair"}
var spare: RefCounted = RefCounted.new()


func take(given: Walker) -> String:
	return "took " + str(given.name)


func pair(a: int, b: int = 2) -> int:
	return a + b


func many(first: int, ...rest: Array) -> int:
	return first + rest.size()


func noisy() -> int:
	push_error("noisy said so")
	return 1


func _get_property_list() -> Array[Dictionary]:
	return [{"name": "mood", "type": TYPE_NIL, "usage": PROPERTY_USAGE_DEFAULT | PROPERTY_USAGE_NIL_IS_VARIANT}]


func _get(property: StringName) -> Variant:
	if property == &"mood":
		return 3
	return null


func _set(property: StringName, _value: Variant) -> bool:
	return property == &"mood"


class Gear:
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
	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _run() -> void:
	_build()
	await _check_a_script_class_without_a_name()
	await _check_the_argument_count()
	await _check_a_slot_that_takes_anything()
	await _check_an_element_declared_as_an_object()
	await _check_a_map_keyed_by_numbers()
	node._cleanup()
	# Not checked: both are gone either way by the time the fixture tears itself down.
	var _took_directory: Error = DirAccess.remove_absolute(directory)
	var _took_script: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(WALKER_SCRIPT))

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
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
		"set_property", {"path": "/root/Holder", "property": property, "value": value}
	)


func _invoke(method: String, args: Array) -> Dictionary:
	return await node._execute_command(
		"call_method", {"path": "/root/Holder", "method": method, "args": args}
	)


## A typed list of a script with no global name, which the engine hands over as Node3D and the
## script. A Node3D with no script, or another script, passed the class and the engine then dropped
## it from the list, so the game's list came out empty behind an answer of success.
func _check_a_script_class_without_a_name() -> void:
	var walker: Node = root.get_node("Walker")
	for stranger: String in ["/root/Plain", "/root/Other"]:
		var refused: Dictionary = await _write("squad", [stranger])
		var said: String = str(refused.get("message", ""))
		if refused.get("type") != "error" or not said.contains("not an instance of %s" % WALKER_SCRIPT):
			_fail("a list of Walker refuses %s by its script: %s" % [stranger, JSON.stringify(refused)])
		if holder.get("squad") != [walker]:
			_fail("and the game's list is as it was: %s" % str(holder.get("squad")))
	# The guard behind that check: a resolver that lets any object through, so the engine drops the
	# element while building the list, and the list that comes back shorter is refused, not written.
	var lax: Callable = func(_given: Variant, _declared: String, _script: Script) -> Dictionary:
		return {"object": root.get_node("Plain")}
	var built: Dictionary = node.values.typed_like(["/root/Plain"], holder.get("squad"), lax)
	if not str(built.get("message", "")).contains("would not take its elements"):
		_fail("a typed list the engine builds shorter is refused: %s" % str(built))
	var built_map: Dictionary = node.values.typed_like({"a": "/root/Plain"}, holder.get("by_name"), lax)
	if not str(built_map.get("message", "")).contains("would not take its entries"):
		_fail("and so is a typed map: %s" % str(built_map))
	var taken: Dictionary = await _write("squad", ["/root/Walker", "null"])
	if taken.get("type") != "property_set" or holder.get("squad") != [walker, null]:
		_fail("a list of Walker takes a Walker: %s" % JSON.stringify(taken))

	var mapped: Dictionary = await _write("by_name", {"a": "/root/Plain"})
	if mapped.get("type") != "error" or not str(mapped.get("message", "")).contains("not an instance of"):
		_fail("a map of Walker refuses a Node3D by its script: %s" % JSON.stringify(mapped))
	var mapped_right: Dictionary = await _write("by_name", {"a": "/root/Walker"})
	var by_name: Dictionary = holder.get("by_name")
	if mapped_right.get("type") != "property_set" or by_name.get("a") != walker:
		_fail("and takes a Walker: %s" % JSON.stringify(mapped_right))

	# An inner class has no global name and no file either.
	var gears: Array = holder.get("gears")
	var gear: Object = gears[0]
	var inner: Dictionary = await _write("gears", ["/root/Holder:spare"])
	if (
		inner.get("type") != "error"
		or not str(inner.get("message", "")).contains("not an instance of an inner class")
	):
		_fail("a list of an inner class refuses another RefCounted: %s" % JSON.stringify(inner))
	if holder.get("gears") != [gear]:
		_fail("and keeps the gear it held: %s" % str(holder.get("gears")))

	# A single slot and a parameter, where the declaration is only the engine class: the write is
	# refused by what it reads back, and the call by the engine, each saying what the class may be.
	var slot: Dictionary = await _write("quarrel", "/root/Plain")
	var slot_said: String = str(slot.get("message", ""))
	if slot.get("type") != "error" or not slot_said.contains("script class with no class_name"):
		_fail("a Walker slot given a plain Node3D says why it may be refused: %s" % JSON.stringify(slot))
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
		if refused.get("type") != "error" or not str(refused.get("message", "")).ends_with(str(case[2])):
			_fail("%s with %s is refused: %s" % [method, str(args), JSON.stringify(refused)])
	for case: Array in [["pair", [1], 3], ["pair", [1, 5], 6], ["many", [1], 1], ["many", [1, 7, 7, 7], 4]]:
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
		_fail("a method that reports an error still answers what it returned: %s" % JSON.stringify(noisy))
	if raised.size() != 1 or not str(raised[0]).contains("noisy said so"):
		_fail("with what it reported: %s" % JSON.stringify(noisy))


## A slot declared as Variant takes what it is given, as the engine does; one declared as a number
## still refuses a word. The text null empties a Variant slot holding nothing, as a wait on it reads.
func _check_a_slot_that_takes_anything() -> void:
	var numbered: Dictionary = await _write("shifting", 7)
	if numbered.get("type") != "property_set" or typeof(holder.get("shifting")) != TYPE_INT:
		_fail("a Variant slot holding an int keeps a number an int: %s" % JSON.stringify(numbered))
	var worded: Dictionary = await _write("shifting", "idle")
	if worded.get("type") != "property_set" or holder.get("shifting") != "idle":
		_fail("and takes a word: %s" % JSON.stringify(worded))
	var back: Dictionary = await _write("shifting", 5)
	if back.get("type") != "property_set" or typeof(holder.get("shifting")) not in [TYPE_INT, TYPE_FLOAT]:
		_fail("and a number back as a number, not its text: %s" % JSON.stringify(back))
	# One that ignores every write, holding a number and given a word it cannot be compared with, is
	# still refused by what it reads back.
	var ignored: Dictionary = await _write("mood", "cheerful")
	if ignored.get("type") != "error" or not str(ignored.get("message", "")).contains("reads 3 afterwards"):
		_fail("a write the property ignores is refused whatever its kind: %s" % JSON.stringify(ignored))
	var counted: Dictionary = await _write("counted", "idle")
	if counted.get("type") != "error" or not str(counted.get("message", "")).contains("cannot become one"):
		_fail("an int slot still refuses a word: %s" % JSON.stringify(counted))

	var emptied: Dictionary = await _write("loose", "null")
	if (
		emptied.get("type") != "property_set"
		or holder.get("loose") != null
		or typeof(holder.get("loose")) != TYPE_NIL
	):
		_fail(
			"the text null leaves a Variant slot holding nothing, not the word: %s" % JSON.stringify(emptied)
		)
	var worded_loose: Dictionary = await _write("loose", "idle")
	if worded_loose.get("type") != "property_set" or holder.get("loose") != "idle":
		_fail("and any other word is stored as the word: %s" % JSON.stringify(worded_loose))
	var met: Dictionary = await node._execute_command(
		"wait_until", {"path": "/root/Holder", "property": "loose", "value": "idle", "timeout_ms": 1000}
	)
	if met.get("met") != true:
		_fail("a wait reads the same slot the same way: %s" % JSON.stringify(met))

	# A slot that turns into something the value waited for cannot be compared with, a word to a
	# number, ends the wait with what it holds. Comparing them is an error raised inside the game.
	holder.set("loose", "waiting")
	var turn: Callable = func() -> void: holder.set("loose", 3)
	Checked.done(process_frame.connect(turn, CONNECT_ONE_SHOT) as Error, "turning the slot mid-wait")
	var turned: Dictionary = await node._execute_command(
		"wait_until", {"path": "/root/Holder", "property": "loose", "value": "done", "timeout_ms": 3000}
	)
	if (
		turned.get("met") != false
		or turned.get("value") != 3
		or Read.as_int(turned.get("elapsed_ms"), 0) >= 3000
	):
		_fail("a wait on a slot that turns into a number ends there: %s" % JSON.stringify(turned))


## An element of a typed list of objects: a wait for a number on it is refused as a set of one is,
## rather than waited out, and the text null meets it at once. A record given for an object element
## is told objects go by their path.
func _check_an_element_declared_as_an_object() -> void:
	var impossible: Dictionary = await node._execute_command(
		"wait_until", {"path": "/root/Holder", "property": "nodes:0", "value": 5, "timeout_ms": 3000}
	)
	if (
		impossible.get("type") != "error"
		or not str(impossible.get("message", "")).contains("declared to hold an object")
	):
		_fail("a wait for a number on an object element is refused: %s" % JSON.stringify(impossible))
	var emptied: Dictionary = await node._execute_command(
		"wait_until", {"path": "/root/Holder", "property": "nodes:0", "value": "null", "timeout_ms": 1000}
	)
	if emptied.get("met") != true or emptied.get("frames") != 0:
		_fail("and the text null meets the empty element at once: %s" % JSON.stringify(emptied))
	var recorded: Dictionary = await _write("nodes", [{"_type": "Node", "path": "/root/Plain"}])
	if recorded.get("type") != "error" or not str(recorded.get("message", "")).contains("named by its path"):
		_fail("a record for an object element is told how objects are named: %s" % JSON.stringify(recorded))


## A map keyed by numbers, stepped into by the number written as text, and written back under the
## key it has rather than beside it under the text.
func _check_a_map_keyed_by_numbers() -> void:
	for case: Array in [["3", "three"], ["4.5", "four and a half"]]:
		var read: Dictionary = await node._execute_command(
			"get_property", {"path": "/root/Holder", "property": "by_id:" + str(case[0])}
		)
		if read.get("value") != case[1]:
			_fail("by_id:%s reads its entry: %s" % [case[0], JSON.stringify(read)])
	var written: Dictionary = await _write("by_id:3", "drei")
	var map: Dictionary = holder.get("by_id")
	if written.get("type") != "property_set" or map.get(3) != "drei" or map.size() != 3:
		_fail("by_id:3 is written under the number: %s, %s" % [JSON.stringify(written), str(map)])
	var paired: Dictionary = await node._execute_command(
		"get_property", {"path": "/root/Holder", "property": "by_id:(1, 2)"}
	)
	var said: String = str(paired.get("message", ""))
	if paired.get("type") != "error" or not said.contains("has a key that reads (1, 2), but it is Vector2i"):
		_fail("a key a step cannot spell is named by its type: %s" % JSON.stringify(paired))
