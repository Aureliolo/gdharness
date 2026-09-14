extends RefCounted

# What each Godot type becomes on the wire, as one table you can read rather than an order you
# have to trust. Keyed on typeof() rather than written as a chain of `is` tests, because the
# order mattered: Resource had to be tested before Object or every resource came back as a bare
# class name with its path dropped, and nothing but a comment said so.
#
# Method names rather than Callables: a table of Callables bound to this object is a reference
# cycle that nothing breaks, so the object outlives the run and the engine reports its script as
# a resource still in use at exit, on the same stderr the server reads failures off.
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
	TYPE_TRANSFORM3D: "_serialize_transform3d",
	TYPE_DICTIONARY: "_serialize_dictionary",
	TYPE_OBJECT: "_serialize_object",
}


# Converts a Godot value into something JSON can carry. A type with no entry in the table
# passes through as itself, which is what the JSON-native ones want.
#
# A property that holds no object is Object-typed and null rather than nil, which is most of what
# a node's property list is, and an object that has been freed is the same shape again. Both are
# refused here rather than inside _serialize_object, because a freed one never reaches it: the
# call itself fails on the argument, with "previously freed is not a subclass of the expected
# argument class", and a guard behind that is a guard that never runs.
func serialize_value(value: Variant) -> Variant:
	if typeof(value) == TYPE_OBJECT and not is_instance_valid(value):
		return null
	var serialiser: String = SERIALISERS.get(typeof(value), "")
	return call(serialiser, value) if not serialiser.is_empty() else value


# Rebuilds a Godot value from the shape serialize_value gave it.
func deserialize_value(value: Variant) -> Variant:
	if value == null:
		return null
	if value is Array:
		var items: Array = value
		var rebuilt: Array = []
		for item: Variant in items:
			rebuilt.append(deserialize_value(item))
		return rebuilt
	if not value is Dictionary:
		return value

	var fields: Dictionary = value
	if not fields.has("_type"):
		var rebuilt: Dictionary = {}
		for key: Variant in fields:
			rebuilt[key] = deserialize_value(fields[key])
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
		"Rect2":
			var position: Variant = deserialize_value(fields.get("position", {}))
			var size: Variant = deserialize_value(fields.get("size", {}))
			return Rect2(position, size)
		"NodePath":
			return NodePath(fields.get("path", ""))
	return fields


func _serialize_nil(_value: Variant) -> Variant:
	return null


func _serialize_vector2(value: Vector2) -> Dictionary:
	return {"x": value.x, "y": value.y, "_type": "Vector2"}


func _serialize_vector3(value: Vector3) -> Dictionary:
	return {"x": value.x, "y": value.y, "z": value.z, "_type": "Vector3"}


func _serialize_vector2i(value: Vector2i) -> Dictionary:
	return {"x": value.x, "y": value.y, "_type": "Vector2i"}


func _serialize_vector3i(value: Vector3i) -> Dictionary:
	return {"x": value.x, "y": value.y, "z": value.z, "_type": "Vector3i"}


func _serialize_color(value: Color) -> Dictionary:
	return {"r": value.r, "g": value.g, "b": value.b, "a": value.a, "_type": "Color"}


func _serialize_node_path(value: NodePath) -> Dictionary:
	return {"path": str(value), "_type": "NodePath"}


func _serialize_array(value: Array) -> Array:
	return value.map(serialize_value)


func _serialize_rect2(value: Rect2) -> Dictionary:
	return {
		"position": serialize_value(value.position), "size": serialize_value(value.size), "_type": "Rect2"
	}


func _serialize_transform2d(value: Transform2D) -> Dictionary:
	return {
		"origin": serialize_value(value.origin),
		"x": serialize_value(value.x),
		"y": serialize_value(value.y),
		"_type": "Transform2D"
	}


func _serialize_transform3d(value: Transform3D) -> Dictionary:
	return {
		"origin": serialize_value(value.origin),
		"basis":
		{
			"x": serialize_value(value.basis.x),
			"y": serialize_value(value.basis.y),
			"z": serialize_value(value.basis.z)
		},
		"_type": "Transform3D"
	}


func _serialize_dictionary(value: Dictionary) -> Dictionary:
	var serialised: Dictionary = {}
	for key: Variant in value:
		serialised[str(key)] = serialize_value(value[key])
	return serialised


# A pathless Resource says so rather than inventing an empty path for the caller to load.
func _serialize_object(value: Object) -> Variant:
	if not value is Resource:
		return {"_type": "Object", "class": value.get_class()}
	var resource: Resource = value
	if resource.resource_path.is_empty():
		return {"_type": "Resource", "class": resource.get_class()}
	return {"path": resource.resource_path, "_type": "Resource", "class": resource.get_class()}
