extends RefCounted

## What the server changes in the running game: a property written, a method called. Both take values
## from the wire, so both fit them to what the game declares and refuse what cannot fit, and both read
## back what the engine did rather than trusting that it did it.

const GdhCallErrors = preload("call_errors.gd")
const GdhDeclared = preload("declared_values.gd")
const GdhPaths = preload("runtime_paths.gd")
const GdhRead = preload("reading.gd")
const GdhValues = preload("runtime_values.gd")

## The most errors a call's answer carries, which is enough to see what the method ran into and short
## of a method reporting one per element of a list of thousands.
const ERRORS_KEPT: int = 20

var _host: Node
var _values: GdhValues


## The host is the autoload, which is how the tree is reached: it is not in one when the
## modules are built, and a fixture may put it in one later.
func _init(host: Node, values: GdhValues) -> void:
	_host = host
	_values = values


func set_property(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var value: Variant = params.get("value")

	if node_path.is_empty() or property.is_empty():
		return {"type": "error", "message": "Node path and property required"}

	var standing: Dictionary = GdhValues.target_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	var target: Object = standing["object"]

	# Through a path as well, for the reason [method GdhPaths.walk_to] gives, and read back off the same
	# holder afterwards: a set that does not take says so by answering with the old value, which is
	# how a typed container refusing a write is told from one accepting it.
	var reached: Dictionary = GdhPaths.walk_to(target, node_path, property)
	if reached.has("message"):
		return reached

	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	# A call can be walked through and read, and is not a place: what it returns is the method's
	# to hand out, and writing "into" it would set nothing the game keeps.
	if not GdhPaths.method_of(named).is_empty():
		return {
			"type": "error",
			"message":
			(
				"%s:%s is a call, and a call is not a place to write: name a property"
				% [reached["called"], named]
			)
		}
	if not GdhPaths.can_read(holder, named):
		return {"type": "error", "message": GdhPaths.nothing_there(holder, named, str(reached["called"]))}
	var old_value: Variant = GdhPaths.read_under(holder, named)
	var slot: Dictionary = GdhValues.slot_declared(holder, named)
	var declared: int = slot["type"]
	var declared_script: Script = slot["script"]
	var fitting: Dictionary = _value_for(value, slot, old_value, reached, node, node_path)
	if fitting.has("message"):
		return fitting
	var given: Variant = fitting["value"]
	# A component of a vector or a transform is written into a copy, which is put back where it was
	# read from, setter and all; the read back is then taken off the game again, since the copy here
	# says only what was written into it.
	var chain: Array[Dictionary] = reached["chain"]
	var copied: bool = GdhPaths.composite(holder)
	if copied:
		var unwritable: String = GdhPaths.unwritable_copy(chain)
		if not unwritable.is_empty():
			return {"type": "error", "message": unwritable}
	# The write alone, setter included, which is where a property's cost is. Listened to as a call
	# is, since a setter refusing a value says why only in what it reports.
	var caught: GdhCallErrors = GdhCallErrors.new()
	OS.add_logger(caught)
	var began: int = Time.get_ticks_usec()
	var written: Variant = GdhPaths.write(holder, named, given)
	if copied:
		GdhPaths.write_back(chain, written)
	var elapsed: int = Time.get_ticks_usec() - began
	OS.remove_logger(caught)
	var now: Variant = GdhPaths.read_under(holder, named)
	if copied:
		var again: Dictionary = GdhPaths.walk_to(target, node_path, property)
		if again.has("message"):
			return again
		var reread: Variant = again["holder"]
		now = GdhPaths.read_under(reread, named) if GdhPaths.can_read(reread, named) else null
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
	# [method GdhValues.slot_declared]), where an object of that class with another script is refused.
	#
	# Judged by what reads back alone, so a value of another kind than the one held, which cannot be
	# compared with it, is still caught when the engine drops it.
	var already: bool = held_already(given, old_value)
	var unmoved: bool = GdhValues.comparable(now, old_value) and now == old_value
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
				% [named, str(slot["class"]), GdhValues.class_of(refused_object)]
			)
		var refused: String = (
			"%s.%s was given %s and reads %s afterwards, as it did before: %s."
			% [
				reached["called"],
				named,
				JSON.stringify(_values.serialize(given), "", false),
				JSON.stringify(_values.serialize(now), "", false),
				why,
			]
		)
		if not caught.raised.is_empty():
			var reported: PackedStringArray = PackedStringArray(caught.raised.slice(0, ERRORS_KEPT))
			refused += " While it was written the game reported: %s" % "; ".join(reported)
		return {"type": "error", "message": refused}

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
	_keep_reported(answer, "errors", caught.raised)
	_keep_reported(answer, "warnings", caught.warned)
	# The engine stores a number past an export range, or one no enum value has, as given; only the
	# inspector holds a property to them, so the game now holds a value its own script never expected.
	if holder is Object:
		var owner: Object = holder
		var shown: String = JSON.stringify(_values.serialize(now), "", false)
		var declaration: Dictionary = slot["declared"]
		var outside: String = GdhDeclared.outside(owner, declaration, now, shown)
		if not outside.is_empty():
			answer["outside_declared"] = outside
	return answer


