extends RefCounted

const GdhRead = preload("reading.gd")
const GdhLog = preload("logger.gd")
const GdhSerialisation = preload("serialisation.gd")
# How far below the closest name another may score and still be offered beside it.
const CLOSE_TO_THE_BEST: float = 0.2
# The base classes each category name stands for. Kept to the list the tool's schema offers, which
# a case holds: the schema offered physics3d and ui, which this refused, and physics answered the 3D
# bodies alone beside physics2d and physics3d.
const CATEGORY_BASES: Dictionary = {
	"node": ["Node"],
	"node2d": ["Node2D"],
	"node3d": ["Node3D"],
	"control": ["Control"],
	"ui": ["Control"],
	"resource": ["Resource"],
	"physics": ["PhysicsBody2D", "PhysicsBody3D"],
	"physics2d": ["PhysicsBody2D"],
	"physics3d": ["PhysicsBody3D"],
	"audio": ["AudioStream"],
	"visual": ["VisualInstance3D"],
	"animation": ["AnimationMixer"],
}
## The engine's MethodFlags, each by the name an answer gives it.
const METHOD_FLAG_NAMES: Dictionary[int, String] = {
	METHOD_FLAG_NORMAL: "normal",
	METHOD_FLAG_EDITOR: "editor",
	METHOD_FLAG_CONST: "const",
	METHOD_FLAG_VIRTUAL: "virtual",
	METHOD_FLAG_VARARG: "vararg",
	METHOD_FLAG_STATIC: "static",
	METHOD_FLAG_OBJECT_CORE: "object_core",
	METHOD_FLAG_VIRTUAL_REQUIRED: "virtual_required",
}

var _log: GdhLog
var _values: GdhSerialisation = GdhSerialisation.new()


func _init(p_log: GdhLog) -> void:
	_log = p_log


static func _under_any(name: String, bases: Array) -> bool:
	for base: Variant in bases:
		var base_name: String = str(base)
		if name == base_name or ClassDB.is_parent_class(name, base_name):
			return true
	return false


# Query available classes from ClassDB with optional filtering
func query_classes(params: Dictionary) -> Dictionary:
	var filter: String = str(params.get("filter", ""))
	var category: String = str(params.get("category", ""))
	var instantiable_only: bool = GdhRead.as_bool(params.get("instantiable_only", false))

	_log.info(
		(
			"Querying ClassDB classes (filter: '"
			+ filter
			+ "', category: '"
			+ category
			+ "', instantiable_only: "
			+ str(instantiable_only)
			+ ")"
		)
	)

	var bases: Array = []
	if not category.is_empty():
		bases = CATEGORY_BASES.get(category.to_lower(), [])
		if bases.is_empty():
			return _log.failure(
				"Unknown category: " + category + ". Valid: " + str(CATEGORY_BASES.keys())
			)

	var all_classes: PackedStringArray = ClassDB.get_class_list()
	all_classes.sort()

	var filtered_classes: Array[String] = []

	for class_name_str: String in all_classes:
		if instantiable_only and not ClassDB.can_instantiate(class_name_str):
			continue

		if not filter.is_empty() and not class_name_str.to_lower().contains(filter.to_lower()):
			continue

		if not bases.is_empty() and not _under_any(class_name_str, bases):
			continue

		filtered_classes.append(class_name_str)

	var declared: Dictionary = _declared_classes(params)
	var own: Array[Dictionary] = []
	for name: String in _sorted_names(declared):
		if instantiable_only and not _instantiable(name, declared):
			continue
		if not filter.is_empty() and not name.to_lower().contains(filter.to_lower()):
			continue
		if not bases.is_empty():
			var engine_base: String = _engine_base_of(name, declared)
			if engine_base.is_empty() or not _under_any(engine_base, bases):
				continue
		own.append(_project_entry(name, declared))

	_log.info(
		(
			"Found "
			+ str(filtered_classes.size())
			+ " classes (out of "
			+ str(all_classes.size())
			+ " total)"
		)
	)

	return {
		"total_classes": all_classes.size(),
		"filtered_count": filtered_classes.size(),
		"filter": filter,
		"category": category,
		"instantiable_only": instantiable_only,
		"classes": filtered_classes,
		"project_classes": own,
	}


