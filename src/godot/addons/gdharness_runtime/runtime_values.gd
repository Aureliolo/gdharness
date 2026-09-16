extends RefCounted

## What crosses the wire between the game and the server, in both directions: Godot values
## as JSON-safe dictionaries, and JSON back into the values a property or parameter wants.

# What each Godot type becomes on the wire, keyed on typeof() rather than written as a chain of
# `is` tests whose order has to be trusted: Resource had to be tested before Object, or every
# resource came back as a bare class name with its path dropped.
#
# Method names rather than Callables or lambdas: a lambda spanning more than one line inside a
# dictionary literal is where gdformat loses track of every comment in the file and writes them
# all again into the lambda body, on every run.
const SERIALISERS: Dictionary = {
	TYPE_NIL: "_serialize_nil",
	TYPE_VECTOR2: "_serialize_vector2",
	TYPE_VECTOR3: "_serialize_vector3",
	TYPE_VECTOR2I: "_serialize_vector2i",
	TYPE_VECTOR3I: "_serialize_vector3i",
	TYPE_COLOR: "_serialize_color",
	TYPE_NODE_PATH: "_serialize_node_path",
	TYPE_ARRAY: "_serialize_array",
	TYPE_RECT2: "_serialize_rect2",
	TYPE_TRANSFORM2D: "_serialize_transform2d",
	TYPE_DICTIONARY: "_serialize_dictionary",
	TYPE_OBJECT: "_serialize_object",
}


## Converts a Godot value into something JSON can carry. A type with no entry in the table
## passes through as itself, which is what the JSON-native ones want.
##
## A method or property typed as a class answers a null with a Variant of type OBJECT that has
## nothing behind it, and so does one whose object has been freed. Asking either for its class is
## a script error, and a script error here costs far more than the one answer: the request is
## never replied to at all, and an editor playing the game stops it dead on the error, so every
## question after it times out as well. `find_child` for a name nothing has cost a whole session
## that way.
func serialize(value: Variant) -> Variant:
	if typeof(value) == TYPE_OBJECT and not is_instance_valid(value):
		return null
	var serialiser: String = SERIALISERS.get(typeof(value), "")
	return call(serialiser, value) if not serialiser.is_empty() else value


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


func _serialize_nil(_value: Variant) -> Variant:
	return null


func _serialize_vector2(value: Vector2) -> Dictionary:
	return {"_type": "Vector2", "x": value.x, "y": value.y}


func _serialize_vector3(value: Vector3) -> Dictionary:
	return {"_type": "Vector3", "x": value.x, "y": value.y, "z": value.z}


func _serialize_vector2i(value: Vector2i) -> Dictionary:
	return {"_type": "Vector2i", "x": value.x, "y": value.y}


