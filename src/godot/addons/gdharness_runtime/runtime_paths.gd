extends RefCounted

## Colon paths through what a node holds: "/root/Main" with "_game:run:day" reaches the day off the
## run off the game the node keeps. Every op that reads, writes, calls or waits on a game's state
## walks the same way, so the walk and what it says when a step is not there live in one place.

const Values = preload("runtime_values.gd")

## The calls a path makes on a list or a map: those that take no arguments and change nothing.
##
## Named rather than asked of the engine, because asking about a method a list does not have logs an
## error into the game's output, and a typo in a path is not the game's error. The ones that change
## what they are called on, such as clear(), sort() and pop_back(), are left out: a path is how a
## read and a wait reach what they read, and a wait asks many times.
const LIST_CALLS: Array[String] = [
	"size",
	"is_empty",
	"front",
	"back",
	"max",
	"min",
	"pick_random",
	"hash",
	"duplicate",
	"duplicate_deep",
	"is_read_only",
	"is_typed",
	"get_typed_builtin",
	"get_typed_class_name",
	"get_typed_script",
]
const MAP_CALLS: Array[String] = [
	"size",
	"is_empty",
	"keys",
	"values",
	"hash",
	"duplicate",
	"duplicate_deep",
	"is_read_only",
	"is_typed",
	"is_typed_key",
	"is_typed_value",
	"get_typed_key_builtin",
	"get_typed_key_class_name",
	"get_typed_key_script",
	"get_typed_value_builtin",
	"get_typed_value_class_name",
	"get_typed_value_script",
]
## The calls an empty list has nothing to answer, which the engine reports as an error when asked.
const NEEDS_AN_ELEMENT: Array[String] = ["front", "back", "pick_random"]


## What [param reaching] names something on, which is the node itself until the name has a colon
## in it, and the last name along that path.
##
## A game's state does not sit on nodes, it hangs off them: the speed of the clock is a property of
## a [RefCounted] held by a [RefCounted] held by the root, and that is what an agent asks about.
## What a game does hangs off them the same way, so the last name is a property to read, a property
## to write or a method to call, and the walk to it is one walk.
##
## Colons, because that is the separator [method Object.get_indexed] already takes. Walked a step
## at a time rather than handed to that method, which answers null for a path that goes wrong
## halfway along and for one that ends on null.
##
## A step written as a call, "get_viewport()", calls a method of that name that takes no arguments
## and walks into what it returned. Some of what hangs off a node is only reachable by asking:
## which control holds the focus is a question for the viewport a control is in, and the viewport
## is a method's answer rather than a property. Spelled with the brackets so a reader sees a call
## where one happens, and so a method can never shadow a property of the same name. A list or a map
## answers the calls that read it, "board:size()" or "inbox:keys()", listed in [constant LIST_CALLS]
## and [constant MAP_CALLS].
##
## Answers with a `message` instead when a step along the way is not there or holds something that
## is not an object, naming the step rather than the whole path: "/root/Main:_game has no property
## clocks" is a typo found, and "no property _game:clocks:speed" is a puzzle.
static func walk_to(node: Node, node_path: String, reaching: String) -> Dictionary:
	var parts: PackedStringArray = reaching.split(":")
	var holder: Variant = node
	var called: String = node_path
	for step: int in parts.size() - 1:
		var named: String = parts[step]
		if not can_read(holder, named):
			return {"type": "error", "message": nothing_there(holder, named, called)}
		holder = read_under(holder, named)
		called = "%s:%s" % [called, named]
		if not _can_hold(holder):
			var wanted: String = parts[step + 1]
			return {"type": "error", "message": "%s holds no object to read %s off" % [called, wanted]}
	return {"holder": holder, "name": parts[parts.size() - 1], "called": called}


