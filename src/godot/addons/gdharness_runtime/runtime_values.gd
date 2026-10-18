extends RefCounted

## What crosses the wire between the game and the server, in both directions: Godot values
## as JSON-safe dictionaries, and JSON back into the values a property or parameter wants.
##
## The conversion itself is the shared one, so a value read off a running game is spelled exactly
## as the same value read off the editor or off a headless engine. What is here is the part that is
## only true of a running game: reaching a node by path, and fitting an argument to the type the
## method it is going to declares.

const Read = preload("reading.gd")
const Serialisation = preload("serialisation.gd")

## The engine singletons a call, a write or a read may name instead of a node: what the engine
## measures, and the engine settings that are the game's own. Not every singleton: OS runs programs
## and opens files, DisplayServer switches the keyboard's layout and Input moves the real pointer,
## and none of that is a game's to do to the machine it runs on.
const SINGLETONS: Array[String] = [
	"Engine",
	"Performance",
	"RenderingServer",
	"AudioServer",
	"PhysicsServer2D",
	"PhysicsServer3D",
	"NavigationServer2D",
	"NavigationServer3D",
	"Time",
	"TranslationServer",
]
## The most frames a press is held in one call, as many as a frames wait takes.
const MOST_HELD: int = 600

var _shared: Serialisation = Serialisation.new()


## Converts a Godot value into something JSON can carry.
func serialize(value: Variant) -> Variant:
	return _shared.serialize_value(value)


## Rebuilds a Godot value from the shape [method serialize] gave it.
func deserialize(value: Variant) -> Variant:
	return _shared.deserialize_value(value)


## The node [param path] names under [param root], or a refusal saying why there is not one.
##
## The other direction of what a node serialises as, and here for that reason: a node crosses the
## wire as its path, so a path crossing back is a node or it is nothing. One answer for every op,
## because each of them read a path for itself and they could disagree about what one means.
##
## A colon is the disagreement worth its own sentence. Godot reads everything after the first one
## as subnames and [method Node.get_node_or_null] drops them, so "/root/Main:_game:run" was quietly
## answered about "/root/Main", and an op that then said the path had no method `advance` was right
## about an object nobody had asked for. Colons reach through what a node holds, and the arguments
## that take them are the property and the method.
static func node_at(root: Node, path: String) -> Dictionary:
	if path.is_empty():
		return {"type": "error", "message": "Node path required"}

	if path.contains(":"):
		var shape: String = (
			'"%s" names a node and colons reach past one: "%s" is the node,'
			+ ' and "%s" goes in the property or the method'
		)
		return {
			"type": "error",
			"message": shape % [path, path.get_slice(":", 0), path.substr(path.find(":") + 1)],
		}

	var node: Node = root.get_node_or_null(path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + path}
	return {"node": node}


## How many process frames a whole press holds before its release, from `holdFrames`: one unless
## asked, as the halves of a press have always been a frame apart. Held inside the game because the
## time between a press, a wait and a release sent as three calls counts as held too: a 60-frame
## pour poured for nearly three seconds. A String saying why, where the hold cannot be.
static func held_for(params: Dictionary) -> Variant:
	if not params.has("holdFrames"):
		return 1
	if params.has("pressed"):
		return (
			"holdFrames holds a whole press and then lets go, and pressed asks for one half of one:"
			+ " give one or the other."
		)
	var frames: int = Read.as_int(params["holdFrames"], 0)
	if frames < 1 or frames > MOST_HELD:
		return "holdFrames is %d, and it takes 1 to %d." % [frames, MOST_HELD]
	return frames


## What a press says it was held for: [param frames] for a whole one, nothing for one half.
static func held_answer(whole: bool, frames: int) -> Variant:
	if whole:
		return frames
	return null


## What [param path] names: a node under [param root], as [method node_at] reads it, or an engine
## singleton by its name. Answers the object under "object", and under "node" the node that objects
## named in a value are found from, which for a singleton is [param root].
static func target_at(root: Node, path: String) -> Dictionary:
	if SINGLETONS.has(path):
		return {"object": Engine.get_singleton(path), "node": root}
	if not path.contains("/") and Engine.has_singleton(path):
		return {
			"type": "error",
			"message":
			(
				(
					"%s is an engine singleton, and the ones that can be reached are %s. The rest act"
					+ " on the machine rather than the game: OS runs programs, DisplayServer switches the"
					+ " keyboard's layout and Input moves the real pointer."
				)
				% [path, ", ".join(SINGLETONS)]
			),
		}
	var standing: Dictionary = node_at(root, path)
	if standing.has("message"):
		return standing
	return {"object": standing["node"], "node": standing["node"]}


