extends RefCounted

const Patterns = preload("patterns.gd")
const Read = preload("reading.gd")
const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# Analyze a GDScript file and return its structure
func get_gdscript_info(params: Dictionary) -> Dictionary:
	var script_path: String = str(params.get("script_path", ""))

	_log.info("Analyzing GDScript: " + script_path)

	var full_script_path: String = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	if not FileAccess.file_exists(full_script_path):
		return _log.failure("Script file does not exist: " + full_script_path)

	var file: FileAccess = FileAccess.open(full_script_path, FileAccess.READ)
	if not file:
		return _log.failure("Failed to open script file: " + full_script_path)

	var content: String = file.get_as_text()
	file.close()

	var lines: PackedStringArray = content.split("\n")

	var declared_class_name: Variant = null
	var extends_name: String = "RefCounted"
	var signals: Array[Dictionary] = []
	var variables: Array[Dictionary] = []
	var functions: Array[Dictionary] = []
	var constants: Array[Dictionary] = []
	var enums: Array[Dictionary] = []
	var inner_classes: Array[String] = []
	var dependencies: Array[String] = []

	var in_multiline_string: bool = false

	for i: int in range(lines.size()):
		var stripped: String = lines[i].strip_edges()

		if stripped.is_empty() or stripped.begins_with("#"):
			continue

		if '"""' in stripped or "'''" in stripped:
			in_multiline_string = not in_multiline_string
			continue

		if in_multiline_string:
			continue

		# Annotations may share the line with anything they annotate, so every branch below decides
		# on the line with them off. `@abstract class_name X` was reported as no declared class,
		# and `@abstract func x()` and `@warning_ignore("...") func x()` as no function at all:
		# gdUnit4 alone declares 248 methods that way and this answered with none of them.
		var header: String = Patterns.without_annotations(stripped)
		var declaration: RegExMatch = Patterns.declared_class(header)
		if declaration != null:
			declared_class_name = declaration.get_string(1)
			# `class_name X extends Y` is also one line, and taking the rest of it as the name
			# reported `Blade extends Node2D` as the class while `extends` kept its default of
			# `RefCounted`: the name unusable and the base flatly wrong.
			if not declaration.get_string(2).is_empty():
				extends_name = declaration.get_string(2)
		elif header.begins_with("extends "):
			extends_name = header.substr(8).strip_edges()
		elif header.begins_with("signal "):
			signals.append(_parse_signal(header, i + 1))
		elif header.begins_with("const "):
			constants.append(_parse_constant(header, i + 1))
		elif header.begins_with("enum "):
			enums.append(_parse_enum(header, i + 1))
		elif header.begins_with("var "):
			# The whole line here, not the header: which annotations a variable carries is the
			# answer rather than noise in front of it, and `@export_range(0, 1)` is the hint.
			variables.append(_parse_variable(stripped, i + 1))
		elif header.begins_with("func ") or header.begins_with("static func "):
			functions.append(_parse_function(header, i + 1, stripped))
		elif header.begins_with("class "):
			inner_classes.append(header.substr(6).split(":")[0].split(" ")[0].strip_edges())

		if "preload(" in stripped or "load(" in stripped:
			for dep: String in _extract_dependencies(stripped):
				if dep not in dependencies:
					dependencies.append(dep)

	var answer: Dictionary = {
		"path": script_path,
		"full_path": full_script_path,
		"class_name": declared_class_name,
		"extends": extends_name,
		"signals": signals,
		"variables": variables,
		"functions": functions,
		"constants": constants,
		"enums": enums,
		"inner_classes": inner_classes,
		"dependencies": dependencies,
		"line_count": lines.size()
	}
	if Read.as_bool(params.get("include_inherited", false)):
		_add_inherited(answer, [full_script_path])
	return answer


