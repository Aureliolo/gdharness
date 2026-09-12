extends RefCounted

const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# Create a new GDScript file with proper structure and optional templates
func create_gdscript(params) -> Dictionary:
	var script_path = params.script_path
	var cls_name_param = params.get("class_name", "")
	var extends_class = params.get("extends_class", "Node")
	var content = params.get("content", "")
	var template = params.get("template", "")

	_log.info("Creating GDScript: " + script_path)

	# Ensure script path has res:// prefix
	var full_script_path = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	# Validate script path ends with .gd
	if not full_script_path.ends_with(".gd"):
		return _log.failure("Script path must end with .gd extension")

	# Check if file already exists
	if FileAccess.file_exists(full_script_path):
		return _log.failure("Script file already exists: " + full_script_path)

	# Create parent directories if needed
	var dir = DirAccess.open("res://")
	var script_dir = full_script_path.get_base_dir()
	if script_dir != "res://" and not dir.dir_exists(script_dir.substr(6)):
		_log.debug("Creating directory: " + script_dir)
		var error = dir.make_dir_recursive(script_dir.substr(6))
		if error != OK:
			return _log.failure("Failed to create directory: " + script_dir + ", error: " + str(error))

	# Build script content
	var script_content = ""

	# Add class_name if provided
	if not cls_name_param.is_empty():
		script_content += "class_name " + cls_name_param + "\n"

	# Add extends
	script_content += "extends " + extends_class + "\n\n"

	# Add template content or custom content
	if not template.is_empty():
		script_content += _script_template(template)
	elif not content.is_empty():
		script_content += content
	else:
		# Default minimal template
		script_content += "# Called when the node enters the scene tree for the first time.\n"
		script_content += "func _ready() -> void:\n"
		script_content += "\tpass\n"

	# Write the script file
	var file = FileAccess.open(full_script_path, FileAccess.WRITE)
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
func modify_gdscript(params) -> Dictionary:
	var script_path = params.script_path
	var modifications = params.modifications

	_log.info("Modifying GDScript: " + script_path)

	# Ensure script path has res:// prefix
	var full_script_path = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	# Check if file exists
	if not FileAccess.file_exists(full_script_path):
		return _log.failure("Script file does not exist: " + full_script_path)

	# Read existing script content
	var file = FileAccess.open(full_script_path, FileAccess.READ)
	if not file:
		return _log.failure("Failed to open script file: " + full_script_path)

	var original_content = file.get_as_text()
	file.close()

	var lines = original_content.split("\n")
	var modifications_applied = []

	# Process each modification
	for mod in modifications:
		var mod_type = mod.get("type", "")
		var mod_name = mod.get("name", "")

		if mod_name.is_empty():
			_log.error("Modification missing 'name' field")
			continue

		match mod_type:
			"add_variable":
				var result = _add_variable(lines, mod)
				if result["success"]:
					lines = result["lines"]
					modifications_applied.append(
						{"type": "add_variable", "name": mod_name, "line": result["line"]}
					)
			"add_signal":
				var result = _add_signal(lines, mod)
				if result["success"]:
					lines = result["lines"]
					modifications_applied.append(
						{"type": "add_signal", "name": mod_name, "line": result["line"]}
					)
			"add_function":
				var result = _add_function(lines, mod)
				if result["success"]:
					lines = result["lines"]
					modifications_applied.append(
						{"type": "add_function", "name": mod_name, "line": result["line"]}
					)
			_:
				_log.error("Unknown modification type: " + mod_type)

	# Write modified content back
	var new_content = "\n".join(lines)
	file = FileAccess.open(full_script_path, FileAccess.WRITE)
	if not file:
		return _log.failure("Failed to write to script file: " + full_script_path)

	file.store_string(new_content)
	file.close()

	return {
		"success": true,
		"script_path": script_path,
		"modifications_applied": modifications_applied,
		"total_modifications": modifications_applied.size()
	}


