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
	TYPE_PACKED_BYTE_ARRAY: TYPE_INT,
	TYPE_PACKED_INT32_ARRAY: TYPE_INT,
	TYPE_PACKED_INT64_ARRAY: TYPE_INT,
	TYPE_PACKED_FLOAT32_ARRAY: TYPE_FLOAT,
	TYPE_PACKED_FLOAT64_ARRAY: TYPE_FLOAT,
	TYPE_PACKED_STRING_ARRAY: TYPE_STRING,
	TYPE_PACKED_VECTOR2_ARRAY: TYPE_VECTOR2,
	TYPE_PACKED_VECTOR3_ARRAY: TYPE_VECTOR3,
	TYPE_PACKED_VECTOR4_ARRAY: TYPE_VECTOR4,
	TYPE_PACKED_COLOR_ARRAY: TYPE_COLOR,
}

# The types made of floats, which a read back compares within float precision: a Vector2 property
# stores 32-bit components, so 0.1 comes back as 0.100000001.
const FLOAT_SHAPES: Array[int] = [
	TYPE_VECTOR2,
	TYPE_VECTOR3,
	TYPE_VECTOR4,
	TYPE_QUATERNION,
	TYPE_COLOR,
	TYPE_RECT2,
	TYPE_TRANSFORM2D,
	TYPE_BASIS,
	TYPE_TRANSFORM3D,
	TYPE_PLANE,
	TYPE_AABB,
	TYPE_PROJECTION,
]

# Entries in a property list that only head a section of the inspector. Object.set ignores their
# names, so a write to "Visibility" or "Transform" changed nothing and was answered as made.
const HEADINGS: int = PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP

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
##
## [param elements] is what a typed Array or Dictionary holds, as [method elements_of] reads it.
func parse(value: Variant, expected_type: int = TYPE_NIL, elements: Array = []) -> Variant:
	if value is Dictionary:
		var fields: Dictionary = value
		# A dictionary with keys that are not text arrives as its entries, and is read against the
		# declared element types like any other.
		if str(fields.get("_type", "")) == "Dictionary" and Serialisation.pairs(fields.get("entries")):
			var built: Dictionary = _values.deserialize_value(fields)
			return _parse_entries(built, elements)
		var tagged: Array = _parse_tagged_dictionary(fields)
		if tagged[0]:
			return tagged[1]
		return _parse_shaped_dictionary(fields, expected_type, elements)
	if value is Array:
		var items: Array = value
		return _parse_array(items, expected_type, elements)
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
func cannot_hold(
	holder: String, property: String, value: Variant, expected_type: int, elements: Array = []
) -> String:
	var held: String = type_string(expected_type)
	var cost: String = " Setting it would save a different value than the one asked for."
	if not Serialisation.acceptable(value, expected_type):
		var shape: String = "%s.%s is %s and the value given is %s, which cannot become one."
		return shape % [holder, property, held, type_string(typeof(value))] + cost

	# And the same question of each element, because a list is accepted for a packed or typed array
	# whatever is in it: a polygon written as [{"x": 1}] passes the check above and lands as one zero
	# vector, and [1.5, "x"] for a PackedInt32Array as [1, 0].
	var element: int = Read.as_int(PACKED_ELEMENTS.get(expected_type, TYPE_NIL), TYPE_NIL)
	if expected_type == TYPE_ARRAY and not elements.is_empty():
		element = Read.as_int(elements[0], TYPE_NIL)
	if element != TYPE_NIL and value is Array:
		var items: Array = value
		for index: int in items.size():
			if not Serialisation.acceptable(items[index], element):
				var shape: String = "%s.%s is %s and item %d of the list given is %s, not %s."
				var named: Array = [
					holder, property, held, index, type_string(typeof(items[index])), type_string(element)
				]
				return shape % named + cost
	if expected_type == TYPE_DICTIONARY and elements.size() == 2 and value is Dictionary:
		var entries: Dictionary = value
		var key_type: int = Read.as_int(elements[0], TYPE_NIL)
		var value_type: int = Read.as_int(elements[1], TYPE_NIL)
		for key: Variant in entries:
			if not Serialisation.acceptable(key, key_type):
				var shape: String = "%s.%s has %s keys, and %s is not one."
				return shape % [holder, property, type_string(key_type), shown(key)] + cost
			var entry: Variant = entries[key]
			if not Serialisation.acceptable(entry, value_type):
				var shape: String = "%s.%s holds %s values, and the one given for %s is %s."
				var named: Array = [holder, property, type_string(value_type), shown(key), shown(entry)]
				return shape % named + cost
	return ""


