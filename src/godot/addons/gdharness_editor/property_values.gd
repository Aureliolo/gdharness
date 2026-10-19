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

const GdhDeclared = preload("declared_values.gd")
const GdhPropertyPaths = preload("property_paths.gd")
const GdhRead = preload("reading.gd")
const GdhSame = preload("same_values.gd")
const GdhSerialisation = preload("serialisation.gd")
const GdhShapes = preload("value_shapes.gd")

# The data types a Theme names its items by, as in "Button/colors/font_color", and what each holds.
const THEME_ITEMS: Dictionary[String, Array] = {
	"colors": [TYPE_COLOR, ""],
	"constants": [TYPE_INT, ""],
	"font_sizes": [TYPE_INT, ""],
	"fonts": [TYPE_OBJECT, "Font"],
	"icons": [TYPE_OBJECT, "Texture2D"],
	"styles": [TYPE_OBJECT, "StyleBox"],
}

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

# Entries in a property list that only head a section of the inspector. Object.set ignores their
# names, so a write to "Visibility" or "Transform" changed nothing and was answered as made.
const HEADINGS: int = PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP

var _values: GdhSerialisation = GdhSerialisation.new()

# Why the value being parsed cannot be written, when the parse is what found out. A resource is
# built inside the parse and there is nowhere in a parsed value to put the reason it is wrong.
var _refused: String = ""

# The stored properties the last write_all changed without being given them, by name, as [what it
# held before, what it holds now]. A setter keeps other properties in step with the one it is given:
# a Gradient given a third colour gives that point an offset of 0, a Control given a size moves its
# offsets. An answer naming only what was given leaves the caller to guess the rest.
var _also_changed: Dictionary = {}

# The values the last write_all wrote outside what their property declares, by name, as a sentence
# saying so: a number past an export range, or one no enum value has. The engine stores either, and
# the inspector would not have let it be entered, so a write answered as made said nothing of it.
var _outside_declared: Dictionary = {}


