@tool
extends RefCounted

## What a caller writes for a property, read against the type that property declares, and the
## question of whether it can be written at all.
##
## One parser for the three tools that write properties into files. There were three, each with its
## own short list of tags it knew: scenes handled eighteen types, resources seven, animation tracks
## three. A Quaternion keyframe was stored as the dictionary it arrived as, a Rect2 written to a
## resource likewise, and both were saved that way, so the same value written through two tools
## came out as two different things and only one of them was the value.
##
## The tags themselves are the shared serialiser's, so every shape a read answers with is a shape a
## write accepts. What is here on top of it is the part only a property knows: the type wanted, so a
## dictionary shaped like a vector or a bare pair of numbers can be read as one.

const Read = preload("reading.gd")
const Serialisation = preload("serialisation.gd")

# What each packed array holds, for the four whose elements are not types JSON has. A polygon is
# written as a list of pairs, and only the property knows that each pair is a Vector2 rather than a
# list of two numbers: without being told, every element was read as itself and the engine turned
# the lot into zeroes on the way into the property.
const PACKED_ELEMENTS: Dictionary = {
	TYPE_PACKED_VECTOR2_ARRAY: TYPE_VECTOR2,
	TYPE_PACKED_VECTOR3_ARRAY: TYPE_VECTOR3,
	TYPE_PACKED_VECTOR4_ARRAY: TYPE_VECTOR4,
	TYPE_PACKED_COLOR_ARRAY: TYPE_COLOR,
}

var _values: Serialisation = Serialisation.new()

# Why the value being parsed cannot be written, when the parse is what found out. A resource is
# built inside the parse and there is nowhere in a parsed value to put the reason it is wrong.
var _refused: String = ""


## Turns what arrived over the wire into the Godot value a property wants.
##
## Three separate questions, asked in order, because a caller may say what it means in three
## ways: a dictionary that names its own type, a dictionary shaped like the type the property
## declares, or a bare array positional for a vector. Each is its own function; asking all three
## in one was twenty-four exits deep and impossible to follow.
func parse(value: Variant, expected_type: int = TYPE_NIL) -> Variant:
	if value is Dictionary:
		var fields: Dictionary = value
		var tagged: Array = _parse_tagged_dictionary(fields)
		if tagged[0]:
			return tagged[1]
		return _parse_shaped_dictionary(fields, expected_type)
	if value is Array:
		var items: Array = value
		return _parse_array(items, expected_type)
	# The same fitting the running game does, so "2.5" written to a float property here and there
	# mean the same thing. It leaves a value it cannot fit alone rather than casting it, which is
	# what lets the write be refused instead of landing as whatever the cast produced.
	return _values.fitted(value, expected_type)


## Why [param property] on [param holder] cannot be given [param value], or "" when it can.
##
## Object.set converts rather than refuses, and the conversion is silent and lossy: a word written
## to an int property is stored as 0, to a bool as true, to a Vector2 as (0, 0). The file is then
## saved holding a value nobody asked for and the tool reports the change as made, which is worse
## than refusing and worse than failing, because there is nothing anywhere to read afterwards that
## says the value is not the one that was sent.
func cannot_hold(holder: String, property: String, value: Variant, expected_type: int) -> String:
	var held: String = type_string(expected_type)
	var cost: String = " Setting it would save a different value than the one asked for."
	if not Serialisation.acceptable(value, expected_type):
		var shape: String = "%s.%s is %s and the value given is %s, which cannot become one."
		return shape % [holder, property, held, type_string(typeof(value))] + cost

	# And the same question of each element, because a list is accepted for a packed array whatever
	# is in it: a polygon written as [{"x": 1}] passes the check above and lands as one zero vector.
	var element: int = Read.as_int(PACKED_ELEMENTS.get(expected_type, TYPE_NIL), TYPE_NIL)
	if element == TYPE_NIL or not value is Array:
		return ""
	var items: Array = value
	for index: int in items.size():
		if not Serialisation.acceptable(items[index], element):
			var shape: String = "%s.%s is %s and item %d of the list given is %s, not %s."
			var named: Array = [
				holder, property, held, index, type_string(typeof(items[index])), type_string(element)
			]
			return shape % named + cost
	return ""


