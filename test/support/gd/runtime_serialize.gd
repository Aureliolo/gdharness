extends SceneTree

## The runtime addon carries its own copy of the value serialisers, separate from the ones in
## the operations script and with a different key order, and the same round trip is asserted
## against it.

const Values = preload("res://addons/gdharness_runtime/runtime_values.gd")

var failures: Array[String] = []


func _init() -> void:
	_check(Values.new())

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


func _check(values: Values) -> void:
	var vec2: Variant = values.serialize(Vector2(1.5, -2.5))
	if vec2 != {"_type": "Vector2", "x": 1.5, "y": -2.5}:
		_fail("Vector2: %s" % JSON.stringify(vec2))
	if values.deserialize(vec2) != Vector2(1.5, -2.5):
		_fail("Vector2 round trip: %s" % str(values.deserialize(vec2)))

	if values.deserialize(values.serialize(Vector3(1, 2, 3))) != Vector3(1, 2, 3):
		_fail("Vector3 round trip")
	if values.deserialize(values.serialize(Vector2i(4, 5))) != Vector2i(4, 5):
		_fail("Vector2i round trip")
	if values.deserialize(values.serialize(Vector3i(6, 7, 8))) != Vector3i(6, 7, 8):
		_fail("Vector3i round trip")
	if values.deserialize(values.serialize(Color(0.25, 0.5, 0.75, 1))) != Color(0.25, 0.5, 0.75, 1):
		_fail("Color round trip")
	if values.deserialize(values.serialize(NodePath("Root/Child"))) != NodePath("Root/Child"):
		_fail("NodePath round trip")

	var rect: Dictionary = values.serialize(Rect2(Vector2(1, 2), Vector2(3, 4)))
	if _tag_of(rect) != "Rect2":
		_fail("Rect2 tag: %s" % JSON.stringify(rect))
	elif _tag_of(rect["position"]) != "Vector2":
		_fail("Rect2 does not recurse into its position: %s" % JSON.stringify(rect))

	var transform: Dictionary = values.serialize(Transform2D(0.0, Vector2(3, 4)))
	if _tag_of(transform) != "Transform2D":
		_fail("Transform2D tag: %s" % JSON.stringify(transform))
	elif _tag_of(transform["origin"]) != "Vector2":
		_fail("Transform2D origin: %s" % JSON.stringify(transform))

	var nested: Variant = values.serialize([Vector2(1, 1), {"inner": Vector3(2, 2, 2)}])
	var members: Array = []
	if nested is Array:
		members = nested
	if members.size() != 2:
		_fail("array shape: %s" % JSON.stringify(nested))
	elif _tag_of(members[0]) != "Vector2":
		_fail("array member: %s" % JSON.stringify(members))
	else:
		var restored: Array = values.deserialize(members)
		var restored_inner: Dictionary = restored[1]
		if restored[0] != Vector2(1, 1) or restored_inner["inner"] != Vector3(2, 2, 2):
			_fail("nested round trip: %s" % str(restored))

	# A Resource is also an Object, so the Resource branch has to be reached first or the path
	# is dropped and the caller gets a bare class name back.
	var resource: Resource = Resource.new()
	resource.resource_path = "res://thing.tres"
	var serialised: Dictionary = values.serialize(resource)
	if _tag_of(serialised) != "Resource":
		_fail("Resource tag: %s" % JSON.stringify(serialised))
	elif serialised.get("path", "") != "res://thing.tres":
		_fail("Resource path: %s" % JSON.stringify(serialised))

	if _tag_of(values.serialize(RefCounted.new())) != "Object":
		_fail("Object tag: %s" % JSON.stringify(values.serialize(RefCounted.new())))

	if values.serialize(null) != null:
		_fail("null")
	if values.serialize(7) != 7:
		_fail("passthrough int")
	if values.deserialize(7) != 7:
		_fail("deserialize passthrough int")

	var untagged: Dictionary = values.deserialize({"a": {"_type": "Vector2", "x": 9, "y": 9}})
	if untagged["a"] != Vector2(9, 9):
		_fail("untagged dictionary recursion: %s" % str(untagged))

	var unknown: Dictionary = {"_type": "Nonesuch", "x": 1}
	if values.deserialize(unknown) != unknown:
		_fail("unknown tag: %s" % str(values.deserialize(unknown)))

	# Arguments arrive over the wire as strings and have to be fitted to the parameter the
	# object itself declares, or callv refuses a number that was written as "2.0".
	if values.fitted("2.0", TYPE_FLOAT) != 2.0:
		_fail("_as_type string to float: %s" % str(values.fitted("2.0", TYPE_FLOAT)))
	if values.fitted("7", TYPE_INT) != 7:
		_fail("_as_type string to int: %s" % str(values.fitted("7", TYPE_INT)))
	if values.fitted("true", TYPE_BOOL) != true:
		_fail("_as_type string to bool: %s" % str(values.fitted("true", TYPE_BOOL)))
	if values.fitted("plain", TYPE_STRING) != "plain":
		_fail("_as_type leaves a string alone: %s" % str(values.fitted("plain", TYPE_STRING)))
	if values.fitted({"_type": "Vector2", "x": 1, "y": 2}, TYPE_NIL) != Vector2(1, 2):
		_fail("_as_type with no declared type still deserialises")