## Turns what arrived over the wire into the Godot value a property wants.
##
## Three separate questions, asked in order, because a caller may say what it means in three
## ways: a dictionary that names its own type, a dictionary shaped like the type the property
## declares, or a bare array positional for a vector. Each is its own function; asking all three
## in one was twenty-four exits deep and impossible to follow.
##
## [param elements] is what a typed Array or Dictionary holds, as [method GdhDeclared.elements_of]
## reads it.
func parse(value: Variant, expected_type: int = TYPE_NIL, elements: Array = []) -> Variant:
	if value is Dictionary:
		var fields: Dictionary = value
		# A dictionary with keys that are not text arrives as its entries, and is read against the
		# declared element types like any other.
		if str(fields.get("_type", "")) == "Dictionary" and GdhSerialisation.pairs(fields.get("entries")):
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
	if not GdhSerialisation.acceptable(value, expected_type):
		var shape: String = "%s.%s is %s and the value given is %s, which cannot become one."
		var remedy: String = GdhShapes.remedy(value, expected_type)
		return shape % [holder, property, held, type_string(typeof(value))] + remedy + cost

	# And the same question of each element, because a list is accepted for a packed or typed array
	# whatever is in it: a polygon written as [{"x": 1}] passes the check above and lands as one zero
	# vector, and [1.5, "x"] for a PackedInt32Array as [1, 0].
	var element: int = GdhRead.as_int(PACKED_ELEMENTS.get(expected_type, TYPE_NIL), TYPE_NIL)
	if expected_type == TYPE_ARRAY and not elements.is_empty():
		element = GdhRead.as_int(elements[0], TYPE_NIL)
	if element != TYPE_NIL and value is Array:
		var items: Array = value
		for index: int in items.size():
			if not GdhSerialisation.acceptable(items[index], element):
				var shape: String = "%s.%s is %s and item %d of the list given is %s, not %s."
				var named: Array = [
					holder, property, held, index, type_string(typeof(items[index])), type_string(element)
				]
				return shape % named + GdhShapes.remedy(items[index], element) + cost
	if expected_type == TYPE_DICTIONARY and elements.size() == 2 and value is Dictionary:
		var entries: Dictionary = value
		var key_type: int = GdhRead.as_int(elements[0], TYPE_NIL)
		var value_type: int = GdhRead.as_int(elements[1], TYPE_NIL)
		for key: Variant in entries:
			if not GdhSerialisation.acceptable(key, key_type):
				var shape: String = "%s.%s has %s keys, and %s is not one."
				return shape % [holder, property, type_string(key_type), shown(key)] + cost
			var entry: Variant = entries[key]
			if not GdhSerialisation.acceptable(entry, value_type):
				var shape: String = "%s.%s holds %s values, and the one given for %s is %s."
				var named: Array = [holder, property, type_string(value_type), shown(key), shown(entry)]
				return shape % named + GdhShapes.remedy(entry, value_type) + cost
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
## A name may be a colon path into a property's components, "position:x" or "region_rect:size:y",
## spelled as the runtime tools spell it, so one axis can be written without restating the others.
##
## Nothing here saves, so a refusal partway leaves the change in memory and the file as it was. The
## caller returns the refusal instead of saving.
func write_all(target: Object, properties: Dictionary) -> String:
	_also_changed = {}
	_outside_declared = {}
	var named: Dictionary = {}
	for key: Variant in properties:
		named[str(key).get_slice(":", 0)] = true
	var before: Dictionary = _stored(target, named)
	var given: Dictionary = {}
	var declarations: Dictionary = {}
	# A refusal of one of several leaves the others unwritten too, which a refusal naming only the
	# one it refused left a caller to guess.
	var unwritten: String = (
		"" if properties.size() < 2 else " None of the %d properties given was written." % properties.size()
	)
	# The script first, wherever the caller put it, since the properties it declares exist only once
	# it is attached.
	var order: Array = properties.keys()
	if order.has("script"):
		order.erase("script")
		order.push_front("script")
	var home: String = GdhPropertyPaths.home_of(target)
	for key: Variant in order:
		var property: String = str(key)
		var place: Array = GdhPropertyPaths.holder_of(target, property, home)
		var holder: Object = place[0]
		var name: String = place[1]
		var declared: Dictionary = declaration(holder, name)
		if declared.is_empty():
			var elsewhere: String = GdhPropertyPaths.held_elsewhere(holder, name, home)
			if not elsewhere.is_empty():
				return elsewhere + unwritten
			var ungrown: String = GdhPropertyPaths.grow(holder, name, GdhPropertyPaths.class_called(holder))
			if not ungrown.is_empty():
				return ungrown + unwritten
			declared = declaration(holder, name)
		if declared.is_empty() and ":" in name:
			declared = _component_slot(holder, name)
			if declared.has("refused"):
				return str(declared["refused"]) + unwritten
		if declared.is_empty() and holder is ShaderMaterial and name.begins_with("shader_parameter/"):
			return _no_uniform(holder as ShaderMaterial, name) + unwritten
		if declared.is_empty():
			return no_property(holder, name) + unwritten
		var value: Array = value_for(holder, declared, properties[key])
		if not value[0]:
			return str(value[1]) + unwritten
		var outside: String = GdhDeclared.outside(holder, declared, value[1], shown(value[1]))
		if not outside.is_empty():
			_outside_declared[property] = outside
		_write(target, property, value[1])
		given[property] = value[1]
		declarations[property] = declared

	for property: String in given:
		if not GdhSame.same(read_at(target, property), given[property]):
			_write(target, property, given[property])
	for property: String in given:
		var held: Variant = read_at(target, property)
		if not GdhSame.same(held, given[property]):
			var declared: Dictionary = declarations[property]
			return _not_held(target, property, given[property], held, declared)
	for property: String in before:
		var now: Variant = target.get(property)
		if not GdhSame.same(now, before[property]):
			_also_changed[property] = [before[property], now]
	return ""


