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


## The sentences a refusal of [param value] where a [param type] goes ends with: which of its keys
## kept it from being read as one, and how one is written. Empty for a type not built from fields.
##
## The refusal names only the two types, and the key is what the caller has to take out.
static func remedy(value: Variant, type: int) -> String:
	var shape: String = written_as(type)
	if shape.is_empty():
		return ""
	return _unread(value, type) + " A %s is sent as %s." % [type_string(type), shape]


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
