extends RefCounted

const GdscriptAuthoring = preload("gdscript_authoring.gd")
const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# What each of the names asked about already is to the engine, and which class in the native
# chain from the base asked about declares it. A file cannot answer either: the native classes, the
# built-in types and the singletons are compiled into the engine, and a rename onto one of them is
# a script that no longer compiles, or one that quietly overrides an engine method.
func names_taken(params: Dictionary) -> Dictionary:
	var names: Array = params.get("names", [])
	var base: String = str(params.get("base", ""))
	var built_in_types: Array[String] = []
	for type: int in range(TYPE_MAX):
		built_in_types.append(type_string(type))
	var singletons: PackedStringArray = Engine.get_singleton_list()
	var taken: Dictionary = {}
	for value: Variant in names:
		var name: String = str(value)
		var as_what: Array[String] = []
		if ClassDB.class_exists(name):
			as_what.append("a native class")
		if name in built_in_types:
			as_what.append("a built-in type")
		if singletons.has(name):
			as_what.append("an engine singleton")
		var entry: Dictionary = {"as": as_what, "declaredBy": null}
		var declared_by: String = _declared_in_chain(base, name)
		if not declared_by.is_empty():
			entry["declaredBy"] = declared_by
		taken[name] = entry
	return {"taken": taken}


# The native class from [param base] upwards that declares [param name] as a method, property,
# signal, constant or enum, or empty when none does. Methods are read off the method list rather
# than asked with class_has_method, which answers false for a virtual such as Node._ready: those
# are the names a script most often overrides and the engine calls by name.
func _declared_in_chain(base: String, name: String) -> String:
	var current: String = base
	while not current.is_empty() and ClassDB.class_exists(current):
		if (
			_named(ClassDB.class_get_method_list(current, true), name)
			or ClassDB.class_has_enum(current, name, true)
			or _named(ClassDB.class_get_property_list(current, true), name)
			or _named(ClassDB.class_get_signal_list(current, true), name)
			or ClassDB.class_get_integer_constant_list(current, true).has(name)
		):
			return current
		current = str(ClassDB.get_parent_class(current))
	return ""


static func _named(entries: Array[Dictionary], name: String) -> bool:
	for entry: Dictionary in entries:
		if str(entry.get("name", "")) == name:
			return true
	return false


# Whether each script compiles in a fresh engine, which reads the class cache as it starts and so
# resolves every class the cache lists. The engine's reasons go to stderr and come back with the
# answer.
func check_scripts(params: Dictionary) -> Dictionary:
	var paths: Array = params.get("paths", [])
	var failed: Array[String] = []
	for value: Variant in paths:
		var path: String = str(value)
		var script: Script = ResourceLoader.load(path, "Script", ResourceLoader.CACHE_MODE_IGNORE)
		if not GdscriptAuthoring._parses(script):
			_log.error("Does not compile: " + path)
			failed.append(path)
	return {"checked": paths.size(), "failed": failed}