## Why [param property] of [param target], declared as [param declared], holds [param held] after
## it was given [param value]. A text property with a list of names holds only one of them, and its
## getter answers its default for any other. A player's bus is one, though the engine fills its list
## only in the inspector, so the buses are read from the AudioServer, which holds the project's
## layout; "the engine changed or refused the value" left a caller to guess the bus did not exist.
func _not_held(
	target: Object, property: String, value: Variant, held: Variant, declared: Dictionary
) -> String:
	var said: String = (
		"%s.%s was given %s and holds %s after it was set"
		% [GdhPropertyPaths.class_called(target), property, shown(value), shown(held)]
	)
	var type: int = GdhRead.as_int(declared.get("type", TYPE_NIL))
	var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	var names: PackedStringArray = []
	if hint == PROPERTY_HINT_ENUM and (type == TYPE_STRING or type == TYPE_STRING_NAME):
		names = PackedStringArray(GdhDeclared.enum_values(str(declared.get("hint_string", ""))).keys())
	var bus: bool = property == "bus" and target.get_class().begins_with("AudioStreamPlayer")
	if bus:
		names = []
		for index: int in AudioServer.bus_count:
			var _added: bool = names.append(AudioServer.get_bus_name(index))
	if names.is_empty() or names.has(str(value)):
		return said + ": the engine changed or refused the value, so nothing was written."
	var close: PackedStringArray = GdhRead.nearest(str(value), names)
	var nearest: String = (
		"%s %s" % ["is" if close.size() == 1 else "are", ", ".join(close)] if not close.is_empty() else ""
	)
	if bus:
		return (
			(
				"%s: it takes the name of one of the project's audio buses, and %s is none of them; %s. "
				+ "project_info include audio_buses lists them, and project_settings add_audio_bus adds "
				+ "one. Nothing was written."
			)
			% [
				said,
				shown(value),
				"the buses are " + ", ".join(names) if nearest.is_empty() else "the nearest " + nearest
			]
		)
	return (
		"%s: it takes one of the names it lists, and %s is none of them; %s. Nothing was written."
		% [
			said,
			shown(value),
			"it lists " + ", ".join(names) if nearest.is_empty() else "the nearest it lists " + nearest
		]
	)


## Why [param material] has no [param property]: a ShaderMaterial's parameters are its shader's
## uniforms, so the shader is what lacks one, and "ShaderMaterial has no property" named the
## material.
static func _no_uniform(material: ShaderMaterial, property: String) -> String:
	var uniform: String = property.trim_prefix("shader_parameter/")
	if material.shader == null:
		return "The ShaderMaterial has no shader, so it has no parameter %s yet; set shader first." % uniform
	var shader: String = material.shader.resource_path
	var named: String = shader if not shader.is_empty() else "Its shader"
	var uniforms: Array = []
	for entry: Dictionary in material.shader.get_shader_uniform_list():
		uniforms.append(str(entry["name"]))
	var said: String = "%s declares no uniform %s, which %s would set" % [named, uniform, property]
	if uniforms.is_empty():
		return said + "; it declares no uniforms."
	return GdhRead.offered(said, uniform, uniforms) + "."


## Puts under alsoChanged in [param answer] each property the last [method write_all] changed
## without being given it, as {was, now}, and under outsideDeclared each value it wrote outside what
## its property declares, when there are any. A node is named by its path from [param relative_to],
## as a scene answer names one. Called before the scene is written, since the write frees the nodes
## these values can hold.
func note_write(answer: Dictionary, relative_to: Node = null) -> void:
	if not _outside_declared.is_empty():
		answer["outsideDeclared"] = _outside_declared.duplicate()
	if _also_changed.is_empty():
		return
	var noted: Dictionary = {}
	for property: Variant in _also_changed:
		var pair: Array = _also_changed[property]
		noted[property] = {"was": _readable(pair[0], relative_to), "now": _readable(pair[1], relative_to)}
	answer["alsoChanged"] = noted


func _readable(value: Variant, relative_to: Node) -> Variant:
	if value is Node and relative_to != null:
		var target: Node = value
		return _values.serialize_value(relative_to.get_path_to(target))
	if value is Array:
		var items: Array = value
		return items.map(func(item: Variant) -> Variant: return _readable(item, relative_to))
	return _values.serialize_value(value)


## What [param target] stores, by name, but its script and the properties in [param leave]. A list
## or a map is copied, since a setter can change the one it holds in place.
func _stored(target: Object, leave: Dictionary) -> Dictionary:
	var held: Dictionary = {}
	for entry: Dictionary in target.get_property_list():
		var name: String = str(entry["name"])
		var usage: int = GdhRead.as_int(entry["usage"])
		if (
			usage & PROPERTY_USAGE_STORAGE == 0
			or usage & HEADINGS != 0
			or name == "script"
			or leave.has(name)
		):
			continue
		var value: Variant = target.get(name)
		if value is Array:
			var listed: Array = value
			value = listed.duplicate(true)
		elif value is Dictionary:
			var mapped: Dictionary = value
			value = mapped.duplicate(true)
		held[name] = value
	return held


