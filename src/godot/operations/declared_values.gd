@tool
extends RefCounted

## What a property declares beyond its type: the values of its enum and the range it is exported
## with, for taking a value by name and for saying when a value written lies outside them.

const GdhRead = preload("reading.gd")

## The section of layer_names in project.godot naming the layers of each layers hint.
const LAYER_NAMES: Dictionary[int, String] = {
	PROPERTY_HINT_LAYERS_2D_PHYSICS: "2d_physics",
	PROPERTY_HINT_LAYERS_2D_RENDER: "2d_render",
	PROPERTY_HINT_LAYERS_2D_NAVIGATION: "2d_navigation",
	PROPERTY_HINT_LAYERS_3D_PHYSICS: "3d_physics",
	PROPERTY_HINT_LAYERS_3D_RENDER: "3d_render",
	PROPERTY_HINT_LAYERS_3D_NAVIGATION: "3d_navigation",
	PROPERTY_HINT_LAYERS_AVOIDANCE: "avoidance",
}
## How many layers a mask holds, one bit each, whatever the editor names.
const MASK_LAYERS: int = 32


## The layers [param mask] holds under a layers [param hint], each with the name project.godot
## gives it where it gives one.
static func layers_in(hint: int, mask: int) -> Array[Dictionary]:
	var layers: Array[Dictionary] = []
	for layer: int in range(1, MASK_LAYERS + 1):
		if mask & (1 << (layer - 1)) == 0:
			continue
		var entry: Dictionary = {"layer": layer}
		var name: String = str(
			ProjectSettings.get_setting("layer_names/%s/layer_%d" % [LAYER_NAMES[hint], layer], "")
		)
		if not name.is_empty():
			entry["name"] = name
		layers.append(entry)
	return layers


## The values an enum hint names, by name, from its hint string: "SWORD:0,SHIELD:1" as a script
## declares one, or "Add,Subtract" as an engine property does, each name then taking the number
## after the one before it.
static func enum_values(hint_string: String) -> Dictionary:
	var values: Dictionary = {}
	var next: int = 0
	for entry: String in hint_string.split(",", false):
		var name: String = entry.get_slice(":", 0).strip_edges()
		var number: String = entry.get_slice(":", 1).strip_edges() if ":" in entry else ""
		var value: int = number.to_int() if number.is_valid_int() else next
		values[name] = value
		next = value + 1
	return values


## The values of the enum [param declared] declares, by name, spelt as the script of [param target]
## spells them when it declares that enum. The engine's hint capitalises each name, "SWORD" as
## "Sword", and a refusal listing those named values the script never spells.
static func enum_of(target: Object, declared: Dictionary) -> Dictionary:
	var hinted: Dictionary = enum_values(str(declared.get("hint_string", "")))
	var attached: Variant = target.get_script()
	if not attached is Script:
		return hinted
	var script: Script = attached
	for constant: Variant in script.get_script_constant_map().values():
		if not constant is Dictionary:
			continue
		var values: Dictionary = constant
		if values.size() != hinted.size():
			continue
		var spelt: Dictionary = {}
		for name: Variant in values:
			if hinted.get(str(name).capitalize()) == values[name]:
				spelt[str(name)] = values[name]
		if spelt.size() == hinted.size():
			return spelt
	return hinted


## The number [param word] names among [param choices], matched as written and then ignoring case,
## or null when it names none.
static func enum_named(choices: Dictionary, word: String) -> Variant:
	var wanted: String = word.strip_edges()
	if choices.has(wanted):
		return choices[wanted]
	for name: String in choices:
		if name.to_lower() == wanted.to_lower():
			return choices[name]
	return null


