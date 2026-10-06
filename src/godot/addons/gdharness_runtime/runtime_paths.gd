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
## The calls a path makes on a packed list, which has fewer than a list: measured on 4.7.2, it has no
## front(), back(), max(), min() or hash().
const PACKED_CALLS: Array[String] = ["size", "is_empty", "duplicate", "to_byte_array"]
## The packed lists, which a game keeps names and points in as often as it keeps them in an Array.
const PACKED: Array[int] = [
	TYPE_PACKED_BYTE_ARRAY,
	TYPE_PACKED_INT32_ARRAY,
	TYPE_PACKED_INT64_ARRAY,
	TYPE_PACKED_FLOAT32_ARRAY,
	TYPE_PACKED_FLOAT64_ARRAY,
	TYPE_PACKED_STRING_ARRAY,
	TYPE_PACKED_VECTOR2_ARRAY,
	TYPE_PACKED_VECTOR3_ARRAY,
	TYPE_PACKED_COLOR_ARRAY,
	TYPE_PACKED_VECTOR4_ARRAY,
]
## The calls an empty list has nothing to answer, which the engine reports as an error when asked.
const NEEDS_AN_ELEMENT: Array[String] = ["front", "back", "pick_random"]

## Said after every call a path refuses for doing something rather than reading.
const READS_ONLY: String = ", and a path, which a wait reads every frame, only calls methods that read"


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
## A step written as a call, "get_viewport()", calls a method of that name and walks into what it
## returned. Some of what hangs off a node is only reachable by asking: which control holds the
## focus is a question for the viewport a control is in, and the viewport is a method's answer
## rather than a property. Spelled with the brackets so a reader sees a call where one happens, and
## so a method can never shadow a property of the same name. A list or a map answers the calls that
## read it, "board:size()" or "inbox:keys()", listed in [constant LIST_CALLS] and
## [constant MAP_CALLS]. An engine method that reads takes literal arguments in the brackets,
## "get_theme_stylebox(\"panel\"):content_margin_top", since what a control's theme gives it is only
## reachable by naming what is asked for; see [method arguments_of].
##
## Answers with a `message` instead when a step along the way is not there or holds something that
## is not an object, naming the step rather than the whole path: "/root/Main:_game has no property
## clocks" is a typo found, and "no property _game:clocks:speed" is a puzzle.
static func walk_to(node: Node, node_path: String, reaching: String) -> Dictionary:
	var parts: PackedStringArray = steps_of(reaching)
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
	return value is Object or value is Array or value is Dictionary or packed(value)


## Whether [param value] is a packed list. Stepped into the way a list is, by index, and a write into
## one reaches the game's own copy, since packed lists share their storage until one is duplicated.
static func packed(value: Variant) -> bool:
	return typeof(value) in PACKED


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
	var method: String = method_of(named)
	var given: Dictionary = arguments_of(named) if not method.is_empty() else {"args": []}
	if given.has("message"):
		return false
	var args: Array = given["args"]
	if holder is Array:
		var items: Array = holder
		if not method.is_empty():
			return (
				args.is_empty()
				and method in LIST_CALLS
				and not (items.is_empty() and method in NEEDS_AN_ELEMENT)
			)
		return _index_in(named, items.size()) != -1
	if packed(holder):
		if not method.is_empty():
			return args.is_empty() and method in PACKED_CALLS
		return _index_in(named, len(holder)) != -1
	if holder is Dictionary:
		var map: Dictionary = holder
		if not method.is_empty():
			return args.is_empty() and method in MAP_CALLS
		return not _key_in(map, named).is_empty()
	if holder is Object:
		var object: Object = holder
		if not method.is_empty():
			return call_refused(object, method, "", args.size()).is_empty()
		return _has_property(object, named)
	return false


## The key of [param map] a step names, in a list of one, or an empty list when it names none.
##
## A step is text, and a map is keyed by whatever the game put in it: text, a StringName, or a
## number, which a map of units by id is. Keyed by 3, "3" is not a key of it, measured on 4.7.2, so a
## step that reads as a number is tried as one after the two spellings of text.
##
## A map typed by its key is asked only in that type. It checks every key it is asked about and
## reports an engine error for one of another type, so a step into a map typed by an enum read the
## right entry and left four errors in the game's log for each of the two walks, and the run was
## counted as unclean for a read.
static func _key_in(map: Dictionary, named: String) -> Array:
	var spellings: Array = [named, StringName(named)]
	if named.is_valid_int():
		spellings.append(int(named))
	if named.is_valid_float():
		spellings.append(float(named))
	var typed: int = map.get_typed_key_builtin() if map.is_typed_key() else TYPE_NIL
	for key: Variant in spellings:
		if typed != TYPE_NIL and typeof(key) != typed:
			continue
		if map.has(key):
			return [key]
	return []


