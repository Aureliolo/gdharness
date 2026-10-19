extends RefCounted

## Godot values as JSON can carry them, and JSON back into the values the engine wants.
##
## This file is the one beside the operations, and `bun run sync:gd` copies it into each addon,
## because an addon is installed as a directory and cannot preload out of one. The copies are
## byte for byte this file and a fixture says so. Three spellings of one value is what there was
## before: the same Vector2 came back three ways depending on which tool was asked, and a caller
## reading a property off the editor could not feed it back to the game.

const GdhRead = preload("reading.gd")
const GdhShapes = preload("value_shapes.gd")

# What the engine carries from one to another without complaint, which is what a value written to a
# property or handed to a parameter may arrive as. Numbers include bool because the engine counts it
# as one, and the three text types are one string wearing three hats.
const NUMBERS: Array[int] = [TYPE_BOOL, TYPE_INT, TYPE_FLOAT]
const TEXTS: Array[int] = [TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH]

# 2^53. A JSON number is a double, and every whole number below this one in size has a double of
# its own; from here on two or more share each double, so one arriving tells nobody which was sent.
const EXACT: int = 9007199254740992

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
	TYPE_INT: "_serialize_int",
	TYPE_PACKED_INT64_ARRAY: "_serialize_ints",
	TYPE_FLOAT: "_serialize_float",
	TYPE_PACKED_FLOAT32_ARRAY: "_serialize_floats",
	TYPE_PACKED_FLOAT64_ARRAY: "_serialize_floats",
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
	"float": "_build_float",
	"int": "_build_int",
	"RID": "_build_rid",
	"Dictionary": "_build_dictionary",
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
	if serialiser.is_empty():
		return value
	var carried: Variant = call(serialiser, value)
	# The fixed shapes carry their components as bare floats, so an infinite one in a Vector2 is
	# tagged here; containers reach their members through this function already.
	return carried if typeof(value) in [TYPE_ARRAY, TYPE_DICTIONARY] else _finite(carried)


# [param carried] with every non-finite float in it tagged. JSON has no spelling for infinity or
# NaN: the engine writes 1e99999 and null, and the server, reading 1e99999 as Infinity, writes it
# back out as null, so a property holding INF was answered as holding nothing.
func _finite(carried: Variant) -> Variant:
	if carried is float:
		var number: float = carried
		return _serialize_float(number)
	if carried is Dictionary:
		var fields: Dictionary = carried
		var tagged: Dictionary = {}
		for key: Variant in fields:
			tagged[key] = _finite(fields[key])
		return tagged
	if carried is Array:
		var items: Array = carried
		var tagged_items: Array = []
		for item: Variant in items:
			tagged_items.append(_finite(item))
		return tagged_items
	return carried


func _serialize_float(value: float) -> Variant:
	if is_finite(value):
		return value
	return {"_type": "float", "value": "nan" if is_nan(value) else ("inf" if value > 0 else "-inf")}


# A packed float array stays the JSON list it is unless something in it has no JSON spelling.
func _serialize_floats(value: Variant) -> Variant:
	var numbers: Array = []
	if value is PackedFloat32Array:
		var single: PackedFloat32Array = value
		numbers = Array(single)
	else:
		var double: PackedFloat64Array = value
		numbers = Array(double)
	for number: float in numbers:
		if not is_finite(number):
			var items: Array = []
			for each: float in numbers:
				items.append(_serialize_float(each))
			return items
	return value


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
	var spare: Array = GdhShapes.spare(fields, tag)
	if builder.is_empty() or not spare.any(func(left: Array) -> bool: return left.is_empty()):
		return fields
	if tag == "float" and str(fields["value"]) not in ["inf", "-inf", "nan"]:
		return fields
	if tag == "Dictionary" and not pairs(fields["entries"]):
		return fields
	# Digits only: the tag is there to carry what a number cannot, and {"value": 5} meant for some
	# other shape is not to be read as 5.
	if tag == "int" and not (fields["value"] is String and _exact_int(fields["value"]) != null):
		return fields
	if tag == "RID" and _exact_int(fields["id"]) == null:
		return fields
	return call(builder, fields)