## What [param sent] becomes as argument [param index] of the method [param named] on the holder
## [param reached] ends at, as [method GdhPaths.walk_to] answered it, as `{"value": ...}`, or the refusal
## saying why it cannot become one: a number the parameter would have to cut, a value that cannot be
## converted, or a list or map that cannot be built as the typed one the parameter takes.
func _argument_for(
	sent: Variant, index: int, reached: Dictionary, named: String, node: Node, node_path: String
) -> Dictionary:
	var holder: Object = reached["holder"]
	var called: String = reached["called"]
	var wants: int = _values.parameter_type(holder, named, index)
	var choices: Dictionary = _values.parameter_enum(holder, named, index)
	var values: Dictionary = choices.get("values", {})
	if not choices.is_empty() and sent is String and not str(sent).strip_edges().is_valid_int():
		var chosen: Variant = GdhDeclared.enum_named(values, str(sent))
		if chosen == null:
			return {
				"type": "error",
				"message":
				GdhDeclared.enum_argument_refusal(
					"%s.%s" % [called, named], index, str(choices["enum"]), str(sent), values
				)
			}
		return {"value": chosen}
	# A packed list's elements are fitted one by one, and one that cannot become what the list holds
	# is named: converted whole, a word or a fraction among them became 0 or was cut, and the call ran.
	var packed: Variant = GdhValues.packed_template(wants)
	if packed != null and sent is Array:
		var elements: Dictionary = _values.typed_like(sent, packed, _element_object.bind(node, node_path))
		if elements.has("message"):
			return {
				"type": "error",
				"message":
				(
					"%s.%s takes %s as argument %d: %s"
					% [called, named, type_string(wants), index + 1, elements["message"]]
				)
			}
	if GdhValues.cuts(sent, wants):
		return {
			"type": "error",
			"message":
			(
				"%s.%s takes %s as argument %d and was given %s, which %s cannot hold without changing it"
				% [
					called,
					named,
					type_string(wants),
					index + 1,
					JSON.stringify(sent),
					GdhValues.cut_by(wants)
				]
			)
		}
	var rounded: String = GdhValues.inexact(sent, wants)
	if not rounded.is_empty():
		return {
			"type": "error",
			"message": "%s.%s takes int as argument %d: %s." % [called, named, index + 1, rounded]
		}
	var given: Variant = _values.fitted(sent, wants)
	if not GdhValues.acceptable(given, wants):
		return {
			"type": "error",
			"message":
			(
				"%s.%s takes %s as argument %d and was given %s, which cannot be converted.%s"
				% [
					called,
					named,
					type_string(wants),
					index + 1,
					type_string(typeof(given)),
					GdhValues.remedy(sent, wants)
				]
			)
		}
	# A typed list or map is built as one, since a plain one handed to such a parameter raises
	# inside the game, which is what every check here exists to stop.
	var container: Variant = _values.parameter_container(holder, named, index)
	if container == null:
		return {"value": given}
	var typed: Dictionary = _values.typed_like(given, container, _element_object.bind(node, node_path))
	if typed.has("message"):
		return {
			"type": "error",
			"message":
			(
				"%s.%s takes a typed %s as argument %d: %s"
				% [called, named, _sort_of(container), index + 1, typed["message"]]
			)
		}
	return {"value": typed["value"]}