## The values of the engine enum [param property] of [param target] holds, by the constants its
## class declares them as: blend_mode's Add is BLEND_MODE_ADD in a script, and the hint gives only
## the inspector's word. Empty for an enum a script declares.
##
## The enum is named by the setter's argument, as Node.ProcessMode, since the property list gives
## an engine enum property no class of its own.
static func engine_constants(target: Object, property: String) -> Dictionary:
	var values: Dictionary = {}
	var engine_class: String = target.get_class()
	var setter: String = str(ClassDB.class_get_property_setter(engine_class, property))
	if setter.is_empty():
		return values
	var named: String = ""
	for method: Dictionary in ClassDB.class_get_method_list(engine_class):
		var arguments: Array = method.get("args", [])
		if str(method.get("name", "")) == setter and not arguments.is_empty():
			var value_argument: Dictionary = arguments[-1]
			named = str(value_argument.get("class_name", ""))
			break
	var holder: String = named.get_slice(".", 0)
	if named.count(".") != 1 or not ClassDB.class_exists(holder):
		return values
	for constant: String in ClassDB.class_get_enum_constants(holder, named.get_slice(".", 1)):
		values[constant] = ClassDB.class_get_integer_constant(holder, constant)
	return values


## [param word] as the number of the value the enum property [param declared] of [param target]
## names by it, as [true, number], or [false, why] naming the values, with [param holder] naming the
## target in the refusal. [false, ""] for a word that is a number, which converts as one.
##
## An enum is written by the name of a value as well as its number, since the name is what the script
## and the inspector show and the number is only where the value happens to sit. Tried as the script
## spells it, then as the hint does, then as the engine's constant.
static func enum_by_name(target: Object, declared: Dictionary, word: String, holder: String) -> Array:
	var property: String = str(declared.get("name", ""))
	var choices: Dictionary = enum_of(target, declared)
	var chosen: Variant = enum_named(choices, word)
	if chosen == null:
		chosen = enum_named(enum_values(str(declared.get("hint_string", ""))), word)
	var constants: Dictionary = {}
	if chosen == null:
		constants = engine_constants(target, property)
		chosen = enum_named(constants, word)
	if chosen != null:
		return [true, chosen]
	if word.strip_edges().is_valid_int():
		return [false, ""]
	return [false, enum_refusal(holder, property, word, choices, constants)]


static func enum_refusal(
	holder: String, property: String, word: String, choices: Dictionary, constants: Dictionary = {}
) -> String:
	var ways: String = "by name or by number"
	if not constants.is_empty():
		ways = "by name, by number or by the engine's constant, such as %s" % str(constants.keys()[0])
	var said: String = (
		"%s.%s is an enum, and %s is none of its values: send %s %s"
		% [holder, property, word, _listed(choices), ways]
	)
	var named: PackedStringArray = PackedStringArray(choices.keys())
	named.append_array(PackedStringArray(constants.keys()))
	var close: PackedStringArray = GdhRead.nearest(word, named)
	if close.is_empty():
		return said + "."
	return said + ". The nearest %s %s." % ["is" if close.size() == 1 else "are", ", ".join(close)]


