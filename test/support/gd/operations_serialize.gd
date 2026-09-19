extends SceneTree

## Drives the value serialisers the headless operations use. They convert Godot values to
## JSON-safe dictionaries and back, and they are dispatch chains where a reordered branch
## silently changes the answer rather than failing, so the round trip is asserted value by value.

const Serialisation = preload("res://operations/serialisation.gd")

## The types that are described rather than rebuilt, because nothing can send one back.
const DESCRIBED: Array[int] = [TYPE_OBJECT, TYPE_RID, TYPE_CALLABLE, TYPE_SIGNAL]

var failures: Array[String] = []
var values: Serialisation = Serialisation.new()
var samples: Dictionary = {}


func _init() -> void:
	samples = _samples()
	_check_serialize()
	_check_deserialize()
	_check_every_type()

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

	# Object-typed and holding nothing, which is not the plain null below and does not take its
	# branch: one that was never set, and one that has been freed. The second never reaches the
	# object serialiser at all, because the call fails on the argument before it runs.
	var holder: Node = Node.new()
	var nothing: Variant = holder.callv("find_child", ["nonesuch", true, false])
	if values.serialize_value(nothing) != null:
		_fail("a method that answered nothing: %s" % JSON.stringify(values.serialize_value(nothing)))
	holder.free()

	var doomed: Node = Node.new()
	var stale: Variant = doomed
	doomed.free()
	if values.serialize_value(stale) != null:
		_fail("an object that has been freed: %s" % JSON.stringify(values.serialize_value(stale)))

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


## Every type the engine has, carried through JSON and back.
##
## JSON does not refuse a value it cannot carry: it writes the value's own text and moves on, so a
## type nobody added to the table came back as a string that reads like an answer and cannot be
## read back. A Polygon2D's points were "[(1.0, 2.0), (3.0, 4.0)]" and a Quaternion "(0, 0, 0, 1)".
##
## The engine's own type count is what is walked, rather than a list kept here, because a list kept
## here is the mistake this exists to catch. A type with no sample below fails rather than being
## skipped, so an engine that grows one says so.
func _check_every_type() -> void:
	for kind: int in range(TYPE_MAX):
		if DESCRIBED.has(kind):
			_check_described(kind)
			continue

		if not samples.has(kind):
			_fail("%s has no sample, so nothing says whether it survives JSON" % type_string(kind))
			continue
		var original: Variant = samples[kind]

		var carried: Variant = JSON.parse_string(JSON.stringify({"v": values.serialize_value(original)}))
		var held: Dictionary = carried
		var rebuilt: Variant = type_convert(values.deserialize_value(held["v"]), kind)
		if var_to_str(rebuilt) != var_to_str(original):
			_fail(
				(
					"%s did not survive JSON: sent %s, wire %s, back %s"
					% [
						type_string(kind),
						var_to_str(original),
						JSON.stringify(held["v"]),
						var_to_str(rebuilt)
					]
				)
			)


## The types that describe rather than rebuild: an object, a bound method, a signal and a resource
## id are all things a caller can be told about and none of them can be sent back. What is asked of
## these is that the answer is a tagged description rather than the engine's own text for them.
func _check_described(kind: int) -> void:
	if not samples.has(kind):
		_fail("%s has no sample" % type_string(kind))
		return
	var original: Variant = samples[kind]
	var serialised: Variant = values.serialize_value(original)
	if not serialised is Dictionary:
		_fail("%s flattened to %s" % [type_string(kind), JSON.stringify(serialised)])
		return
	var described: Dictionary = serialised
	if str(described.get("_type", "")).is_empty():
		_fail("%s came back untagged: %s" % [type_string(kind), JSON.stringify(described)])


## A value of each type, chosen so that a serialiser answering with a default would be caught: a
## Vector2 that came back as the zero vector is indistinguishable from one that was never read.
##
## One table rather than a branch per type, because a branch per type is forty exits out of one
## function and the linter is right about that.
func _samples() -> Dictionary:
	return {
		TYPE_NIL: null,
		TYPE_BOOL: true,
		TYPE_INT: 42,
		TYPE_FLOAT: 1.5,
		TYPE_STRING: "text",
		TYPE_VECTOR2: Vector2(1.5, -2.5),
		TYPE_VECTOR2I: Vector2i(3, -4),
		TYPE_RECT2: Rect2(1, 2, 3, 4),
		TYPE_RECT2I: Rect2i(5, 6, 7, 8),
		TYPE_VECTOR3: Vector3(1, 2, 3),
		TYPE_VECTOR3I: Vector3i(4, 5, 6),
		TYPE_TRANSFORM2D: Transform2D(Vector2(1, 2), Vector2(3, 4), Vector2(5, 6)),
		TYPE_VECTOR4: Vector4(1, 2, 3, 4),
		TYPE_VECTOR4I: Vector4i(5, 6, 7, 8),
		TYPE_PLANE: Plane(Vector3(0, 1, 0), 3.5),
		TYPE_QUATERNION: Quaternion(0.1, 0.2, 0.3, 0.9),
		TYPE_AABB: AABB(Vector3(1, 2, 3), Vector3(4, 5, 6)),
		TYPE_BASIS: Basis(Vector3(1, 2, 3), Vector3(4, 5, 6), Vector3(7, 8, 9)),
		TYPE_TRANSFORM3D:
		Transform3D(Basis(Vector3(1, 2, 3), Vector3(4, 5, 6), Vector3(7, 8, 9)), Vector3(9, 8, 7)),
		TYPE_PROJECTION:
		Projection(Vector4(1, 2, 3, 4), Vector4(5, 6, 7, 8), Vector4(9, 1, 2, 3), Vector4(4, 5, 6, 7)),
		TYPE_COLOR: Color(0.25, 0.5, 0.75, 0.5),
		TYPE_STRING_NAME: &"walk",
		TYPE_NODE_PATH: NodePath("Root/Child"),
		TYPE_DICTIONARY: {"where": Vector2(1, 2)},
		TYPE_ARRAY: [Vector2(1, 2), "plain"],
		TYPE_PACKED_BYTE_ARRAY: PackedByteArray([1, 2, 250]),
		TYPE_PACKED_INT32_ARRAY: PackedInt32Array([1, -2]),
		TYPE_PACKED_INT64_ARRAY: PackedInt64Array([3, -4]),
		TYPE_PACKED_FLOAT32_ARRAY: PackedFloat32Array([1.5, -2.5]),
		TYPE_PACKED_FLOAT64_ARRAY: PackedFloat64Array([3.5, -4.5]),
		TYPE_PACKED_STRING_ARRAY: PackedStringArray(["a", "b"]),
		TYPE_PACKED_VECTOR2_ARRAY: PackedVector2Array([Vector2(1, 2), Vector2(3, 4)]),
		TYPE_PACKED_VECTOR3_ARRAY: PackedVector3Array([Vector3(1, 2, 3)]),
		TYPE_PACKED_COLOR_ARRAY: PackedColorArray([Color(1, 0, 0, 1)]),
		TYPE_PACKED_VECTOR4_ARRAY: PackedVector4Array([Vector4(1, 2, 3, 4)]),
		TYPE_OBJECT: RefCounted.new(),
		TYPE_RID: RID(),
		TYPE_CALLABLE: Callable(self, "_samples"),
		TYPE_SIGNAL: Signal(self, "process_frame"),
	}