## What [param value] becomes written into the slot [param reached] ends on, as
## [method GdhPaths.walk_to] answered it, as `{"value": ...}`, or the refusal saying why it cannot become
## one.
##
## The same rule the call path holds: a value that cannot become what the property holds is
## refused rather than written. Writing it means the engine picks something, and what it picks
## for a word where a number goes is zero, which the answer then reports as the new value. So is a
## number a whole number or a truth would have to cut, since converting one truncates.
##
## A slot declaring nothing, an untyped or Variant property or an element of an untyped list, takes
## anything, and the engine stores what it is given there. What it holds now still says how a value
## of the same kind is meant, 5 into an int staying an int, and whether a path names an object, but
## a value of another kind is stored as sent: a word into one holding a number is the word, a
## fraction into one holding a whole number is the fraction, and a number into one holding a word is
## the number, not its text. The text null empties it when it holds an object or nothing, as a wait
## reads it on the same slot.
func _value_for(
	value: Variant, slot: Dictionary, old_value: Variant, reached: Dictionary, node: Node, node_path: String
) -> Dictionary:
	var named: String = reached["name"]
	var called: String = reached["called"]
	var declared: int = slot["type"]
	var declared_script: Script = slot["script"]
	var wanted: int = declared if declared != TYPE_NIL else typeof(old_value)
	var declaration: Dictionary = slot["declared"]
	var enum_hint: bool = GdhRead.as_int(declaration.get("hint", PROPERTY_HINT_NONE)) == PROPERTY_HINT_ENUM
	if declared == TYPE_INT and enum_hint and value is String and reached["holder"] is Object:
		var owner: Object = reached["holder"]
		var by_name: Array = GdhDeclared.enum_by_name(owner, declaration, str(value), called)
		if by_name[0]:
			return {"value": by_name[1]}
		if not str(by_name[1]).is_empty():
			return {"type": "error", "message": by_name[1]}
	var packed: Variant = GdhValues.packed_template(wanted)
	if packed != null and value is Array:
		var elements: Dictionary = _values.typed_like(value, packed, _element_object.bind(node, node_path))
		if elements.has("message"):
			return {
				"type": "error",
				"message": "%s.%s holds %s: %s" % [called, named, type_string(wanted), elements["message"]]
			}
	var holds_objects: bool = (
		declared == TYPE_OBJECT or (declared == TYPE_NIL and (old_value == null or old_value is Object))
	)
	if holds_objects and names_no_object(value):
		return {"value": null}
	if wanted == TYPE_OBJECT and (value is String or value is Dictionary):
		var named_object: Dictionary = _object_named(
			node, node_path, value, str(slot["class"]), declared_script
		)
		if named_object.has("message"):
			return {
				"type": "error",
				"message": "%s.%s holds an object: %s" % [called, named, named_object["message"]]
			}
		return {"value": named_object["object"]}
	var rounded: String = GdhValues.inexact(value, wanted)
	if not rounded.is_empty():
		return {"type": "error", "message": "%s.%s holds int: %s." % [called, named, rounded]}
	var as_sent: Variant = _values.fitted(value, TYPE_NIL)
	var cut: bool = GdhValues.cuts(value, wanted)
	var given: Variant = as_sent
	if declared != TYPE_NIL and cut:
		return {
			"type": "error",
			"message":
			(
				"%s.%s holds %s and the value given is %s, which %s cannot hold without changing it"
				% [called, named, type_string(wanted), JSON.stringify(value), GdhValues.cut_by(wanted)]
			)
		}
	if declared != TYPE_NIL or (not cut and GdhValues.acceptable(as_sent, wanted)):
		given = _values.fitted(value, wanted)
		if not GdhValues.acceptable(given, wanted):
			return {
				"type": "error",
				"message":
				(
					"%s.%s holds %s and the value given is %s, which cannot become one.%s"
					% [
						called,
						named,
						type_string(wanted),
						type_string(typeof(given)),
						GdhValues.remedy(value, wanted)
					]
				)
			}
	var typed: Dictionary = _values.typed_like(given, old_value, _element_object.bind(node, node_path))
	if typed.has("message"):
		return {
			"type": "error",
			"message": "%s.%s is a typed %s: %s" % [called, named, _sort_of(old_value), typed["message"]]
		}
	return {"value": typed["value"]}


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
static func held_already(given: Variant, held: Variant) -> bool:
	if not GdhValues.comparable(given, held):
		return false
	if given == held:
		return true
	if typeof(given) != TYPE_FLOAT or typeof(held) != TYPE_FLOAT:
		return false
	return PackedFloat32Array([given])[0] == PackedFloat32Array([held])[0]


