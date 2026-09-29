extends RefCounted

## What the server changes in the running game: a property written, a method called. Both take values
## from the wire, so both fit them to what the game declares and refuse what cannot fit, and both read
## back what the engine did rather than trusting that it did it.

const CallErrors = preload("call_errors.gd")
const Paths = preload("runtime_paths.gd")
const Read = preload("reading.gd")
const Values = preload("runtime_values.gd")

## The most errors a call's answer carries, which is enough to see what the method ran into and short
## of a method reporting one per element of a list of thousands.
const ERRORS_KEPT: int = 20

var _host: Node
var _values: Values


## The host is the autoload, which is how the tree is reached: it is not in one when the
## modules are built, and a fixture may put it in one later.
func _init(host: Node, values: Values) -> void:
	_host = host
	_values = values


func set_property(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var value: Variant = params.get("value")

	if node_path.is_empty() or property.is_empty():
		return {"type": "error", "message": "Node path and property required"}

	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]

	# Through a path as well, for the reason [method Paths.walk_to] gives, and read back off the same
	# holder afterwards: a set that does not take says so by answering with the old value, which is
	# how a typed container refusing a write is told from one accepting it.
	var reached: Dictionary = Paths.walk_to(node, node_path, property)
	if reached.has("message"):
		return reached

	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	# A call can be walked through and read, and is not a place: what it returns is the method's
	# to hand out, and writing "into" it would set nothing the game keeps.
	if not Paths.method_of(named).is_empty():
		return {
			"type": "error",
			"message":
			(
				"%s:%s is a call, and a call is not a place to write: name a property"
				% [reached["called"], named]
			)
		}
	if not Paths.can_read(holder, named):
		return {"type": "error", "message": Paths.nothing_there(holder, named, str(reached["called"]))}
	var old_value: Variant = Paths.read_under(holder, named)
	# The same rule the call path holds: a value that cannot become what the property holds is
	# refused rather than written. Writing it means the engine picks something, and what it picks
	# for a word where a number goes is zero, which the answer then reports as the new value.
	#
	# A slot declaring nothing, an untyped or Variant property or an element of an untyped list, takes
	# anything, and the engine stores what it is given there. What it holds now still says how a value
	# of the same kind is meant, 5 into an int staying an int, and whether a path names an object, but
	# a value of another kind is stored as sent: a word into one holding a number is the word, and a
	# number into one holding a word is the number, not its text. The text null empties it when it
	# holds an object or nothing, as a wait reads it on the same slot.
	var slot: Dictionary = Values.slot_declared(holder, named)
	var declared: int = slot["type"]
	var declared_script: Script = slot["script"]
	var wanted: int = declared if declared != TYPE_NIL else typeof(old_value)
	var holds_objects: bool = (
		declared == TYPE_OBJECT or (declared == TYPE_NIL and (old_value == null or old_value is Object))
	)
	var given: Variant
	if holds_objects and names_no_object(value):
		given = null
	elif wanted == TYPE_OBJECT and (value is String or value is Dictionary):
		var named_object: Dictionary = _object_named(
			node, node_path, value, str(slot["class"]), declared_script
		)
		if named_object.has("message"):
			return {
				"type": "error",
				"message": "%s.%s holds an object: %s" % [reached["called"], named, named_object["message"]]
			}
		given = named_object["object"]
	else:
		var as_sent: Variant = _values.fitted(value, TYPE_NIL)
		if declared == TYPE_NIL and not Values.acceptable(as_sent, wanted):
			given = as_sent
		else:
			given = _values.fitted(value, wanted)
			if not Values.acceptable(given, wanted):
				return {
					"type": "error",
					"message":
					(
						"%s.%s holds %s and the value given is %s, which cannot become one."
						% [reached["called"], named, type_string(wanted), type_string(typeof(given))]
					)
				}
		var typed: Dictionary = _values.typed_like(given, old_value, _element_object.bind(node, node_path))
		if typed.has("message"):
			return {
				"type": "error",
				"message":
				"%s.%s is a typed %s: %s." % [reached["called"], named, _sort_of(old_value), typed["message"]]
			}
		given = typed["value"]
	# The write alone, setter included, which is where a property's cost is.
	var began: int = Time.get_ticks_usec()
	Paths.write(holder, named, given)
	var elapsed: int = Time.get_ticks_usec() - began
	var now: Variant = Paths.read_under(holder, named)
	# Read back rather than trusted. The engine drops a write it will not take without a word, and
	# the answer then showed the old value as the new one, shaped as a success: a typed container
	# refusing a plain list did exactly that. A value the property changed on the way in, a setter
	# clamping it, still changed it, so only a write that left the property as it was is refused.
	# And only one that asked for a change: the value the property already held, written again, left
	# it as it was because nothing was asked of it.
	#
	# Said as what was seen, because two causes look the same from here: the engine refusing the write,
	# and a setter that ran and left the value where it was, clamping it, say. The one this can name
	# is an object slot checked only by the engine class a script extends (see
	# [method Values.slot_declared]), where an object of that class with another script is refused.
	#
	# Judged by what reads back alone, so a value of another kind than the one held, which cannot be
	# compared with it, is still caught when the engine drops it.
	var already: bool = _held_already(given, old_value)
	var unmoved: bool = Values.comparable(now, old_value) and now == old_value
	if unmoved and not already:
		var why: String = (
			"the write left it as it was, which is what the engine refusing it and a setter keeping the"
			+ " value both look like"
		)
		if declared == TYPE_OBJECT and given is Object and declared_script == null:
			var refused_object: Object = given
			why += (
				(
					". %s is declared as %s, which is also how the engine names a script class with no"
					+ " class_name; if it is one, the object given has the right class and another script:"
					+ " it is %s"
				)
				% [named, str(slot["class"]), Values.class_of(refused_object)]
			)
		return {
			"type": "error",
			"message":
			(
				"%s.%s was given %s and reads %s afterwards, as it did before: %s."
				% [
					reached["called"],
					named,
					JSON.stringify(_values.serialize(given)),
					JSON.stringify(_values.serialize(now)),
					why,
				]
			)
		}

	var answer: Dictionary = {
		"type": "property_set",
		"path": node_path,
		"property": property,
		"old_value": _values.serialize(old_value),
		"new_value": _values.serialize(now),
		"elapsed_usec": elapsed
	}
	if already and unmoved:
		answer["unchanged"] = true
	return answer