## Writes each of [param properties] onto [param target], stopping at the first it cannot write and
## answering with why, or "" when every one of them went on and holds what was given.
##
## In the order they were given, because a property list is not fixed: a ShaderMaterial has no
## `shader_parameter/tint` until its `shader` is set, so a pass that checked them all before writing
## any would refuse the pair that works.
##
## Every value is read back, because a setter can refuse or change what it is given and say so only
## in the editor's log. Measured on 4.7.2: a Timer given a wait_time of 0 holds 1, a Sprite2D given
## 0 hframes holds 1, a Sprite2D given a Material for its texture holds nothing. A value a setter
## clamped against a property given later in the same call (a ProgressBar's value against its
## max_value) is set once more after the rest, so the order a caller wrote them in does not decide
## what is saved.
##
## Nothing here saves, so a refusal partway leaves the change in memory and the file as it was. The
## caller returns the refusal instead of saving.
func write_all(target: Object, properties: Dictionary) -> String:
	var given: Dictionary = {}
	for key: Variant in properties:
		var property: String = str(key)
		var declared: Dictionary = declaration(target, property)
		if declared.is_empty():
			return "%s has no property %s" % [target.get_class(), property]
		var value: Array = value_for(target, declared, properties[key])
		if not value[0]:
			return str(value[1])
		target.set(property, value[1])
		given[property] = value[1]

	for property: String in given:
		if not same(target.get(property), given[property]):
			target.set(property, given[property])
	for property: String in given:
		var held: Variant = target.get(property)
		if not same(held, given[property]):
			return (
				(
					"%s.%s was given %s and holds %s after it was set: the engine changed or refused the "
					+ "value, so nothing was written."
				)
				% [target.get_class(), property, shown(given[property]), shown(held)]
			)
	return ""


## [param raw] as the value [param declared] takes, as [ok, value] or [false, why not].
func value_for(target: Object, declared: Dictionary, raw: Variant) -> Array:
	var property: String = str(declared.get("name", ""))
	var expected_type: int = Read.as_int(declared.get("type", TYPE_NIL), TYPE_NIL)
	var hint: int = Read.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	if expected_type == TYPE_OBJECT and hint == PROPERTY_HINT_NODE_TYPE:
		return _node_reference(target, property, raw)

	# A resource-valued property takes the path of one, which is how a caller names a TileSet,
	# a material or a theme: there is no other way to hand a tool a Resource.
	var value: Variant = null
	if expected_type == TYPE_OBJECT and typeof(raw) == TYPE_STRING:
		var found: Array = _resource_at(str(raw), property)
		if not found[0]:
			return found
		value = found[1]
	else:
		var elements: Array = elements_of(declared)
		if _fraction(raw, expected_type, elements):
			return [false, _fraction_refusal(target, property, raw)]
		_refused = ""
		value = parse(raw, expected_type, elements)
		if not _refused.is_empty():
			return [false, _refused]
		var refusal: String = cannot_hold(target.get_class(), property, value, expected_type, elements)
		if not refusal.is_empty():
			return [false, refusal]
	if value is Object:
		var held: Object = value
		var wrong: String = _wrong_class(held, declared)
		if not wrong.is_empty():
			return [false, wrong]
	return [true, value]