# Query detailed info about a specific class from ClassDB
func query_class_info(params: Dictionary) -> Dictionary:
	var class_name_str: String = str(params.get("class_name", ""))
	var include_inherited: bool = GdhRead.as_bool(params.get("include_inherited", false))

	_log.info(
		(
			"Querying class info for: "
			+ class_name_str
			+ " (include_inherited: "
			+ str(include_inherited)
			+ ")"
		)
	)

	if not ClassDB.class_exists(class_name_str):
		return _not_found(class_name_str, _declared_classes(params))

	var member: String = str(params.get("member", ""))
	if not member.is_empty():
		return _member_of(class_name_str, member)

	var methods: Array[Dictionary] = _methods_of(class_name_str)
	var properties: Array[Dictionary] = _properties_of(class_name_str)
	var signals: Array[Dictionary] = _signals_of(class_name_str)

	var enums: Dictionary = {}
	for e: String in ClassDB.class_get_enum_list(class_name_str, true):
		var enum_values: Dictionary = {}
		for c: String in ClassDB.class_get_enum_constants(class_name_str, e, true):
			enum_values[c] = ClassDB.class_get_integer_constant(class_name_str, c)
		enums[e] = enum_values

	_log.info(
		(
			"Class info retrieved: "
			+ str(methods.size())
			+ " methods, "
			+ str(properties.size())
			+ " properties, "
			+ str(signals.size())
			+ " signals"
		)
	)

	var answer: Dictionary = {
		"class_name": class_name_str,
		"parent_class": ClassDB.get_parent_class(class_name_str),
		"can_instantiate": ClassDB.can_instantiate(class_name_str),
		"include_inherited": include_inherited,
		"methods_count": methods.size(),
		"methods": methods,
		"properties_count": properties.size(),
		"properties": properties,
		"signals_count": signals.size(),
		"signals": signals,
		"enums": enums,
	}
	if include_inherited:
		answer["inherited"] = _inherited_names(class_name_str)
	return answer


# What [param class_name_str] inherits, by name under the ancestor declaring it, nearest first. In
# full, CharacterBody2D's inherited members ran to two hundred thousand characters, more than a
# client takes in one answer, and any one of them is read in full by asking for it as member.
func _inherited_names(class_name_str: String) -> Array[Dictionary]:
	var inherited: Array[Dictionary] = []
	var current: String = ClassDB.get_parent_class(class_name_str)
	while not current.is_empty():
		(
			inherited
			. append(
				{
					"class": current,
					"methods": _names(_methods_of(current)),
					"properties": _names(_properties_of(current)),
					"signals": _names(_signals_of(current)),
					"enums": Array(ClassDB.class_get_enum_list(current, true)),
				}
			)
		)
		current = ClassDB.get_parent_class(current)
	return inherited


static func _names(members: Array[Dictionary]) -> Array[String]:
	var names: Array[String] = []
	for each: Dictionary in members:
		names.append(str(each["name"]))
	return names


## What the project's scripts declare on disk, class to its path, what it extends and whether it is
## abstract, as the server read them.
static func _declared_classes(params: Dictionary) -> Dictionary:
	var given: Variant = params.get("project_classes", {})
	if given is Dictionary:
		var declared: Dictionary = given
		return declared
	return {}


static func _entry_of(name: String, declared: Dictionary) -> Dictionary:
	var entry: Variant = declared.get(name, {})
	if entry is Dictionary:
		var fields: Dictionary = entry
		return fields
	return {}


static func _sorted_names(declared: Dictionary) -> Array[String]:
	var names: Array[String] = []
	for name: Variant in declared.keys():
		names.append(str(name))
	names.sort()
	return names


## [param name]'s ancestors, nearest first: the project classes it extends, then the engine's. A
## base that is neither ends the line, as it is written.
static func _ancestors_of(name: String, declared: Dictionary) -> Array[String]:
	var ancestors: Array[String] = []
	var current: String = name
	while declared.has(current):
		var base: String = str(_entry_of(current, declared).get("extends", ""))
		if base.is_empty() or base == name or ancestors.has(base):
			return ancestors
		ancestors.append(base)
		current = base
	while ClassDB.class_exists(current):
		var parent: String = ClassDB.get_parent_class(current)
		if parent.is_empty():
			break
		ancestors.append(parent)
		current = parent
	return ancestors


## The engine class [param name] is built on, or empty when its line reaches none.
static func _engine_base_of(name: String, declared: Dictionary) -> String:
	if not declared.has(name):
		return name if ClassDB.class_exists(name) else ""
	for each: String in _ancestors_of(name, declared):
		if ClassDB.class_exists(each):
			return each
	return ""


static func _instantiable(name: String, declared: Dictionary) -> bool:
	if GdhRead.as_bool(_entry_of(name, declared).get("abstract", false)):
		return false
	var engine_base: String = _engine_base_of(name, declared)
	return not engine_base.is_empty() and ClassDB.can_instantiate(engine_base)