## What [param target] holds under [param key], a property or a colon path into one's components.
func read_at(target: Object, key: String) -> Variant:
	var place: Array = GdhPropertyPaths.holder_of(target, key)
	var holder: Object = place[0]
	var name: String = place[1]
	if ":" in name and declaration(holder, name).is_empty():
		return holder.get_indexed(NodePath(name))
	return holder.get(name)


## Writes [param value] under [param key], putting a changed component back into the property it
## was read out of, and that one into the one above it.
func _write(target: Object, key: String, value: Variant) -> void:
	var place: Array = GdhPropertyPaths.holder_of(target, key)
	var holder: Object = place[0]
	var name: String = place[1]
	if ":" in name and declaration(holder, name).is_empty():
		holder.set_indexed(NodePath(name), value)
	else:
		holder.set(name, value)


## The declaration the last step of [param path] would have, typed as the component it reaches, so
## a fraction for an integer vector's axis is refused as one for an int property is; or
## {"refused": why} for the first step that is not there.
func _component_slot(target: Object, path: String) -> Dictionary:
	var steps: PackedStringArray = path.split(":")
	var owner: String = GdhPropertyPaths.class_called(target)
	if declaration(target, steps[0]).is_empty():
		return {"refused": no_property(target, steps[0])}
	var value: Variant = target.get(steps[0])
	var walked: String = steps[0]
	for index: int in range(1, steps.size()):
		var step: String = steps[index]
		var has: PackedStringArray = GdhSerialisation.components_of(value)
		var sort: String = GdhRead.with_article(type_string(typeof(value)))
		if has.is_empty():
			return {
				"refused":
				(
					(
						"%s.%s is %s, which a path does not step into: a path reaches the components of a "
						+ "vector, a colour, a rectangle or a transform."
					)
					% [owner, walked, sort]
				)
			}
		if not step in has:
			return {
				"refused":
				"%s.%s is %s, so it has no %s; it has %s." % [owner, walked, sort, step, ", ".join(has)]
			}
		value = value[step]
		walked += ":" + step
	return {"name": path, "type": typeof(value), "usage": PROPERTY_USAGE_DEFAULT}