## Whether two values can be compared without the comparison itself failing.
static func comparable(one: Variant, other: Variant) -> bool:
	return Serialisation.comparable(one, other)


## Whether a value can be handed to a parameter declared as [param type] without the call failing.
static func acceptable(value: Variant, type: int) -> bool:
	return Serialisation.acceptable(value, type)


## Whether [param given] would have to be cut to become a [param type]: a fraction made a whole
## number, or a number other than 0 or 1 made a truth.
##
## A number arrives from JSON as a float, so one is converted to what the slot holds, and the
## conversion truncates: 2.5 written into an int was stored as 2 and answered as written, and 0.2 on
## a bool became true. A number written as text counts as the number.
static func cuts(given: Variant, type: int) -> bool:
	if type != TYPE_INT and type != TYPE_BOOL:
		return false
	var number: Variant = given
	if given is String:
		var text: String = given
		number = Read.json_or_null(text)
	if typeof(number) != TYPE_FLOAT and typeof(number) != TYPE_INT:
		return false
	var value: float = Read.as_float(number)
	var whole: bool = value == floorf(value)
	if type == TYPE_INT:
		return not whole
	return not (whole and (value == 0.0 or value == 1.0))


## The slot [method cuts] speaks of, with its article, for a refusal to name: "an int" or "a bool".
static func cut_by(type: int) -> String:
	return "an int" if type == TYPE_INT else "a bool"


## Why [param given] may not be the whole number sent, or "": see [method Serialisation.inexact].
static func inexact(given: Variant, type: int) -> String:
	return Serialisation.inexact(given, type)


## How a value of [param type] is written to be read as one, or empty when it is not built from fields.
static func written_as(type: int) -> String:
	return Serialisation.written_as(type)


## The declared type of one parameter of a method, or TYPE_NIL when the method or the parameter
## is not there, which reads as "no opinion".
func parameter_type(object: Object, method: String, index: int) -> int:
	for entry: Dictionary in object.get_method_list():
		if entry.get("name", "") != method:
			continue
		var params: Array = entry.get("args", [])
		if index < 0 or index >= params.size():
			return TYPE_NIL
		var parameter: Dictionary = params[index]
		return Read.as_int(parameter.get("type", TYPE_NIL), TYPE_NIL)
	return TYPE_NIL


## The class a method declares for argument [param index], or "" when it names none: an untyped
## parameter, a Variant, or a type that is not an object.
func parameter_class(object: Object, method: String, index: int) -> String:
	for entry: Dictionary in object.get_method_list():
		if entry.get("name", "") != method:
			continue
		var params: Array = entry.get("args", [])
		if index < 0 or index >= params.size():
			return ""
		var parameter: Dictionary = params[index]
		return str(parameter.get("class_name", ""))
	return ""


## What the slot [param named] on [param holder] declares it holds, as `{"type": int, "class":
## String, "script": Script or null}`: a property's declaration, or the element type of a typed list
## or the value type of a typed map. TYPE_NIL when nothing is declared, which is also what a
## property declared as Variant or left untyped reads as: either way it takes anything.
##
## Asked rather than read off the value in the slot, because an object slot can be empty: a
## property typed `Gear` holding null reads as TYPE_NIL, and anything written into it passed the
## check and was then dropped by the engine, which answered with the slot still null.
##
## The script only for a typed container, the one place the engine hands it over. A property typed
## as a script class with no `class_name` is declared under the engine class the script extends,
## measured on 4.7.2: `var quarrel: Walker` with Walker a preloaded Node3D script lists as Node3D.
static func slot_declared(holder: Variant, named: String) -> Dictionary:
	# A component holds one kind of value and no other: a vector's axis is a number, its integer
	# form's an integer, a rectangle's size a vector of the same form.
	if named in Serialisation.components_of(holder):
		var component: Variant = holder[named]
		return {"type": typeof(component), "class": "", "script": null}
	if holder is Array:
		var items: Array = holder
		if items.is_typed():
			return {
				"type": items.get_typed_builtin(),
				"class": _typed_class(items.get_typed_script(), items.get_typed_class_name()),
				"script": _script_or_null(items.get_typed_script()),
			}
	elif holder is Dictionary:
		var map: Dictionary = holder
		if map.is_typed_value():
			return {
				"type": map.get_typed_value_builtin(),
				"class": _typed_class(map.get_typed_value_script(), map.get_typed_value_class_name()),
				"script": _script_or_null(map.get_typed_value_script()),
			}
	elif holder is Object:
		var object: Object = holder
		for entry: Dictionary in object.get_property_list():
			if str(entry.get("name", "")) == named:
				return {
					"type": Read.as_int(entry.get("type", TYPE_NIL), TYPE_NIL),
					"class": str(entry.get("class_name", "")),
					"script": null,
				}
	return {"type": TYPE_NIL, "class": "", "script": null}


