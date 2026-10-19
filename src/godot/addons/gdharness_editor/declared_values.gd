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


static func enum_refusal(holder: String, property: String, word: String, choices: Dictionary) -> String:
	var said: String = (
		"%s.%s is an enum, and %s is none of its values: send %s by name or by number"
		% [holder, property, word, _listed(choices)]
	)
	var close: PackedStringArray = GdhRead.nearest(word, PackedStringArray(choices.keys()))
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