## [param held] as the whole number it spells exactly, or null: an int, a JSON number that is whole
## and no larger than a double holds exactly, the digits of one, or the int tag carrying them. A
## fraction, or a number past 2^53 that arrived as a number and so may already be a neighbour of the
## one meant, is no id.
func _exact_int(held: Variant) -> Variant:
	if held is int:
		return held
	if held is float:
		var number: float = held
		if is_finite(number) and number == floorf(number) and absf(number) < EXACT:
			return int(number)
		return null
	if held is String:
		var digits: String = held
		var parsed: int = digits.to_int()
		if digits.is_valid_int() and str(parsed) == digits:
			return parsed
		return null
	if held is Dictionary:
		var tagged: Dictionary = held
		if str(tagged.get("_type", "")) == "int" and tagged.has("value"):
			return _exact_int(tagged["value"])
	return null


## The components a path reads off [param value], by the names GDScript gives them, or none for a
## value that has none: a vector's axes, a colour's channels, a rectangle's corners and size, a
## transform's basis and origin. A value of one of these is a copy wherever it is read, so a write
## into a component is a write into the copy until it is put back where it was read from.
static func components_of(value: Variant) -> PackedStringArray:
	match typeof(value):
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return PackedStringArray(["x", "y"])
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return PackedStringArray(["x", "y", "z"])
		TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_QUATERNION:
			return PackedStringArray(["x", "y", "z", "w"])
		TYPE_COLOR:
			return PackedStringArray(
				[
					"r",
					"g",
					"b",
					"a",
					"r8",
					"g8",
					"b8",
					"a8",
					"h",
					"s",
					"v",
					"ok_hsl_h",
					"ok_hsl_s",
					"ok_hsl_l"
				]
			)
		TYPE_RECT2, TYPE_RECT2I, TYPE_AABB:
			return PackedStringArray(["position", "size", "end"])
		TYPE_PLANE:
			return PackedStringArray(["normal", "x", "y", "z", "d"])
		TYPE_BASIS:
			return PackedStringArray(["x", "y", "z"])
		TYPE_TRANSFORM2D:
			return PackedStringArray(["x", "y", "origin"])
		TYPE_TRANSFORM3D:
			return PackedStringArray(["basis", "origin"])
		TYPE_PROJECTION:
			return PackedStringArray(["x", "y", "z", "w"])
	return PackedStringArray()


## Whether [param entries] is a list of [key, value] pairs, as a Dictionary tag carries them.
static func pairs(entries: Variant) -> bool:
	if not entries is Array:
		return false
	var listed: Array = entries
	for entry: Variant in listed:
		if not entry is Array:
			return false
		var pair: Array = entry
		if pair.size() != 2:
			return false
	return true


