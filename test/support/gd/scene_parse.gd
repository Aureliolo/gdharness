extends SceneTree

## A property value can arrive in three shapes and the parser tries them in order: a dictionary
## that names its own type, a dictionary shaped like the type the property declares, or a bare
## array positional for a vector. The order matters and so do the gaps between them, because a
## tag that names a type it cannot build has to fall through rather than answer with a wrong
## value, and a tag that legitimately means nothing has to answer null rather than fall through.

var failures: Array[String] = []


func _init() -> void:
	var tools = load("res://addons/godot_mcp_editor/tools/scene_tools.gd").new()

	_check_tagged(tools)
	_check_shaped(tools)
	_check_positional(tools)
	_check_gaps(tools)

	tools.free()

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _check_tagged(tools: Object) -> void:
	if tools._parse_value({"_type": "Vector2", "x": 1, "y": 2}) != Vector2(1, 2):
		_fail("tagged Vector2")
	if tools._parse_value({"type": "Vector2", "x": 1, "y": 2}) != Vector2(1, 2):
		_fail("tagged Vector2 under the older 'type' key")
	if tools._parse_value({"_type": "Vector3", "x": 1, "y": 2, "z": 3}) != Vector3(1, 2, 3):
		_fail("tagged Vector3")
	if tools._parse_value({"_type": "Vector2i", "x": 4, "y": 5}) != Vector2i(4, 5):
		_fail("tagged Vector2i")
	if tools._parse_value({"_type": "Vector3i", "x": 6, "y": 7, "z": 8}) != Vector3i(6, 7, 8):
		_fail("tagged Vector3i")
	if (
		tools._parse_value({"_type": "Color", "r": 0.25, "g": 0.5, "b": 0.75, "a": 1})
		!= Color(0.25, 0.5, 0.75, 1)
	):
		_fail("tagged Color")
	if tools._parse_value({"_type": "NodePath", "path": "Root/Child"}) != NodePath("Root/Child"):
		_fail("tagged NodePath")

	var rect = tools._parse_value({"_type": "Rect2", "x": 1, "y": 2, "width": 3, "height": 4})
	if rect != Rect2(1, 2, 3, 4):
		_fail("tagged Rect2: %s" % str(rect))

	var transform2d = (
		tools
		. _parse_value(
			{
				"_type": "Transform2D",
				"x": {"x": 1, "y": 0},
				"y": {"x": 0, "y": 1},
				"origin": {"x": 3, "y": 4},
			}
		)
	)
	if not transform2d is Transform2D:
		_fail("tagged Transform2D is not a Transform2D: %s" % str(transform2d))
	elif transform2d.origin != Vector2(3, 4):
		_fail("tagged Transform2D origin: %s" % str(transform2d.origin))

	var transform3d = (
		tools
		. _parse_value(
			{
				"_type": "Transform3D",
				"basis": {"x": {"x": 1}, "y": {"y": 1}, "z": {"z": 1}},
				"origin": {"x": 5, "y": 6, "z": 7},
			}
		)
	)
	if not transform3d is Transform3D:
		_fail("tagged Transform3D is not a Transform3D: %s" % str(transform3d))
	elif transform3d.origin != Vector3(5, 6, 7):
		_fail("tagged Transform3D origin: %s" % str(transform3d.origin))


func _check_shaped(tools: Object) -> void:
	if tools._parse_value({"x": 1, "y": 2}, TYPE_VECTOR2) != Vector2(1, 2):
		_fail("untagged dictionary against a declared Vector2")
	if tools._parse_value({"x": 1, "y": 2, "z": 3}, TYPE_VECTOR3) != Vector3(1, 2, 3):
		_fail("untagged dictionary against a declared Vector3")
	if tools._parse_value({"r": 1, "g": 0, "b": 0}, TYPE_COLOR) != Color(1, 0, 0, 1):
		_fail("untagged dictionary against a declared Color")
	if tools._parse_value({"path": "Root"}, TYPE_NODE_PATH) != NodePath("Root"):
		_fail("untagged dictionary against a declared NodePath")

	# With no declared type there is nothing to read it as, so it stays a dictionary.
	var plain = tools._parse_value({"x": 1, "y": 2})
	if not plain is Dictionary:
		_fail("untagged dictionary with no declared type should stay a dictionary: %s" % str(plain))


func _check_positional(tools: Object) -> void:
	if tools._parse_value([1, 2], TYPE_VECTOR2) != Vector2(1, 2):
		_fail("array against a declared Vector2")
	if tools._parse_value([1, 2, 3], TYPE_VECTOR3) != Vector3(1, 2, 3):
		_fail("array against a declared Vector3")
	if tools._parse_value([4, 5], TYPE_VECTOR2I) != Vector2i(4, 5):
		_fail("array against a declared Vector2i")

	# Too short for the declared type, so it is a list rather than a vector.
	var short = tools._parse_value([1], TYPE_VECTOR2)
	if not short is Array:
		_fail("a too-short array should stay an array: %s" % str(short))

	# A list parses per item, so a tagged member inside it comes back built.
	var nested = tools._parse_value([{"_type": "Vector2", "x": 1, "y": 1}])
	if not nested is Array or nested.size() != 1:
		_fail("array shape: %s" % str(nested))
	elif nested[0] != Vector2(1, 1):
		_fail("array does not parse its members: %s" % str(nested))


func _check_gaps(tools: Object) -> void:
	# A Resource with no path means nothing, which is not the same as the tag not matching.
	var empty_resource = tools._parse_value({"_type": "Resource", "path": ""})
	if empty_resource != null:
		_fail("a pathless Resource should parse to null, got %s" % str(empty_resource))

	# A tag naming a type it has not got the keys to build falls through to the declared type,
	# rather than answering with a Transform2D built out of defaults.
	var incomplete = tools._parse_value({"_type": "Transform2D", "x": 1, "y": 2}, TYPE_VECTOR2)
	if incomplete != Vector2(1, 2):
		_fail("an incomplete Transform2D should fall through to the declared type, got %s" % str(incomplete))

	# A tag nobody builds is left alone.
	var unknown = tools._parse_value({"_type": "Nonesuch", "x": 1})
	if not unknown is Dictionary:
		_fail("an unknown tag should stay a dictionary: %s" % str(unknown))

	# Scalars pass through untouched.
	if tools._parse_value(7) != 7:
		_fail("passthrough int")
	if tools._parse_value("plain") != "plain":
		_fail("passthrough string")
	if tools._parse_value(null) != null:
		_fail("passthrough null")
