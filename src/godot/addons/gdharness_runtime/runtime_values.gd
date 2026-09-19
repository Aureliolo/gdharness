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

# The types that cross as a plain JSON list and have to be built back into themselves. A list is
# what a caller can write by hand and what the serialiser answers with, and the parameter or
# property being written is the only thing that knows which of these it wanted.
const LIST_TYPES: Array[int] = [
	TYPE_PACKED_INT32_ARRAY,
	TYPE_PACKED_INT64_ARRAY,
	TYPE_PACKED_FLOAT32_ARRAY,
	TYPE_PACKED_FLOAT64_ARRAY,
	TYPE_PACKED_STRING_ARRAY,
	TYPE_PACKED_VECTOR2_ARRAY,
	TYPE_PACKED_VECTOR3_ARRAY,
	TYPE_PACKED_VECTOR4_ARRAY,
	TYPE_PACKED_COLOR_ARRAY,
]

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


## A value from the wire fitted to the type a property or parameter declares. Arguments arrive
## as strings often enough, and callv refuses a "2.0" where a float is wanted, so a string that
## reads as the wanted scalar is read as one.
##
## The conversion is also what restores a packed array's exact type. Those cross as the plain JSON
## lists they fit into, so what comes back from the wire is an Array, and the parameter is what says
## it was a PackedStringArray.
func fitted(value: Variant, type: int) -> Variant:
	var rebuilt: Variant = deserialize(value)
	if type == TYPE_NIL or typeof(rebuilt) == type:
		return rebuilt

	if rebuilt is Array and LIST_TYPES.has(type):
		return type_convert(rebuilt, type)

	var simple: Array[int] = [TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING]
	if not simple.has(type) or not simple.has(typeof(rebuilt)):
		return rebuilt

	if rebuilt is String and type != TYPE_STRING:
		var text: String = rebuilt
		var parsed: Variant = JSON.parse_string(text)
		if typeof(parsed) != TYPE_NIL and typeof(parsed) != TYPE_STRING:
			rebuilt = parsed

	return type_convert(rebuilt, type)