static func _project_entry(name: String, declared: Dictionary) -> Dictionary:
	var entry: Dictionary = _entry_of(name, declared)
	return {
		"name": name,
		"path": str(entry.get("path", "")),
		"extends": str(entry.get("extends", "")),
		"abstract": GdhRead.as_bool(entry.get("abstract", false)),
	}


## Why [param wanted] has no answer here. A class_name a project script declares is not in ClassDB,
## and "Class not found" for one read as though the project had no such class. [param declared] is
## what the project's scripts declare on disk, class to path, rather than the engine's list, which
## is the class cache: that lags the scripts, and a class written a moment ago was refused as
## declared nowhere.
func _not_found(wanted: String, declared: Dictionary, answers_own: bool = false) -> Dictionary:
	if declared.has(wanted):
		return (
			_log
			. failure(
				(
					(
						"%s is not an engine class: it is the class_name %s declares, and "
						+ "editor_classes reads the engine's ClassDB only. script_info structure "
						+ "on that script, with includeInherited, answers what it declares and "
						+ "what it inherits."
					)
					% [wanted, str(_entry_of(wanted, declared).get("path", ""))]
				)
			)
		)
	# The usual miss is a spelling, one letter off a class the engine has or one the project
	# declares. Ranked as one pool and kept near the best, since a project class a letter off came
	# behind three engine classes that shared only "Texture" with it.
	var pool: PackedStringArray = ClassDB.get_class_list()
	pool.append_array(PackedStringArray(declared.keys()))
	var close: PackedStringArray = GdhRead.nearest(wanted, pool)
	var best: float = 0.0 if close.is_empty() else close[0].to_lower().similarity(wanted.to_lower())
	var engine: Array[String] = []
	var own: Array[String] = []
	for name: String in close:
		if name.to_lower().similarity(wanted.to_lower()) < best - CLOSE_TO_THE_BEST:
			continue
		# Similarity counts shared letter pairs, so a word the two names share passes it:
		# NoSuchClass was offered ClassDB. A spelling is a few letters off, a swap of two among
		# them.
		if _edits(name.to_lower(), wanted.to_lower()) > maxi(2, floori(wanted.length() / 3.0)):
			continue
		if declared.has(name):
			own.append(name)
		else:
			engine.append(name)
	var offered: String = (
		""
		if engine.is_empty()
		else (
			" The nearest engine %s %s."
			% ["class is" if engine.size() == 1 else "classes are", ", ".join(engine)]
		)
	)
	if not own.is_empty():
		offered += (
			" The nearest %s a project script declares %s %s%s."
			% [
				"class" if own.size() == 1 else "classes",
				"is" if own.size() == 1 else "are",
				", ".join(own),
				"" if answers_own else ", which script_info structure reads",
			]
		)
	if answers_own:
		return _log.failure(
			(
				"Class not found: %s.%s Neither the engine nor a project script declares it."
				% [wanted, offered]
			)
		)
	return (
		_log
		. failure(
			(
				(
					"Class not found: %s.%s editor_classes reads the engine's ClassDB, so a "
					+ "class_name a project script declares is not in it either; script_info "
					+ "structure reads one."
				)
				% [wanted, offered]
			)
		)
	)


## How many letters must be put in, taken out or changed to make [param from] into [param to].
static func _edits(from: String, to: String) -> int:
	var above: PackedInt32Array = PackedInt32Array(range(to.length() + 1))
	for row: int in range(1, from.length() + 1):
		var here: PackedInt32Array = PackedInt32Array([row])
		for column: int in range(1, to.length() + 1):
			var changed: int = above[column - 1] + (0 if from[row - 1] == to[column - 1] else 1)
			var _added: bool = here.append(
				mini(changed, mini(above[column] + 1, here[column - 1] + 1))
			)
		above = here
	return above[to.length()]