## What to do instead of the call [param method] makes on [param sort], the list or map [param
## reached] ends on, which a path does not make. A method of the list itself is the likelier aim
## than one of what it holds when the list has it: told to call append() on an element, a caller
## adding to a list has nowhere to go.
static func _instead_of_a_call(reached: Dictionary, method: String, sort: String) -> String:
	var own: String = GdhPaths.method_of(str(reached["name"]))
	if own.is_empty():
		own = str(reached["name"])
	var steps: PackedStringArray = GdhPaths.steps_of(method)
	var _shortened: int = steps.resize(steps.size() - 1)
	var holding: String = ":".join(steps)
	var through_a_call: bool = false
	for step: String in steps:
		through_a_call = through_a_call or not GdhPaths.method_of(step).is_empty()
	var the: String = "the " + sort.trim_prefix("a ")
	match GdhPaths.container_method(reached["holder"], own):
		"changes":
			if through_a_call:
				return (
					(
						"%s() changes %s: to change it, call a method of the game that changes it, since %s"
						+ " is returned by a call, and runtime_invoke set does not write into what a call returns"
					)
					% [own, the, reached["called"]]
				)
			return (
				(
					"%s() changes %s: to change it, give %s its new value whole with runtime_invoke set,"
					+ " property %s, or call a method of the game that changes it"
				)
				% [own, the, reached["called"], holding]
			)
		"reads":
			return (
				(
					"To look in %s with %s(), read %s whole with runtime_inspect property, property %s, and"
					+ " look in what comes back"
				)
				% [the, own, reached["called"], holding]
			)
	return (
		"A method of what %s holds is called on the element, as in %s:0:%s"
		% [sort, reached["called"], reached["name"]]
	)


