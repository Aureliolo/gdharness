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
const GdhFileWalk = preload("file_walk.gd")
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
const PACKED_ELEMENTS: Dictionary = GdhShapes.PACKED_ELEMENTS
# Entries in a property list that only head a section of the inspector. Object.set ignores their
# names, so a write to "Visibility" or "Transform" changed nothing and was answered as made.
const HEADINGS: int = PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP
## Control's layout_mode values, which the engine does not expose as constants.
const LAYOUT_MODE_POSITION: int = 0
const LAYOUT_MODE_ANCHORS: int = 1
const LAYOUT_MODE_UNCONTROLLED: int = 3
## What a container sets on each child it lays out, beside the anchors and offsets.
const PLACED_BY_A_CONTAINER: Array[String] = ["position", "size", "global_position"]

## The property the last write_all refused because it did not hold what it was given, or "".
var unheld: String = ""
## The stored properties the last write_all's own writes moved beside the ones they were given, as a
## set: the Anchors mode an anchor needs, and what an engine setter keeps in step, such as the
## anchors an anchor preset sets. Only writes no script code runs for count. A headless write that
## attaches a script that is not a tool puts back whatever the call did not name, as that script's
## doing, which put a panel given a script and a bottom-wide preset back in Position mode, where its
## anchors are not stored.
var moved_by_engine: Dictionary = {}
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
# The node paths the last write_all wrote that name no node from the node written, by property, as
# a sentence saying so.
var _names_no_node: Dictionary = {}


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
		if (
			str(fields.get("_type", "")) == "Dictionary"
			and GdhSerialisation.pairs(fields.get("entries"))
		):
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
		return shape % [holder, property, held, GdhShapes.kind(value)] + remedy + cost

	# And the same question of each element, because a list is accepted for a packed or typed array
	# whatever is in it: a polygon written as [{"x": 1}] passes the check above and lands as one
	# zero vector, and [1.5, "x"] for a PackedInt32Array as [1, 0].
	var element: int = GdhRead.as_int(PACKED_ELEMENTS.get(expected_type, TYPE_NIL), TYPE_NIL)
	if expected_type == TYPE_ARRAY and not elements.is_empty():
		element = GdhRead.as_int(elements[0], TYPE_NIL)
	if element != TYPE_NIL and value is Array:
		var items: Array = value
		for index: int in items.size():
			if not GdhSerialisation.acceptable(items[index], element):
				var shape: String = "%s.%s is %s and item %d of the list given is %s, not %s."
				var named: Array = [
					holder,
					property,
					held,
					index,
					GdhShapes.kind(items[index]),
					type_string(element),
				]
				return shape % named + GdhShapes.remedy(items[index], element) + cost
			# A list of polygons is a list of lists of points, and each point is read as one too.
			var inner: int = GdhRead.as_int(PACKED_ELEMENTS.get(element, TYPE_NIL), TYPE_NIL)
			if inner == TYPE_NIL or not items[index] is Array:
				continue
			var points: Array = items[index]
			for at: int in points.size():
				if not GdhSerialisation.acceptable(points[at], inner):
					var nested: String = (
						"%s.%s holds lists of %s, and item %d of list %d given is %s, not %s."
					)
					var said: Array = [
						holder,
						property,
						type_string(inner),
						at,
						index,
						GdhShapes.kind(points[at]),
						type_string(inner),
					]
					return nested % said + GdhShapes.remedy(points[at], inner) + cost
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
				var named: Array = [
					holder, property, type_string(value_type), shown(key), shown(entry),
				]
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
	_names_no_node = {}
	moved_by_engine = {}
	unheld = ""
	var named: Dictionary = {}
	for key: Variant in properties:
		named[str(key).get_slice(":", 0)] = true
	var before: Dictionary = _stored(target, named)
	var given: Dictionary = {}
	var declarations: Dictionary = {}
	# How many writes had been made when each property was last written. One written last is not
	# written again: the node is as that write left it, so the engine refuses it the same way and
	# says so a second time.
	var written_at: Dictionary[String, int] = {}
	var writes: int = 0
	# Which other property's write last changed each one already written, by name. A Gradient keeps
	# one offset for each colour, so offsets given after colors cut them back, and the refusal said
	# only that the engine had changed the colours.
	var undone_by: Dictionary[String, String] = {}
	# A refusal of one of several leaves the others unwritten too, which a refusal naming only the
	# one it refused left a caller to guess.
	var unwritten: String = (
		""
		if properties.size() < 2
		else " None of the %d properties given was written." % properties.size()
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
			var unlisted: String = GdhPropertyPaths.unlisted(holder, name)
			if not unlisted.is_empty():
				return unlisted + unwritten
			var ungrown: String = GdhPropertyPaths.grow(
				holder, name, GdhPropertyPaths.class_called(holder)
			)
			if not ungrown.is_empty():
				return ungrown + unwritten
			declared = declaration(holder, name)
		if declared.is_empty() and ":" in name:
			declared = _component_slot(holder, name)
			if declared.has("refused"):
				return str(declared["refused"]) + unwritten
		if (
			declared.is_empty()
			and holder is ShaderMaterial
			and name.begins_with("shader_parameter/")
		):
			return GdhDeclared.no_uniform(holder as ShaderMaterial, name) + unwritten
		if declared.is_empty():
			return no_property(holder, name) + unwritten
		var unscripted: Variant = null
		if holder == target and not GdhDeclared.runs_script_code(target, name):
			unscripted = _stored(target, {})
		if holder is Control:
			var unplaced: String = _laid_out(holder as Control, name)
			if not unplaced.is_empty():
				return unplaced + unwritten
		var value: Array = value_for(holder, declared, properties[key])
		if not value[0]:
			return str(value[1]) + unwritten
		var outside: String = GdhDeclared.outside(holder, declared, value[1], shown(value[1]))
		if not outside.is_empty():
			_outside_declared[property] = outside
		_write(target, property, value[1])
		if unscripted is Dictionary:
			var was: Dictionary = unscripted
			var now: Dictionary = _stored(target, {})
			for moved: String in now:
				if moved != name.get_slice(":", 0) and not GdhSame.same(now[moved], was.get(moved)):
					moved_by_engine[moved] = true
		writes += 1
		written_at[property] = writes
		_note_undone(target, property, given, undone_by)
		given[property] = value[1]
		declarations[property] = declared

	for property: String in given:
		if (
			written_at[property] < writes
			and not GdhSame.same(read_at(target, property), given[property])
		):
			_write(target, property, given[property])
			writes += 1
			written_at[property] = writes
			_note_undone(target, property, given, undone_by)
	for property: String in given:
		var held: Variant = read_at(target, property)
		if not GdhSame.same(held, given[property]):
			unheld = property
			if undone_by.has(property):
				return (
					(
						"%s.%s was given %s and holds %s once %s was set as well: the engine keeps "
						+ "the two in step, so they cannot hold these values together. Nothing was "
						+ "written."
					)
					% [
						GdhPropertyPaths.class_called(target),
						property,
						shown(given[property]),
						shown(held),
						undone_by[property],
					]
				)
			var declared: Dictionary = declarations[property]
			return GdhDeclared.not_held(
				GdhPropertyPaths.class_called(target),
				target.get_class(),
				property,
				declared,
				[given[property], shown(given[property])],
				shown(held)
			)
	for property: String in before:
		var now: Variant = target.get(property)
		if not GdhSame.same(now, before[property]):
			_also_changed[property] = [before[property], now]
	if target is Node:
		_names_no_node = GdhDeclared.naming_nothing(target as Node, given)
	return ""


## Notes in [param undone_by] each property of [param given] that writing [param written] on
## [param target] left holding something else.
func _note_undone(
	target: Object, written: String, given: Dictionary, undone_by: Dictionary[String, String]
) -> void:
	for other: String in given:
		if other != written and not GdhSame.same(read_at(target, other), given[other]):
			undone_by[other] = written


## Why [param name] cannot be written on [param control], or "" once it can. A container places and
## sizes its children and the scene keeps none of that for them, so their anchors, offsets, position
## and size are refused with what a child does set. A control in Position mode ignores an anchor
## preset, and the inspector offers anchors only in Anchors mode, so writing one puts it there
## first, as picking a preset in the editor does; alsoChanged then names layout_mode.
func _laid_out(control: Control, name: String) -> String:
	var base: String = name.get_slice(":", 0)
	var anchoring: bool = base == "anchors_preset" or base.begins_with("anchor_")
	var parent: Node = control.get_parent()
	if (
		parent is Container
		and (anchoring or base.begins_with("offset_") or base in PLACED_BY_A_CONTAINER)
	):
		return (
			(
				"%s's parent, %s, is a %s, which places and sizes it, so its %s is the container's "
				+ "to set and the scene keeps none of it. A child of a container is laid out with "
				+ "size_flags_horizontal, size_flags_vertical and custom_minimum_size."
			)
			% [control.name, parent.name, parent.get_class(), base]
		)
	var mode: int = GdhRead.as_int(control.get("layout_mode"))
	if anchoring and mode == LAYOUT_MODE_POSITION:
		control.set("layout_mode", LAYOUT_MODE_ANCHORS)
	# A scene's root reads as Uncontrolled but keeps the Position mode it was made with until it
	# enters a tree, and the engine ignores a preset in that stored mode, so full rect read back as
	# top left on every root a headless edit wrote.
	elif anchoring and mode == LAYOUT_MODE_UNCONTROLLED:
		control.set("layout_mode", LAYOUT_MODE_UNCONTROLLED)
	return ""


## Puts under alsoChanged in [param answer] each property the last [method write_all] changed
## without being given it, as {was, now}, and under outsideDeclared each value it wrote outside what
## its property declares, when there are any. A node is named by its path from [param relative_to],
## as a scene answer names one. Called before the scene is written, since the write frees the nodes
## these values can hold.
func note_write(answer: Dictionary, relative_to: Node = null) -> void:
	if not _outside_declared.is_empty():
		answer["outsideDeclared"] = _outside_declared.duplicate()
	if not _names_no_node.is_empty():
		answer["namesNoNode"] = _names_no_node.duplicate()
	if _also_changed.is_empty():
		return
	var noted: Dictionary = {}
	for property: Variant in _also_changed:
		var pair: Array = _also_changed[property]
		noted[property] = {
			"was": _readable(pair[0], relative_to), "now": _readable(pair[1], relative_to),
		}
	answer["alsoChanged"] = noted


func _readable(value: Variant, relative_to: Node) -> Variant:
	if value is Node and relative_to != null:
		var target: Node = value
		return _values.serialize_value(relative_to.get_path_to(target))
	if value is Array:
		var items: Array = value
		return items.map(func(item: Variant) -> Variant: return _readable(item, relative_to))
	return _values.serialize_value(value)


## What [param target] stores, by name, but its script and the properties in [param leave], in the
## names a read answers with: a Curve's points as point_0/position and the rest rather than the
## _data list every point write changes. A list or a map is copied, since a setter can change the
## one it holds in place.
func _stored(target: Object, leave: Dictionary) -> Dictionary:
	var held: Dictionary = {}
	for entry: Dictionary in GdhShapes.read_properties(target):
		var name: String = str(entry["name"])
		var usage: int = GdhRead.as_int(entry["usage"])
		if usage & HEADINGS != 0 or name == "script" or leave.has(name):
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
		return { "refused": no_property(target, steps[0]) }
	var value: Variant = target.get(steps[0])
	var walked: String = steps[0]
	for index: int in range(1, steps.size()):
		var step: String = steps[index]
		var has: PackedStringArray = GdhSerialisation.components_of(value)
		var sort: String = GdhRead.with_article(type_string(typeof(value)))
		if has.is_empty():
			var refused: String = (
				(
					"%s.%s is %s, which a path does not step into: a path reaches the components "
					+ "of a vector, a colour, a rectangle or a transform."
				)
				% [owner, walked, sort]
			)
			# A resource is reached with a slash, which a caller writing a colon had no way to know.
			if value is Resource:
				refused += (
					" A property of the resource it holds is reached with a slash: %s/%s."
					% [walked, ":".join(steps.slice(index))]
				)
			elif value is Array and index + 1 < steps.size():
				refused += (
					(
						" A property of a resource in it is reached with slashes and the element's "
						+ "index: %s/%s/%s."
					)
					% [walked, step, ":".join(steps.slice(index + 1))]
				)
			return { "refused": refused }
		if not step in has:
			return {
				"refused":
				(
					"%s.%s is %s, so it has no %s; it has %s."
					% [owner, walked, sort, step, ", ".join(has)]
				),
			}
		value = value[step]
		walked += ":" + step
	return { "name": path, "type": typeof(value), "usage": PROPERTY_USAGE_DEFAULT }


## [param raw] as the value [param declared] takes, as [ok, value] or [false, why not].
func value_for(target: Object, declared: Dictionary, raw: Variant) -> Array:
	var property: String = str(declared.get("name", ""))
	var expected_type: int = GdhRead.as_int(declared.get("type", TYPE_NIL), TYPE_NIL)
	var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	if expected_type == TYPE_OBJECT and hint == PROPERTY_HINT_NODE_TYPE:
		return _node_reference(target, property, raw)
	if expected_type == TYPE_INT and hint == PROPERTY_HINT_ENUM and typeof(raw) == TYPE_STRING:
		var by_name: Array = GdhDeclared.enum_by_name(
			target, declared, str(raw), GdhPropertyPaths.class_called(target)
		)
		if by_name[0] or not str(by_name[1]).is_empty():
			return by_name

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
		# Some engine properties declare a bare Array and hold a typed one: NavigationPolygon's
		# outlines hold PackedVector2Arrays, and points written as {"x", "y"} inside them landed as
		# zero vectors, since nothing said what the inner lists hold.
		if elements.is_empty() and expected_type == TYPE_ARRAY:
			var current: Variant = target.get(property)
			if current is Array:
				var typed: Array = current
				if typed.is_typed() and typed.get_typed_builtin() != TYPE_OBJECT:
					elements = [typed.get_typed_builtin()]
		if GdhShapes.fraction(raw, expected_type, elements):
			return [false, _fraction_refusal(target, property, raw)]
		var rounded: String = GdhSerialisation.inexact(raw, expected_type)
		if not rounded.is_empty():
			return [
				false,
				"%s.%s holds int: %s." % [GdhPropertyPaths.class_called(target), property, rounded],
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
			),
		]
	var found: Node = node.get_node_or_null(path)
	if found == null:
		return [
			false,
			"%s names %s, and there is no node at that path from %s." % [property, path, node.name],
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


## [param value] as the typed list of objects that [param declared] holds on [param target], as [ok,
## list or why not]. Measured on 4.7.2, a scene's node whose script exports Array[Item] holds []
## after being given an untyped list of Items, and keeps a list typed as its own is.
func _object_list(target: Object, declared: Dictionary, value: Array) -> Array:
	var property: String = str(declared.get("name", ""))
	var kind: Array = GdhDeclared.object_kind(declared, 0)
	var holding: String = (
		"%s.%s holds %s" % [GdhPropertyPaths.class_called(target), property, kind[0]]
	)
	var items: Array = []
	for index: int in value.size():
		var place: Array = [
			"item %d of the list given" % index, "item %d of %s" % [index, property],
		]
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
				items,
				current.get_typed_builtin(),
				current.get_typed_class_name(),
				current.get_typed_script()
			),
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
	var holding: String = (
		"%s.%s holds %s values" % [GdhPropertyPaths.class_called(target), property, kind[0]]
	)
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
			),
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
func _object_item(
	target: Object, given: Variant, kind: Array, holding: String, place: Array
) -> Array:
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


