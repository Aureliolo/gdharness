extends SceneTree

## The runtime autoload carries its own copy of the value serialisers, separate from the ones
## in the operations script and with a different key order. It is a Node, so it instantiates
## normally, and the same round trip is asserted against it.

const Runtime = preload("res://addons/godot_mcp_runtime/mcp_runtime_autoload.gd")

var failures: Array[String] = []


func _init() -> void:
	var node: Runtime = Runtime.new()

	_check(node)
	node.free()

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _tag_of(value: Variant) -> String:
	if value is Dictionary:
		var fields: Dictionary = value
		return str(fields.get("_type", ""))
	return ""


func _check(node: Runtime) -> void:
	var vec2: Variant = node._serialize_value(Vector2(1.5, -2.5))
	if vec2 != {"_type": "Vector2", "x": 1.5, "y": -2.5}:
		_fail("Vector2: %s" % JSON.stringify(vec2))
	if node._deserialize_value(vec2) != Vector2(1.5, -2.5):
		_fail("Vector2 round trip: %s" % str(node._deserialize_value(vec2)))

	if node._deserialize_value(node._serialize_value(Vector3(1, 2, 3))) != Vector3(1, 2, 3):
		_fail("Vector3 round trip")
	if node._deserialize_value(node._serialize_value(Vector2i(4, 5))) != Vector2i(4, 5):
		_fail("Vector2i round trip")
	if node._deserialize_value(node._serialize_value(Vector3i(6, 7, 8))) != Vector3i(6, 7, 8):
		_fail("Vector3i round trip")
	if node._deserialize_value(node._serialize_value(Color(0.25, 0.5, 0.75, 1))) != Color(0.25, 0.5, 0.75, 1):
		_fail("Color round trip")
	if node._deserialize_value(node._serialize_value(NodePath("Root/Child"))) != NodePath("Root/Child"):
		_fail("NodePath round trip")

	var rect: Dictionary = node._serialize_value(Rect2(Vector2(1, 2), Vector2(3, 4)))
	if _tag_of(rect) != "Rect2":
		_fail("Rect2 tag: %s" % JSON.stringify(rect))
	elif _tag_of(rect["position"]) != "Vector2":
		_fail("Rect2 does not recurse into its position: %s" % JSON.stringify(rect))

	var transform: Dictionary = node._serialize_value(Transform2D(0.0, Vector2(3, 4)))
	if _tag_of(transform) != "Transform2D":
		_fail("Transform2D tag: %s" % JSON.stringify(transform))
	elif _tag_of(transform["origin"]) != "Vector2":
		_fail("Transform2D origin: %s" % JSON.stringify(transform))

	var nested: Variant = node._serialize_value([Vector2(1, 1), {"inner": Vector3(2, 2, 2)}])
	if not nested is Array or nested.size() != 2:
		_fail("array shape: %s" % JSON.stringify(nested))
	elif _tag_of(nested[0]) != "Vector2":
		_fail("array member: %s" % JSON.stringify(nested))

	var restored: Array = node._deserialize_value(nested)
	var restored_inner: Dictionary = restored[1]
	if restored[0] != Vector2(1, 1) or restored_inner["inner"] != Vector3(2, 2, 2):
		_fail("nested round trip: %s" % str(restored))

	# A Resource is also an Object, so the Resource branch has to be reached first or the path
	# is dropped and the caller gets a bare class name back.
	var resource: Resource = Resource.new()
	resource.resource_path = "res://thing.tres"
	var serialised: Dictionary = node._serialize_value(resource)
	if _tag_of(serialised) != "Resource":
		_fail("Resource tag: %s" % JSON.stringify(serialised))
	elif serialised.get("path", "") != "res://thing.tres":
		_fail("Resource path: %s" % JSON.stringify(serialised))

	if _tag_of(node._serialize_value(RefCounted.new())) != "Object":
		_fail("Object tag: %s" % JSON.stringify(node._serialize_value(RefCounted.new())))

	if node._serialize_value(null) != null:
		_fail("null")
	if node._serialize_value(7) != 7:
		_fail("passthrough int")
	if node._deserialize_value(7) != 7:
		_fail("deserialize passthrough int")

	var untagged: Dictionary = node._deserialize_value({"a": {"_type": "Vector2", "x": 9, "y": 9}})
	if untagged["a"] != Vector2(9, 9):
		_fail("untagged dictionary recursion: %s" % str(untagged))

	var unknown: Dictionary = {"_type": "Nonesuch", "x": 1}
	if node._deserialize_value(unknown) != unknown:
		_fail("unknown tag: %s" % str(node._deserialize_value(unknown)))

	# Arguments arrive over the wire as strings and have to be fitted to the parameter the
	# object itself declares, or callv refuses a number that was written as "2.0".
	if node._as_type("2.0", TYPE_FLOAT) != 2.0:
		_fail("_as_type string to float: %s" % str(node._as_type("2.0", TYPE_FLOAT)))
	if node._as_type("7", TYPE_INT) != 7:
		_fail("_as_type string to int: %s" % str(node._as_type("7", TYPE_INT)))
	if node._as_type("true", TYPE_BOOL) != true:
		_fail("_as_type string to bool: %s" % str(node._as_type("true", TYPE_BOOL)))
	if node._as_type("plain", TYPE_STRING) != "plain":
		_fail("_as_type leaves a string alone: %s" % str(node._as_type("plain", TYPE_STRING)))
	if node._as_type({"_type": "Vector2", "x": 1, "y": 2}, TYPE_NIL) != Vector2(1, 2):
		_fail("_as_type with no declared type still deserialises")