## Whether [param given] is the value [param held] already is, at the precision the property keeps.
##
## A float arrives as 64 bits and most engine properties keep 32: Camera3D.h_offset given -1.1
## reads back as -1.10000002384186, so comparing the two exactly took a write of the value already
## held for one the engine refused (#780). Rounding both to 32 bits is exact for a 32-bit property.
## A 64-bit one can take a write this calls the same and read back changed, and the caller calls a
## write unchanged only when it reads back as it was. What that cannot tell apart is a 64-bit
## property whose setter ignored a value differing from the held one below 32 bits: it is answered
## unchanged rather than refused. Vectors and colours hold 32-bit parts in the value itself, so they
## already compare at the property's precision.
static func _held_already(given: Variant, held: Variant) -> bool:
	if not Values.comparable(given, held):
		return false
	if given == held:
		return true
	if typeof(given) != TYPE_FLOAT or typeof(held) != TYPE_FLOAT:
		return false
	return PackedFloat32Array([given])[0] == PackedFloat32Array([held])[0]


func call_method(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var method: String = str(params.get("method", ""))
	var args: Array = params.get("args", [])

	if node_path.is_empty() or method.is_empty():
		return {"type": "error", "message": "Node path and method required"}

	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]

	# Through a path as well, for the reason [method Paths.walk_to] gives. What a game does hangs off its
	# nodes as much as its state does, so reading `_game:run:day` while being unable to call
	# `_game:run:advance` answers half of what a node holds and refuses the other half.
	var reached: Dictionary = Paths.walk_to(node, node_path, method)
	if reached.has("message"):
		return reached

	# A list or a map answers the calls a path makes on one, and nothing else: said in those terms
	# rather than as "has no method", which reads as a misspelling of a method that was never going
	# to be there, and with the element spelled out, since a method on what it holds is the usual aim.
	if not reached["holder"] is Object:
		var sort: String = "a list"
		if reached["holder"] is Dictionary:
			sort = "a map"
		elif Paths.packed(reached["holder"]):
			sort = "a packed list"
		var spelled: String = str(reached["name"])
		if Paths.method_of(spelled).is_empty():
			spelled += "()"
		if args.is_empty() and Paths.can_read(reached["holder"], spelled):
			var read_from: int = Time.get_ticks_usec()
			var answered: Variant = Paths.read_under(reached["holder"], spelled)
			var read_for: int = Time.get_ticks_usec() - read_from
			return {
				"type": "method_result",
				"path": node_path,
				"method": method,
				"result": _values.serialize(answered),
				"elapsed_usec": read_for,
			}
		var why: String = (
			"%s:%s takes no arguments" % [reached["called"], spelled]
			if Paths.can_read(reached["holder"], spelled)
			else Paths.nothing_there(reached["holder"], spelled, str(reached["called"]))
		)
		return {
			"type": "error",
			"message":
			(
				"%s. A method of what %s holds is called on the element, as in %s:0:%s"
				% [why, sort, reached["called"], reached["name"]]
			)
		}
	var holder: Object = reached["holder"]
	var named: String = reached["name"]
	# The method a call ends on is the one being called whether or not it carries the brackets a
	# step along the way would: "get_viewport():gui_get_focus_owner()" is the same call as without
	# the last pair.
	if not Paths.method_of(named).is_empty():
		named = Paths.method_of(named)
	if not holder.has_method(named):
		return {"type": "error", "message": "%s has no method %s" % [reached["called"], named]}

	# Checked before the call rather than left to it. `callv` raises inside the game when an
	# argument cannot be converted, and an error raised in a game somebody is playing holds it at a
	# debugger break: every later call then reports a game that is not responding, which points
	# nowhere near the argument. A wrong argument costs a refusal, never the session's game.
	var count: String = _argument_count_refused(holder, named, args.size())
	if not count.is_empty():
		return {"type": "error", "message": "%s.%s %s" % [reached["called"], named, count]}
	var deserialized_args: Array = []
	# The object arguments checked only against the engine class, by position from 1, for the refusal
	# the engine may still make: see [method Values.slot_declared].
	var by_engine_class: Dictionary = {}
	for index: int in args.size():
		var wants: int = _values.parameter_type(holder, named, index)
		if wants == TYPE_OBJECT and (args[index] is String or args[index] is Dictionary):
			var declared: String = _values.parameter_class(holder, named, index)
			var named_object: Dictionary = _object_named(node, node_path, args[index], declared)
			if named_object.has("message"):
				return {
					"type": "error",
					"message":
					"%s.%s argument %d: %s" % [reached["called"], named, index + 1, named_object["message"]]
				}
			var resolved: Object = named_object["object"]
			if resolved != null and ClassDB.class_exists(declared):
				by_engine_class[index + 1] = [declared, Values.class_of(resolved)]
			deserialized_args.append(named_object["object"])
			continue
		var given: Variant = _values.fitted(args[index], wants)
		if not Values.acceptable(given, wants):
			return {
				"type": "error",
				"message":
				(
					"%s.%s takes %s as argument %d and was given %s, which cannot be converted."
					% [reached["called"], named, type_string(wants), index + 1, type_string(typeof(given))]
				)
			}
		# A typed list or map is built as one, since a plain one handed to such a parameter raises
		# inside the game, which is what every check here exists to stop.
		var container: Variant = _values.parameter_container(holder, named, index)
		if container != null:
			var typed: Dictionary = _values.typed_like(
				given, container, _element_object.bind(node, node_path)
			)
			if typed.has("message"):
				return {
					"type": "error",
					"message":
					(
						"%s.%s takes a typed %s as argument %d: %s."
						% [reached["called"], named, _sort_of(container), index + 1, typed["message"]]
					)
				}
			given = typed["value"]
		deserialized_args.append(given)

	# Timed around the call alone, since the bridge's round trip is a second or more and swamps what
	# one click's work costs; the frame metrics read whichever frame is last, which is not this one.
	# Listened to as well, because a call the engine refused returns null like one that ran.
	var caught: CallErrors = CallErrors.new()
	OS.add_logger(caught)
	var began: int = Time.get_ticks_usec()
	var result: Variant = holder.callv(named, deserialized_args)
	var elapsed: int = Time.get_ticks_usec() - began
	OS.remove_logger(caught)

	if not caught.refused.is_empty():
		var message: String = (
			"%s.%s did not run: the engine refused the call: %s"
			% [reached["called"], named, caught.refused.trim_suffix(".")]
		)
		var position: RegExMatch = RegEx.create_from_string(r"Cannot convert argument (\d+)").search(
			caught.refused
		)
		if position != null and by_engine_class.has(int(position.get_string(1))):
			var checked: Array = by_engine_class[int(position.get_string(1))]
			message += (
				(
					". The parameter is declared as %s, which is also how the engine names a script class"
					+ " with no class_name; if it is one, the object given has the right class and another"
					+ " script: it is %s"
				)
				% checked
			)
		return {"type": "error", "message": message + "."}

	var answer: Dictionary = {
		"type": "method_result",
		"path": node_path,
		"method": method,
		"result": _values.serialize(result),
		"elapsed_usec": elapsed
	}
	if not caught.raised.is_empty():
		answer["errors"] = caught.raised.slice(0, ERRORS_KEPT)
		if caught.raised.size() > ERRORS_KEPT:
			answer["errors_not_shown"] = caught.raised.size() - ERRORS_KEPT
	return answer