## Why [param value], shown as [param shown], lies outside what [param declared] allows, an export
## range or an enum's values, or "" when it does not. A range marked or_greater or or_less is open
## on that side.
static func outside(target: Object, declared: Dictionary, value: Variant, shown: String) -> String:
	var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	var hint_string: String = str(declared.get("hint_string", ""))
	var property: String = str(declared.get("name", ""))
	if hint == PROPERTY_HINT_ENUM and (typeof(value) == TYPE_STRING or typeof(value) == TYPE_STRING_NAME):
		var names: PackedStringArray = PackedStringArray(enum_values(hint_string).keys())
		if names.is_empty() or names.has(str(value)):
			return ""
		return (
			(
				"%s is none of the names %s lists: %s, which the inspector holds it to; the engine "
				+ "stores it as given."
			)
			% [shown, property, ", ".join(names)]
		)
	if typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT:
		return ""
	var number: float = GdhRead.as_float(value)
	if hint == PROPERTY_HINT_ENUM and typeof(value) == TYPE_INT:
		var choices: Dictionary = enum_of(target, declared)
		if choices.is_empty() or choices.values().has(value):
			return ""
		return "%d is none of the values %s declares: %s." % [value, property, _listed(choices)]
	if hint == PROPERTY_HINT_FLAGS and typeof(value) == TYPE_INT:
		var flags: Dictionary = flags_of(hint_string)
		var known: int = 0
		for bit: int in flags.values():
			known |= bit
		var whole: int = value
		var stray: int = whole & ~known
		if flags.is_empty() or stray == 0:
			return ""
		return (
			"%d holds bits no flag of %s has (%d): its flags are %s; the engine stores it as given."
			% [whole, property, stray, _listed(flags)]
		)
	if hint != PROPERTY_HINT_RANGE:
		return ""
	var parts: PackedStringArray = []
	for part: String in hint_string.split(","):
		var _added: bool = parts.append(part.strip_edges())
	if parts.size() < 2 or not parts[0].is_valid_float() or not parts[1].is_valid_float():
		return ""
	var low: float = parts[0].to_float()
	var high: float = parts[1].to_float()
	if (number <= high or parts.has("or_greater")) and (number >= low or parts.has("or_less")):
		return ""
	return (
		(
			"%s is outside the range %s declares, %s to %s, which the inspector holds it to; the "
			+ "engine stores it as given."
		)
		% [shown, property, _bound(low), _bound(high)]
	)


## The flags a flags hint names, each with its bit: "Fill:1,Expand:2" gives its values, and a name
## with none takes the bit of its place, as @export_flags("A", "B") does.
static func flags_of(hint_string: String) -> Dictionary:
	var flags: Dictionary = {}
	var parts: PackedStringArray = hint_string.split(",", false)
	for index: int in parts.size():
		var part: String = parts[index].strip_edges()
		if ":" in part:
			flags[part.get_slice(":", 0)] = part.get_slice(":", 1).to_int()
		else:
			flags[part] = 1 << index
	return flags


static func _listed(choices: Dictionary) -> String:
	var listed: PackedStringArray = []
	for name: String in choices:
		var _added: bool = listed.append("%s (%d)" % [name, choices[name]])
	return ", ".join(listed)


## A range's end as the script wrote it: the engine's hint gives @export_range(0, 10) as 0.0 and 10.0.
static func _bound(end: float) -> String:
	return str(int(end)) if end == floorf(end) and absf(end) < 1e15 else str(end)


## Puts back on [param built] what its script set as it was attached and was not among
## [param wanted], to the defaults it declares, outside the editor. Attaching runs the script's _init
## there, which the editor never runs for a script that is not a tool, so a resource_name _init chose
## was saved as if asked for. A property whose default the engine cannot report is left as made.
static func unmade(built: Resource, wanted: Dictionary) -> void:
	var attached: Variant = built.get_script()
	if Engine.is_editor_hint() or not attached is Script:
		return
	var script: Script = attached
	var asked: Dictionary = {}
	for key: Variant in wanted:
		asked[str(key).get_slice(":", 0)] = true
	for entry: Dictionary in built.get_property_list():
		var name: String = str(entry["name"])
		var usage: int = GdhRead.as_int(entry["usage"])
		if usage & PROPERTY_USAGE_STORAGE == 0 or name == "script" or asked.has(name):
			continue
		var declared: Variant = ClassDB.class_get_property_default_value(built.get_class(), name)
		if usage & PROPERTY_USAGE_SCRIPT_VARIABLE:
			declared = script.get_property_default_value(name)
		var held: Variant = built.get(name)
		if declared != null and not (typeof(held) == typeof(declared) and held == declared):
			built.set(name, declared)


## The element types a typed Array or Dictionary property declares: [element] for an array,
## [key, value] for a dictionary, [] when nothing is declared.
##
## Read from the declaration because the value cannot say: a script's exported `Array[int]` sits
## behind a placeholder in the editor, and measured on 4.7.2 that placeholder stores [1.5, 2.0]
## as given, which the game then fails to load into the typed array.
static func elements_of(declared: Dictionary) -> Array:
	var type: int = GdhRead.as_int(declared.get("type", TYPE_NIL), TYPE_NIL)
	var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
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