## Writes each of [param properties] onto [param target], stopping at the first it cannot write and
## answering with why, or "" when every one of them went on.
##
## In the order they were given, because a property list is not fixed: a ShaderMaterial has no
## `shader_parameter/tint` until its `shader` is set, so a pass that checked them all before writing
## any would refuse the pair that works.
##
## Nothing here saves, so a refusal partway leaves the change in memory and the file as it was. The
## caller returns the refusal instead of saving.
func write_all(target: Object, properties: Dictionary) -> String:
	for key: Variant in properties:
		var property: String = str(key)
		if not has_property(target, property):
			return "%s has no property %s" % [target.get_class(), property]
		var expected_type: int = property_type(target, property)
		var raw: Variant = properties[key]

		# A resource-valued property takes the path of one, which is how a caller names a TileSet,
		# a material or a theme: there is no other way to hand a tool a Resource.
		if expected_type == TYPE_OBJECT and typeof(raw) == TYPE_STRING:
			var found: Array = _resource_at(str(raw), property)
			if not found[0]:
				return str(found[1])
			target.set(property, found[1])
			continue

		_refused = ""
		var value: Variant = parse(raw, expected_type)
		if not _refused.is_empty():
			return _refused
		var refusal: String = cannot_hold(target.get_class(), property, value, expected_type)
		if not refusal.is_empty():
			return refusal
		target.set(property, value)
	return ""


## The resource [param path] names, as [found, resource or why not].
##
## The project boundary is enforced here as well as on the server, because only the engine knows
## that this property is one holding a path: an absolute path and a user:// one both load, and
## neither names a file this project owns. A path nothing is at is refused too, since Object.set
## stores the null that load answers with and the file is saved having quietly lost the reference.
func _resource_at(path: String, property: String) -> Array:
	if not (path.begins_with("res://") or path.begins_with("uid://")):
		return [false, "%s takes a res:// or uid:// path, not %s" % [property, path]]
	if path.split("/").has(".."):
		return [false, "%s leaves the project: %s" % [property, path]]
	if not ResourceLoader.exists(path):
		return [false, "No resource at %s for %s" % [path, property]]
	return [true, load(path)]


## Whether [param target] declares [param property] at all. Object.set ignores a name it does not
## know, so without this a typo saved a file that had not changed and reported it as one that had.
func has_property(target: Object, property: String) -> bool:
	for declared: Dictionary in target.get_property_list():
		if str(declared.get("name", "")) == property:
			return true
	return false


## The type [param property] is declared as, or TYPE_NIL where nothing declares one.
func property_type(target: Object, property: String) -> int:
	for declared: Dictionary in target.get_property_list():
		if str(declared.get("name", "")) == property:
			return Read.as_int(declared.get("type", TYPE_NIL), TYPE_NIL)
	return TYPE_NIL


## Why the last [method parse] cannot be written, when the parse itself found out.
func refusal() -> String:
	return _refused


## A dictionary carrying its own type name, as the serialiser writes it.
##
## Answers [handled, value] rather than just the value, because a handled tag may legitimately
## produce null: a Resource with no path is "this is nothing", not "this is not mine". A tag
## that names a type but lacks the keys to build it is left unhandled on purpose, so the caller
## can still read it against the type the property declares.
func _parse_tagged_dictionary(value: Dictionary) -> Array:
	var type_tag: String = str(value.get("_type", value.get("type", "")))
	if type_tag == "Resource":
		var resource_path: String = str(value.get("path", ""))
		return [true, null if resource_path.is_empty() else load(resource_path)]

	# The shared builder is the same one the answer was written by, so every shape it writes comes
	# back as itself. `type` as the tag is read as `_type`: it is what these tools answered with
	# before the serialisers were made one, and a caller who kept an answer can still send it.
	var tagged: Dictionary = value
	if not value.has("_type") and not type_tag.is_empty():
		tagged = value.duplicate()
		tagged["_type"] = type_tag
	var rebuilt: Variant = _values.deserialize_value(tagged)
	if not rebuilt is Dictionary:
		return [true, rebuilt]

	return _parse_new_resource(type_tag, value)