# One member of a class by name, wherever in its ancestry it is declared.
#
# The question a member is asked by name for is "does this engine have it, and what does it take":
# the whole class in answer to that ran to seventy thousand characters for Control, and the member
# is as often an ancestor's as the class's own, so the ancestry is walked without being asked. Each
# match says which class declares it. Nothing found names the members whose names contain the one
# asked for, since the usual miss is a spelling.
func _member_of(class_name_str: String, member: String) -> Dictionary:
	var found: Array[Dictionary] = []
	var current: String = class_name_str
	while not current.is_empty():
		for m: Dictionary in _methods_of(current):
			if m["name"] == member:
				found.append({ "kind": "method", "declared_in": current, "member": m })
		for p: Dictionary in _properties_of(current):
			if p["name"] == member:
				found.append({ "kind": "property", "declared_in": current, "member": p })
		for s: Dictionary in _signals_of(current):
			if s["name"] == member:
				found.append({ "kind": "signal", "declared_in": current, "member": s })
		for e: String in ClassDB.class_get_enum_list(current, true):
			if e == member:
				var values: Dictionary = {}
				for c: String in ClassDB.class_get_enum_constants(current, e, true):
					values[c] = ClassDB.class_get_integer_constant(current, c)
				found.append(
					{
						"kind": "enum",
						"declared_in": current,
						"member": { "name": e, "values": values },
					}
				)
		for c: String in ClassDB.class_get_integer_constant_list(current, true):
			if c == member:
				var value: int = ClassDB.class_get_integer_constant(current, c)
				found.append(
					{
						"kind": "constant",
						"declared_in": current,
						"member": { "name": c, "value": value },
					}
				)
		current = ClassDB.get_parent_class(current)

	if found.is_empty():
		var alike: Array[String] = _members_alike(class_name_str, member)
		var hint: String = (
			""
			if alike.is_empty()
			else " Members with names containing it: " + ", ".join(alike) + "."
		)
		return _log.failure(
			"%s and its ancestors declare no member named %s.%s" % [class_name_str, member, hint]
		)

	return { "class_name": class_name_str, "member": member, "found": found }


# The names, across a class and its ancestors, that contain the asked-for one, case-insensitively.
func _members_alike(class_name_str: String, member: String) -> Array[String]:
	var alike: Array[String] = []
	var wanted: String = member.to_lower()
	var current: String = class_name_str
	while not current.is_empty():
		for m: Dictionary in _methods_of(current):
			var name: String = m["name"]
			if name.to_lower().contains(wanted) and not alike.has(name):
				alike.append(name)
		for p: Dictionary in _properties_of(current):
			var name: String = p["name"]
			if name.to_lower().contains(wanted) and not alike.has(name):
				alike.append(name)
		for s: Dictionary in _signals_of(current):
			var name: String = s["name"]
			if name.to_lower().contains(wanted) and not alike.has(name):
				alike.append(name)
		current = ClassDB.get_parent_class(current)
	alike.sort()
	return alike


# Inspect class inheritance hierarchy
func inspect_inheritance(params: Dictionary) -> Dictionary:
	var class_name_str: String = str(params.get("class_name", ""))

	_log.info("Inspecting inheritance for: " + class_name_str)

	var declared: Dictionary = _declared_classes(params)
	var own_class: bool = declared.has(class_name_str)
	if not own_class and not ClassDB.class_exists(class_name_str):
		return _not_found(class_name_str, declared, true)

	# A class a project script declares can stand only under another or under an engine class, so
	# both answers carry the project's own beneath the class asked about.
	var project_children: Array[Dictionary] = []
	var project_descendants: Array[Dictionary] = []
	for name: String in _sorted_names(declared):
		var line: Array[String] = _ancestors_of(name, declared)
		if name == class_name_str or not line.has(class_name_str):
			continue
		project_descendants.append(_project_entry(name, declared))
		if line[0] == class_name_str:
			project_children.append(_project_entry(name, declared))
	if own_class:
		var own_line: Array[String] = _ancestors_of(class_name_str, declared)
		return {
			"class_name": class_name_str,
			"declared_in": str(_entry_of(class_name_str, declared).get("path", "")),
			"parent_class": "" if own_line.is_empty() else own_line[0],
			"ancestors": own_line,
			"abstract": GdhRead.as_bool(_entry_of(class_name_str, declared).get("abstract", false)),
			"can_instantiate": _instantiable(class_name_str, declared),
			"project_children": project_children,
			"project_descendants": project_descendants,
		}

	var ancestors: Array[String] = []
	var current: String = class_name_str
	while not current.is_empty():
		var parent: String = ClassDB.get_parent_class(current)
		if parent.is_empty():
			break
		ancestors.append(parent)
		current = parent

	var all_classes: PackedStringArray = ClassDB.get_class_list()

	var direct_children: Array[String] = []
	for c: String in all_classes:
		if ClassDB.get_parent_class(c) == class_name_str:
			direct_children.append(c)
	direct_children.sort()

	var all_descendants: Array[String] = []
	for c: String in all_classes:
		if c != class_name_str and ClassDB.is_parent_class(c, class_name_str):
			all_descendants.append(c)
	all_descendants.sort()

	_log.info(
		(
			"Inheritance: "
			+ str(ancestors.size())
			+ " ancestors, "
			+ str(direct_children.size())
			+ " direct children, "
			+ str(all_descendants.size())
			+ " total descendants"
		)
	)

	return {
		"class_name": class_name_str,
		"parent_class": ClassDB.get_parent_class(class_name_str),
		"ancestors": ancestors,
		"direct_children_count": direct_children.size(),
		"direct_children": direct_children,
		"all_descendants_count": all_descendants.size(),
		"all_descendants": all_descendants,
		"can_instantiate": ClassDB.can_instantiate(class_name_str),
		"project_children": project_children,
		"project_descendants": project_descendants,
	}


