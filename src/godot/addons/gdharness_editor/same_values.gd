@tool
extends RefCounted
## Whether a value read back is the value that was given, as the tools that write properties judge
## what a write kept and what it changed besides.

const GdhRead = preload("reading.gd")
const GdhSerialisation = preload("serialisation.gd")
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
const PACKED: Array[int] = [
	TYPE_PACKED_BYTE_ARRAY,
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

# The pairs of built-in resources being compared, so a resource that holds itself ends the
# comparison instead of recursing into it for ever.
static var _comparing: Array[Array] = []


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
	if GdhSerialisation.NUMBERS.has(held_type) and GdhSerialisation.NUMBERS.has(given_type):
		if held_type == TYPE_BOOL or given_type == TYPE_BOOL:
			return held_type == given_type and held == given
		var held_number: float = GdhRead.as_float(held)
		var given_number: float = GdhRead.as_float(given)
		return (
			(is_nan(held_number) and is_nan(given_number))
			or is_equal_approx(held_number, given_number)
		)
	if GdhSerialisation.TEXTS.has(held_type) and GdhSerialisation.TEXTS.has(given_type):
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
	if not _built_in(held_resource):
		return held_resource.resource_path == given_resource.resource_path
	if held_resource.get_class() != given_resource.get_class():
		return false
	# A resource local to the scene is duplicated for every instance, so the copy read back is
	# another object of the same class.
	if held_resource.resource_local_to_scene:
		return true
	return _built_in(given_resource) and _same_stored(held_resource, given_resource)


## A resource no other file can refer to: one with no path, or one of a file's own sub-resources,
## whose path is the file's with "::" and an id after it.
static func _built_in(resource: Resource) -> bool:
	return resource.resource_path.is_empty() or resource.resource_path.contains("::")


## Two built-in resources of one class, by every property they store. Neither has a path to be
## known by, and a file loaded again holds a new object for each, so a Curve written into a
## resource file and read back was judged lost by the save that had just kept it.
static func _same_stored(held: Resource, given: Resource) -> bool:
	for pair: Array in _comparing:
		if is_same(pair[0], held) and is_same(pair[1], given):
			return true
	_comparing.append([held, given])
	var alike: bool = true
	for property: Dictionary in held.get_property_list():
		var usage: int = GdhRead.as_int(property.get("usage", 0))
		var name: String = str(property.get("name", ""))
		if (
			not (usage & PROPERTY_USAGE_STORAGE)
			or (name.begins_with("resource_") and name != "resource_name")
		):
			continue
		if not same(held.get(name), given.get(name)):
			alike = false
			break
	_comparing.pop_back()
	return alike


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
	return type == TYPE_ARRAY or PACKED.has(type)