func _serialize_vector3i(value: Vector3i) -> Dictionary:
	return {"_type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}


func _serialize_color(value: Color) -> Dictionary:
	return {"_type": "Color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}


func _serialize_node_path(value: NodePath) -> Dictionary:
	return {"_type": "NodePath", "path": str(value)}


func _serialize_array(value: Array) -> Array:
	return value.map(serialize)


func _serialize_rect2(value: Rect2) -> Dictionary:
	return {"_type": "Rect2", "position": serialize(value.position), "size": serialize(value.size)}


func _serialize_transform2d(value: Transform2D) -> Dictionary:
	return {
		"_type": "Transform2D",
		"origin": serialize(value.origin),
		"x": serialize(value.x),
		"y": serialize(value.y)
	}


func _serialize_dictionary(value: Dictionary) -> Dictionary:
	var serialised: Dictionary = {}
	for key: Variant in value:
		serialised[str(key)] = serialize(value[key])
	return serialised


## The one case that genuinely needs the class hierarchy, since a Resource is also an Object and
## its path is the half worth having. A node in the tree is answered with its path, so a
## property that points at one can be fed straight back to any tool that takes a node.
func _serialize_object(value: Object) -> Dictionary:
	if value is Resource:
		var resource: Resource = value
		return {"_type": "Resource", "path": resource.resource_path, "class": resource.get_class()}
	if value is Node:
		var node: Node = value
		if node.is_inside_tree():
			return {"_type": "Node", "class": node.get_class(), "path": str(node.get_path())}
	return _describe_object(value)


## A plain object, said in enough detail to tell it from the one beside it.
##
## `{"class": "RefCounted"}` was all of it, so a roster of twelve people came back as the word
## RefCounted twelve times: correct, useless, and indistinguishable from a list of twelve of
## anything else. The state worth looking at in a game is lists of these, so each one carries what
## it is (the `class_name` its script declares, or the script's path when it has no name), what it
## says about itself when the game has given it a `_to_string`, and an id that is at least
## different per object. None of it is invented: every field is left out when there is nothing to
## put in it, because a key holding "" is a worse answer than a key that is not there.
func _describe_object(value: Object) -> Dictionary:
	var described: Dictionary = {"_type": "Object", "class": value.get_class()}
	# Asked as a Variant and narrowed, because get_script answers one and an object without a
	# script answers null: casting that to Script is the unsafe cast the engine refuses to compile.
	var attached: Variant = value.get_script()
	if attached is Script:
		var script: Script = attached
		var declared: String = String(script.get_global_name())
		if not declared.is_empty():
			described["script_class"] = declared
		elif not script.resource_path.is_empty():
			described["script"] = script.resource_path
	# Only when the game wrote one. The default is "<RefCounted#31098236>", which is the id again
	# in a costume and reads as if the object had been asked and had nothing to say.
	if value.has_method("_to_string"):
		described["says"] = value.to_string()
	described["id"] = value.get_instance_id()
	return described


## Rebuilds a Godot value from the shape serialize gave it.
func deserialize(value: Variant) -> Variant:
	if value == null:
		return null
	if value is Array:
		var items: Array = value
		var rebuilt: Array = []
		for item: Variant in items:
			rebuilt.append(deserialize(item))
		return rebuilt
	if not value is Dictionary:
		return value

	var fields: Dictionary = value
	if not fields.has("_type"):
		var rebuilt: Dictionary = {}
		for key: Variant in fields:
			rebuilt[key] = deserialize(fields[key])
		return rebuilt

	match fields["_type"]:
		"Vector2":
			return Vector2(fields.get("x", 0), fields.get("y", 0))
		"Vector3":
			return Vector3(fields.get("x", 0), fields.get("y", 0), fields.get("z", 0))
		"Vector2i":
			return Vector2i(fields.get("x", 0), fields.get("y", 0))
		"Vector3i":
			return Vector3i(fields.get("x", 0), fields.get("y", 0), fields.get("z", 0))
		"Color":
			return Color(fields.get("r", 0), fields.get("g", 0), fields.get("b", 0), fields.get("a", 1))
		"NodePath":
			return NodePath(fields.get("path", ""))
	return value


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
		return int(parameter.get("type", TYPE_NIL))
	return TYPE_NIL


## A value from the wire fitted to the type a property or parameter declares. Arguments arrive
## as strings often enough, and callv refuses a "2.0" where a float is wanted, so a string that
## reads as the wanted scalar is read as one.
func fitted(value: Variant, type: int) -> Variant:
	var rebuilt: Variant = deserialize(value)
	if type == TYPE_NIL or typeof(rebuilt) == type:
		return rebuilt

	var simple: Array[int] = [TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING]
	if not simple.has(type) or not simple.has(typeof(rebuilt)):
		return rebuilt

	if rebuilt is String and type != TYPE_STRING:
		var parsed: Variant = JSON.parse_string(rebuilt)
		if typeof(parsed) != TYPE_NIL and typeof(parsed) != TYPE_STRING:
			rebuilt = parsed

	return type_convert(rebuilt, type)
