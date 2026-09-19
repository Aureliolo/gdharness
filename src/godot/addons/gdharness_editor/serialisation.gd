extends RefCounted

## Godot values as JSON can carry them, and JSON back into the values the engine wants.
##
## This file is the one beside the operations, and `bun run sync:gd` copies it into each addon,
## because an addon is installed as a directory and cannot preload out of one. The copies are
## byte for byte this file and a fixture says so. Three spellings of one value is what there was
## before: the same Vector2 came back three ways depending on which tool was asked, and a caller
## reading a property off the editor could not feed it back to the game.

const Read = preload("reading.gd")

# What the engine carries from one to another without complaint, which is what a value written to a
# property or handed to a parameter may arrive as. Numbers include bool because the engine counts it
# as one, and the three text types are one string wearing three hats.
const NUMBERS: Array[int] = [TYPE_BOOL, TYPE_INT, TYPE_FLOAT]
const TEXTS: Array[int] = [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH]

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

# What each Godot type becomes on the wire, as one table you can read rather than an order you
# have to trust. Keyed on typeof() rather than written as a chain of `is` tests, because the
# order mattered: Resource had to be tested before Object or every resource came back as a bare
# class name with its path dropped, and nothing but a comment said so.
#
# Method names rather than Callables: a table of Callables bound to this object is a reference
# cycle that nothing breaks, so the object outlives the run and the engine reports its script as
# a resource still in use at exit, on the same stderr the server reads failures off.
#
# Every type the engine has that JSON cannot carry is in here, and a fixture walks the engine's own
# type list to say so, because what this table used to be was the types somebody had thought of.
# JSON does not refuse what it cannot carry: it writes the value's own text and moves on, so a
# Polygon2D's points came back as the string "[(1.0, 2.0), (3.0, 4.0)]" and a Quaternion as
# "(0, 0, 0, 1)". Both read as an answer, neither can be read back, and nothing anywhere said the
# value had been flattened on the way out.
#
# The types JSON does carry exactly are left alone, PackedStringArray and the numeric packed arrays
# among them, because a plugin list reads better as ["res://addons/x/plugin.cfg"] than as a tagged
# wrapper around one, and type_convert restores the exact type wherever the receiver knows which
# type it wanted.
const SERIALISERS: Dictionary = {
	TYPE_NIL: "_serialize_nil",
	TYPE_VECTOR2: "_serialize_vector2",
	TYPE_VECTOR2I: "_serialize_vector2i",
	TYPE_VECTOR3: "_serialize_vector3",
	TYPE_VECTOR3I: "_serialize_vector3i",
	TYPE_VECTOR4: "_serialize_vector4",
	TYPE_VECTOR4I: "_serialize_vector4i",
	TYPE_RECT2: "_serialize_rect2",
	TYPE_RECT2I: "_serialize_rect2i",
	TYPE_PLANE: "_serialize_plane",
	TYPE_QUATERNION: "_serialize_quaternion",
	TYPE_AABB: "_serialize_aabb",
	TYPE_BASIS: "_serialize_basis",
	TYPE_TRANSFORM2D: "_serialize_transform2d",
	TYPE_TRANSFORM3D: "_serialize_transform3d",
	TYPE_PROJECTION: "_serialize_projection",
	TYPE_COLOR: "_serialize_color",
	TYPE_NODE_PATH: "_serialize_node_path",
	TYPE_RID: "_serialize_rid",
	TYPE_OBJECT: "_serialize_object",
	TYPE_CALLABLE: "_serialize_callable",
	TYPE_SIGNAL: "_serialize_signal",
	TYPE_DICTIONARY: "_serialize_dictionary",
	TYPE_ARRAY: "_serialize_array",
	TYPE_PACKED_BYTE_ARRAY: "_serialize_bytes",
	TYPE_PACKED_VECTOR2_ARRAY: "_serialize_vector2s",
	TYPE_PACKED_VECTOR3_ARRAY: "_serialize_vector3s",
	TYPE_PACKED_VECTOR4_ARRAY: "_serialize_vector4s",
	TYPE_PACKED_COLOR_ARRAY: "_serialize_colors",
}

