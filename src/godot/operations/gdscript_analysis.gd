extends RefCounted

const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# Analyze a GDScript file and return its structure
func get_gdscript_info(params) -> Dictionary:
	var script_path = params.script_path

	_log.info("Analyzing GDScript: " + script_path)

	# Ensure script path has res:// prefix
	var full_script_path = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	# Check if file exists
	if not FileAccess.file_exists(full_script_path):
		return _log.failure("Script file does not exist: " + full_script_path)

	# Read script content
	var file = FileAccess.open(full_script_path, FileAccess.READ)
	if not file:
		return _log.failure("Failed to open script file: " + full_script_path)

	var content = file.get_as_text()
	file.close()

	var lines = content.split("\n")

	var result = {
		"path": script_path,
		"full_path": full_script_path,
		"class_name": null,
		"extends": "RefCounted",
		"signals": [],
		"variables": [],
		"functions": [],
		"constants": [],
		"enums": [],
		"inner_classes": [],
		"dependencies": [],
		"line_count": lines.size()
	}

	var in_multiline_string = false

	for i in range(lines.size()):
		var line = lines[i]
		var stripped = line.strip_edges()

		# Skip empty lines and comments
		if stripped.is_empty() or stripped.begins_with("#"):
			continue

		# Handle multiline strings
		if '"""' in stripped or "'''" in stripped:
			in_multiline_string = not in_multiline_string
			continue

		if in_multiline_string:
			continue

		# Parse class_name
		if stripped.begins_with("class_name "):
			result["class_name"] = stripped.substr(11).strip_edges()

		# Parse extends
		elif stripped.begins_with("extends "):
			result["extends"] = stripped.substr(8).strip_edges()

		# Parse signals
		elif stripped.begins_with("signal "):
			result["signals"].append(_parse_signal(stripped, i + 1))

		# Parse constants
		elif stripped.begins_with("const "):
			result["constants"].append(_parse_constant(stripped, i + 1))

		# Parse enums
		elif stripped.begins_with("enum "):
			result["enums"].append(_parse_enum(stripped, i + 1))

		# Parse variables
		elif (
			stripped.begins_with("var ")
			or stripped.begins_with("@export")
			or stripped.begins_with("@onready")
		):
			result["variables"].append(_parse_variable(stripped, i + 1))

		# Parse functions
		elif stripped.begins_with("func ") or stripped.begins_with("static func "):
			result["functions"].append(_parse_function(stripped, i + 1))

		# Parse inner classes
		elif stripped.begins_with("class "):
			var cls_name = stripped.substr(6).split(":")[0].split(" ")[0].strip_edges()
			result["inner_classes"].append(cls_name)

		# Parse dependencies (preload, load)
		if "preload(" in stripped or "load(" in stripped:
			for dep in _extract_dependencies(stripped):
				if dep not in result["dependencies"]:
					result["dependencies"].append(dep)

	return result


func _parse_signal(line: String, line_num: int) -> Dictionary:
	var signal_text = line.substr(7).strip_edges()
	var signal_name = ""
	var params = []

	if "(" in signal_text:
		var parts = signal_text.split("(")
		signal_name = parts[0].strip_edges()
		if parts.size() > 1:
			var params_text = parts[1].replace(")", "").strip_edges()
			if not params_text.is_empty():
				var param_parts = params_text.split(",")
				for p in param_parts:
					params.append(_parse_param(p.strip_edges()))
	else:
		signal_name = signal_text

	return {"name": signal_name, "params": params, "line": line_num}


func _parse_constant(line: String, line_num: int) -> Dictionary:
	var const_text = line.substr(6).strip_edges()
	var name = ""
	var value = ""
	var type_hint = ""

	if "=" in const_text:
		var parts = const_text.split("=", true, 1)
		var name_part = parts[0].strip_edges()
		value = parts[1].strip_edges() if parts.size() > 1 else ""

		if ":" in name_part:
			var type_parts = name_part.split(":")
			name = type_parts[0].strip_edges()
			type_hint = type_parts[1].strip_edges()
		else:
			name = name_part
	else:
		name = const_text

	return {"name": name, "value": value, "type": type_hint, "line": line_num}