## The class the objects of a typed list or map hold, and whether they are nodes, as
## [class, nodes], read from entry [param at] of [param declared]'s hint: "24/17:Item" in a type
## string, "Item" in an array or dictionary type.
static func object_kind(declared: Dictionary, at: int) -> Array:
	var entry: String = str(declared.get("hint_string", "")).get_slice(";", at)
	if GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE)) != PROPERTY_HINT_TYPE_STRING:
		return [entry.strip_edges(), false]
	var nodes: bool = entry.get_slice(":", 0).get_slice("/", 1) == str(PROPERTY_HINT_NODE_TYPE)
	return [entry.get_slice(":", 1), nodes]


## The base class and script that type a list or map holding [param wanted], as [class, script],
## or [] when nothing in the project or the engine is called that.
static func object_typing(wanted: String) -> Array:
	if ClassDB.class_exists(wanted):
		return [StringName(wanted), null]
	var script: Script = script_class(wanted)
	return [] if script == null else [script.get_instance_base_type(), script]


## The script declaring the class_name [param name], or null.
static func script_class(name: String) -> Script:
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == name:
			return load(str(entry.get("path", ""))) as Script
	return null


## Whether [param value] is the class [param name] names, an engine class or a script's class_name.
static func is_a(value: Object, name: String) -> bool:
	if value.is_class(name):
		return true
	var script: Script = value.get_script()
	while script != null:
		if str(script.get_global_name()) == name:
			return true
		script = script.get_base_script()
	return false


## Why [param property] of a [param holder], an [param engine_class], declared as [param declared],
## holds [param held], as shown, after it was given [param given], the value and how it is shown. A
## text property with a list of names holds only one of them, and its getter answers its default
## for any other. A player's bus is one, though the engine fills its list only in the inspector, so
## the buses are read from the AudioServer, which holds the project's layout; "the engine changed or
## refused the value" left a caller to guess the bus did not exist.
static func not_held(
	holder: String, engine_class: String, property: String, declared: Dictionary, given: Array, held: String
) -> String:
	var value: Variant = given[0]
	var said: String = "%s.%s was given %s and holds %s after it was set" % [holder, property, given[1], held]
	var type: int = GdhRead.as_int(declared.get("type", TYPE_NIL))
	var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
	if hint in LAYER_NAMES and typeof(value) == TYPE_INT:
		return (
			(
				"%s: it is a mask of the %s layers, one bit each from layer 1 (1) to layer %d (%d), so it "
				+ "takes 0 to %d and the engine keeps only those bits. Nothing was written."
			)
			% [
				said,
				LAYER_NAMES[hint],
				MASK_LAYERS,
				1 << (MASK_LAYERS - 1),
				(1 << MASK_LAYERS) - 1,
			]
		)
	var names: PackedStringArray = []
	if hint == PROPERTY_HINT_ENUM and (type == TYPE_STRING or type == TYPE_STRING_NAME):
		names = PackedStringArray(enum_values(str(declared.get("hint_string", ""))).keys())
	var bus: bool = property == "bus" and engine_class.begins_with("AudioStreamPlayer")
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
		# Not "holds Master after it was set": the getter answers the first bus for any name the
		# layout lacks, and nothing was kept.
		return (
			(
				"%s.bus takes the name of one of the project's audio buses, and %s is none of them, so it "
				+ "would play on %s; %s. project_info include audio_buses lists them, and "
				+ "project_settings add_audio_bus adds one. Nothing was written."
			)
			% [
				holder,
				given[1],
				AudioServer.get_bus_name(0),
				"the buses are " + ", ".join(names) if nearest.is_empty() else "the nearest " + nearest
			]
		)
	return (
		"%s: it takes one of the names it lists, and %s is none of them; %s. Nothing was written."
		% [
			said,
			given[1],
			"it lists " + ", ".join(names) if nearest.is_empty() else "the nearest it lists " + nearest
		]
	)
