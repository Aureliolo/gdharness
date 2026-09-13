extends RefCounted

const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# Create a new GDScript file with proper structure and optional templates
func create_gdscript(params: Dictionary) -> Dictionary:
	var script_path: String = str(params.get("script_path", ""))
	var cls_name_param: String = str(params.get("class_name", ""))
	var extends_class: String = str(params.get("extends_class", "Node"))
	var content: String = str(params.get("content", ""))
	var template: String = str(params.get("template", ""))

	_log.info("Creating GDScript: " + script_path)

	var full_script_path: String = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	if not full_script_path.ends_with(".gd"):
		return _log.failure("Script path must end with .gd extension")

	if FileAccess.file_exists(full_script_path):
		return _log.failure("Script file already exists: " + full_script_path)

	var dir: DirAccess = DirAccess.open("res://")
	var script_dir: String = full_script_path.get_base_dir()
	if script_dir != "res://" and not dir.dir_exists(script_dir.substr(6)):
		_log.debug("Creating directory: " + script_dir)
		var error: Error = dir.make_dir_recursive(script_dir.substr(6))
		if error != OK:
			return _log.failure("Failed to create directory: " + script_dir + ", error: " + str(error))

	var script_content: String = ""

	if not cls_name_param.is_empty():
		script_content += "class_name " + cls_name_param + "\n"

	script_content += "extends " + extends_class + "\n\n"

	if not template.is_empty():
		script_content += _script_template(template)
	elif not content.is_empty():
		script_content += content
	else:
		script_content += "func _ready() -> void:\n"
		script_content += "\tpass\n"

	var file: FileAccess = FileAccess.open(full_script_path, FileAccess.WRITE)
	if not file:
		return _log.failure("Failed to create script file: " + full_script_path)

	file.store_string(script_content)
	file.close()

	return {
		"success": true,
		"script_path": script_path,
		"full_path": full_script_path,
		"absolute_path": ProjectSettings.globalize_path(full_script_path),
		"registered": not cls_name_param.is_empty(),
		"extends": extends_class,
		"template_used": template if not template.is_empty() else "none"
	}


# Modify an existing GDScript file by adding functions, variables, or signals
func modify_gdscript(params: Dictionary) -> Dictionary:
	var script_path: String = str(params.get("script_path", ""))
	var modifications: Array = params.get("modifications", [])

	_log.info("Modifying GDScript: " + script_path)

	var full_script_path: String = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	if not FileAccess.file_exists(full_script_path):
		return _log.failure("Script file does not exist: " + full_script_path)

	var file: FileAccess = FileAccess.open(full_script_path, FileAccess.READ)
	if not file:
		return _log.failure("Failed to open script file: " + full_script_path)

	var original_content: String = file.get_as_text()
	file.close()

	var lines: Array[String] = []
	lines.assign(original_content.split("\n"))
	var modifications_applied: Array[Dictionary] = []

	for mod: Variant in modifications:
		if not mod is Dictionary:
			_log.error("Modification must be an object")
			continue
		var fields: Dictionary = mod
		var mod_type: String = str(fields.get("type", ""))
		var mod_name: String = str(fields.get("name", ""))

		if mod_name.is_empty():
			_log.error("Modification missing 'name' field")
			continue

		match mod_type:
			"add_variable":
				var line: int = _add_variable(lines, fields)
				modifications_applied.append({"type": "add_variable", "name": mod_name, "line": line})
			"add_signal":
				var line: int = _add_signal(lines, fields)
				modifications_applied.append({"type": "add_signal", "name": mod_name, "line": line})
			"add_function":
				var line: int = _add_function(lines, fields)
				modifications_applied.append({"type": "add_function", "name": mod_name, "line": line})
			_:
				_log.error("Unknown modification type: " + mod_type)

	file = FileAccess.open(full_script_path, FileAccess.WRITE)
	if not file:
		return _log.failure("Failed to write to script file: " + full_script_path)

	file.store_string("\n".join(lines))
	file.close()

	return {
		"success": true,
		"script_path": script_path,
		"modifications_applied": modifications_applied,
		"total_modifications": modifications_applied.size()
	}


# Inserts the declaration and answers with its one-based line number.
func _add_variable(lines: Array[String], mod: Dictionary) -> int:
	var var_name: String = str(mod.get("name", ""))
	var var_type: String = str(mod.get("varType", ""))
	var default_value: String = str(mod.get("defaultValue", ""))
	var is_export: bool = bool(mod.get("isExport", false))
	var export_hint: String = str(mod.get("exportHint", ""))
	var is_onready: bool = bool(mod.get("isOnready", false))

	var var_line: String = ""

	if is_export:
		if not export_hint.is_empty():
			var_line += "@export_" + export_hint + " "
		else:
			var_line += "@export "

	if is_onready:
		var_line += "@onready "

	var_line += "var " + var_name

	# A declaration with neither a type nor a value to infer one from is spelled out as Variant,
	# so what this writes still parses in a project that treats an untyped declaration as an error.
	if not var_type.is_empty():
		var_line += ": " + var_type
		if not default_value.is_empty():
			var_line += " = " + default_value
	elif not default_value.is_empty():
		var_line += " := " + default_value
	else:
		var_line += ": Variant"

	var insert_line: int = _variable_insertion_point(lines)
	lines.insert(insert_line, var_line)
	return insert_line + 1


func _add_signal(lines: Array[String], mod: Dictionary) -> int:
	var signal_name: String = str(mod.get("name", ""))
	var signal_params: String = str(mod.get("params", ""))

	var signal_line: String = "signal " + signal_name
	if not signal_params.is_empty():
		signal_line += "(" + signal_params + ")"

	var insert_line: int = _signal_insertion_point(lines)
	lines.insert(insert_line, signal_line)
	return insert_line + 1