## A property holding a Node is given the node the path leads to from [param target], as the
## editor's inspector gives it; the scene is saved with the path. A res:// path could never name a
## node, so the remedy a caller is given is a node path.
func _node_reference(target: Object, property: String, raw: Variant) -> Array:
	if raw == null:
		return [true, null]
	var node: Node = target as Node
	if node == null:
		return [false, "%s holds a node, and only a node can hold one." % property]
	var rebuilt: Variant = _values.deserialize_value(raw)
	var path: NodePath = NodePath()
	if rebuilt is NodePath:
		path = rebuilt
	elif typeof(raw) == TYPE_STRING and not str(raw).contains("://"):
		path = NodePath(str(raw))
	else:
		return [
			false,
			(
				(
					"%s holds a node, and takes the path to it from the node being set, such as "
					+ '"../Player", not %s.'
				)
				% [property, shown(raw)]
			)
		]
	var found: Node = node.get_node_or_null(path)
	if found == null:
		return [
			false, "%s names %s, and there is no node at that path from %s." % [property, path, node.name]
		]
	return [true, found]


## Why [param value] is not the class [param declared] holds, or "". Object.set does not refuse
## an object of the wrong class: measured on 4.7.2, a Sprite2D given a Material for its texture
## held nothing afterwards, and the scene was saved without the texture it had.
func _wrong_class(value: Object, declared: Dictionary) -> String:
	var hint: int = Read.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	var wanted: String = str(declared.get("hint_string", ""))
	if hint != PROPERTY_HINT_RESOURCE_TYPE or wanted.is_empty():
		return ""
	var names: PackedStringArray = wanted.split(",", false)
	for name: String in names:
		if value.is_class(name.strip_edges()):
			return ""
		var script: Script = value.get_script()
		while script != null:
			if str(script.get_global_name()) == name.strip_edges():
				return ""
			script = script.get_base_script()
	return (
		"%s holds %s, and the value given is a %s."
		% [str(declared.get("name", "")), " or ".join(names), value.get_class()]
	)


## The element types a typed Array or Dictionary property declares: [element] for an array,
## [key, value] for a dictionary, [] when nothing is declared.
##
## Read from the declaration because the value cannot say: a script's exported `Array[int]` sits
## behind a placeholder in the editor, and measured on 4.7.2 that placeholder stores [1.5, 2.0]
## as given, which the game then fails to load into the typed array.
static func elements_of(declared: Dictionary) -> Array:
	var type: int = Read.as_int(declared.get("type", TYPE_NIL), TYPE_NIL)
	var hint: int = Read.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	var wanted: String = str(declared.get("hint_string", ""))
	if wanted.is_empty():
		return []
	if hint == PROPERTY_HINT_TYPE_STRING:
		var parts: PackedStringArray = wanted.split(";")
		if type == TYPE_ARRAY and parts.size() == 1:
			return [_type_in_hint(parts[0])]
		if type == TYPE_DICTIONARY and parts.size() == 2:
			return [_type_in_hint(parts[0]), _type_in_hint(parts[1])]
		return []
	if hint == PROPERTY_HINT_ARRAY_TYPE and type == TYPE_ARRAY:
		return [_type_named(wanted)]
	if hint == PROPERTY_HINT_DICTIONARY_TYPE and type == TYPE_DICTIONARY:
		var parts: PackedStringArray = wanted.split(";")
		if parts.size() == 2:
			return [_type_named(parts[0]), _type_named(parts[1])]
	return []


## The type at the front of one entry of a type-string hint, "2:" or "24/17:Texture2D".
static func _type_in_hint(entry: String) -> int:
	var number: String = entry.get_slice(":", 0).get_slice("/", 0)
	return number.to_int() if number.is_valid_int() else TYPE_NIL


## The Variant type [param name] names, or TYPE_OBJECT for a class.
static func _type_named(name: String) -> int:
	var named: String = name.get_slice(":", 0).strip_edges()
	for type: int in TYPE_MAX:
		if type_string(type) == named:
			return type
	return TYPE_OBJECT if not named.is_empty() else TYPE_NIL