## Whether two values can be compared without the comparison itself failing.
##
## GDScript's `==` is not total. An Object against a String is a hard error rather than false, and
## an error raised inside a game is not a wrong answer: it stops the game. A caller who asked
## `runtime_wait until` for the wrong kind of value got their game held at a debugger break, every
## later call answering "did not respond within 10000ms, it may be stuck in a long frame", and
## nothing anywhere naming the argument that did it. A wrong argument costs a refusal, never the
## session's game.
##
## Measured on 4.7.2 over every pair of built-in types: two values of different types compare only
## as an int against a float, a String against a StringName, or anything against null. Every other
## pair is that error, a word against a number as much as an object against a word, and so is a bool
## against an int and a NodePath against a String. An int against a float is kept because it is the
## same number to a caller waiting for 1 on a property holding 1.0.
static func comparable(one: Variant, other: Variant) -> bool:
	var left: int = typeof(one)
	var right: int = typeof(other)
	if left == right or left == TYPE_NIL or right == TYPE_NIL:
		return true
	var numbers: Array[int] = [TYPE_INT, TYPE_FLOAT]
	var texts: Array[int] = [TYPE_STRING, TYPE_STRING_NAME]
	return (left in numbers and right in numbers) or (left in texts and right in texts)


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
##
## A dictionary with no tag is read as the type wanted when it carries that type's fields, as
## scene_node and resource_edit read one: runtime_invoke refused {"x": 140, "y": 300} for a Vector2
## argument the editor tools took, so one value was right for one tool and wrong for the next. The
## value as sent is what is tagged, since the builders read a nested vector from its own fields.
func fitted(value: Variant, type: int) -> Variant:
	var rebuilt: Variant = deserialize_value(value)
	if type == TYPE_NIL or typeof(rebuilt) == type:
		return rebuilt

	if value is Dictionary and type != TYPE_DICTIONARY:
		var fields: Dictionary = value
		if not fields.has("_type"):
			var tagged: Dictionary = fields.duplicate()
			tagged["_type"] = type_string(type)
			var built: Variant = deserialize_value(tagged)
			if typeof(built) == type:
				return built

	if rebuilt is Array and LIST_TYPES.has(type):
		return type_convert(rebuilt, type)

	# The inspector and every colour picker give a colour as its html code. Anything else stays the
	# text it is, for the refusal to name.
	if type == TYPE_COLOR and rebuilt is String and Color.html_is_valid(str(rebuilt)):
		return Color.html(str(rebuilt))

	var simple: Array[int] = [TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING]
	if not simple.has(type) or not simple.has(typeof(rebuilt)):
		return rebuilt

	# Digits are read as digits, since read as JSON they become a double and one past 2^53 a
	# neighbour of the number written.
	if rebuilt is String and type == TYPE_INT and _exact_int(rebuilt) != null:
		return _exact_int(rebuilt)

	if rebuilt is String and type != TYPE_STRING:
		var text: String = rebuilt
		var parsed: Variant = GdhRead.json_or_null(text)
		# A string that does not read as the type wanted is handed back as the string it is, so
		# whoever asked can refuse it. type_convert answers 0 for "not an index" and true for any
		# text at all, and a caller who sent a word got back a number they never sent: get_child
		# answered about child 0 with no refusal and no note, which is a halt traded for a plausible
		# wrong answer, and the wrong answer is the worse of the two.
		if typeof(parsed) == TYPE_NIL or typeof(parsed) == TYPE_STRING:
			return rebuilt
		rebuilt = parsed

	return type_convert(rebuilt, type)


## Why [param given], meant for an int, may not be the number that was sent, or "" when it is. A
## JSON number is a double wherever it is read, so a whole number from 2^53 on arrives as the nearest
## double to the one written: 9007199254740993 sent as a number arrives as 9007199254740992, and a
## seed written that way would be stored as its neighbour with the answer saying it was written.
static func inexact(given: Variant, type: int) -> String:
	if type != TYPE_INT or (typeof(given) != TYPE_FLOAT and typeof(given) != TYPE_INT):
		return ""
	var number: float = GdhRead.as_float(given)
	if not is_finite(number) or absf(number) < EXACT:
		return ""
	return (
		(
			"%s is 2^53 or more, where a JSON number holds a whole number only to the nearest double,"
			+ ' so it may not be the number sent: send the digits as {"_type": "int", "value": "..."}'
			+ ", the form a read answers with"
		)
		% String.num(number, 0)
	)


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


# By its id, which is all an RID is from outside the server holding it, and which builds it back:
# a viewport's RID read off one call is what RenderingServer's render timing takes in the next.
func _serialize_rid(value: RID) -> Dictionary:
	return {"id": _serialize_int(value.get_id()), "_type": "RID"}