## [param reaching] split into its steps at each colon, except one inside a call's brackets or a
## quoted argument: `get_node("/root/Main"):name` is two steps, and split at every colon a quoted
## argument holding one became a step that names nothing.
static func steps_of(reaching: String) -> PackedStringArray:
	var steps: PackedStringArray = []
	var step: String = ""
	var depth: int = 0
	var quoted: bool = false
	var escaped: bool = false
	for character: String in reaching:
		if quoted:
			if escaped:
				escaped = false
			elif character == "\\":
				escaped = true
			elif character == '"':
				quoted = false
		elif character == '"':
			quoted = true
		elif character == "(":
			depth += 1
		elif character == ")":
			depth = maxi(depth - 1, 0)
		elif character == ":" and depth == 0:
			var _kept: bool = steps.push_back(step)
			step = ""
			continue
		step += character
	var _last: bool = steps.push_back(step)
	return steps


## The method a step written as a call names, "get_viewport()" being get_viewport and
## `get_theme_constant("separation")` get_theme_constant, or "" for a step that is a name.
static func method_of(named: String) -> String:
	if not named.ends_with(")"):
		return ""
	var opened: int = named.find("(")
	if opened < 1:
		return ""
	var method: String = named.substr(0, opened)
	return method if method.is_valid_ascii_identifier() else ""


## The arguments a call step gives in its brackets, as {"args"}, or {"message"} saying why they are
## not ones a path can give.
##
## Literals only: words in double quotes, numbers, true, false and null, read as JSON reads them, a
## whole number as an int. A path names what is read, and an argument that was itself a path or an
## object would make a read depend on other state in a way the step does not show.
static func arguments_of(named: String) -> Dictionary:
	var inside: String = named.substr(named.find("(") + 1, named.length() - named.find("(") - 2).strip_edges()
	if inside.is_empty():
		return {"args": []}
	var reader: JSON = JSON.new()
	var parsed: Variant = reader.data if reader.parse("[%s]" % inside) == OK else null
	if not parsed is Array:
		return {"message": _not_literals(named)}
	var args: Array = []
	for given: Variant in parsed:
		if given is float:
			var number: float = given
			if number == floorf(number) and absf(number) < 9.0e15:
				args.append(int(number))
			else:
				args.append(number)
		elif given == null or given is String or given is bool:
			args.append(given)
		else:
			return {"message": _not_literals(named)}
	return {"args": args}


static func _not_literals(named: String) -> String:
	return (
		"%s: a path gives a call literal arguments only, words in double quotes, numbers, true, false or null"
		% named
	)


## How many arguments [param method] on [param object] takes, as {"least", "most", "any_more"}, or
## an empty map when there is no such method. Read off the method list rather than
## [method Object.has_method], because a method given too few or too many raises inside the game
## rather than answering.
static func _arity(object: Object, method: String) -> Dictionary:
	for entry: Dictionary in object.get_method_list():
		if str(entry.get("name", "")) != method:
			continue
		var params: Array = entry.get("args", [])
		var defaults: Array = entry.get("default_args", [])
		var flags: int = entry.get("flags", 0)
		return {
			"least": params.size() - defaults.size(),
			"most": params.size(),
			"any_more": flags & METHOD_FLAG_VARARG != 0,
		}
	return {}


## Why a path may not call [param method] on [param object], said about [param called_as], or ""
## when it may.
##
## A path is read, and a wait reads it every frame, so a call in one has to be a read. The engine
## marks its own reading methods const and `queue_free()`, `free()` and `set_name()` not, measured on
## 4.7.2. A game's methods carry no such mark, so one declared `-> void` is taken at its word, as
## doing something and answering nothing, and one left untyped is trusted. Without this a find
## with property "queue_free()" freed every node it matched, and a wait on "advance_day()" called
## it once a frame and then reported the state it had driven the game to.
##
## Given [param given] arguments, a call is the engine's and marked as reading, or it is refused. A
## game's method taking arguments is trusted on nothing at all: one answering a value can as well
## change what it was asked about, and runtime_invoke call is how one is called on purpose.
static func call_refused(object: Object, method: String, called_as: String, given: int = 0) -> String:
	var arity: Dictionary = _arity(object, method)
	if arity.is_empty():
		return "%s has no method %s" % [called_as, method]
	var least: int = arity["least"]
	var most: int = arity["most"]
	var any_more: bool = arity["any_more"]
	var scripted: Dictionary = _script_method(object, method)
	if not scripted.is_empty() and (given > 0 or least > 0):
		var why: String = (
			"since nothing marks one as only reading%s; runtime_invoke call takes them" % READS_ONLY
		)
		return (
			"%s.%s is the game's own and a path gives a game's method no arguments, %s"
			% [called_as, method, why]
		)
	if given < least or (given > most and not any_more):
		var takes: String = "%d" % least
		if any_more:
			takes = "at least %d" % least
		elif most != least:
			takes = "%d to %d" % [least, most]
		return (
			'%s.%s takes %s argument%s and the path gives it %d, in the brackets as in %s("name")'
			% [called_as, method, takes, "" if takes == "1" else "s", given, method]
		)
	if not scripted.is_empty():
		var returned: Dictionary = scripted.get("return", {})
		var usage: int = returned.get("usage", 0)
		var type: int = returned.get("type", TYPE_NIL)
		if type == TYPE_NIL and usage & PROPERTY_USAGE_NIL_IS_VARIANT == 0:
			return (
				"%s.%s is declared -> void, so it does something rather than answering%s"
				% [called_as, method, READS_ONLY]
			)
		return ""
	if _native_flags(object, method) & METHOD_FLAG_CONST == 0:
		return "%s.%s changes what it is called on rather than reading it%s" % [called_as, method, READS_ONLY]
	return ""