func _methods_of(class_name_str: String) -> Array[Dictionary]:
	var methods: Array[Dictionary] = []

	for m: Dictionary in ClassDB.class_get_method_list(class_name_str, true):
		var args: Array[Dictionary] = []
		var declared_args: Array = m.get("args", [])
		for a: Dictionary in declared_args:
			args.append(
				{
					"name": a.get("name", ""),
					"type": a.get("type", 0),
					"type_name": _type_name(a, "Variant"),
					"class_name": a.get("class_name", ""),
					"hint_string": a.get("hint_string", ""),
				}
			)
		var return_info: Dictionary = m.get("return", {})
		(
			methods
			. append(
				{
					"name": m.get("name", ""),
					"args": args,
					"return":
					{
						"type": return_info.get("type", 0),
						"type_name": _type_name(return_info, "void"),
						"class_name": return_info.get("class_name", ""),
					},
					"flags": m.get("flags", 0),
					"flag_names": _flag_names(GdhRead.as_int(m.get("flags", 0))),
					# As values, tagged the way every other answer tags one: JSON writes a Vector2i
					# it is handed as its text, so TileMapLayer.set_cell's default atlas coords read
					# "(-1, -1)".
					"default_args": _values.serialize_value(m.get("default_args", [])),
				}
			)
		)

	return methods


# The MethodFlags set in [param flags] by name, beside the number the engine reports, which reads as
# nothing without its enum: 1 is normal, and a const method is 5.
static func _flag_names(flags: int) -> Array[String]:
	var named: Array[String] = []
	for flag: int in METHOD_FLAG_NAMES:
		if flags & flag:
			named.append(METHOD_FLAG_NAMES[flag])
	return named


# What [param info]'s type is called: its class for an object of one, and otherwise the engine's own
# name for the type, beside the number the engine reports, which reads as nothing without its enum.
# Nil is a value that can be anything when the usage says so, and [param nil_name] otherwise: void
# for what a method returns, and Variant for an argument or property with no type.
static func _type_name(info: Dictionary, nil_name: String) -> String:
	var type: int = GdhRead.as_int(info.get("type", 0))
	var named: String = str(info.get("class_name", ""))
	if type == TYPE_OBJECT and not named.is_empty():
		return named
	if type == TYPE_NIL:
		return (
			"Variant"
			if GdhRead.as_int(info.get("usage", 0)) & PROPERTY_USAGE_NIL_IS_VARIANT
			else nil_name
		)
	return type_string(type)


func _properties_of(class_name_str: String) -> Array[Dictionary]:
	var properties: Array[Dictionary] = []

	for p: Dictionary in ClassDB.class_get_property_list(class_name_str, true):
		# A category, group or subgroup is an editor heading rather than a property.
		var usage: int = GdhRead.as_int(p.get("usage", 0))
		if (
			usage & PROPERTY_USAGE_CATEGORY
			or usage & PROPERTY_USAGE_GROUP
			or usage & PROPERTY_USAGE_SUBGROUP
		):
			continue
		properties.append(
			{
				"name": p.get("name", ""),
				"type": p.get("type", 0),
				"type_name": _type_name(p, "Variant"),
				"class_name": p.get("class_name", ""),
				"hint": p.get("hint", 0),
				"hint_string": p.get("hint_string", ""),
				"usage": usage,
			}
		)

	return properties


func _signals_of(class_name_str: String) -> Array[Dictionary]:
	var signals: Array[Dictionary] = []

	for s: Dictionary in ClassDB.class_get_signal_list(class_name_str, true):
		var sig_args: Array[Dictionary] = []
		var declared_args: Array = s.get("args", [])
		for a: Dictionary in declared_args:
			sig_args.append(
				{
					"name": a.get("name", ""),
					"type": a.get("type", 0),
					"type_name": _type_name(a, "Variant"),
					"class_name": a.get("class_name", ""),
				}
			)
		signals.append({ "name": s.get("name", ""), "args": sig_args })

	return signals