# The members this script's ancestors declare, appended to the lists they belong in.
#
# Only the script ancestors: `extends` naming a native class is ClassDB's question and
# `editor_classes info` answers it with the whole hierarchy. A base is reachable either as a quoted
# `res://` path or as a `class_name` in the project's class list, and a script whose base is neither
# has no ancestor to read, which the answer says by leaving `inherits_from` short rather than by
# refusing. Each entry carries `inherited_from`, so a caller can tell a member the script declares
# from one it is given; a name a script overrides appears twice, at both lines, on purpose.
func _add_inherited(answer: Dictionary, seen: Array[String]) -> void:
	var inherits_from: Array[String] = []
	var base: String = str(answer.get("extends", ""))
	while true:
		var base_path: String = _script_named(base)
		if base_path.is_empty() or base_path in seen:
			break
		seen.append(base_path)
		var above: Dictionary = get_gdscript_info({"script_path": base_path})
		# A read that failed answers with an empty dictionary rather than with a flag, so that is
		# what is asked. `_script_named` has already checked the file is there, which leaves only
		# an open that fails, and the chain stops without recording a file nothing was read from.
		if above.is_empty():
			break
		inherits_from.append(base_path)
		for list_name: String in ["signals", "variables", "functions", "constants", "enums"]:
			var mine: Array[Dictionary] = answer[list_name]
			var theirs: Array[Dictionary] = above[list_name]
			for member: Dictionary in theirs:
				var carried: Dictionary = member.duplicate()
				carried["inherited_from"] = base_path
				mine.append(carried)
		base = str(above.get("extends", ""))
	answer["inherits_from"] = inherits_from


# The file a base names, whether it named a path or a class, or empty for a native class.
func _script_named(base: String) -> String:
	if base.is_empty():
		return ""
	if base.begins_with('"') and base.ends_with('"'):
		var quoted: String = base.substr(1, base.length() - 2)
		return quoted if FileAccess.file_exists(quoted) else ""
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == base:
			var path: String = str(entry.get("path", ""))
			return path if FileAccess.file_exists(path) else ""
	return ""


func _parse_signal(line: String, line_num: int) -> Dictionary:
	var signal_text: String = line.substr(7).strip_edges()
	var signal_name: String = ""
	var params: Array[Dictionary] = []

	if "(" in signal_text:
		var parts: PackedStringArray = signal_text.split("(")
		signal_name = parts[0].strip_edges()
		if parts.size() > 1:
			var params_text: String = parts[1].replace(")", "").strip_edges()
			if not params_text.is_empty():
				for p: String in params_text.split(","):
					params.append(_parse_param(p.strip_edges()))
	else:
		signal_name = signal_text

	return {"name": signal_name, "params": params, "line": line_num}


func _parse_constant(line: String, line_num: int) -> Dictionary:
	var const_text: String = line.substr(6).strip_edges()
	var name: String = ""
	var value: String = ""
	var type_hint: String = ""

	if "=" in const_text:
		var parts: PackedStringArray = const_text.split("=", true, 1)
		var name_part: String = parts[0].strip_edges()
		value = parts[1].strip_edges() if parts.size() > 1 else ""

		if ":" in name_part:
			var type_parts: PackedStringArray = name_part.split(":")
			name = type_parts[0].strip_edges()
			type_hint = type_parts[1].strip_edges()
		else:
			name = name_part
	else:
		name = const_text

	return {"name": name, "value": value, "type": type_hint, "line": line_num}


func _parse_enum(line: String, line_num: int) -> Dictionary:
	var enum_text: String = line.substr(5).strip_edges()
	var enum_name: String = ""
	var values: Array[String] = []

	if "{" in enum_text:
		var parts: PackedStringArray = enum_text.split("{")
		enum_name = parts[0].strip_edges()
		if parts.size() > 1:
			var values_text: String = parts[1].replace("}", "").strip_edges()
			if not values_text.is_empty():
				for v: String in values_text.split(","):
					var val: String = v.strip_edges()
					if not val.is_empty():
						values.append(val)
	else:
		enum_name = enum_text

	return {"name": enum_name, "values": values, "line": line_num}