## [param raw] as the value [param declared] takes, as [ok, value] or [false, why not].
func value_for(target: Object, declared: Dictionary, raw: Variant) -> Array:
	var property: String = str(declared.get("name", ""))
	var expected_type: int = GdhRead.as_int(declared.get("type", TYPE_NIL), TYPE_NIL)
	var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	if expected_type == TYPE_OBJECT and hint == PROPERTY_HINT_NODE_TYPE:
		return _node_reference(target, property, raw)
	# An enum is written by the name of a value as well as its number, since the name is what the
	# script and the inspector show and the number is only where the value happens to sit.
	if expected_type == TYPE_INT and hint == PROPERTY_HINT_ENUM and typeof(raw) == TYPE_STRING:
		var choices: Dictionary = GdhDeclared.enum_of(target, declared)
		var chosen: Variant = GdhDeclared.enum_named(choices, str(raw))
		if chosen == null:
			var hinted: Dictionary = GdhDeclared.enum_values(str(declared.get("hint_string", "")))
			chosen = GdhDeclared.enum_named(hinted, str(raw))
		var constants: Dictionary = {}
		if chosen == null:
			constants = GdhDeclared.engine_constants(target, property)
			chosen = GdhDeclared.enum_named(constants, str(raw))
		if chosen != null:
			return [true, chosen]
		if not str(raw).strip_edges().is_valid_int():
			var why: String = GdhDeclared.enum_refusal(
				GdhPropertyPaths.class_called(target), property, str(raw), choices, constants
			)
			return [false, why]

	# A resource-valued property takes the path of one, which is how a caller names a TileSet,
	# a material or a theme: there is no other way to hand a tool a Resource.
	var value: Variant = null
	if expected_type == TYPE_OBJECT and typeof(raw) == TYPE_STRING:
		var found: Array = _resource_at(str(raw), property)
		if not found[0]:
			return found
		value = found[1]
	else:
		var elements: Array = GdhDeclared.elements_of(declared)
		if _fraction(raw, expected_type, elements):
			return [false, _fraction_refusal(target, property, raw)]
		var rounded: String = GdhSerialisation.inexact(raw, expected_type)
		if not rounded.is_empty():
			return [
				false, "%s.%s holds int: %s." % [GdhPropertyPaths.class_called(target), property, rounded]
			]
		_refused = ""
		value = parse(raw, expected_type, elements)
		if not _refused.is_empty():
			return [false, _refused]
		if expected_type == TYPE_ARRAY and elements == [TYPE_OBJECT] and value is Array:
			var listed: Array = value
			return _object_list(target, declared, listed)
		if expected_type == TYPE_DICTIONARY and elements.size() == 2 and value is Dictionary:
			if GdhRead.as_int(elements[1], TYPE_NIL) == TYPE_OBJECT:
				var mapped: Dictionary = value
				return _object_entries(target, declared, mapped)
		var refusal: String = cannot_hold(
			GdhPropertyPaths.class_called(target), property, value, expected_type, elements
		)
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
	var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	var wanted: String = str(declared.get("hint_string", ""))
	if hint != PROPERTY_HINT_RESOURCE_TYPE or wanted.is_empty():
		return ""
	var names: PackedStringArray = wanted.split(",", false)
	for name: String in names:
		if GdhDeclared.is_a(value, name.strip_edges()):
			return ""
	return (
		"%s holds %s, and the value given is a %s."
		% [str(declared.get("name", "")), " or ".join(names), value.get_class()]
	)


## [param value] as the typed list of objects that [param declared] holds on [param target], as
## [ok, list or why not]. Measured on 4.7.2, a scene's node whose script exports Array[Item] holds []
## after being given an untyped list of Items, and keeps a list typed as its own is.
func _object_list(target: Object, declared: Dictionary, value: Array) -> Array:
	var property: String = str(declared.get("name", ""))
	var kind: Array = GdhDeclared.object_kind(declared, 0)
	var holding: String = "%s.%s holds %s" % [GdhPropertyPaths.class_called(target), property, kind[0]]
	var items: Array = []
	for index: int in value.size():
		var place: Array = ["item %d of the list given" % index, "item %d of %s" % [index, property]]
		var item: Array = _object_item(target, value[index], kind, holding, place)
		if not item[0]:
			return item
		items.append(item[1])
	var held: Variant = target.get(property)
	var current: Array = held if held is Array else []
	if current.is_typed():
		return [
			true,
			Array(
				items, current.get_typed_builtin(), current.get_typed_class_name(), current.get_typed_script()
			)
		]
	var typing: Array = GdhDeclared.object_typing(str(kind[0]))
	if typing.is_empty():
		return [true, items]
	var base: StringName = typing[0]
	var script: Script = typing[1]
	return [true, Array(items, TYPE_OBJECT, base, script)]


## [param value] as the typed map to objects that [param declared] holds on [param target], as
## [ok, map or why not], typed for the same reason as [method _object_list].
func _object_entries(target: Object, declared: Dictionary, value: Dictionary) -> Array:
	var property: String = str(declared.get("name", ""))
	var kind: Array = GdhDeclared.object_kind(declared, 1)
	var holding: String = "%s.%s holds %s values" % [GdhPropertyPaths.class_called(target), property, kind[0]]
	var entries: Dictionary = {}
	for key: Variant in value:
		var place: Array = ["the one given for %s" % shown(key), "%s[%s]" % [property, shown(key)]]
		var entry: Array = _object_item(target, value[key], kind, holding, place)
		if not entry[0]:
			return entry
		entries[key] = entry[1]
	var held: Variant = target.get(property)
	var current: Dictionary = held if held is Dictionary else {}
	if current.is_typed():
		return [
			true,
			Dictionary(
				entries,
				current.get_typed_key_builtin(),
				current.get_typed_key_class_name(),
				current.get_typed_key_script(),
				current.get_typed_value_builtin(),
				current.get_typed_value_class_name(),
				current.get_typed_value_script()
			)
		]
	var typing: Array = GdhDeclared.object_typing(str(kind[0]))
	var key_type: int = GdhRead.as_int(GdhDeclared.elements_of(declared)[0], TYPE_NIL)
	if typing.is_empty() or key_type == TYPE_OBJECT:
		return [true, entries]
	var base: StringName = typing[0]
	var script: Script = typing[1]
	return [true, Dictionary(entries, key_type, &"", null, TYPE_OBJECT, base, script)]