## Whether [param value] holds a number with a fractional part where an integer is wanted, in a
## list or a dictionary as much as bare. The conversion would cut 2.7 to 2 without a word, and a
## dictionary key arrives as the text "2.7", which reads as the same number.
func _fraction(value: Variant, type: int, elements: Array = []) -> bool:
	if type == TYPE_INT:
		var number: Variant = value
		if typeof(value) == TYPE_STRING:
			number = Read.json_or_null(str(value))
		if typeof(number) != TYPE_FLOAT:
			return false
		var whole: float = number
		return is_finite(whole) and whole != floorf(whole)
	var element: int = Read.as_int(PACKED_ELEMENTS.get(type, TYPE_NIL), TYPE_NIL)
	if type == TYPE_ARRAY and not elements.is_empty():
		element = Read.as_int(elements[0], TYPE_NIL)
	if value is Array and element != TYPE_NIL:
		var items: Array = value
		return items.any(func(item: Variant) -> bool: return _fraction(item, element))
	if type == TYPE_DICTIONARY and elements.size() == 2 and value is Dictionary:
		var entries: Dictionary = value
		var key_type: int = Read.as_int(elements[0], TYPE_NIL)
		var value_type: int = Read.as_int(elements[1], TYPE_NIL)
		for key: Variant in entries:
			if _fraction(key, key_type) or _fraction(entries[key], value_type):
				return true
	return false


func _fraction_refusal(target: Object, property: String, raw: Variant) -> String:
	return (
		(
			"%s.%s holds whole numbers, and %s would be cut to fit. Setting it would save a different "
			+ "value than the one asked for."
		)
		% [target.get_class(), property, shown(raw)]
	)


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
	if path.contains("::"):
		return [
			false,
			(
				(
					"%s is a resource built into %s, and only that file can refer to it. Build a new one "
					+ 'for %s with "_type" set to its class and its properties beside it.'
				)
				% [path, path.get_slice("::", 0), property]
			)
		]
	if not ResourceLoader.exists(path):
		return [false, "No resource at %s for %s" % [path, property]]
	return [true, load(path)]


## The entry [param target] declares for [param property], or {} when it declares none. Headings
## are left out: a category or group shares the list with the properties, and Object.set ignores
## its name, so without this a typo or a heading saved a file that had not changed and reported it
## as one that had.
func declaration(target: Object, property: String) -> Dictionary:
	for declared: Dictionary in target.get_property_list():
		if str(declared.get("name", "")) != property:
			continue
		if Read.as_int(declared.get("usage", 0)) & HEADINGS:
			continue
		return declared
	return {}


## Whether [param held] is [param given], as a property read back after a set answers it.
##
## Close enough rather than equal for anything made of floats: a Vector2 property stores 32-bit
## components, so 0.1 comes back as 0.100000001. A packed array read back against the list it was
## given compares element by element, since `==` between the two is an error rather than false.
static func same(held: Variant, given: Variant) -> bool:
	var held_type: int = typeof(held)
	var given_type: int = typeof(given)
	# An empty object property reads back as an Object that is null, not as nil, and the two are
	# the same nothing.
	var held_none: bool = held_type == TYPE_NIL or (held_type == TYPE_OBJECT and held == null)
	var given_none: bool = given_type == TYPE_NIL or (given_type == TYPE_OBJECT and given == null)
	if held_none or given_none:
		return held_none == given_none
	if held_type == TYPE_OBJECT or given_type == TYPE_OBJECT:
		return _same_object(held, given)
	if Serialisation.NUMBERS.has(held_type) and Serialisation.NUMBERS.has(given_type):
		if held_type == TYPE_BOOL or given_type == TYPE_BOOL:
			return held_type == given_type and held == given
		var held_number: float = Read.as_float(held)
		var given_number: float = Read.as_float(given)
		return (is_nan(held_number) and is_nan(given_number)) or is_equal_approx(held_number, given_number)
	if Serialisation.TEXTS.has(held_type) and Serialisation.TEXTS.has(given_type):
		return str(held) == str(given)
	if _listed(held_type) and _listed(given_type):
		var held_items: Array = type_convert(held, TYPE_ARRAY)
		var given_items: Array = type_convert(given, TYPE_ARRAY)
		if held_items.size() != given_items.size():
			return false
		for index: int in held_items.size():
			if not same(held_items[index], given_items[index]):
				return false
		return true
	if held_type == TYPE_DICTIONARY and given_type == TYPE_DICTIONARY:
		var held_entries: Dictionary = held
		var given_entries: Dictionary = given
		return _same_entries(held_entries, given_entries)
	if held_type != given_type:
		return false
	return _same_shape(held, given)