static func _script_or_null(typed: Variant) -> Script:
	return typed if typed is Script else null


## The class a typed container names: its script's global name where it has one, since the engine
## class of a script class is only what the script extends.
static func _typed_class(script: Variant, engine_class: StringName) -> String:
	if script is Script:
		var typed: Script = script
		if not typed.get_global_name().is_empty():
			return str(typed.get_global_name())
	return str(engine_class)


## Whether [param object] is a [param declared]: an engine class, or a script class by its global
## name anywhere along the script's inheritance.
##
## Against [param declared_script] itself when there is one. A script with no global name is named by
## the engine class it extends, so an object of that class with another script, or none, passes the
## name, and a typed list built with it drops the element: measured on 4.7.2, an Array[Walker] given
## a plain Node3D comes out empty, the engine's errors going to the game's output alone.
static func is_a(object: Object, declared: String, declared_script: Script = null) -> bool:
	if declared_script != null:
		var own: Variant = object.get_script()
		while own is Script:
			if own == declared_script:
				return true
			var along: Script = own
			own = along.get_base_script()
		return false
	if object.is_class(declared):
		return true
	var script: Variant = object.get_script()
	while script is Script:
		var current: Script = script
		if current.get_global_name() == StringName(declared):
			return true
		script = current.get_base_script()
	return false


## What became of [param node] once an input it was given has run: still in the tree, taken out of
## it, or freed. Untyped, because a freed reference handed to a typed parameter is itself the engine
## error this is here to avoid.
static func afterwards(node: Variant) -> String:
	if not is_instance_valid(node):
		return "freed"
	if not node is Node:
		return "removed"
	var placed: Node = node
	return "in_tree" if placed.is_inside_tree() else "removed"


## What [param object] is, by its script class where it has one, and by its script's file where
## that has no global name, since the engine class alone is what a refusal about the script has
## just said it matched.
static func class_of(object: Object) -> String:
	var script: Variant = object.get_script()
	if script is Script:
		var current: Script = script
		if not current.get_global_name().is_empty():
			return str(current.get_global_name())
		return "%s with the script %s" % [object.get_class(), script_named(current)]
	return object.get_class()


## How a refusal names [param script]: its global name, or its file. A class declared inside another
## script has neither, measured on 4.7.2, so it is called an inner class and no more.
static func script_named(script: Script) -> String:
	if not script.get_global_name().is_empty():
		return str(script.get_global_name())
	if not script.resource_path.is_empty():
		return script.resource_path
	return "an inner class"


## A value from the wire fitted to the type a property or parameter declares.
func fitted(value: Variant, type: int) -> Variant:
	return _shared.fitted(value, type)


## An empty list or map typed the way argument [param index] of [param method] declares, or null
## when that argument is not a typed container. What [method typed_like] builds against.
func parameter_container(object: Object, method: String, index: int) -> Variant:
	for entry: Dictionary in object.get_method_list():
		if entry.get("name", "") != method:
			continue
		var params: Array = entry.get("args", [])
		if index < 0 or index >= params.size():
			return null
		var parameter: Dictionary = params[index]
		var hint: int = Read.as_int(parameter.get("hint", 0), 0)
		var named: String = str(parameter.get("hint_string", ""))
		if hint == PROPERTY_HINT_ARRAY_TYPE:
			var element: Dictionary = _element_type(named)
			if element.is_empty():
				return null
			var builtin: int = element["builtin"]
			var engine_class: StringName = element["class"]
			return Array([], builtin, engine_class, element["script"])
		if hint == PROPERTY_HINT_DICTIONARY_TYPE and named.contains(";"):
			var key: Dictionary = _element_type(named.get_slice(";", 0))
			var entry_type: Dictionary = _element_type(named.get_slice(";", 1))
			if key.is_empty() or entry_type.is_empty():
				return null
			var key_builtin: int = key["builtin"]
			var key_class: StringName = key["class"]
			var value_builtin: int = entry_type["builtin"]
			var value_class: StringName = entry_type["class"]
			return Dictionary(
				{}, key_builtin, key_class, key["script"], value_builtin, value_class, entry_type["script"]
			)
		return null
	return null


## The type a container hint names, as `{"builtin", "class", "script"}`, or {} for a name this
## cannot resolve. A built-in type by its name, an engine class, or a script class by its global
## name, which a typed container holds as the class it extends and the script itself.
static func _element_type(named: String) -> Dictionary:
	for type: int in TYPE_MAX:
		if type != TYPE_OBJECT and type_string(type) == named:
			return {"builtin": type, "class": &"", "script": null}
	if ClassDB.class_exists(named):
		return {"builtin": TYPE_OBJECT, "class": StringName(named), "script": null}
	for global: Dictionary in ProjectSettings.get_global_class_list():
		if str(global.get("class", "")) == named:
			var script: Script = load(str(global.get("path", "")))
			if script == null:
				return {}
			return {"builtin": TYPE_OBJECT, "class": script.get_instance_base_type(), "script": script}
	return {}