## A tag naming a Resource class builds a fresh one, its other keys set as properties, so a
## NavigationRegion2D can arrive with its NavigationPolygon and an AnimationTree with its root
## state machine in the same add as any other property.
func _parse_new_resource(type_tag: String, value: Dictionary) -> Array:
	if (
		type_tag.is_empty()
		or not ClassDB.class_exists(type_tag)
		or not ClassDB.is_parent_class(type_tag, "Resource")
		or not ClassDB.can_instantiate(type_tag)
	):
		return [false, null]

	var built: Resource = ClassDB.instantiate(type_tag)
	var wanted: Dictionary = value.duplicate()
	wanted.erase("_type")
	wanted.erase("type")
	var refusal: String = write_all(built, wanted)
	if not refusal.is_empty():
		_refused = refusal
		return [true, null]
	return [true, built]


## A dictionary with no tag, read against the type the property declares. Falls back to the
## dictionary itself, since a property may genuinely want one.
func _parse_shaped_dictionary(value: Dictionary, expected_type: int) -> Variant:
	match expected_type:
		TYPE_VECTOR2:
			if value.has("x") and value.has("y"):
				return Vector2(Read.as_float(value["x"]), Read.as_float(value["y"]))
		TYPE_VECTOR2I:
			if value.has("x") and value.has("y"):
				return Vector2i(Read.as_int(value["x"]), Read.as_int(value["y"]))
		TYPE_VECTOR3:
			if value.has("x") and value.has("y") and value.has("z"):
				return Vector3(
					Read.as_float(value["x"]), Read.as_float(value["y"]), Read.as_float(value["z"])
				)
		TYPE_VECTOR3I:
			if value.has("x") and value.has("y") and value.has("z"):
				return Vector3i(Read.as_int(value["x"]), Read.as_int(value["y"]), Read.as_int(value["z"]))
		TYPE_VECTOR4:
			if value.has("x") and value.has("y") and value.has("z") and value.has("w"):
				return Vector4(
					Read.as_float(value["x"]),
					Read.as_float(value["y"]),
					Read.as_float(value["z"]),
					Read.as_float(value["w"])
				)
		TYPE_COLOR:
			if value.has("r") and value.has("g") and value.has("b"):
				return Color(
					Read.as_float(value["r"]),
					Read.as_float(value["g"]),
					Read.as_float(value["b"]),
					Read.as_float(value.get("a", 1), 1.0)
				)
		TYPE_RECT2:
			if value.has("x") and value.has("y") and value.has("width") and value.has("height"):
				return Rect2(
					Read.as_float(value["x"]),
					Read.as_float(value["y"]),
					Read.as_float(value["width"]),
					Read.as_float(value["height"])
				)
		TYPE_NODE_PATH:
			if value.has("path"):
				return NodePath(str(value["path"]))
	return value


## An array, either positional for a vector the property declares, or a list to parse per item.
func _parse_array(value: Array, expected_type: int) -> Variant:
	if PACKED_ELEMENTS.has(expected_type):
		var element: int = Read.as_int(PACKED_ELEMENTS[expected_type], TYPE_NIL)
		return value.map(func(item: Variant) -> Variant: return parse(item, element))

	match expected_type:
		TYPE_VECTOR2:
			if value.size() >= 2:
				return Vector2(Read.as_float(value[0]), Read.as_float(value[1]))
		TYPE_VECTOR2I:
			if value.size() >= 2:
				return Vector2i(Read.as_int(value[0]), Read.as_int(value[1]))
		TYPE_VECTOR3:
			if value.size() >= 3:
				return Vector3(Read.as_float(value[0]), Read.as_float(value[1]), Read.as_float(value[2]))
		TYPE_VECTOR3I:
			if value.size() >= 3:
				return Vector3i(Read.as_int(value[0]), Read.as_int(value[1]), Read.as_int(value[2]))
		TYPE_VECTOR4:
			if value.size() >= 4:
				return Vector4(
					Read.as_float(value[0]),
					Read.as_float(value[1]),
					Read.as_float(value[2]),
					Read.as_float(value[3])
				)
		TYPE_COLOR:
			if value.size() >= 3:
				return Color(
					Read.as_float(value[0]),
					Read.as_float(value[1]),
					Read.as_float(value[2]),
					Read.as_float(value[3]) if value.size() >= 4 else 1.0
				)
	return value.map(func(item: Variant) -> Variant: return parse(item))