static func _same_object(held: Variant, given: Variant) -> bool:
	if typeof(held) != TYPE_OBJECT or typeof(given) != TYPE_OBJECT:
		return false
	if is_same(held, given):
		return true
	if not held is Resource or not given is Resource:
		return false
	var held_resource: Resource = held
	var given_resource: Resource = given
	if not held_resource.resource_path.is_empty():
		return held_resource.resource_path == given_resource.resource_path
	# A resource local to the scene is duplicated for every instance, so the copy read back is
	# another object of the same class.
	return held_resource.resource_local_to_scene and held_resource.get_class() == given_resource.get_class()


static func _same_entries(held: Dictionary, given: Dictionary) -> bool:
	if held.size() != given.size():
		return false
	for key: Variant in given:
		var found: bool = false
		for held_key: Variant in held:
			if same(held_key, key):
				found = same(held[held_key], given[key])
				break
		if not found:
			return false
	return true


## Two values of one type made of floats, compared component by component through the type's own
## text form, which lists every component: each type has its own is_equal_approx, and reaching it
## through a Variant is a call the typed gate refuses.
static func _same_shape(held: Variant, given: Variant) -> bool:
	if typeof(held) not in FLOAT_SHAPES:
		return held == given
	var held_parts: Array[float] = _components(held)
	var given_parts: Array[float] = _components(given)
	if held_parts.size() != given_parts.size():
		return false
	for index: int in held_parts.size():
		if not same(held_parts[index], given_parts[index]):
			return false
	return true


static func _components(value: Variant) -> Array[float]:
	var parts: Array[float] = []
	var text: String = var_to_str(value)
	var inner: String = text.substr(text.find("(") + 1).trim_suffix(")")
	for part: String in inner.split(",", false):
		parts.append(part.strip_edges().to_float())
	return parts


static func _listed(type: int) -> bool:
	return type == TYPE_ARRAY or PACKED_ELEMENTS.has(type)


## [param value] as a caller would write it, for a refusal to quote.
func shown(value: Variant) -> String:
	return JSON.stringify(_values.serialize_value(value))


## A dictionary carrying its own type name, as the serialiser writes it.
##
## Answers [handled, value] rather than just the value, because a handled tag may legitimately
## produce null: a Resource tag with neither a path nor a class is "this is nothing", not "this is
## not mine". A tag that names a type but lacks the keys to build it is left unhandled on purpose,
## so the caller can still read it against the type the property declares.
func _parse_tagged_dictionary(value: Dictionary) -> Array:
	var type_tag: String = str(value.get("_type", value.get("type", "")))
	if type_tag == "Resource":
		return _parse_resource_tag(value)

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


## A resource named by its path, which goes through the same checks as a path given bare: the
## project boundary, and a file being there. A tag skipping them loaded an absolute path into the
## scene, and cleared the property when nothing was at the path.
func _parse_resource_tag(value: Dictionary) -> Array:
	var resource_path: String = str(value.get("path", ""))
	if not resource_path.is_empty():
		var found: Array = _resource_at(resource_path, "the value")
		if not found[0]:
			_refused = str(found[1])
			return [true, null]
		return [true, found[1]]
	# What a read answers for a resource built into the scene it was read from: a class and no
	# path. Taken as nothing, it cleared the property it was written back to.
	if value.has("class"):
		_refused = (
			(
				"The %s given has no path: it was read from a resource built into a scene, which cannot "
				+ 'be referred to from elsewhere. Build a new one with "_type" set to its class and its '
				+ "properties beside it."
			)
			% str(value["class"])
		)
		return [true, null]
	return [true, null]


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
	var wanted: Dictionary = {}
	for key: Variant in value:
		var property: String = str(key)
		if property != "_type" and property != "type":
			wanted[property] = value[key]
	var refused: String = write_all(built, wanted)
	if not refused.is_empty():
		_refused = refused
		return [true, null]
	return [true, built]