## The object [param given] names for a method's argument, as `{"object": ...}`, or as
## `{"message": ...}` saying why it names none.
##
## A colon path read from [param node], the node the call was made on, the way the method's own
## path is: "_ladder:shop:_wares:-15". One beginning with a slash starts at the node it names
## instead, "/root/Main/Hud" or "/root/Main:_game:run". The record runtime_inspect answers an object
## with is not accepted, because its id is a 64-bit number and does not survive being sent as JSON:
## a rounded id names another object or none, and the path names the one meant.
static func object_at(root: Node, node: Node, node_path: String, given: Variant) -> Dictionary:
	if given is Dictionary:
		return {
			"message":
			(
				"an object is named by its path, not by the record runtime_inspect answered with:"
				+ " its id does not survive the trip as a number"
			)
		}
	var path: String = given
	var start: Node = node
	var start_path: String = node_path
	var reaching: String = path
	if path.begins_with("/"):
		var colon: int = path.find(":")
		start_path = path if colon == -1 else path.substr(0, colon)
		var standing: Dictionary = Values.node_at(root, start_path)
		if standing.has("message"):
			return {"message": str(standing["message"])}
		start = standing["node"]
		if colon == -1:
			return {"object": start}
		reaching = path.substr(colon + 1)
	if reaching.is_empty():
		return {"message": "%s names nothing past the node" % path}
	var reached: Dictionary = walk_to(start, start_path, reaching)
	if reached.has("message"):
		return {"message": str(reached["message"])}
	var holder: Variant = reached["holder"]
	var name: String = reached["name"]
	if not can_read(holder, name):
		return {"message": nothing_there(holder, name, str(reached["called"]))}
	var value: Variant = read_under(holder, name)
	if not value is Object or not is_instance_valid(value):
		return {
			"message": "%s:%s holds %s, not an object" % [reached["called"], name, type_string(typeof(value))]
		}
	return {"object": value}


## Whether a step can be taken into [param value] at all: an object, a list or a map can be walked
## into, and a number or a string is where a path ends whether the caller meant it to or not.
static func _can_hold(value: Variant) -> bool:
	return value is Object or value is Array or value is Dictionary


## What is wrong with reading [param named] off [param holder], or "" when nothing is.
##
## Public because a wait asks the same question before it starts waiting, and used to answer it by
## waiting: a property nobody has spends the whole timeout and comes back "not met", which reads
## exactly like a game that never reached the state. The read refuses a mistyped name in one call
## and says so, and the two tools disagreeing about one typo is worth more than the duplication.
static func nothing_under(holder: Variant, named: String, called: String) -> String:
	return "" if can_read(holder, named) else nothing_there(holder, named, called)


## Whether [param named] is something [param holder] has.
##
## Three kinds of holder, because the state a game keeps is not all properties of objects: a roster
## is a list and an in-tray is a map, and a path that could not step into either stopped at the
## first one. An index reads the way a property does, and a negative one counts from the end the
## way GDScript's own does, so reading the last of something does not mean asking how many first.
static func can_read(holder: Variant, named: String) -> bool:
	if holder is Array:
		var items: Array = holder
		var list_call: String = method_of(named)
		if not list_call.is_empty():
			return list_call in LIST_CALLS and not (items.is_empty() and list_call in NEEDS_AN_ELEMENT)
		return _index_in(named, items.size()) != -1
	if holder is Dictionary:
		var map: Dictionary = holder
		if not method_of(named).is_empty():
			return method_of(named) in MAP_CALLS
		return map.has(named) or map.has(StringName(named))
	if holder is Object:
		var object: Object = holder
		var method: String = method_of(named)
		if not method.is_empty():
			return _arguments_required(object, method) == 0
		return _has_property(object, named)
	return false


## The method a step written as a call names, "get_viewport()" being get_viewport, or "" for a
## step that is a name.
static func method_of(named: String) -> String:
	return named.trim_suffix("()") if named.ends_with("()") else ""


## How many arguments [param method] on [param object] has to be given, or -1 when there is no such
## method. Read off the method list rather than [method Object.has_method], because a path can only
## call a method with nothing, and a method with a required argument called with nothing raises
## inside the game rather than answering.
static func _arguments_required(object: Object, method: String) -> int:
	for entry: Dictionary in object.get_method_list():
		if str(entry.get("name", "")) != method:
			continue
		var params: Array = entry.get("args", [])
		var defaults: Array = entry.get("default_args", [])
		return params.size() - defaults.size()
	return -1


## Put [param value] where [param named] points. Only ever called once [method can_read] agrees,
## and lists and maps are reference types, so writing into one reaches the game's own copy.
static func write(holder: Variant, named: String, value: Variant) -> void:
	if holder is Array:
		var items: Array = holder
		items[_index_in(named, items.size())] = value
		return
	if holder is Dictionary:
		var map: Dictionary = holder
		# Written back under the key it was found under, since a map keyed by StringName and one
		# keyed by String both read the same way and a write to the wrong one adds a second entry.
		if map.has(named):
			map[named] = value
		else:
			map[StringName(named)] = value
		return
	var object: Object = holder
	object.set(named, value)