func _add_variable(lines: Array, mod: Dictionary) -> Dictionary:
	var var_name = mod.get("name", "")
	var var_type = mod.get("varType", "")
	var default_value = mod.get("defaultValue", "")
	var is_export = mod.get("isExport", false)
	var export_hint = mod.get("exportHint", "")
	var is_onready = mod.get("isOnready", false)

	# Build variable declaration
	var var_line = ""

	if is_export:
		if not export_hint.is_empty():
			var_line += "@export_" + export_hint + " "
		else:
			var_line += "@export "

	if is_onready:
		var_line += "@onready "

	var_line += "var " + var_name

	if not var_type.is_empty():
		var_line += ": " + var_type

	if not default_value.is_empty():
		var_line += " = " + default_value

	# Find insertion point (after extends/class_name, before functions)
	var insert_line = _variable_insertion_point(lines)

	# Insert the variable
	lines.insert(insert_line, var_line)

	return {"success": true, "lines": lines, "line": insert_line + 1}


func _add_signal(lines: Array, mod: Dictionary) -> Dictionary:
	var signal_name = mod.get("name", "")
	var signal_params = mod.get("params", "")

	# Build signal declaration
	var signal_line = "signal " + signal_name
	if not signal_params.is_empty():
		signal_line += "(" + signal_params + ")"

	# Find insertion point (after extends/class_name, before variables)
	var insert_line = _signal_insertion_point(lines)

	# Insert the signal
	lines.insert(insert_line, signal_line)

	return {"success": true, "lines": lines, "line": insert_line + 1}


func _add_function(lines: Array, mod: Dictionary) -> Dictionary:
	var func_name = mod.get("name", "")
	var func_params = mod.get("params", "")
	var return_type = mod.get("returnType", "")
	var body = mod.get("body", "pass")
	var position = mod.get("position", "end")

	# Build function declaration
	var func_lines = []
	var func_decl = "func " + func_name + "(" + func_params + ")"

	if not return_type.is_empty():
		func_decl += " -> " + return_type

	func_decl += ":"
	func_lines.append("")
	func_lines.append(func_decl)

	# Add body lines with proper indentation
	var body_lines = body.split("\n")
	for bl in body_lines:
		func_lines.append("\t" + bl)

	# Find insertion point based on position parameter
	var insert_line = _function_insertion_point(lines, position)

	# Insert the function
	for i in range(func_lines.size() - 1, -1, -1):
		lines.insert(insert_line, func_lines[i])

	return {"success": true, "lines": lines, "line": insert_line + 1}


func _variable_insertion_point(lines: Array) -> int:
	var after_header = 0
	var before_func = lines.size()

	for i in range(lines.size()):
		var line = lines[i].strip_edges()
		if line.begins_with("extends ") or line.begins_with("class_name "):
			after_header = i + 1
		elif line.begins_with("signal "):
			after_header = i + 1
		elif line.begins_with("func ") or line.begins_with("static func "):
			before_func = i
			break

	# Find last variable declaration
	for i in range(after_header, before_func):
		var line = lines[i].strip_edges()
		if line.begins_with("var ") or line.begins_with("@export") or line.begins_with("@onready"):
			after_header = i + 1

	return after_header


func _signal_insertion_point(lines: Array) -> int:
	var after_header = 0

	for i in range(lines.size()):
		var line = lines[i].strip_edges()
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


func _function_insertion_point(lines: Array, position: String) -> int:
	match position:
		"after_ready":
			# Find _ready function and insert after it
			var in_ready = false
			for i in range(lines.size()):
				var line = lines[i].strip_edges()
				if line.begins_with("func _ready"):
					in_ready = true
				elif in_ready and (line.begins_with("func ") or line.begins_with("static func ")):
					return i
			return lines.size()
		"after_init":
			# Find _init function and insert after it
			var in_init = false
			for i in range(lines.size()):
				var line = lines[i].strip_edges()
				if line.begins_with("func _init"):
					in_init = true
				elif in_init and (line.begins_with("func ") or line.begins_with("static func ")):
					return i
			return lines.size()
		_:  # "end" or default
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
\tvar old_state = current_state
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

func _process(delta: float) -> void:
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
\tvar new_resource = self.duplicate()
\treturn new_resource
"""
		_:
			return """# Called when the node enters the scene tree for the first time.
func _ready() -> void:
\tpass

# Called every frame. 'delta' is the elapsed time since the previous frame.
func _process(delta: float) -> void:
\tpass
"""