func _parse_variable(line: String, line_num: int) -> Dictionary:
	var is_export: bool = false
	var is_onready: bool = false
	var export_hint: String = ""

	# From the annotations themselves rather than from where they sit. `@onready @export var x` put
	# the export second and so read as not exported, and a hint with a space in it was cut at it.
	for one: String in Patterns.annotations_on(line):
		if one.begins_with("export"):
			is_export = true
			var after: String = one.substr(6)
			if after.begins_with("_"):
				export_hint = after.substr(1)
		elif one == "onready":
			is_onready = true

	var var_pos: int = line.find("var ")
	if var_pos == -1:
		return {"name": "", "line": line_num}

	var var_text: String = line.substr(var_pos + 4).strip_edges()
	var name: String = ""
	var type_hint: String = ""
	var default_value: String = ""

	if "=" in var_text:
		var parts: PackedStringArray = var_text.split("=", true, 1)
		var name_part: String = parts[0].strip_edges()
		default_value = parts[1].strip_edges() if parts.size() > 1 else ""

		if ":" in name_part:
			var type_parts: PackedStringArray = name_part.split(":")
			name = type_parts[0].strip_edges()
			type_hint = type_parts[1].strip_edges()
		else:
			name = name_part
	elif ":" in var_text:
		var type_parts: PackedStringArray = var_text.split(":")
		name = type_parts[0].strip_edges()
		type_hint = type_parts[1].strip_edges()
	else:
		name = var_text.split(" ")[0].strip_edges()

	return {
		"name": name,
		"type": type_hint,
		"default_value": default_value,
		"is_export": is_export,
		"export_hint": export_hint,
		"is_onready": is_onready,
		"line": line_num
	}


func _parse_function(line: String, line_num: int, annotated: String = "") -> Dictionary:
	var is_static: bool = line.begins_with("static ")
	var func_text: String = line

	if is_static:
		func_text = line.substr(7).strip_edges()

	func_text = func_text.substr(5).strip_edges()

	var name: String = ""
	var params: Array[Dictionary] = []
	var return_type: String = ""

	if "(" in func_text:
		var paren_start: int = func_text.find("(")
		name = func_text.substr(0, paren_start).strip_edges()

		var paren_end: int = func_text.rfind(")")
		if paren_end > paren_start:
			var params_text: String = func_text.substr(paren_start + 1, paren_end - paren_start - 1)
			if not params_text.is_empty():
				for p: String in params_text.split(","):
					params.append(_parse_param(p.strip_edges()))

		var after_paren: String = func_text.substr(paren_end + 1).strip_edges()
		if after_paren.begins_with("->"):
			return_type = after_paren.substr(2).replace(":", "").strip_edges()

	return {
		"name": name,
		"params": params,
		"return_type": return_type,
		"is_virtual": name.begins_with("_"),
		"is_static": is_static,
		# Said rather than left to be inferred: an abstract method has no body, so a caller that
		# saw only the declaration would otherwise take it for one whose body it failed to read.
		"is_abstract": "abstract" in Patterns.annotations_on(annotated),
		"line": line_num
	}


func _parse_param(param_text: String) -> Dictionary:
	var name: String = ""
	var type_hint: String = ""
	var default_value: String = ""

	if "=" in param_text:
		var parts: PackedStringArray = param_text.split("=", true, 1)
		var name_part: String = parts[0].strip_edges()
		default_value = parts[1].strip_edges() if parts.size() > 1 else ""

		if ":" in name_part:
			var type_parts: PackedStringArray = name_part.split(":")
			name = type_parts[0].strip_edges()
			type_hint = type_parts[1].strip_edges()
		else:
			name = name_part
	elif ":" in param_text:
		var type_parts: PackedStringArray = param_text.split(":")
		name = type_parts[0].strip_edges()
		type_hint = type_parts[1].strip_edges()
	else:
		name = param_text

	return {"name": name, "type": type_hint, "default": default_value}


func _extract_dependencies(line: String) -> Array[String]:
	var deps: Array[String] = []
	var regex: RegEx = Patterns.compiled("(?:preload|load)\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)")

	for m: RegExMatch in regex.search_all(line):
		deps.append(m.get_string(1))

	return deps