## [param given] rebuilt as the typed list or map [param like] is, as `{"value": ...}`, or
## `{"message": ...}` naming the element that cannot become what the container holds.
##
## A typed container refuses a plain one, and the engine says nothing about it: an Array[int]
## property written with the list JSON carries kept what it held, and the answer showed the write
## as done. Each element is fitted the way a single value is, and an object element is named by
## its path through [param resolve], which is called with the path, the class declared and the
## script declared, and answers the way an object argument does. Anything that is not a typed
## container comes back as it was given.
##
## The container built is counted against what went into it. The engine drops an element it will
## not take and says so only in the game's output, so a list that came out shorter is refused here
## rather than written, which would empty the game's own.
func typed_like(given: Variant, like: Variant, resolve: Callable) -> Dictionary:
	if like is Array and given is Array:
		var template: Array = like
		if not template.is_typed():
			return {"value": given}
		var items: Array = given
		var built: Array = []
		for index: int in items.size():
			var element: Dictionary = _element(
				items[index],
				template.get_typed_builtin(),
				_typed_class(template.get_typed_script(), template.get_typed_class_name()),
				_script_or_null(template.get_typed_script()),
				resolve
			)
			if element.has("message"):
				return {"message": "element %d %s" % [index, element["message"]]}
			built.append(element["value"])
		var typed: Array = Array(
			built, template.get_typed_builtin(), template.get_typed_class_name(), template.get_typed_script()
		)
		if typed.size() != built.size():
			return {"message": "the engine would not take its elements as what the list holds"}
		return {"value": typed}
	if like is Dictionary and given is Dictionary:
		var map_like: Dictionary = like
		if not map_like.is_typed():
			return {"value": given}
		var entries: Dictionary = given
		var rebuilt: Dictionary = {}
		for key: Variant in entries:
			var key_fitted: Dictionary = _element(
				key,
				map_like.get_typed_key_builtin(),
				_typed_class(map_like.get_typed_key_script(), map_like.get_typed_key_class_name()),
				_script_or_null(map_like.get_typed_key_script()),
				resolve
			)
			if key_fitted.has("message"):
				return {"message": "key %s %s" % [str(key), key_fitted["message"]]}
			var value_fitted: Dictionary = _element(
				entries[key],
				map_like.get_typed_value_builtin(),
				_typed_class(map_like.get_typed_value_script(), map_like.get_typed_value_class_name()),
				_script_or_null(map_like.get_typed_value_script()),
				resolve
			)
			if value_fitted.has("message"):
				return {"message": "the value under %s %s" % [str(key), value_fitted["message"]]}
			rebuilt[key_fitted["value"]] = value_fitted["value"]
		var typed_map: Dictionary = Dictionary(
			rebuilt,
			map_like.get_typed_key_builtin(),
			map_like.get_typed_key_class_name(),
			map_like.get_typed_key_script(),
			map_like.get_typed_value_builtin(),
			map_like.get_typed_value_class_name(),
			map_like.get_typed_value_script()
		)
		if typed_map.size() != rebuilt.size():
			return {"message": "the engine would not take its entries as what the map holds"}
		return {"value": typed_map}
	return {"value": given}


## One element fitted to a container's element type, as `{"value"}` or `{"message"}` saying what it
## was and what goes there. The message is the part after "element N".
##
## An object element given as a record goes to [param resolve] as a path would, which says how an
## object is named, rather than being refused as a map that cannot become the class.
func _element(item: Variant, builtin: int, declared: String, script: Script, resolve: Callable) -> Dictionary:
	if builtin == TYPE_NIL:
		return {"value": item}
	if builtin == TYPE_OBJECT and (item is String or item is Dictionary):
		var named: Dictionary = resolve.call(item, declared, script)
		if named.has("message"):
			return {"message": str(named["message"])}
		return {"value": named["object"]}
	var fitted_item: Variant = fitted(item, builtin)
	if not acceptable(fitted_item, builtin):
		# The value as it was sent rather than its engine type: JSON numbers arrive as floats, so a 7
		# the caller wrote was named "float".
		var wanted: String = type_string(builtin)
		if builtin == TYPE_OBJECT:
			wanted = declared if script == null else script_named(script)
		return {
			"message": "is %s, which cannot become %s" % [JSON.stringify(serialize(item), "", false), wanted]
		}
	return {"value": fitted_item}