# What each tag builds back into. The other half of the table above, and separate from it because
# they are keyed differently: one by the type of a value in hand, the other by the name in a
# dictionary that arrived from somewhere else.
const BUILDERS: Dictionary = {
	"Vector2": "_build_vector2",
	"Vector2i": "_build_vector2i",
	"Vector3": "_build_vector3",
	"Vector3i": "_build_vector3i",
	"Vector4": "_build_vector4",
	"Vector4i": "_build_vector4i",
	"Rect2": "_build_rect2",
	"Rect2i": "_build_rect2i",
	"Plane": "_build_plane",
	"Quaternion": "_build_quaternion",
	"AABB": "_build_aabb",
	"Basis": "_build_basis",
	"Transform2D": "_build_transform2d",
	"Transform3D": "_build_transform3d",
	"Projection": "_build_projection",
	"Color": "_build_color",
	"NodePath": "_build_node_path",
	"PackedByteArray": "_build_bytes",
}

# What each tag has to carry before it is built. A tag naming a type whose keys are not there is a
# tag somebody wrote by mistake or wrote for a different shape, and building one out of defaults
# answers with a Transform2D of zeros where the caller meant something else entirely. Unbuilt, it
# comes back as it arrived, and whoever asked can read it against the type they were expecting.
const REQUIRED: Dictionary = {
	"Vector2": [["x", "y"]],
	"Vector2i": [["x", "y"]],
	"Vector3": [["x", "y", "z"]],
	"Vector3i": [["x", "y", "z"]],
	"Vector4": [["x", "y", "z", "w"]],
	"Vector4i": [["x", "y", "z", "w"]],
	"Rect2": [["position", "size"], ["x", "y", "width", "height"]],
	"Rect2i": [["position", "size"], ["x", "y", "width", "height"]],
	"Plane": [["normal", "d"]],
	"Quaternion": [["x", "y", "z", "w"]],
	"AABB": [["position", "size"]],
	"Basis": [["x", "y", "z"]],
	"Transform2D": [["x", "y", "origin"]],
	"Transform3D": [["basis", "origin"]],
	"Projection": [["x", "y", "z", "w"]],
	"Color": [["r", "g", "b"]],
	"NodePath": [["path"]],
	"PackedByteArray": [["base64"]],
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
#
# A tag with no builder is left as the dictionary it arrived as. Some of them describe something
# that cannot be rebuilt at all, a Callable or a live object, and answering with a default-built
# one of those would be inventing a value rather than reporting one.
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
		var mapped: Dictionary = {}
		for key: Variant in fields:
			mapped[key] = deserialize_value(fields[key])
		return mapped

	# Each component read as the type the constructor wants before it is handed over. These come
	# out of JSON as Variant, and a project holding `unsafe_call_argument` at error level refuses
	# to compile a script that gives a Variant to a typed parameter: the operations are compiled
	# under the target project's warning levels, so one such project lost every headless call.
	var tag: String = str(fields["_type"])
	var builder: String = BUILDERS.get(tag, "")
	var needed: Array = REQUIRED.get(tag, [])
	if builder.is_empty() or not _carries(fields, needed):
		return fields
	return call(builder, fields)


## Whether two values can be compared without the comparison itself failing.
##
## GDScript's `==` is not total. An Object against a String is a hard error rather than false, and
## an error raised inside a game is not a wrong answer: it stops the game. A caller who asked
## `runtime_wait until` for the wrong kind of value got their game held at a debugger break, every
## later call answering "did not respond within 10000ms, it may be stuck in a long frame", and
## nothing anywhere naming the argument that did it. A wrong argument costs a refusal, never the
## session's game.
##
## Only an object is special. Every other pair the engine answers, false where they differ, and
## refusing those would refuse calls that work: an int against a float is the same number to a
## caller waiting for 1 on a property holding 1.0.
static func comparable(one: Variant, other: Variant) -> bool:
	var left: int = typeof(one)
	var right: int = typeof(other)
	if left != TYPE_OBJECT and right != TYPE_OBJECT:
		return true
	# An object compares with another object and with null. Anything else is the error above.
	return (left == TYPE_OBJECT or left == TYPE_NIL) and (right == TYPE_OBJECT or right == TYPE_NIL)


## Whether [param value] can be given to something declared as [param type] without damage.
##
## Here rather than beside either caller because the running game and the editor ask it of the same
## values and must not answer differently. What it protects against differs by side and both are
## silent: `callv` and `==` raise inside a running game, which holds it at a debugger break, while
## `Object.set` in the editor converts instead and writes the result to the scene file. A word where
## an int goes is stored as 0, where a bool goes as true, where a Vector2 goes as (0, 0), and the
## tool reports the change as made. The property keeps a value nobody asked for and the scene is
## saved with it.
##
## A list of what is accepted rather than of what is refused, which is the way round that errs
## safely. The engine's own conversion table is not readable from GDScript, so either list is a
## guess at it; guessing narrow costs a caller a refusal naming both types, and guessing wide costs
## them the damage above. A refusal is the cheaper mistake, and it is the one they can act on.
static func acceptable(value: Variant, type: int) -> bool:
	if type == TYPE_NIL:
		return true
	var given: int = typeof(value)
	if given == type:
		return true
	# null is a value for anything that holds an object, and for nothing else.
	if given == TYPE_NIL:
		return type == TYPE_OBJECT
	if NUMBERS.has(given) and NUMBERS.has(type):
		return true
	if TEXTS.has(given) and TEXTS.has(type):
		return true
	return given == TYPE_ARRAY and LIST_TYPES.has(type)


## A value from the wire fitted to the type a property or parameter declares. Arguments arrive
## as strings often enough, and callv refuses a "2.0" where a float is wanted, so a string that
## reads as the wanted scalar is read as one.
##
## The conversion is also what restores a packed array's exact type. Those cross as the plain JSON
## lists they fit into, so what comes back from the wire is an Array, and the parameter is what says
## it was a PackedStringArray.
func fitted(value: Variant, type: int) -> Variant:
	var rebuilt: Variant = deserialize_value(value)
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
		# A string that does not read as the type wanted is handed back as the string it is, so
		# whoever asked can refuse it. type_convert answers 0 for "not an index" and true for any
		# text at all, and a caller who sent a word got back a number they never sent: get_child
		# answered about child 0 with no refusal and no note, which is a halt traded for a plausible
		# wrong answer, and the wrong answer is the worse of the two.
		if typeof(parsed) == TYPE_NIL or typeof(parsed) == TYPE_STRING:
			return rebuilt
		rebuilt = parsed

	return type_convert(rebuilt, type)


## Whether [param fields] carries every key of any one of [param alternatives].
##
## More than one spelling because a rectangle has two: the two corners it is answered with, and the
## four numbers the editor's own tools answered with before the serialisers were made one, which a
## caller may have kept.
func _carries(fields: Dictionary, alternatives: Array) -> bool:
	for alternative: Variant in alternatives:
		var keys: Array = alternative
		if keys.all(func(key: Variant) -> bool: return fields.has(key)):
			return true
	return false


func _serialize_nil(_value: Variant) -> Variant:
	return null


func _serialize_vector2(value: Vector2) -> Dictionary:
	return {"x": value.x, "y": value.y, "_type": "Vector2"}


func _serialize_vector2i(value: Vector2i) -> Dictionary:
	return {"x": value.x, "y": value.y, "_type": "Vector2i"}


func _serialize_vector3(value: Vector3) -> Dictionary:
	return {"x": value.x, "y": value.y, "z": value.z, "_type": "Vector3"}


func _serialize_vector3i(value: Vector3i) -> Dictionary:
	return {"x": value.x, "y": value.y, "z": value.z, "_type": "Vector3i"}


func _serialize_vector4(value: Vector4) -> Dictionary:
	return {"x": value.x, "y": value.y, "z": value.z, "w": value.w, "_type": "Vector4"}


func _serialize_vector4i(value: Vector4i) -> Dictionary:
	return {"x": value.x, "y": value.y, "z": value.z, "w": value.w, "_type": "Vector4i"}


func _serialize_rect2(value: Rect2) -> Dictionary:
	return {
		"position": serialize_value(value.position), "size": serialize_value(value.size), "_type": "Rect2"
	}


func _serialize_rect2i(value: Rect2i) -> Dictionary:
	return {
		"position": serialize_value(value.position), "size": serialize_value(value.size), "_type": "Rect2i"
	}


func _serialize_plane(value: Plane) -> Dictionary:
	return {"normal": serialize_value(value.normal), "d": value.d, "_type": "Plane"}


func _serialize_quaternion(value: Quaternion) -> Dictionary:
	return {"x": value.x, "y": value.y, "z": value.z, "w": value.w, "_type": "Quaternion"}


func _serialize_aabb(value: AABB) -> Dictionary:
	return {"position": serialize_value(value.position), "size": serialize_value(value.size), "_type": "AABB"}


func _serialize_basis(value: Basis) -> Dictionary:
	return {
		"x": serialize_value(value.x),
		"y": serialize_value(value.y),
		"z": serialize_value(value.z),
		"_type": "Basis"
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
		"origin": serialize_value(value.origin), "basis": serialize_value(value.basis), "_type": "Transform3D"
	}


func _serialize_projection(value: Projection) -> Dictionary:
	return {
		"x": serialize_value(value.x),
		"y": serialize_value(value.y),
		"z": serialize_value(value.z),
		"w": serialize_value(value.w),
		"_type": "Projection"
	}


func _serialize_color(value: Color) -> Dictionary:
	return {"r": value.r, "g": value.g, "b": value.b, "a": value.a, "_type": "Color"}


func _serialize_node_path(value: NodePath) -> Dictionary:
	return {"path": str(value), "_type": "NodePath"}


# An id rather than nothing, because two properties holding the same RID are worth telling apart
# even though neither can be handed back to the engine.
func _serialize_rid(value: RID) -> Dictionary:
	return {"id": value.get_id(), "_type": "RID"}


# A bound method, said in the terms a caller could act on: what it is on, and what it is called.
# It cannot be rebuilt from here, and saying so is the answer rather than a silent null.
func _serialize_callable(value: Callable) -> Dictionary:
	var described: Dictionary = {"method": str(value.get_method()), "_type": "Callable"}
	var holder: Object = value.get_object()
	if holder != null:
		described["object"] = _describe_object(holder)
	return described


func _serialize_signal(value: Signal) -> Dictionary:
	var described: Dictionary = {"name": str(value.get_name()), "_type": "Signal"}
	var holder: Object = value.get_object()
	if holder != null:
		described["object"] = _describe_object(holder)
	return described


func _serialize_dictionary(value: Dictionary) -> Dictionary:
	var serialised: Dictionary = {}
	for key: Variant in value:
		serialised[str(key)] = serialize_value(value[key])
	return serialised


func _serialize_array(value: Array) -> Array:
	return value.map(serialize_value)


# Base64 rather than a list of numbers. A byte array is a texture, a sound or a save file often
# enough that the list would be the whole answer, megabytes of it, and unreadable either way.
func _serialize_bytes(value: PackedByteArray) -> Dictionary:
	return {"base64": Marshalls.raw_to_base64(value), "size": value.size(), "_type": "PackedByteArray"}


# The packed vector and colour arrays, each element serialised the way one of them on its own is.
# A plain list rather than a tagged wrapper, so a polygon reads as the points it is, and because
# the receiver of a write knows the type it wanted and converts to it. One function each rather
# than one taking a Variant, because a Variant handed to the element serialiser is the unsafe
# argument a project with every warning at error level refuses to compile.
func _serialize_vector2s(value: PackedVector2Array) -> Array:
	var serialised: Array = []
	for element: Vector2 in value:
		serialised.append(_serialize_vector2(element))
	return serialised


func _serialize_vector3s(value: PackedVector3Array) -> Array:
	var serialised: Array = []
	for element: Vector3 in value:
		serialised.append(_serialize_vector3(element))
	return serialised


func _serialize_vector4s(value: PackedVector4Array) -> Array:
	var serialised: Array = []
	for element: Vector4 in value:
		serialised.append(_serialize_vector4(element))
	return serialised


func _serialize_colors(value: PackedColorArray) -> Array:
	var serialised: Array = []
	for element: Color in value:
		serialised.append(_serialize_color(element))
	return serialised


# A pathless Resource says so rather than inventing an empty path for the caller to load.
func _serialize_object(value: Object) -> Variant:
	if value is Resource:
		var resource: Resource = value
		if resource.resource_path.is_empty():
			return {"class": resource.get_class(), "_type": "Resource"}
		return {"path": resource.resource_path, "class": resource.get_class(), "_type": "Resource"}
	if value is Node:
		var node: Node = value
		if node.is_inside_tree():
			return {"path": str(node.get_path()), "class": node.get_class(), "_type": "Node"}
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
	var described: Dictionary = {"class": value.get_class(), "_type": "Object"}
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


func _build_vector2(fields: Dictionary) -> Vector2:
	return Vector2(Read.as_float(fields.get("x", 0)), Read.as_float(fields.get("y", 0)))


func _build_vector2i(fields: Dictionary) -> Vector2i:
	return Vector2i(Read.as_int(fields.get("x", 0)), Read.as_int(fields.get("y", 0)))


func _build_vector3(fields: Dictionary) -> Vector3:
	return Vector3(
		Read.as_float(fields.get("x", 0)),
		Read.as_float(fields.get("y", 0)),
		Read.as_float(fields.get("z", 0))
	)


func _build_vector3i(fields: Dictionary) -> Vector3i:
	return Vector3i(
		Read.as_int(fields.get("x", 0)), Read.as_int(fields.get("y", 0)), Read.as_int(fields.get("z", 0))
	)


func _build_vector4(fields: Dictionary) -> Vector4:
	return Vector4(
		Read.as_float(fields.get("x", 0)),
		Read.as_float(fields.get("y", 0)),
		Read.as_float(fields.get("z", 0)),
		Read.as_float(fields.get("w", 0))
	)


func _build_vector4i(fields: Dictionary) -> Vector4i:
	return Vector4i(
		Read.as_int(fields.get("x", 0)),
		Read.as_int(fields.get("y", 0)),
		Read.as_int(fields.get("z", 0)),
		Read.as_int(fields.get("w", 0))
	)


## A rectangle from its two corners, or from the four numbers this tool answered with before the
## serialisers were made one, so an answer somebody kept can still be written back.
func _build_rect2(fields: Dictionary) -> Rect2:
	if not fields.has("position"):
		return Rect2(
			Read.as_float(fields.get("x", 0)),
			Read.as_float(fields.get("y", 0)),
			Read.as_float(fields.get("width", 0)),
			Read.as_float(fields.get("height", 0))
		)
	return Rect2(_vector2_at(fields, "position"), _vector2_at(fields, "size"))


func _build_rect2i(fields: Dictionary) -> Rect2i:
	if not fields.has("position"):
		return Rect2i(
			Read.as_int(fields.get("x", 0)),
			Read.as_int(fields.get("y", 0)),
			Read.as_int(fields.get("width", 0)),
			Read.as_int(fields.get("height", 0))
		)
	return Rect2i(_vector2i_at(fields, "position"), _vector2i_at(fields, "size"))


func _build_plane(fields: Dictionary) -> Plane:
	return Plane(_vector3_at(fields, "normal"), Read.as_float(fields.get("d", 0)))


func _build_quaternion(fields: Dictionary) -> Quaternion:
	return Quaternion(
		Read.as_float(fields.get("x", 0)),
		Read.as_float(fields.get("y", 0)),
		Read.as_float(fields.get("z", 0)),
		Read.as_float(fields.get("w", 0))
	)


func _build_aabb(fields: Dictionary) -> AABB:
	return AABB(_vector3_at(fields, "position"), _vector3_at(fields, "size"))


func _build_basis(fields: Dictionary) -> Basis:
	return Basis(
		_vector3_at(fields, "x", Vector3.RIGHT),
		_vector3_at(fields, "y", Vector3.UP),
		_vector3_at(fields, "z", Vector3.BACK)
	)


func _build_transform2d(fields: Dictionary) -> Transform2D:
	return Transform2D(
		_vector2_at(fields, "x", Vector2.RIGHT),
		_vector2_at(fields, "y", Vector2.DOWN),
		_vector2_at(fields, "origin")
	)


func _build_transform3d(fields: Dictionary) -> Transform3D:
	var held: Variant = fields.get("basis", null)
	if not held is Dictionary:
		return Transform3D(Basis.IDENTITY, _vector3_at(fields, "origin"))
	var columns: Dictionary = held
	return Transform3D(_build_basis(columns), _vector3_at(fields, "origin"))


func _build_projection(fields: Dictionary) -> Projection:
	return Projection(
		_vector4_at(fields, "x"), _vector4_at(fields, "y"), _vector4_at(fields, "z"), _vector4_at(fields, "w")
	)


func _build_color(fields: Dictionary) -> Color:
	return Color(
		Read.as_float(fields.get("r", 0)),
		Read.as_float(fields.get("g", 0)),
		Read.as_float(fields.get("b", 0)),
		Read.as_float(fields.get("a", 1), 1.0)
	)


func _build_node_path(fields: Dictionary) -> NodePath:
	return NodePath(str(fields.get("path", "")))


func _build_bytes(fields: Dictionary) -> PackedByteArray:
	return Marshalls.base64_to_raw(str(fields.get("base64", "")))


## One component of a compound value, as the type its constructor wants.
##
## Their own functions because a constructor refuses a Variant under `unsafe_call_argument`, and
## because a component that is not there at all has to answer with a default rather than take the
## whole build down with it.
##
## The component is built from its keys rather than deserialised, so it does not matter whether it
## carries a tag. A caller writing a transform by hand writes {"x": {"x": 1, "y": 0}}, and that is
## the same value as the tagged form this answers with.
##
## [param fallback] is what a missing component is, which is the zero vector everywhere except the
## columns of a basis: a matrix half given should come out the identity it was being varied from
## rather than the degenerate one that collapses everything drawn with it.
func _vector2_at(fields: Dictionary, key: String, fallback: Vector2 = Vector2.ZERO) -> Vector2:
	var held: Variant = fields.get(key, null)
	if not held is Dictionary:
		return fallback
	var component: Dictionary = held
	return _build_vector2(component)


func _vector2i_at(fields: Dictionary, key: String, fallback: Vector2i = Vector2i.ZERO) -> Vector2i:
	var held: Variant = fields.get(key, null)
	if not held is Dictionary:
		return fallback
	var component: Dictionary = held
	return _build_vector2i(component)


func _vector3_at(fields: Dictionary, key: String, fallback: Vector3 = Vector3.ZERO) -> Vector3:
	var held: Variant = fields.get(key, null)
	if not held is Dictionary:
		return fallback
	var component: Dictionary = held
	return _build_vector3(component)


func _vector4_at(fields: Dictionary, key: String, fallback: Vector4 = Vector4.ZERO) -> Vector4:
	var held: Variant = fields.get(key, null)
	if not held is Dictionary:
		return fallback
	var component: Dictionary = held
	return _build_vector4(component)