## Why [param given] arguments are the wrong number for [param method], or "" when they are not.
##
## Asked before the call, because `callv` given the wrong number refuses inside the game and returns
## null, and the method list says how many a method takes: its parameters less those with defaults,
## up to all of them, or any number past that for one taking varargs.
static func _argument_count_refused(holder: Object, method: String, given: int) -> String:
	for entry: Dictionary in holder.get_method_list():
		if str(entry.get("name", "")) != method:
			continue
		var parameters: Array = entry.get("args", [])
		var defaults: Array = entry.get("default_args", [])
		var most: int = parameters.size()
		var least: int = most - defaults.size()
		var any_more: bool = (Read.as_int(entry.get("flags", 0), 0) & METHOD_FLAG_VARARG) != 0
		if given >= least and (given <= most or any_more):
			return ""
		var takes: String = "%d" % least
		if any_more:
			takes = "at least %d" % least
		elif most != least:
			takes = "%d to %d" % [least, most]
		var one: bool = least == 1 and (most == least or any_more)
		return "takes %s argument%s and was given %d" % [takes, "" if one else "s", given]
	return ""


## [method _object_named] with the path first, which is the order [method Values.typed_like] calls
## an element resolver in.
func _element_object(
	given: Variant, declared: String, script: Script, node: Node, node_path: String
) -> Dictionary:
	return _object_named(node, node_path, given, declared, script)


