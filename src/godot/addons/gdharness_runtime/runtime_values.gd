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


## Whether two values can be compared without the comparison itself failing.
static func comparable(one: Variant, other: Variant) -> bool:
	return Serialisation.comparable(one, other)


## Whether a value can be handed to a parameter declared as [param type] without the call failing.
static func acceptable(value: Variant, type: int) -> bool:
	return Serialisation.acceptable(value, type)


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
## String}`: a property's declaration, or the element type of a typed list or the value type of a
## typed map. TYPE_NIL when nothing is declared.
##
## Asked rather than read off the value in the slot, because an object slot can be empty: a
## property typed `Gear` holding null reads as TYPE_NIL, and anything written into it passed the
## check and was then dropped by the engine, which answered with the slot still null.
static func slot_declared(holder: Variant, named: String) -> Dictionary:
	if holder is Array:
		var items: Array = holder
		if items.is_typed():
			return {
				"type": items.get_typed_builtin(),
				"class": _typed_class(items.get_typed_script(), items.get_typed_class_name()),
			}
	elif holder is Dictionary:
		var map: Dictionary = holder
		if map.is_typed_value():
			return {
				"type": map.get_typed_value_builtin(),
				"class": _typed_class(map.get_typed_value_script(), map.get_typed_value_class_name()),
			}
	elif holder is Object:
		var object: Object = holder
		for entry: Dictionary in object.get_property_list():
			if str(entry.get("name", "")) == named:
				return {
					"type": Read.as_int(entry.get("type", TYPE_NIL), TYPE_NIL),
					"class": str(entry.get("class_name", "")),
				}
	return {"type": TYPE_NIL, "class": ""}


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
static func is_a(object: Object, declared: String) -> bool:
	if object.is_class(declared):
		return true
	var script: Variant = object.get_script()
	while script is Script:
		var current: Script = script
		if current.get_global_name() == StringName(declared):
			return true
		script = current.get_base_script()
	return false


## What [param object] is, by its script class where it has one.
static func class_of(object: Object) -> String:
	var script: Variant = object.get_script()
	if script is Script:
		var current: Script = script
		if not current.get_global_name().is_empty():
			return str(current.get_global_name())
	return object.get_class()


## A value from the wire fitted to the type a property or parameter declares.
func fitted(value: Variant, type: int) -> Variant:
	return _shared.fitted(value, type)
