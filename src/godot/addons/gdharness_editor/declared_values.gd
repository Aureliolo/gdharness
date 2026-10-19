@tool
extends RefCounted

## What a property declares beyond its type: the values of its enum and the range it is exported
## with, for taking a value by name and for saying when a value written lies outside them.

const GdhRead = preload("reading.gd")


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