## What [param holder] holds under [param named], or answers to it when [param named] is a call.
## Only ever called once [method can_read] agrees.
static func read_under(holder: Variant, named: String) -> Variant:
	if (holder is Array or holder is Dictionary) and not method_of(named).is_empty():
		return Callable.create(holder, method_of(named)).call()
	if holder is Array:
		var items: Array = holder
		return items[_index_in(named, items.size())]
	if holder is Dictionary:
		var map: Dictionary = holder
		if map.has(named):
			return map[named]
		return map[StringName(named)]
	var object: Object = holder
	var method: String = method_of(named)
	if not method.is_empty():
		return object.call(method)
	return object.get(named)


## Where [param named] lands in a list of [param size], or -1 for a step that is not in it.
##
## -1 for "nowhere" is safe because every answer this gives is an index into a list that long, so a
## real one is never negative by the time it is returned.
static func _index_in(named: String, size: int) -> int:
	if not named.is_valid_int():
		return -1
	var index: int = int(named)
	if index < 0:
		index += size
	return index if index >= 0 and index < size else -1


## Why a step could not be taken, said in the terms of what was actually there.
##
## "has no property 0" about a list is a true sentence that sends somebody looking for a property,
## so a list says how long it is and a map says what it is keyed by. The step is named rather than
## the whole path, because the step is the typo.
static func nothing_there(holder: Variant, named: String, called_as: String) -> String:
	var container_call: String = method_of(named)
	if holder is Array:
		var items: Array = holder
		if container_call in NEEDS_AN_ELEMENT and items.is_empty():
			return "%s is an empty list, so it has no %s" % [called_as, named]
		if not container_call.is_empty():
			return container_calls_refused(called_as, "a list", container_call)
		return "%s is a list of %d, so there is no %s in it" % [called_as, items.size(), named]
	if holder is Dictionary:
		if not container_call.is_empty():
			return container_calls_refused(called_as, "a map", container_call)
		var map: Dictionary = holder
		var keys: Array = map.keys()
		# Eight of them, because a map keyed by something unexpected is told by the first few and a
		# map of two hundred would bury the sentence saying which key was missing.
		var some: Array[String] = []
		for key: Variant in keys.slice(0, 8):
			some.append(str(key))
		var rest: String = ""
		if keys.size() > 8:
			rest = " and %d more" % [keys.size() - 8]
		return "%s has no key %s; it is keyed by %s%s" % [called_as, named, ", ".join(some), rest]
	var object: Object = holder
	var method: String = method_of(named)
	if not method.is_empty():
		var required: int = _arguments_required(object, method)
		if required == -1:
			return "%s has no method %s" % [called_as, method]
		return (
			"%s.%s takes %d argument%s, and a path can only call a method that takes none"
			% [called_as, method, required, "" if required == 1 else "s"]
		)
	# A method spelled as a property is the likeliest thing behind a name the object has no property
	# for, and the caller is one pair of brackets away from what they meant.
	if object.has_method(named):
		return (
			"%s has no property %s; it has a method of that name, which a path calls as %s()"
			% [called_as, named, named]
		)
	return "%s has no property %s" % [called_as, named]


## Why [param method] is not a call a path makes on [param sort] ("a list" or "a map"), naming
## the calls it does make.
static func container_calls_refused(called_as: String, sort: String, method: String) -> String:
	var calls: Array[String] = LIST_CALLS if sort == "a list" else MAP_CALLS
	var spelled: Array[String] = []
	for each: String in calls:
		spelled.append(each + "()")
	return (
		"%s is %s, and %s() is not one of the calls a path makes on one, which read it and take no arguments: %s"
		% [called_as, sort, method, ", ".join(spelled)]
	)


## Whether [param holder] declares [param named]. Asked of the list rather than read, because a
## property read back as null answers it wrongly.
static func _has_property(holder: Object, named: String) -> bool:
	for entry: Dictionary in holder.get_property_list():
		if str(entry["name"]) == named:
			return true
	return false