## "list" or "map", for a refusal about a typed container.
static func _sort_of(container: Variant) -> String:
	return "list" if container is Array else "map"


## The object [param given] names for a slot or a parameter declared as [param declared], as
## `{"object": ...}`, or `{"message": ...}` saying why it names none that fits.
##
## JSON cannot carry an object, so one the game holds is named by its path, read from the node the
## call or the write was made on, and handed over as that instance rather than a copy: a method
## given a piece of the game's state acts on the piece the game keeps, and a slot written with one
## holds the game's own.
##
## The text null names no object, which is what an object slot or parameter takes to be emptied. A
## caller's null arrived as that text in #772 and #783, and was looked up as a node called "null".
##
## Checked against [param script] where the declaration hands one over, which only a typed container
## does: see [method Values.is_a].
func _object_named(
	node: Node, node_path: String, given: Variant, declared: String, script: Script = null
) -> Dictionary:
	if names_no_object(given):
		return {"object": null}
	var found: Dictionary = Paths.object_at(_host.get_tree().root, node, node_path, given)
	if found.has("message"):
		return found
	var instance: Object = found["object"]
	if script != null and not Values.is_a(instance, declared, script):
		var wanted: String = "an instance of %s" % Values.script_named(script)
		if not script.get_global_name().is_empty():
			wanted = "a %s" % script.get_global_name()
		return {"message": "%s is %s, not %s" % [str(given), Values.class_of(instance), wanted]}
	if script == null and not declared.is_empty() and not Values.is_a(instance, declared):
		return {"message": "%s is %s, not a %s" % [str(given), Values.class_of(instance), declared]}
	return found


## Whether [param given] is the text null, which is how a caller's null arrives. Public because a
## wait reads the same text the same way.
static func names_no_object(given: Variant) -> bool:
	return given is String and str(given).strip_edges() == "null"