func _add_function(lines: Array[String], mod: Dictionary) -> int:
	var func_name: String = str(mod.get("name", ""))
	var func_params: String = str(mod.get("params", ""))
	# A function that names no return type returns nothing, and says so, for the same reason
	# the variable above does.
	var return_type: String = str(mod.get("returnType", ""))
	if return_type.is_empty():
		return_type = "void"
	var body: String = str(mod.get("body", "pass"))
	var position: String = str(mod.get("position", "end"))

	var func_lines: Array[String] = []
	var func_decl: String = "func " + func_name + "(" + func_params + ") -> " + return_type + ":"
	func_lines.append("")
	func_lines.append(func_decl)

	for bl: String in body.split("\n"):
		func_lines.append("\t" + bl)

	var insert_line: int = _function_insertion_point(lines, position)

	for i: int in range(func_lines.size() - 1, -1, -1):
		lines.insert(insert_line, func_lines[i])

	return insert_line + 1


func _variable_insertion_point(lines: Array[String]) -> int:
	var after_header: int = 0
	var before_func: int = lines.size()

	for i: int in range(lines.size()):
		var line: String = lines[i].strip_edges()
		if line.begins_with("extends ") or line.begins_with("class_name "):
			after_header = i + 1
		elif line.begins_with("signal "):
			after_header = i + 1
		elif line.begins_with("func ") or line.begins_with("static func "):
			before_func = i
			break

	for i: int in range(after_header, before_func):
		var line: String = lines[i].strip_edges()
		if line.begins_with("var ") or line.begins_with("@export") or line.begins_with("@onready"):
			after_header = i + 1

	return after_header


func _signal_insertion_point(lines: Array[String]) -> int:
	var after_header: int = 0

	for i: int in range(lines.size()):
		var line: String = lines[i].strip_edges()
		if line.begins_with("extends ") or line.begins_with("class_name "):
			after_header = i + 1
		elif line.begins_with("signal "):
			after_header = i + 1
		elif (
			line.begins_with("var ")
			or line.begins_with("@export")
			or line.begins_with("@onready")
			or line.begins_with("func ")
		):
			break

	return after_header


func _function_insertion_point(lines: Array[String], position: String) -> int:
	match position:
		"after_ready":
			return _line_after_function(lines, "func _ready")
		"after_init":
			return _line_after_function(lines, "func _init")
		_:
			return lines.size()


# The line the next function starts on after the one whose declaration begins with `prefix`,
# or the end of the file when it is the last one or is not there at all.
func _line_after_function(lines: Array[String], prefix: String) -> int:
	var inside: bool = false
	for i: int in range(lines.size()):
		var line: String = lines[i].strip_edges()
		if line.begins_with(prefix):
			inside = true
		elif inside and (line.begins_with("func ") or line.begins_with("static func ")):
			return i
	return lines.size()


func _script_template(template_name: String) -> String:
	match template_name:
		"singleton":
			return """## Singleton (Autoload) script
## Add to Project Settings -> Autoload to use as a global singleton

var _instance: Object = null

func _init() -> void:
\tif _instance != null:
\t\tpush_error("Singleton instance already exists!")
\t\treturn
\t_instance = self

func _ready() -> void:
\tpass

# Add your singleton methods here
"""
		"state_machine":
			return """## Finite State Machine implementation

signal state_changed(old_state: String, new_state: String)

var current_state: String = ""
var states: Dictionary = {}

func _ready() -> void:
\t_setup_states()
\tif states.size() > 0:
\t\tchange_state(states.keys()[0])

func _setup_states() -> void:
\t# Override this to add states
\t# Example: states["idle"] = IdleState.new()
\tpass

func _process(delta: float) -> void:
\tif current_state.is_empty():
\t\treturn
\tif states.has(current_state) and states[current_state].has_method("process"):
\t\tstates[current_state].process(delta)

func _physics_process(delta: float) -> void:
\tif current_state.is_empty():
\t\treturn
\tif states.has(current_state) and states[current_state].has_method("physics_process"):
\t\tstates[current_state].physics_process(delta)

func change_state(new_state: String) -> void:
\tif not states.has(new_state):
\t\tpush_error("State not found: " + new_state)
\t\treturn
\t
\tvar old_state: String = current_state
\t
\tif not old_state.is_empty() and states.has(old_state):
\t\tif states[old_state].has_method("exit"):
\t\t\tstates[old_state].exit()
\t
\tcurrent_state = new_state
\t
\tif states[current_state].has_method("enter"):
\t\tstates[current_state].enter()
\t
\tstate_changed.emit(old_state, new_state)
"""
		"component":
			return """## Component pattern - attach to nodes to add behavior

@export var enabled: bool = true

func _ready() -> void:
\tif not enabled:
\t\tset_process(false)
\t\tset_physics_process(false)

func _process(_delta: float) -> void:
\tif not enabled:
\t\treturn
\t# Component logic here
\tpass

func enable() -> void:
\tenabled = true
\tset_process(true)
\tset_physics_process(true)

func disable() -> void:
\tenabled = false
\tset_process(false)
\tset_physics_process(false)
"""
		"resource":
			return """## Custom Resource - save and load data

@export var id: String = ""
@export var display_name: String = ""
@export var description: String = ""

func _init(p_id: String = "", p_name: String = "", p_desc: String = "") -> void:
\tid = p_id
\tdisplay_name = p_name
\tdescription = p_desc

func duplicate_resource() -> Resource:
\tvar new_resource: Resource = duplicate()
\treturn new_resource
"""
		_:
			return """func _ready() -> void:
\tpass

func _process(_delta: float) -> void:
\tpass
"""