# A whole number from 2^53 on as its digits, because JSON numbers are doubles on the server's side
# and on the engine's, and from there on neighbouring whole numbers share a double. A RefCounted's
# instance id is one, with its top bit set, and a resource uid another; read as numbers they came
# back as a neighbouring id, which named nothing or something else.
func _serialize_int(value: int) -> Variant:
	if value > -EXACT and value < EXACT:
		return value
	return {"_type": "int", "value": str(value)}


# A packed list of 64-bit numbers stays the JSON list it is unless something in it is too large for
# a double to hold.
func _serialize_ints(value: PackedInt64Array) -> Variant:
	for number: int in value:
		if number <= -EXACT or number >= EXACT:
			var items: Array = []
			for each: int in value:
				items.append(_serialize_int(each))
			return items
	return value


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


## A dictionary keyed by text as itself, and any other as its entries. JSON keys are text, so an
## int or Vector2 key was answered as its text, and a dictionary read and written back had its keys
## replaced by words: `{1: "a"}` came back as `{"1": "a"}`.
func _serialize_dictionary(value: Dictionary) -> Dictionary:
	var texts: bool = value.keys().all(func(key: Variant) -> bool: return key is String or key is StringName)
	if not texts:
		var entries: Array = []
		for key: Variant in value:
			entries.append([serialize_value(key), serialize_value(value[key])])
		return {"_type": "Dictionary", "entries": entries}
	var serialised: Dictionary = {}
	for key: Variant in value:
		serialised[str(key)] = serialize_value(value[key])
	return serialised


func _serialize_array(value: Array) -> Array:
	return value.map(serialize_value)


# Base64 rather than a list of numbers. A byte array is a texture, a sound or a save file often
# enough that the list would be the whole answer, megabytes of it, and unreadable either way.
#
# The engine's encoder raises an error on an empty array, and an empty tile_map_data is every
# TileMapLayer with nothing painted yet, so a read of one carried an engine error in its answer.
func _serialize_bytes(value: PackedByteArray) -> Dictionary:
	var text: String = "" if value.is_empty() else Marshalls.raw_to_base64(value)
	return {"base64": text, "size": value.size(), "_type": "PackedByteArray"}


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
	if value is InputEvent:
		var event: InputEvent = value
		return _describe_input_event(event)
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


## An input event, by what it is bound to: the engine's own words for it and every field it stores
## away from its default. As a bare resource it was its class and nothing else, so an input action
## read back from project.godot could not say whether it was bound to Space or to a joypad button.
func _describe_input_event(event: InputEvent) -> Dictionary:
	var described: Dictionary = {"class": event.get_class(), "_type": "Resource", "text": event.as_text()}
	for property: Dictionary in event.get_property_list():
		var usage: int = property.get("usage", 0)
		var name: String = str(property.get("name", ""))
		if not (usage & PROPERTY_USAGE_STORAGE) or name.begins_with("resource_") or name == "script":
			continue
		var held: Variant = event.get(name)
		if held == ClassDB.class_get_property_default_value(event.get_class(), name):
			continue
		described[name] = serialize_value(held)
	return described


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
	described["id"] = _serialize_int(value.get_instance_id())
	return described


func _build_vector2(fields: Dictionary) -> Vector2:
	return Vector2(GdhRead.as_float(fields.get("x", 0)), GdhRead.as_float(fields.get("y", 0)))


func _build_vector2i(fields: Dictionary) -> Vector2i:
	return Vector2i(GdhRead.as_int(fields.get("x", 0)), GdhRead.as_int(fields.get("y", 0)))


func _build_vector3(fields: Dictionary) -> Vector3:
	return Vector3(
		GdhRead.as_float(fields.get("x", 0)),
		GdhRead.as_float(fields.get("y", 0)),
		GdhRead.as_float(fields.get("z", 0))
	)