func _parse_enum(line: String, line_num: int) -> Dictionary:
	var enum_text = line.substr(5).strip_edges()
	var enum_name = ""
	var values = []

	if "{" in enum_text:
		var parts = enum_text.split("{")
		enum_name = parts[0].strip_edges()
		if parts.size() > 1:
			var values_text = parts[1].replace("}", "").strip_edges()
			if not values_text.is_empty():
				var value_parts = values_text.split(",")
				for v in value_parts:
					var val = v.strip_edges()
					if not val.is_empty():
						values.append(val)
	else:
		enum_name = enum_text

	return {"name": enum_name, "values": values, "line": line_num}


func _parse_variable(line: String, line_num: int) -> Dictionary:
	var is_export = line.begins_with("@export")
	var is_onready = "@onready" in line
	var export_hint = ""

	# Extract export hint
	if is_export:
		var export_match = line.find("@export")
		var hint_end = line.find("var ")
		if hint_end > export_match:
			var hint_part = line.substr(export_match + 7, hint_end - export_match - 7).strip_edges()
			if hint_part.begins_with("_"):
				export_hint = hint_part.substr(1).split(" ")[0]

	# Find var declaration
	var var_pos = line.find("var ")
	if var_pos == -1:
		return {"name": "", "line": line_num}

	var var_text = line.substr(var_pos + 4).strip_edges()
	var name = ""
	var type_hint = ""
	var default_value = ""

	if "=" in var_text:
		var parts = var_text.split("=", true, 1)
		var name_part = parts[0].strip_edges()
		default_value = parts[1].strip_edges() if parts.size() > 1 else ""

		if ":" in name_part:
			var type_parts = name_part.split(":")
			name = type_parts[0].strip_edges()
			type_hint = type_parts[1].strip_edges()
		else:
			name = name_part
	elif ":" in var_text:
		var type_parts = var_text.split(":")
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
	var is_static = line.begins_with("static ")
	var func_text = line

	if is_static:
		func_text = line.substr(7).strip_edges()

	func_text = func_text.substr(5).strip_edges()  # Remove "func "

	var name = ""
	var params = []
	var return_type = ""

	if "(" in func_text:
		var paren_start = func_text.find("(")
		name = func_text.substr(0, paren_start).strip_edges()

		var paren_end = func_text.rfind(")")
		if paren_end > paren_start:
			var params_text = func_text.substr(paren_start + 1, paren_end - paren_start - 1)
			if not params_text.is_empty():
				var param_parts = params_text.split(",")
				for p in param_parts:
					params.append(_parse_param(p.strip_edges()))

		# Check for return type
		var after_paren = func_text.substr(paren_end + 1).strip_edges()
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
	var name = ""
	var type_hint = ""
	var default_value = ""

	if "=" in param_text:
		var parts = param_text.split("=", true, 1)
		var name_part = parts[0].strip_edges()
		default_value = parts[1].strip_edges() if parts.size() > 1 else ""

		if ":" in name_part:
			var type_parts = name_part.split(":")
			name = type_parts[0].strip_edges()
			type_hint = type_parts[1].strip_edges()
		else:
			name = name_part
	elif ":" in param_text:
		var type_parts = param_text.split(":")
		name = type_parts[0].strip_edges()
		type_hint = type_parts[1].strip_edges()
	else:
		name = param_text

	return {"name": name, "type": type_hint, "default": default_value}


func _extract_dependencies(line: String) -> Array:
	var deps = []
	var regex = RegEx.new()

	# Match preload("...") and load("...")
	regex.compile("(?:preload|load)\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)")

	for m in regex.search_all(line):
		deps.append(m.get_string(1))

	return deps