## The entry a script attached to [param object] declares for [param method], or an empty one when
## the method is the engine's.
static func _script_method(object: Object, method: String) -> Dictionary:
	var attached: Variant = object.get_script()
	if not attached is Script:
		return {}
	var script: Script = attached
	for entry: Dictionary in script.get_script_method_list():
		if str(entry.get("name", "")) == method:
			return entry
	return {}


## The flags the engine declares [param method] with on [param object].
static func _native_flags(object: Object, method: String) -> int:
	for entry: Dictionary in object.get_method_list():
		if str(entry.get("name", "")) == method:
			var flags: int = entry.get("flags", 0)
			return flags
	return 0


## Put [param value] where [param named] points. Only ever called once [method can_read] agrees,
## and lists and maps are reference types, so writing into one reaches the game's own copy.
static func write(holder: Variant, named: String, value: Variant) -> void:
	if holder is Array:
		var items: Array = holder
		items[_index_in(named, items.size())] = value
		return
	if packed(holder):
		var list: Variant = holder
		list[_index_in(named, len(holder))] = value
		return
	if holder is Dictionary:
		var map: Dictionary = holder
		# Written back under the key it was found under, since a map keyed by StringName and one
		# keyed by String both read the same way and a write to the wrong one adds a second entry.
		map[_key_in(map, named)[0]] = value
		return
	var object: Object = holder
	object.set(named, value)


## What [param holder] holds under [param named], or answers to it when [param named] is a call.
## Only ever called once [method can_read] agrees.
static func read_under(holder: Variant, named: String) -> Variant:
	if (holder is Array or holder is Dictionary or packed(holder)) and not method_of(named).is_empty():
		return Callable.create(holder, method_of(named)).call()
	if holder is Array:
		var items: Array = holder
		return items[_index_in(named, items.size())]
	if packed(holder):
		var list: Variant = holder
		return list[_index_in(named, len(holder))]
	if holder is Dictionary:
		var map: Dictionary = holder
		return map[_key_in(map, named)[0]]
	var object: Object = holder
	var method: String = method_of(named)
	if not method.is_empty():
		var args: Array = arguments_of(named)["args"]
		return object.callv(method, args)
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
	var given: Dictionary = arguments_of(named) if not container_call.is_empty() else {"args": []}
	if given.has("message"):
		return "%s:%s" % [called_as, given["message"]]
	var given_args: Array = given["args"]
	var given_count: int = given_args.size()
	if holder is Array:
		var items: Array = holder
		if container_call in NEEDS_AN_ELEMENT and items.is_empty():
			return "%s is an empty list, so it has no %s" % [called_as, named]
		if not container_call.is_empty():
			return container_calls_refused(called_as, "a list", container_call, given_count)
		return "%s is a list of %d, so there is no %s in it" % [called_as, items.size(), named]
	if packed(holder):
		if not container_call.is_empty():
			return container_calls_refused(called_as, "a packed list", container_call, given_count)
		return "%s is a packed list of %d, so there is no %s in it" % [called_as, len(holder), named]
	if holder is Dictionary:
		if not container_call.is_empty():
			return container_calls_refused(called_as, "a map", container_call, given_count)
		var map: Dictionary = holder
		var keys: Array = map.keys()
		# A key reading as the step and still not reached is one of a type a step cannot spell, and
		# saying the map has no key 3 while listing 3 among its keys contradicts itself.
		for key: Variant in keys:
			if str(key) == named:
				return (
					"%s has a key that reads %s, but it is %s, which a path step cannot name"
					% [called_as, named, type_string(typeof(key))]
				)
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
		return call_refused(object, method, called_as, given_count)
	# A method spelled as a property is the likeliest thing behind a name the object has no property
	# for, and the caller is one pair of brackets away from what they meant.
	if object.has_method(named):
		return (
			"%s has no property %s; it has a method of that name, which a path calls as %s()"
			% [called_as, named, named]
		)
	return "%s has no property %s" % [called_as, named]


## Why [param method] is not a call a path makes on [param sort] ("a list", "a packed list" or "a
## map"), naming the calls it does make, or that it makes this one with no arguments when
## [param given] were.
static func container_calls_refused(
	called_as: String, sort: String, method: String, given: int = 0
) -> String:
	var calls: Array[String] = MAP_CALLS
	if sort == "a list":
		calls = LIST_CALLS
	elif sort == "a packed list":
		calls = PACKED_CALLS
	if given > 0 and method in calls:
		return "%s is %s, and a path calls %s() on one with no arguments" % [called_as, sort, method]
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