func _fraction_refusal(target: Object, property: String, raw: Variant) -> String:
	return (
		(
			"%s.%s holds whole numbers, and %s would be cut to fit. Setting it would save a "
			+ "different value than the one asked for."
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
				'%s is {"r": .., "g": .., "b": .., "a": ..} from 0 to 1, a optional, or an html '
				+ 'code such as "#ff8000" or "#ff800080"; %s is neither.'
			)
			% [named, JSON.stringify(raw)]
		),
	]


## The refusal for [param property], which [param target] does not declare, naming the declared
## ones nearest it: "StyleBoxFlat has no property shadow_sizee" left the caller nothing to send.
static func no_property(target: Object, property: String) -> String:
	var said: String = (
		GdhRead.near_property(
			"%s has no property %s" % [GdhPropertyPaths.class_called(target), property],
			target,
			property
		)
		+ "."
	)
	if not target is Node:
		return said
	return said + GdhDeclared.held_by_children(target as Node, property)


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
					"%s is a resource built into %s, and only that file can refer to it. Build a "
					+ 'new one for %s with "_type" set to its class and its properties beside it.'
				)
				% [path, path.get_slice("::", 0), property]
			),
		]
	if not ResourceLoader.exists(path):
		# An image or a sound nobody has imported is a file the engine has no loader for, and "No
		# resource at" sent a caller looking for a file that was there.
		if path.begins_with("res://") and FileAccess.file_exists(path):
			return [
				false,
				(
					(
						"%s is there, but it has never been imported, so the engine has no "
						+ "resource to load from it for %s. project_import reimport with "
						+ "resourcePath %s imports it."
					)
					% [path, property, path]
				),
			]
		if path.begins_with("uid://"):
			return [false, "No resource at %s for %s" % [path, property]]
		return [
			false,
			GdhFileWalk.new().with_nearest_files(
				"No resource at %s for %s" % [path, property], path
			),
		]
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
	if (
		parts.size() != 3
		or parts[0].is_empty()
		or parts[2].is_empty()
		or not THEME_ITEMS.has(parts[1])
	):
		return {}
	var item: Array = THEME_ITEMS[parts[1]]
	var kind: int = item[0]
	var made: Dictionary = { "name": property, "type": kind, "usage": PROPERTY_USAGE_DEFAULT }
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
				+ "alone where it recurs inside itself, and nothing elsewhere can refer to it. "
				+ 'Build a new one with "_type" set to its class and its properties beside it.'
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
		fitted[key] = (
			type_convert(entries[key], value_type) if value_type != TYPE_NIL else entries[key]
		)
	return Dictionary(fitted, key_type, &"", null, value_type, &"", null)


