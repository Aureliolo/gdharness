extends RefCounted

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

		if stripped.begins_with("class_name "):
			declared_class_name = stripped.substr(11).strip_edges()
		elif stripped.begins_with("extends "):
			extends_name = stripped.substr(8).strip_edges()
		elif stripped.begins_with("signal "):
			signals.append(_parse_signal(stripped, i + 1))
		elif stripped.begins_with("const "):
			constants.append(_parse_constant(stripped, i + 1))
		elif stripped.begins_with("enum "):
			enums.append(_parse_enum(stripped, i + 1))
		elif (
			stripped.begins_with("var ")
			or stripped.begins_with("@export")
			or stripped.begins_with("@onready")
		):
			variables.append(_parse_variable(stripped, i + 1))
		elif stripped.begins_with("func ") or stripped.begins_with("static func "):
			functions.append(_parse_function(stripped, i + 1))
		elif stripped.begins_with("class "):
			inner_classes.append(stripped.substr(6).split(":")[0].split(" ")[0].strip_edges())

		if "preload(" in stripped or "load(" in stripped:
			for dep: String in _extract_dependencies(stripped):
				if dep not in dependencies:
					dependencies.append(dep)

	return {
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
	var is_export: bool = line.begins_with("@export")
	var is_onready: bool = "@onready" in line
	var export_hint: String = ""

	if is_export:
		var export_match: int = line.find("@export")
		var hint_end: int = line.find("var ")
		if hint_end > export_match:
			var hint_part: String = line.substr(export_match + 7, hint_end - export_match - 7).strip_edges()
			if hint_part.begins_with("_"):
				export_hint = hint_part.substr(1).split(" ")[0]

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


func _parse_function(line: String, line_num: int) -> Dictionary:
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
	var regex: RegEx = RegEx.new()

	regex.compile("(?:preload|load)\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)")

	for m: RegExMatch in regex.search_all(line):
		deps.append(m.get_string(1))

	return deps