## [param given], an object for a typed list or map, as [ok, object or why not]: a resource's
## res:// path is the resource, and for nodes a path from [param target] is the node there.
## [param holding] says what the list or map holds, and [param place] is [where the value sits in
## what was given, what it is called in the property].
func _object_item(target: Object, given: Variant, kind: Array, holding: String, place: Array) -> Array:
	var item: Variant = given
	if typeof(item) == TYPE_STRING:
		var found: Array = (
			_node_reference(target, str(place[1]), item)
			if kind[1]
			else _resource_at(str(item), str(place[1]))
		)
		if not found[0]:
			return found
		item = found[1]
	var object: Object = item if item is Object else null
	if item == null or (object != null and GdhDeclared.is_a(object, str(kind[0]))):
		return [true, item]
	var named: String = object.get_class() if object != null else shown(item)
	return [false, "%s, and %s is %s." % [holding, place[0], named]]


## Whether [param value] holds a number with a fractional part where an integer is wanted, in a
## list or a dictionary as much as bare. The conversion would cut 2.7 to 2 without a word, and a
## dictionary key arrives as the text "2.7", which reads as the same number.
func _fraction(value: Variant, type: int, elements: Array = []) -> bool:
	if type == TYPE_INT:
		var number: Variant = value
		if typeof(value) == TYPE_STRING:
			number = GdhRead.json_or_null(str(value))
		if typeof(number) != TYPE_FLOAT:
			return false
		var whole: float = number
		return is_finite(whole) and whole != floorf(whole)
	var element: int = GdhRead.as_int(PACKED_ELEMENTS.get(type, TYPE_NIL), TYPE_NIL)
	if type == TYPE_ARRAY and not elements.is_empty():
		element = GdhRead.as_int(elements[0], TYPE_NIL)
	if value is Array and element != TYPE_NIL:
		var items: Array = value
		return items.any(func(item: Variant) -> bool: return _fraction(item, element))
	if type == TYPE_DICTIONARY and elements.size() == 2 and value is Dictionary:
		var entries: Dictionary = value
		var key_type: int = GdhRead.as_int(elements[0], TYPE_NIL)
		var value_type: int = GdhRead.as_int(elements[1], TYPE_NIL)
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
		% [GdhPropertyPaths.class_called(target), property, shown(raw)]
	)


## [param raw] as a colour, read as a property write reads one, as [true, Color] or [false, why]:
## fields from 0 to 1 with a optional, or an html code. [param named] is what the refusal calls it.
func colour_from(raw: Variant, named: String) -> Array:
	_refused = ""
	var value: Variant = parse(raw, TYPE_COLOR)
	if not _refused.is_empty():
		return [false, _refused]
	if value is Color:
		return [true, value]
	return [
		false,
		(
			(
				'%s is {"r": .., "g": .., "b": .., "a": ..} from 0 to 1, a optional, or an html code such as '
				+ '"#ff8000" or "#ff800080"; %s is neither.'
			)
			% [named, JSON.stringify(raw)]
		)
	]