## An array, either positional for a vector the property declares, or a list to parse per item.
func _parse_array(value: Array, expected_type: int, elements: Array) -> Variant:
	if PACKED_ELEMENTS.has(expected_type):
		var element: int = GdhRead.as_int(PACKED_ELEMENTS[expected_type], TYPE_NIL)
		return value.map(func(item: Variant) -> Variant: return parse(item, element))

	# Read by its places, a word was read as 0 and ["a", "b"] written as (0, 0).
	if GdhShapes.NUMBER_FIELDS.has(type_string(expected_type)) and not GdhShapes.all_numbers(value):
		return value
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
					GdhRead.as_float(value[0]),
					GdhRead.as_float(value[1]),
					GdhRead.as_float(value[2])
				)
		TYPE_VECTOR3I:
			if value.size() == 3:
				return Vector3i(
					GdhRead.as_int(value[0]), GdhRead.as_int(value[1]), GdhRead.as_int(value[2])
				)
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
	if not items.all(
		func(item: Variant) -> bool: return GdhSerialisation.acceptable(item, element_type)
	):
		return items
	# Converted, a list of points holding a word became a packed list of zeroes before anything read
	# it.
	var inner: int = GdhRead.as_int(PACKED_ELEMENTS.get(element_type, TYPE_NIL), TYPE_NIL)
	if inner != TYPE_NIL:
		for item: Variant in items:
			var points: Array = item if item is Array else []
			if not points.all(
				func(point: Variant) -> bool: return GdhSerialisation.acceptable(point, inner)
			):
				return items
	var fitted: Array = items.map(
		func(item: Variant) -> Variant: return type_convert(item, element_type)
	)
	return Array(fitted, element_type, &"", null)