func call_method(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var method: String = str(params.get("method", ""))
	var args: Array = params.get("args", [])

	if node_path.is_empty() or method.is_empty():
		return {"type": "error", "message": "Node path and method required"}

	var root: Node = _host.get_tree().root
	var standing: Dictionary = GdhValues.class_at(root, node_path)
	if standing.is_empty():
		standing = GdhValues.target_at(root, node_path)
		if standing.has("message") and node_path.is_valid_ascii_identifier():
			var classes: Array[String] = []
			for declared: Dictionary in ProjectSettings.get_global_class_list():
				classes.append(str(declared.get("class", "")))
			var close: PackedStringArray = GdhRead.nearest(node_path, PackedStringArray(classes))
			standing["message"] = (
				(
					"%s. No global class is called %s either%s; a static function is called with its"
					+ " class's name or its script's res:// path as the path."
				)
				% [
					str(standing["message"]).trim_suffix("."),
					node_path,
					(
						""
						if close.is_empty()
						else (
							", and the nearest %s %s"
							% ["is" if close.size() == 1 else "are", ", ".join(close)]
						)
					),
				]
			)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	var target: Object = standing["object"]

	# Through a path as well, for the reason [method GdhPaths.walk_to] gives. What a game does hangs off its
	# nodes as much as its state does, so reading `_game:run:day` while being unable to call
	# `_game:run:advance` answers half of what a node holds and refuses the other half.
	var reached: Dictionary = GdhPaths.walk_to(target, node_path, method)
	if reached.has("message"):
		return reached

	# A list or a map answers the calls a path makes on one, and nothing else: said in those terms
	# rather than as "has no method", which reads as a misspelling of a method that was never going
	# to be there, and with the element spelled out, since a method on what it holds is the usual aim.
	if not reached["holder"] is Object:
		var sort: String = "a list"
		if reached["holder"] is Dictionary:
			sort = "a map"
		elif GdhPaths.packed(reached["holder"]):
			sort = "a packed list"
		var spelled: String = str(reached["name"])
		if GdhPaths.method_of(spelled).is_empty():
			spelled += "()"
		# A vector or a transform has no element to call a method on, so a call it does not answer is
		# refused without the advice about elements below.
		var answers: bool = GdhPaths.can_read(reached["holder"], spelled)
		var called_on: Variant = reached["holder"]
		if (
			(GdhPaths.composite(called_on) or GdhPaths.textual(called_on))
			and not (args.is_empty() and answers)
		):
			return {
				"type": "error",
				"message":
				(
					"%s:%s takes no arguments" % [reached["called"], spelled]
					if answers
					else GdhPaths.nothing_there(reached["holder"], spelled, str(reached["called"]))
				)
			}
		if args.is_empty() and answers:
			var read_from: int = Time.get_ticks_usec()
			var answered: Variant = GdhPaths.read_under(reached["holder"], spelled)
			var read_for: int = Time.get_ticks_usec() - read_from
			var listed: Dictionary = {
				"type": "method_result",
				"path": node_path,
				"method": method,
				"result": _values.serialize(answered),
				"elapsed_usec": read_for,
			}
			var asked_of_it: Variant = params.get("properties")
			if _reads_the_result(asked_of_it):
				listed.merge(_read_off_result(answered, asked_of_it))
			return listed
		var why: String = (
			"%s:%s takes no arguments" % [reached["called"], spelled]
			if GdhPaths.can_read(reached["holder"], spelled)
			else GdhPaths.nothing_there(reached["holder"], spelled, str(reached["called"]))
		)
		return {"type": "error", "message": "%s. %s" % [why, _instead_of_a_call(reached, method, sort)]}
	var holder: Object = reached["holder"]
	var named: String = reached["name"]
	# The method a call ends on is the one being called whether or not it carries the brackets a
	# step along the way would: "get_viewport():gui_get_focus_owner()" is the same call as without
	# the last pair.
	var not_called: String = _instance_method(
		holder,
		named if GdhPaths.method_of(named).is_empty() else GdhPaths.method_of(named),
		str(reached["called"])
	)
	if not_called.is_empty():
		not_called = _not_a_method_to_call(holder, named, str(reached["called"]))
	if not not_called.is_empty():
		return {"type": "error", "message": not_called}
	if not GdhPaths.method_of(named).is_empty():
		named = GdhPaths.method_of(named)

	# Checked before the call rather than left to it. `callv` raises inside the game when an
	# argument cannot be converted, and an error raised in a game somebody is playing holds it at a
	# debugger break: every later call then reports a game that is not responding, which points
	# nowhere near the argument. A wrong argument costs a refusal, never the session's game.
	var count: String = _argument_count_refused(holder, named, args.size())
	if not count.is_empty():
		return {"type": "error", "message": "%s.%s %s" % [reached["called"], named, count]}
	var deserialized_args: Array = []
	# The object arguments checked only against the engine class, by position from 1, for the refusal
	# the engine may still make: see [method GdhValues.slot_declared].
	var by_engine_class: Dictionary = {}
	# The enum arguments given a number none of their values has, said beside the answer: the engine
	# passes any number on, and a write of the same number to a property already said so.
	var outside: PackedStringArray = []
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
				by_engine_class[index + 1] = [declared, GdhValues.class_of(resolved)]
			deserialized_args.append(named_object["object"])
			continue
		var argument: Dictionary = _argument_for(args[index], index, reached, named, node, node_path)
		if argument.has("message"):
			return argument
		deserialized_args.append(argument["value"])
		var choices: Dictionary = _values.parameter_enum(holder, named, index)
		if not choices.is_empty():
			var values: Dictionary = choices["values"]
			var stray: String = GdhDeclared.outside_enum_argument(
				index, str(choices["enum"]), argument["value"], values
			)
			if not stray.is_empty():
				var _noted: bool = outside.append(stray)

	# Timed around the call alone, since the bridge's round trip is a second or more and swamps what
	# one click's work costs; the frame metrics read whichever frame is last, which is not this one.
	# Listened to as well, because a call the engine refused returns null like one that ran.
	var caught: GdhCallErrors = GdhCallErrors.new()
	OS.add_logger(caught)
	var began: int = Time.get_ticks_usec()
	var result: Variant = holder.callv(named, deserialized_args)
	OS.remove_logger(caught)
	# A method that awaits hands back its state at the first await and its value only when it ends,
	# so the answer waits for the value; one that takes longer than the server waits is collected by
	# its requestId like any slow call.
	var state: Object = result if result is Object else null
	var awaited: bool = state != null and state.get_class() == "GDScriptFunctionState"
	if awaited:
		result = await Signal(state, &"completed")
	var elapsed: int = Time.get_ticks_usec() - began

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
	if awaited:
		answer["awaited"] = true
	if not outside.is_empty():
		answer["outside_declared"] = " ".join(outside)
	_keep_reported(answer, "errors", caught.raised)
	_keep_reported(answer, "warnings", caught.warned)
	# Main.explode, ended at a null it called into, answered result 0 as if it had counted something.
	if caught.ended_at.has(named):
		answer["ended_by_error_at"] = caught.ended_at[named]
	var asked: Variant = params.get("properties")
	if _reads_the_result(asked):
		answer.merge(_read_off_result(result, asked))
	return answer


## Puts the first [constant ERRORS_KEPT] of [param reported] in [param answer] under [param field],
## with how many more there were, when anything was reported.
static func _keep_reported(answer: Dictionary, field: String, reported: Array[String]) -> void:
	if reported.is_empty():
		return
	answer[field] = reported.slice(0, ERRORS_KEPT)
	if reported.size() > ERRORS_KEPT:
		answer[field + "_not_shown"] = reported.size() - ERRORS_KEPT


## Why [param named], the last step of a call's method, names no method of [param holder] to call, or
## "" when it does. Brackets on it holding arguments are refused rather than read: the arguments are
## taken from args alone, so a call is never made with half of them in one place and half in the
## other, or with the bracketed ones quietly dropped.
static func _not_a_method_to_call(holder: Object, named: String, called: String) -> String:
	var method: String = named
	if not GdhPaths.method_of(named).is_empty():
		var bracketed: Dictionary = GdhPaths.arguments_of(named)
		var in_brackets: Array = bracketed.get("args", [])
		if bracketed.has("message") or not in_brackets.is_empty():
			return (
				"%s:%s: the method a call ends on takes its arguments under args, not in its brackets"
				% [called, named]
			)
		method = GdhPaths.method_of(named)
	if holder.has_method(method):
		return ""
	return GdhPaths.with_methods_offered("%s has no method %s" % [called, method], holder, method)


## Why [param method] cannot be called on [param holder], a script named by its class or its path,
## or "": a function that is not static runs on an instance of the class, which the script is not.
static func _instance_method(holder: Object, method: String, called: String) -> String:
	if not holder is Script:
		return ""
	var script: Script = holder
	for entry: Dictionary in script.get_script_method_list():
		if str(entry.get("name", "")) != method or GdhRead.as_int(entry.get("flags", 0)) & METHOD_FLAG_STATIC:
			continue
		return (
			(
				"%s.%s is not static, so it runs on an instance of the class: call it on a node carrying %s,"
				+ " or on an object a path from one reaches"
			)
			% [called, method, script.resource_path]
		)
	return ""


## Whether a call's `properties` asks for its result to be read: true, or a list of names.
static func _reads_the_result(asked: Variant) -> bool:
	return asked is Array or (asked is bool and asked)


## What [param asked] reads off the object a call answered with: every variable its script declares
## when [param asked] is true, or the properties a list names, each a path walked from the object.
## Off each object of a list or a dictionary the call answered with too, in the result's shape.
##
## In the same answer because an object handed back is otherwise only its class and its instance
## id, and reading one field of it meant finding the same object again by a path into the game's
## private state, which works only where the caller already knows a key; a catalogue of records
## handed back as a list took one call per record. A name that is not there is listed rather than
## refusing the answer, since the call has run by then and its result is what was asked.
func _read_off_result(result: Variant, asked: Variant) -> Dictionary:
	var missing: Array[String] = []
	if result is Array:
		var list: Array = result
		var read_each: Array = []
		for index: int in list.size():
			read_each.append(_read_off_element(list[index], "[%d]" % index, asked, missing))
		return _read_off_many(read_each, list, "Array", missing)
	if result is Dictionary:
		var map: Dictionary = result
		var read_by_key: Dictionary = {}
		for key: Variant in map:
			read_by_key[str(key)] = _read_off_element(map[key], "[%s]" % str(key), asked, missing)
		return _read_off_many(read_by_key, map.values(), "Dictionary", missing)
	if result is Object and not is_instance_valid(result):
		return {
			"properties_note": "the call answered an object that has since been freed, so nothing was read"
		}
	if not result is Object:
		return {
			"properties_note":
			"the call answered %s, which has no properties to read" % type_string(typeof(result))
		}
	var object: Object = result
	var one: Dictionary = _read_off_object(object, asked)
	missing = one["missing"]
	var answered: Dictionary = {"result_properties": one["read"]}
	if not missing.is_empty():
		answered["result_properties_missing"] = missing
	return answered


## What was read off one element of a list or a dictionary a call answered with, or null for one
## that is no object; why a name was not there goes into [param missing], led by [param named].
func _read_off_element(element: Variant, named: String, asked: Variant, missing: Array[String]) -> Variant:
	if not element is Object:
		return null
	if not is_instance_valid(element):
		missing.append("%s is an object that has since been freed" % named)
		return null
	var object: Object = element
	var one: Dictionary = _read_off_object(object, asked)
	var whys: Array[String] = one["missing"]
	for why: String in whys:
		missing.append("%s %s" % [named, why])
	return one["read"]


## The answer for a list or a dictionary, [param read] holding what each element gave, unless none
## of [param elements] is an object.
static func _read_off_many(
	read: Variant, elements: Array, shape: String, missing: Array[String]
) -> Dictionary:
	if not elements.any(func(element: Variant) -> bool: return element is Object):
		return {
			"properties_note":
			"the call answered %s with no object in it, so there are no properties to read" % shape
		}
	var answered: Dictionary = {"result_properties": read}
	if not missing.is_empty():
		answered["result_properties_missing"] = missing
	return answered


## What [param asked] reads off [param object], under read, and why each name it could not read is
## not there, under missing.
func _read_off_object(object: Object, asked: Variant) -> Dictionary:
	var wanted: Array[String] = []
	if asked is Array:
		for name: Variant in asked:
			wanted.append(str(name))
	else:
		wanted = _script_variables(object)
	var read: Dictionary = {}
	var missing: Array[String] = []
	for path: String in wanted:
		var walked: Dictionary = _walk_from(object, path)
		if walked.has("message"):
			missing.append(str(walked["message"]))
		else:
			read[path] = _values.serialize(walked["value"])
	return {"read": read, "missing": missing}


## The variables the script attached to [param object] declares, in the order it declares them.
static func _script_variables(object: Object) -> Array[String]:
	var names: Array[String] = []
	for entry: Dictionary in object.get_property_list():
		var usage: int = entry.get("usage", 0)
		if usage & PROPERTY_USAGE_SCRIPT_VARIABLE != 0:
			names.append(str(entry.get("name", "")))
	return names


## What [param path] reads walked from [param object], as {"value"}, or {"message"} naming the step
## that is not there, by the same rules a path read from a node follows.
static func _walk_from(object: Object, path: String) -> Dictionary:
	var holder: Variant = object
	var called: String = "the result"
	for named: String in GdhPaths.steps_of(path):
		if not GdhPaths.can_hold(holder):
			return {
				"message":
				"%s holds %s, which has nothing to read %s off" % [called, type_string(typeof(holder)), named]
			}
		if not GdhPaths.can_read(holder, named):
			return {"message": GdhPaths.nothing_there(holder, named, called)}
		holder = GdhPaths.read_under(holder, named)
		called = "%s:%s" % [called, named]
	return {"value": holder}


## Why [param given] arguments are the wrong number for [param method], or "" when they are not.
##
## Asked before the call, because `callv` given the wrong number refuses inside the game and returns
## null, and the method list says how many a method takes: its parameters less those with defaults,
## up to all of them, or any number past that for one taking varargs.
static func _argument_count_refused(holder: Object, method: String, given: int) -> String:
	# A node's method list runs to hundreds of entries, and walking it costs a couple of milliseconds
	# of the game's frame; a call giving exactly the arguments the method declares needs no walk.
	if given == holder.get_method_argument_count(method):
		return ""
	for entry: Dictionary in GdhValues.methods_of(holder):
		if str(entry.get("name", "")) != method:
			continue
		var parameters: Array = entry.get("args", [])
		var defaults: Array = entry.get("default_args", [])
		var most: int = parameters.size()
		var least: int = most - defaults.size()
		var any_more: bool = (GdhRead.as_int(entry.get("flags", 0), 0) & METHOD_FLAG_VARARG) != 0
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


## [method _object_named] with the path first, which is the order [method GdhValues.typed_like] calls
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
## does: see [method GdhValues.is_a].
func _object_named(
	node: Node, node_path: String, given: Variant, declared: String, script: Script = null
) -> Dictionary:
	if names_no_object(given):
		return {"object": null}
	var found: Dictionary = GdhPaths.object_at(_host.get_tree().root, node, node_path, given)
	if found.has("message"):
		return found
	var instance: Object = found["object"]
	if script != null and not GdhValues.is_a(instance, declared, script):
		var wanted: String = "an instance of %s" % GdhValues.script_named(script)
		if not script.get_global_name().is_empty():
			wanted = "a %s" % script.get_global_name()
		return {"message": "%s is %s, not %s" % [str(given), GdhValues.class_of(instance), wanted]}
	if script == null and not declared.is_empty() and not GdhValues.is_a(instance, declared):
		return {"message": "%s is %s, not a %s" % [str(given), GdhValues.class_of(instance), declared]}
	return found


## Whether [param given] is the text null, which is how a caller's null arrives. Public because a
## wait reads the same text the same way.
static func names_no_object(given: Variant) -> bool:
	return given is String and str(given).strip_edges() == "null"