func _build_vector3i(fields: Dictionary) -> Vector3i:
	return Vector3i(
		GdhRead.as_int(fields.get("x", 0)),
		GdhRead.as_int(fields.get("y", 0)),
		GdhRead.as_int(fields.get("z", 0))
	)


func _build_vector4(fields: Dictionary) -> Vector4:
	return Vector4(
		GdhRead.as_float(fields.get("x", 0)),
		GdhRead.as_float(fields.get("y", 0)),
		GdhRead.as_float(fields.get("z", 0)),
		GdhRead.as_float(fields.get("w", 0))
	)


func _build_vector4i(fields: Dictionary) -> Vector4i:
	return Vector4i(
		GdhRead.as_int(fields.get("x", 0)),
		GdhRead.as_int(fields.get("y", 0)),
		GdhRead.as_int(fields.get("z", 0)),
		GdhRead.as_int(fields.get("w", 0))
	)


## A rectangle from its two corners, or from the four numbers this tool answered with before the
## serialisers were made one, so an answer somebody kept can still be written back.
func _build_rect2(fields: Dictionary) -> Rect2:
	if not fields.has("position"):
		return Rect2(
			GdhRead.as_float(fields.get("x", 0)),
			GdhRead.as_float(fields.get("y", 0)),
			GdhRead.as_float(fields.get("width", 0)),
			GdhRead.as_float(fields.get("height", 0))
		)
	return Rect2(_vector2_at(fields, "position"), _vector2_at(fields, "size"))


func _build_rect2i(fields: Dictionary) -> Rect2i:
	if not fields.has("position"):
		return Rect2i(
			GdhRead.as_int(fields.get("x", 0)),
			GdhRead.as_int(fields.get("y", 0)),
			GdhRead.as_int(fields.get("width", 0)),
			GdhRead.as_int(fields.get("height", 0))
		)
	return Rect2i(_vector2i_at(fields, "position"), _vector2i_at(fields, "size"))


func _build_plane(fields: Dictionary) -> Plane:
	return Plane(_vector3_at(fields, "normal"), GdhRead.as_float(fields.get("d", 0)))


func _build_quaternion(fields: Dictionary) -> Quaternion:
	return Quaternion(
		GdhRead.as_float(fields.get("x", 0)),
		GdhRead.as_float(fields.get("y", 0)),
		GdhRead.as_float(fields.get("z", 0)),
		GdhRead.as_float(fields.get("w", 0))
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
		GdhRead.as_float(fields.get("r", 0)),
		GdhRead.as_float(fields.get("g", 0)),
		GdhRead.as_float(fields.get("b", 0)),
		GdhRead.as_float(fields.get("a", 1), 1.0)
	)


func _build_node_path(fields: Dictionary) -> NodePath:
	return NodePath(str(fields.get("path", "")))


func _build_bytes(fields: Dictionary) -> PackedByteArray:
	return Marshalls.base64_to_raw(str(fields.get("base64", "")))


func _build_float(fields: Dictionary) -> float:
	return GdhRead.as_float(fields)


func _build_int(fields: Dictionary) -> int:
	var exact: int = _exact_int(fields["value"])
	return exact


func _build_rid(fields: Dictionary) -> RID:
	var id: int = _exact_int(fields["id"])
	return rid_from_int64(id)


## The entries of a dictionary whose keys are not all text. JSON carries every number as a float,
## and a dictionary keys 1.0 apart from 1, so a whole-number key is built as an int: the key a
## game uses far more often, and one JSON cannot tell from the float.
func _build_dictionary(fields: Dictionary) -> Dictionary:
	var built: Dictionary = {}
	var entries: Array = fields["entries"]
	for entry: Variant in entries:
		var pair: Array = entry
		var key: Variant = deserialize_value(pair[0])
		if key is float:
			var number: float = key
			if is_finite(number) and number == floorf(number):
				key = int(number)
		built[key] = deserialize_value(pair[1])
	return built


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
