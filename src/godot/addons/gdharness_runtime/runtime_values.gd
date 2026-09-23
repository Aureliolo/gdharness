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
## its path through [param resolve], which is called with the path and the class declared and
## answers the way an object argument does. Anything that is not a typed container comes back as
## it was given.
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
				resolve
			)
			if element.has("message"):
				return {"message": "element %d %s" % [index, element["message"]]}
			built.append(element["value"])
		return {
			"value":
			Array(
				built,
				template.get_typed_builtin(),
				template.get_typed_class_name(),
				template.get_typed_script()
			)
		}
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
				resolve
			)
			if key_fitted.has("message"):
				return {"message": "key %s %s" % [str(key), key_fitted["message"]]}
			var value_fitted: Dictionary = _element(
				entries[key],
				map_like.get_typed_value_builtin(),
				_typed_class(map_like.get_typed_value_script(), map_like.get_typed_value_class_name()),
				resolve
			)
			if value_fitted.has("message"):
				return {"message": "the value under %s %s" % [str(key), value_fitted["message"]]}
			rebuilt[key_fitted["value"]] = value_fitted["value"]
		return {
			"value":
			Dictionary(
				rebuilt,
				map_like.get_typed_key_builtin(),
				map_like.get_typed_key_class_name(),
				map_like.get_typed_key_script(),
				map_like.get_typed_value_builtin(),
				map_like.get_typed_value_class_name(),
				map_like.get_typed_value_script()
			)
		}
	return {"value": given}


## One element fitted to a container's element type, as `{"value"}` or `{"message"}` saying what it
## was and what goes there. The message is the part after "element N".
func _element(item: Variant, builtin: int, declared: String, resolve: Callable) -> Dictionary:
	if builtin == TYPE_NIL:
		return {"value": item}
	if builtin == TYPE_OBJECT and item is String:
		var named: Dictionary = resolve.call(item, declared)
		if named.has("message"):
			return {"message": str(named["message"])}
		return {"value": named["object"]}
	var fitted_item: Variant = fitted(item, builtin)
	if not acceptable(fitted_item, builtin):
		# The value as it was sent rather than its engine type: JSON numbers arrive as floats, so a 7
		# the caller wrote was named "float".
		var wanted: String = declared if builtin == TYPE_OBJECT else type_string(builtin)
		return {"message": "is %s, which cannot become %s" % [JSON.stringify(serialize(item)), wanted]}
	return {"value": fitted_item}
