extends RefCounted

## How each engine type built from fields is written: the fields it needs, the ones it reads when
## they are there, and what a refusal says about a value that is not one.
##
## This file is the one beside the operations, and `bun run sync:gd` copies it into each addon.

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
	"float": [["value"]],
	"int": [["value"]],
	"RID": [["id"]],
	"Dictionary": [["entries"]],
}
## The fields each type reads as numbers. A builder reads a word there as 0, so {"x": 0, "y": "far"}
## was written as (0, 0) and answered as written.
const NUMBER_FIELDS: Dictionary = {
	"Vector2": ["x", "y"],
	"Vector2i": ["x", "y"],
	"Vector3": ["x", "y", "z"],
	"Vector3i": ["x", "y", "z"],
	"Vector4": ["x", "y", "z", "w"],
	"Vector4i": ["x", "y", "z", "w"],
	"Rect2": ["x", "y", "width", "height"],
	"Rect2i": ["x", "y", "width", "height"],
	"Plane": ["d"],
	"Quaternion": ["x", "y", "z", "w"],
	"Color": ["r", "g", "b", "a"],
}
## The fields a builder reads when they are there and does without when not.
const OPTIONAL: Dictionary = {
	"Color": ["a"],
	"PackedByteArray": ["size"],
}


## How a value of [param type] is written to be read as one, for a refusal to name, or empty for a
## type that is not built from fields. A refusal naming only the two types leaves a caller to find
## the shape in the description of another op.
static func written_as(type: int) -> String:
	var tag: String = type_string(type)
	var alternatives: Array = REQUIRED.get(tag, [])
	if alternatives.is_empty() or tag in ["float", "int", "Dictionary"]:
		return ""
	var keys: Array = alternatives[0]
	var optional: Array = OPTIONAL.get(tag, [])
	var parts: Array[String] = []
	for key: Variant in keys + optional:
		parts.append('"%s": ...' % key)
	var shape: String = "{%s}" % ", ".join(parts)
	if type == TYPE_COLOR:
		return shape + ' or as its html code, "#ff8000"'
	return shape


## The keys of [param fields] that a [param tag] built from them would not read, one list for each
## spelling of its fields carried whole. A rectangle has two: its corners, and four numbers.
##
## A builder drops a key it does not know without a word, so {"x": 1, "y": 2, "z": 3} for a Vector2
## would be written as (1, 2) and answered as written: a value is built only when a list is empty.
static func spare(fields: Dictionary, tag: String) -> Array:
	var optional: Array = OPTIONAL.get(tag, [])
	var lists: Array = []
	var alternatives: Array = REQUIRED.get(tag, [])
	for alternative: Variant in alternatives:
		var keys: Array = alternative
		if keys.all(func(key: Variant) -> bool: return fields.has(key)):
			var over: Callable = func(key: Variant) -> bool:
				return str(key) != "_type" and not keys.has(key) and not optional.has(key)
			lists.append(fields.keys().filter(over))
	return lists


## Whether a [param tag] built from [param fields] reads every one of them, and each it reads as a
## number holds one.
static func buildable(fields: Dictionary, tag: String) -> bool:
	return (
		spare(fields, tag).any(func(left: Array) -> bool: return left.is_empty())
		and not_a_number(fields, tag).is_empty()
	)


## The first field of [param fields] that a [param tag] reads as a number and that holds no number,
## or "" when there is none. Digits in quotes are a number, as a write takes them for a float.
static func not_a_number(fields: Dictionary, tag: String) -> String:
	for key: String in NUMBER_FIELDS.get(tag, []):
		if not fields.has(key):
			continue
		var held: Variant = fields[key]
		if held is int or held is float:
			continue
		if held is String and str(held).is_valid_float():
			continue
		return key
	return ""


## Whether every item of [param items] is a number, for a list read by its places as a vector.
static func all_numbers(items: Array) -> bool:
	return items.all(
		func(item: Variant) -> bool:
			return item is int or item is float or (item is String and str(item).is_valid_float())
	)


## The sentences a refusal of [param value] where a [param type] goes ends with: which of its keys
## kept it from being read as one, and how one is written. Empty for a type not built from fields.
##
## The refusal names only the two types, and the key is what the caller has to take out.
static func remedy(value: Variant, type: int) -> String:
	if type == TYPE_STRING and typeof(value) in [TYPE_BOOL, TYPE_INT, TYPE_FLOAT]:
		var number: Variant = value
		if value is float:
			var whole: float = value
			if is_finite(whole) and whole == floorf(whole):
				number = int(whole)
		return ' Text is sent in quotes, as "%s".' % str(number)
	var shape: String = written_as(type)
	if shape.is_empty():
		return ""
	return (
		_unread(value, type) + _no_number(value, type) + " A %s is sent as %s." % [type_string(type), shape]
	)


static func _no_number(value: Variant, type: int) -> String:
	var tag: String = type_string(type)
	if value is Dictionary:
		var fields: Dictionary = value
		var key: String = not_a_number(fields, tag)
		if not key.is_empty():
			return " Its %s is %s, which is no number." % [key, JSON.stringify(fields[key])]
	if value is Array and NUMBER_FIELDS.has(tag):
		var items: Array = value
		if not all_numbers(items):
			return " Read by its places, each item is a number."
	return ""


static func _unread(value: Variant, type: int) -> String:
	if not value is Dictionary:
		return ""
	var fields: Dictionary = value
	var tag: String = type_string(type)
	var lists: Array = spare(fields, tag)
	var built: bool = lists.any(func(over: Array) -> bool: return over.is_empty())
	if lists.is_empty() or built or str(fields.get("_type", tag)) != tag:
		return ""
	lists.sort_custom(func(a: Array, b: Array) -> bool: return a.size() < b.size())
	var left: Array = lists[0]
	var named: PackedStringArray = []
	for key: Variant in left:
		var _named: bool = named.append('"%s"' % key)
	var fields_called: String = "field called" if named.size() == 1 else "fields called"
	var note: String = (
		" A %s has no %s %s, so the value is not read as one" % [tag, fields_called, " or ".join(named)]
	)
	if left.has("type") and not fields.has("_type"):
		return note + ': a value names its type under "_type".'
	return note + "."