## A dictionary with no tag, read against the type the property declares. Anything else is a
## dictionary the property genuinely wants, and its values are read as values in their own right:
## kept as the tags they arrived as, a Vector2 read off one node and written to another was saved as
## a dictionary holding the word "Vector2".
func _parse_shaped_dictionary(value: Dictionary, expected_type: int, elements: Array) -> Variant:
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
	if expected_type != TYPE_NIL and expected_type != TYPE_DICTIONARY:
		return value

	return _parse_entries(value, elements)


## The entries of a dictionary a property holds, each value read as a value in its own right, and
## typed as the property declares when every entry fits.
func _parse_entries(value: Dictionary, elements: Array) -> Dictionary:
	var key_type: int = TYPE_NIL
	var value_type: int = TYPE_NIL
	if elements.size() == 2:
		key_type = Read.as_int(elements[0], TYPE_NIL)
		value_type = Read.as_int(elements[1], TYPE_NIL)
	var entries: Dictionary = {}
	for key: Variant in value:
		entries[_values.fitted(key, key_type)] = parse(value[key], value_type)
	return _typed_dictionary(entries, key_type, value_type)


## [param entries] as the typed dictionary a property declares, so the file holds the type the
## game's script will load it into. Left untyped when an entry does not fit, for the check after
## the parse to refuse by name.
func _typed_dictionary(entries: Dictionary, key_type: int, value_type: int) -> Dictionary:
	if key_type == TYPE_NIL and value_type == TYPE_NIL:
		return entries
	if key_type == TYPE_OBJECT or value_type == TYPE_OBJECT:
		return entries
	for key: Variant in entries:
		if key_type != TYPE_NIL and typeof(key) != key_type:
			return entries
		if not Serialisation.acceptable(entries[key], value_type):
			return entries
	var fitted: Dictionary = {}
	for key: Variant in entries:
		fitted[key] = type_convert(entries[key], value_type) if value_type != TYPE_NIL else entries[key]
	return Dictionary(fitted, key_type, &"", null, value_type, &"", null)


## An array, either positional for a vector the property declares, or a list to parse per item.
func _parse_array(value: Array, expected_type: int, elements: Array) -> Variant:
	if PACKED_ELEMENTS.has(expected_type):
		var element: int = Read.as_int(PACKED_ELEMENTS[expected_type], TYPE_NIL)
		return value.map(func(item: Variant) -> Variant: return parse(item, element))

	match expected_type:
		TYPE_VECTOR2:
			if value.size() == 2:
				return Vector2(Read.as_float(value[0]), Read.as_float(value[1]))
		TYPE_VECTOR2I:
			if value.size() == 2:
				return Vector2i(Read.as_int(value[0]), Read.as_int(value[1]))
		TYPE_VECTOR3:
			if value.size() == 3:
				return Vector3(Read.as_float(value[0]), Read.as_float(value[1]), Read.as_float(value[2]))
		TYPE_VECTOR3I:
			if value.size() == 3:
				return Vector3i(Read.as_int(value[0]), Read.as_int(value[1]), Read.as_int(value[2]))
		TYPE_VECTOR4:
			if value.size() == 4:
				return Vector4(
					Read.as_float(value[0]),
					Read.as_float(value[1]),
					Read.as_float(value[2]),
					Read.as_float(value[3])
				)
		TYPE_COLOR:
			if value.size() == 3 or value.size() == 4:
				return Color(
					Read.as_float(value[0]),
					Read.as_float(value[1]),
					Read.as_float(value[2]),
					Read.as_float(value[3]) if value.size() == 4 else 1.0
				)

	var element_type: int = TYPE_NIL
	if expected_type == TYPE_ARRAY and not elements.is_empty():
		element_type = Read.as_int(elements[0], TYPE_NIL)
	var items: Array = value.map(func(item: Variant) -> Variant: return parse(item, element_type))
	if element_type == TYPE_NIL or element_type == TYPE_OBJECT:
		return items
	if not items.all(func(item: Variant) -> bool: return Serialisation.acceptable(item, element_type)):
		return items
	var fitted: Array = items.map(func(item: Variant) -> Variant: return type_convert(item, element_type))
	return Array(fitted, element_type, &"", null)