## The refusal for [param property], which [param target] does not declare, naming the declared
## ones nearest it: "StyleBoxFlat has no property shadow_sizee" left the caller nothing to send.
static func no_property(target: Object, property: String) -> String:
	return (
		GdhRead.near_property(
			"%s has no property %s" % [GdhPropertyPaths.class_called(target), property], target, property
		)
		+ "."
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
		# An image or a sound nobody has imported is a file the engine has no loader for, and "No
		# resource at" sent a caller looking for a file that was there.
		if path.begins_with("res://") and FileAccess.file_exists(path):
			return [
				false,
				(
					(
						"%s is there, but it has never been imported, so the engine has no resource to load"
						+ " from it for %s. project_import reimport with resourcePath %s imports it."
					)
					% [path, property, path]
				)
			]
		return [false, "No resource at %s for %s" % [path, property]]
	return [true, load(path)]


## The entry [param target] declares for [param property], or {} when it declares none. Headings
## are left out: a category or group shares the list with the properties, and Object.set ignores
## its name, so without this a typo or a heading saved a file that had not changed and reported it
## as one that had.
func declaration(target: Object, property: String) -> Dictionary:
	var declared: Dictionary = GdhPropertyPaths.declared_on(target, property)
	if declared.is_empty() and target is Theme:
		return _theme_item(property)
	return declared


## The entry a Theme would declare for [param property] once it held that item, or {} when the name
## is not an item's. A Theme lists only the items it holds and takes any other through set, so an
## item a read of one theme answered with was refused when written into another that lacked it.
static func _theme_item(property: String) -> Dictionary:
	var parts: PackedStringArray = property.split("/")
	if parts.size() != 3 or parts[0].is_empty() or parts[2].is_empty() or not THEME_ITEMS.has(parts[1]):
		return {}
	var item: Array = THEME_ITEMS[parts[1]]
	var kind: int = item[0]
	var made: Dictionary = {"name": property, "type": kind, "usage": PROPERTY_USAGE_DEFAULT}
	if kind == TYPE_OBJECT:
		made["hint"] = PROPERTY_HINT_RESOURCE_TYPE
		made["hint_string"] = item[1]
	return made


## [param value] as a caller would write it, for a refusal to quote.
func shown(value: Variant) -> String:
	return JSON.stringify(_values.serialize_value(value), "", false)


## A dictionary carrying its own type name, as the serialiser writes it.
##
## Answers [handled, value] rather than just the value, because a handled tag may legitimately
## produce null: a Resource tag with neither a path nor a class is "this is nothing", not "this is
## not mine". A tag that names a type but lacks the keys to build it is left unhandled on purpose,
## so the caller can still read it against the type the property declares.
func _parse_tagged_dictionary(value: Dictionary) -> Array:
	var type_tag: String = str(value.get("_type", ""))
	if type_tag == "Resource":
		return _parse_resource_tag(value)

	# The shared builder is the same one the answer was written by, so every shape it writes comes
	# back as itself.
	var rebuilt: Variant = _values.deserialize_value(value)
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
	# What a read answers where a resource built into a scene recurs inside itself: a class and no
	# path. Taken as nothing, it cleared the property it was written back to.
	if value.has("class"):
		_refused = (
			(
				"The %s given has no path: a read names a resource built into a scene by its class "
				+ "alone where it recurs inside itself, and nothing elsewhere can refer to it. Build "
				+ 'a new one with "_type" set to its class and its properties beside it.'
			)
			% str(value["class"])
		)
		return [true, null]
	# A plain Resource with a script or values of its own, as a read answers one built into a scene,
	# is one to build; taken as nothing, writing such a read back cleared the property.
	if value.size() > 1:
		return _parse_new_resource("Resource", value)
	return [true, null]


## A tag naming a Resource class builds a fresh one, its other keys set as properties, so a
## NavigationRegion2D can arrive with its NavigationPolygon and an AnimationTree with its root
## state machine in the same add as any other property.
func _parse_new_resource(type_tag: String, value: Dictionary) -> Array:
	var built: Resource = null
	if (
		ClassDB.class_exists(type_tag)
		and ClassDB.is_parent_class(type_tag, "Resource")
		and ClassDB.can_instantiate(type_tag)
	):
		built = ClassDB.instantiate(type_tag)
	elif not type_tag.is_empty() and not ClassDB.class_exists(type_tag):
		# A script's class_name, as a read answers it under scriptClass.
		var script: Script = GdhDeclared.script_class(type_tag)
		if script != null and ClassDB.is_parent_class(script.get_instance_base_type(), "Resource"):
			built = ClassDB.instantiate(script.get_instance_base_type())
			built.set_script(script)
	if built == null:
		return [false, null]
	var wanted: Dictionary = {}
	for key: Variant in value:
		var property: String = str(key)
		if property != "_type":
			wanted[property] = value[key]
	var refused: String = write_all(built, wanted)
	if not refused.is_empty():
		_refused = refused
		return [true, null]
	GdhDeclared.unmade(built, wanted)
	return [true, built]


## A dictionary with no tag, read against the type the property declares, by the fields the tagged
## form of that type carries: the shape a read answers with, untagged, is a value too. A rectangle
## written as the position and size a read gave was refused while the four numbers were taken, and
## a Rect2i, an AABB or a transform had no untagged form at all. Anything else is a dictionary the
## property genuinely wants, and its values are read as values in their own right: kept as the tags
## they arrived as, a Vector2 read off one node and written to another was saved as a dictionary
## holding the word "Vector2".
func _parse_shaped_dictionary(value: Dictionary, expected_type: int, elements: Array) -> Variant:
	if expected_type == TYPE_NIL or expected_type == TYPE_DICTIONARY:
		return _parse_entries(value, elements)
	var tag: String = type_string(expected_type)
	if GdhShapes.REQUIRED.has(tag):
		var tagged: Dictionary = value.duplicate()
		tagged["_type"] = tag
		var built: Variant = _values.deserialize_value(tagged)
		if typeof(built) == expected_type:
			return built
	return value


## The entries of a dictionary a property holds, each value read as a value in its own right, and
## typed as the property declares when every entry fits.
func _parse_entries(value: Dictionary, elements: Array) -> Dictionary:
	var key_type: int = TYPE_NIL
	var value_type: int = TYPE_NIL
	if elements.size() == 2:
		key_type = GdhRead.as_int(elements[0], TYPE_NIL)
		value_type = GdhRead.as_int(elements[1], TYPE_NIL)
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
		if not GdhSerialisation.acceptable(entries[key], value_type):
			return entries
	var fitted: Dictionary = {}
	for key: Variant in entries:
		fitted[key] = type_convert(entries[key], value_type) if value_type != TYPE_NIL else entries[key]
	return Dictionary(fitted, key_type, &"", null, value_type, &"", null)


## An array, either positional for a vector the property declares, or a list to parse per item.
func _parse_array(value: Array, expected_type: int, elements: Array) -> Variant:
	if PACKED_ELEMENTS.has(expected_type):
		var element: int = GdhRead.as_int(PACKED_ELEMENTS[expected_type], TYPE_NIL)
		return value.map(func(item: Variant) -> Variant: return parse(item, element))

	match expected_type:
		TYPE_VECTOR2:
			if value.size() == 2:
				return Vector2(GdhRead.as_float(value[0]), GdhRead.as_float(value[1]))
		TYPE_VECTOR2I:
			if value.size() == 2:
				return Vector2i(GdhRead.as_int(value[0]), GdhRead.as_int(value[1]))
		TYPE_VECTOR3:
			if value.size() == 3:
				return Vector3(
					GdhRead.as_float(value[0]), GdhRead.as_float(value[1]), GdhRead.as_float(value[2])
				)
		TYPE_VECTOR3I:
			if value.size() == 3:
				return Vector3i(GdhRead.as_int(value[0]), GdhRead.as_int(value[1]), GdhRead.as_int(value[2]))
		TYPE_VECTOR4:
			if value.size() == 4:
				return Vector4(
					GdhRead.as_float(value[0]),
					GdhRead.as_float(value[1]),
					GdhRead.as_float(value[2]),
					GdhRead.as_float(value[3])
				)
		TYPE_COLOR:
			if value.size() == 3 or value.size() == 4:
				return Color(
					GdhRead.as_float(value[0]),
					GdhRead.as_float(value[1]),
					GdhRead.as_float(value[2]),
					GdhRead.as_float(value[3]) if value.size() == 4 else 1.0
				)

	var element_type: int = TYPE_NIL
	if expected_type == TYPE_ARRAY and not elements.is_empty():
		element_type = GdhRead.as_int(elements[0], TYPE_NIL)
	var items: Array = value.map(func(item: Variant) -> Variant: return parse(item, element_type))
	if element_type == TYPE_NIL or element_type == TYPE_OBJECT:
		return items
	if not items.all(func(item: Variant) -> bool: return GdhSerialisation.acceptable(item, element_type)):
		return items
	var fitted: Array = items.map(func(item: Variant) -> Variant: return type_convert(item, element_type))
	return Array(fitted, element_type, &"", null)
