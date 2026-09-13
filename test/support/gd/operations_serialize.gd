extends SceneTree

## Drives the value serialisers the headless operations use. They convert Godot values to
## JSON-safe dictionaries and back, and they are dispatch chains where a reordered branch
## silently changes the answer rather than failing, so the round trip is asserted value by value.

const Serialisation = preload("res://operations/serialisation.gd")

var failures: Array[String] = []
var values: Serialisation = Serialisation.new()


func _init() -> void:
	_check_serialize()
	_check_deserialize()

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


func _check_serialize() -> void:
	var vec2: Variant = values.serialize_value(Vector2(1.5, -2.5))
	if vec2 != {"x": 1.5, "y": -2.5, "_type": "Vector2"}:
		_fail("Vector2: %s" % JSON.stringify(vec2))

	if _tag_of(values.serialize_value(Vector3(1, 2, 3))) != "Vector3":
		_fail("Vector3 tag: %s" % JSON.stringify(values.serialize_value(Vector3(1, 2, 3))))
	if _tag_of(values.serialize_value(Vector2i(4, 5))) != "Vector2i":
		_fail("Vector2i tag: %s" % JSON.stringify(values.serialize_value(Vector2i(4, 5))))
	if _tag_of(values.serialize_value(Vector3i(6, 7, 8))) != "Vector3i":
		_fail("Vector3i tag: %s" % JSON.stringify(values.serialize_value(Vector3i(6, 7, 8))))
	if _tag_of(values.serialize_value(Color(0.25, 0.5, 0.75, 1))) != "Color":
		_fail("Color tag: %s" % JSON.stringify(values.serialize_value(Color(0.25, 0.5, 0.75, 1))))
	var node_path: Dictionary = values.serialize_value(NodePath("Root/Child"))
	if node_path.get("path", "") != "Root/Child":
		_fail("NodePath: %s" % JSON.stringify(node_path))

	var rect: Dictionary = values.serialize_value(Rect2(Vector2(1, 2), Vector2(3, 4)))
	if _tag_of(rect) != "Rect2":
		_fail("Rect2 tag: %s" % JSON.stringify(rect))
	elif _tag_of(rect["position"]) != "Vector2":
		_fail("Rect2 does not recurse into its position: %s" % JSON.stringify(rect))

	var transform: Dictionary = values.serialize_value(Transform3D.IDENTITY)
	var basis: Dictionary = transform.get("basis", {})
	if _tag_of(transform) != "Transform3D":
		_fail("Transform3D tag: %s" % JSON.stringify(transform))
	elif not basis.has("x"):
		_fail("Transform3D lost its basis: %s" % JSON.stringify(transform))

	# Arrays and dictionaries recurse, so a flattened branch shows up as an untagged member.
	var nested: Variant = values.serialize_value([Vector2(1, 1), {"inner": Vector3(2, 2, 2)}])
	if not nested is Array:
		_fail("array shape: %s" % JSON.stringify(nested))
	else:
		var members: Array = nested
		if members.size() != 2:
			_fail("array shape: %s" % JSON.stringify(members))
		else:
			var inner: Dictionary = members[1]
			if _tag_of(members[0]) != "Vector2":
				_fail("array member: %s" % JSON.stringify(members))
			elif _tag_of(inner["inner"]) != "Vector3":
				_fail("nested dictionary member: %s" % JSON.stringify(members))

	# A Resource is also an Object, so the Resource branch has to be reached first or the path
	# is dropped and the caller gets a bare class name back.
	var resource: Resource = Resource.new()
	resource.resource_path = "res://thing.tres"
	var serialised: Dictionary = values.serialize_value(resource)
	if _tag_of(serialised) != "Resource":
		_fail("Resource tag: %s" % JSON.stringify(serialised))
	elif serialised.get("path", "") != "res://thing.tres":
		_fail("Resource path: %s" % JSON.stringify(serialised))

	# A pathless Resource says so rather than inventing an empty path.
	var unsaved: Dictionary = values.serialize_value(Resource.new())
	if unsaved.has("path"):
		_fail("unsaved Resource claims a path: %s" % JSON.stringify(unsaved))

	if _tag_of(values.serialize_value(RefCounted.new())) != "Object":
		_fail("Object tag: %s" % JSON.stringify(values.serialize_value(RefCounted.new())))

	if values.serialize_value(null) != null:
		_fail("null")
	if values.serialize_value(42) != 42:
		_fail("passthrough int")
	if values.serialize_value("plain") != "plain":
		_fail("passthrough string")


func _check_deserialize() -> void:
	if values.deserialize_value(values.serialize_value(Vector2(1.5, -2.5))) != Vector2(1.5, -2.5):
		_fail("Vector2 round trip")
	if values.deserialize_value(values.serialize_value(Vector3(1, 2, 3))) != Vector3(1, 2, 3):
		_fail("Vector3 round trip")
	if values.deserialize_value(values.serialize_value(Vector2i(4, 5))) != Vector2i(4, 5):
		_fail("Vector2i round trip")
	if values.deserialize_value(values.serialize_value(Vector3i(6, 7, 8))) != Vector3i(6, 7, 8):
		_fail("Vector3i round trip")
	var colour: Color = Color(0.25, 0.5, 0.75, 1)
	if values.deserialize_value(values.serialize_value(colour)) != colour:
		_fail("Color round trip")
	if values.deserialize_value(values.serialize_value(NodePath("Root/Child"))) != NodePath("Root/Child"):
		_fail("NodePath round trip")

	var rect: Rect2 = Rect2(Vector2(1, 2), Vector2(3, 4))
	if values.deserialize_value(values.serialize_value(rect)) != rect:
		_fail("Rect2 round trip: %s" % str(values.deserialize_value(values.serialize_value(rect))))

	var restored: Array = values.deserialize_value(
		values.serialize_value([Vector2(1, 1), {"inner": Vector3(2, 2, 2)}])
	)
	var restored_inner: Dictionary = restored[1]
	if restored[0] != Vector2(1, 1) or restored_inner["inner"] != Vector3(2, 2, 2):
		_fail("nested round trip: %s" % str(restored))

	if values.deserialize_value(null) != null:
		_fail("null")
	if values.deserialize_value(42) != 42:
		_fail("passthrough int")

	# An untagged dictionary is walked rather than handed back whole.
	var untagged: Dictionary = values.deserialize_value({"a": {"_type": "Vector2", "x": 9, "y": 9}})
	if untagged["a"] != Vector2(9, 9):
		_fail("untagged dictionary recursion: %s" % str(untagged))

	# An unknown tag comes back as it arrived rather than being guessed at.
	var unknown: Dictionary = {"_type": "Nonesuch", "x": 1}
	if values.deserialize_value(unknown) != unknown:
		_fail("unknown tag: %s" % str(values.deserialize_value(unknown)))
