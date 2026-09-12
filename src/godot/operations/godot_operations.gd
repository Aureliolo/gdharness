#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Debug mode flag
var debug_mode = false
# Built on first use rather than at load, because the table holds Callables bound to this object.
var _serialisers: Dictionary = {}


# Everything one dependency walk carries: the settings it was started with, and the state it
# accumulates as it recurses. Kept together so the recursion passes one object rather than
# six positional arguments that have to stay in the same order at every call site.
class DependencyWalk:
	var max_depth: int
	var include_built_in: bool
	var visited: Dictionary = {}
	var path_stack: Array = []
	var result: Dictionary

	func _init(p_max_depth: int, p_include_built_in: bool, p_result: Dictionary) -> void:
		max_depth = p_max_depth
		include_built_in = p_include_built_in
		result = p_result


func _init():
	var args = OS.get_cmdline_args()

	# Check for debug flag
	debug_mode = "--debug-godot" in args

	# Find the script argument and determine the positions of operation and params
	var script_index = args.find("--script")
	if script_index == -1:
		log_error("Could not find --script argument")
		quit(1)

	# The operation should be 2 positions after the script path (script_index + 1 is the script path itself)
	var operation_index = script_index + 2
	# The params should be 3 positions after the script path
	var params_index = script_index + 3

	if args.size() <= params_index:
		log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
		log_error("Not enough command-line arguments provided.")
		quit(1)

	# Log all arguments for debugging
	log_debug("All arguments: " + str(args))
	log_debug("Script index: " + str(script_index))
	log_debug("Operation index: " + str(operation_index))
	log_debug("Params index: " + str(params_index))

	var operation = args[operation_index]
	var params_json = args[params_index]
	if params_json.begins_with("@file:"):
		var params_file_path = params_json.substr(6)
		var params_file = FileAccess.open(params_file_path, FileAccess.READ)
		if params_file == null:
			log_error("Failed to open params file: " + params_file_path)
			quit(1)
		params_json = params_file.get_as_text()
		params_file.close()

	log_info("Operation: " + operation)
	log_debug("Params JSON: " + params_json)

	# Parse JSON using Godot 4.x API
	var json = JSON.new()
	var error = json.parse(params_json)
	var params = null

	if error == OK:
		params = json.get_data()
	else:
		log_error("Failed to parse JSON parameters: " + params_json)
		log_error("JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
		quit(1)

	if params == null:
		log_error("Failed to parse JSON parameters: " + params_json)
		quit(1)

	log_info("Executing operation: " + operation)

	match operation:
		"export_mesh_library":
			export_mesh_library(params)
		"get_uid":
			get_uid(params)
		"resave_resources":
			resave_resources(params)
		# Phase 1: Scene Operations (V3 Enhancement)
		"list_scene_nodes":
			list_scene_nodes(params)
		"set_node_properties":
			set_node_properties(params)
		# Phase 2: Import/Export Pipeline (V3 Enhancement)
		"get_import_status":
			get_import_status(params)
		"get_import_options":
			get_import_options(params)
		"set_import_options":
			set_import_options(params)
		"reimport_resource":
			reimport_resource(params)
		"list_export_presets":
			list_export_presets(params)
		"validate_project":
			validate_project(params)
		# Phase 3: Developer Experience Tools
		"get_dependencies":
			get_dependencies(params)
		"find_resource_usages":
			find_resource_usages(params)
		"parse_error_log":
			parse_error_log(params)
		"get_project_health":
			get_project_health(params)
		# Phase 3: Configuration Management Tools
		"get_project_setting":
			get_project_setting(params)
		"set_project_setting":
			set_project_setting(params)
		"add_autoload":
			add_autoload(params)
		"remove_autoload":
			remove_autoload(params)
		"list_autoloads":
			list_autoloads(params)
		"set_main_scene":
			set_main_scene(params)
		# Signal Management
		# GDScript File Operations
		"create_script":
			create_gdscript(params)
		"modify_script":
			modify_gdscript(params)
		"get_script_info":
			get_gdscript_info(params)
		# Resource Creation Tools
		# Animation Tools
		# Plugin Management Tools
		"list_plugins":
			list_plugins(params)
		"enable_plugin":
			enable_plugin(params)
		"disable_plugin":
			disable_plugin(params)
		# Input Action Tools
		"add_input_action":
			add_input_action(params)
		# Project Search Tool
		"search_project":
			search_project(params)
		# 2D Tile Tools
		# Audio System Tools
		"create_audio_bus":
			create_audio_bus(params)
		"get_audio_buses":
			get_audio_buses(params)
		"set_audio_bus_effect":
			set_audio_bus_effect(params)
		"set_audio_bus_volume":
			set_audio_bus_volume(params)
		"create_audio_stream_player":
			create_audio_stream_player(params)
		# Networking Tools
		"create_http_request":
			create_http_request(params)
		"create_multiplayer_spawner":
			create_multiplayer_spawner(params)
		"create_multiplayer_synchronizer":
			create_multiplayer_synchronizer(params)
		# Physics Tools
		"configure_physics_layer":
			configure_physics_layer(params)
		"create_physics_material":
			create_physics_material(params)
		"create_raycast":
			create_raycast(params)
		"set_collision_layer_mask":
			set_collision_layer_mask(params)
		# Navigation Tools
		"configure_navigation_layers":
			configure_navigation_layers(params)
		# Rendering Tools
		"create_environment":
			create_environment_resource(params)
		"create_world_environment":
			create_world_environment(params)
		"create_light":
			create_light(params)
		"create_camera":
			create_camera(params)
		# Animation Tree Tools
		"set_animation_tree_parameter":
			set_animation_tree_parameter(params)
		# UI/Theme Tools
		"create_theme":
			create_theme_resource(params)
		"apply_theme_to_node":
			apply_theme_to_node(params)
		# ClassDB Introspection Tools
		"query_classes":
			query_classes(params)
		"query_class_info":
			query_class_info(params)
		"inspect_inheritance":
			inspect_inheritance(params)
		# Resource Modification Tool
		_:
			log_error("Unknown operation: " + operation)
			quit(1)

	quit()


# Logging functions
func log_debug(message):
	if debug_mode:
		print("[DEBUG] " + message)


func log_info(message):
	print("[INFO] " + message)


func log_error(message):
	printerr("[ERROR] " + message)


# ============================================
# GDScript File Operations
# ============================================


# Create a new GDScript file with proper structure and optional templates
func create_gdscript(params):
	var script_path = params.script_path
	var cls_name_param = params.get("class_name", "")
	var extends_class = params.get("extends_class", "Node")
	var content = params.get("content", "")
	var template = params.get("template", "")

	log_info("Creating GDScript: " + script_path)

	# Ensure script path has res:// prefix
	var full_script_path = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	# Validate script path ends with .gd
	if not full_script_path.ends_with(".gd"):
		log_error("Script path must end with .gd extension")
		quit(1)

	# Check if file already exists
	if FileAccess.file_exists(full_script_path):
		log_error("Script file already exists: " + full_script_path)
		quit(1)

	# Create parent directories if needed
	var dir = DirAccess.open("res://")
	var script_dir = full_script_path.get_base_dir()
	if script_dir != "res://" and not dir.dir_exists(script_dir.substr(6)):
		log_debug("Creating directory: " + script_dir)
		var error = dir.make_dir_recursive(script_dir.substr(6))
		if error != OK:
			log_error("Failed to create directory: " + script_dir + ", error: " + str(error))
			quit(1)

	# Build script content
	var script_content = ""

	# Add class_name if provided
	if not cls_name_param.is_empty():
		script_content += "class_name " + cls_name_param + "\n"

	# Add extends
	script_content += "extends " + extends_class + "\n\n"

	# Add template content or custom content
	if not template.is_empty():
		script_content += get_script_template(template)
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
		log_error("Failed to create script file: " + full_script_path)
		quit(1)

	file.store_string(script_content)
	file.close()

	# Get absolute path for result
	var absolute_path = ProjectSettings.globalize_path(full_script_path)

	var result = {
		"success": true,
		"script_path": script_path,
		"full_path": full_script_path,
		"absolute_path": absolute_path,
		"registered": not cls_name_param.is_empty(),
		"extends": extends_class,
		"template_used": template if not template.is_empty() else "none"
	}

	print(JSON.stringify(result))


# Get script template content based on template name
func get_script_template(template_name: String) -> String:
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


# Modify an existing GDScript file by adding functions, variables, or signals
func modify_gdscript(params):
	var script_path = params.script_path
	var modifications = params.modifications

	log_info("Modifying GDScript: " + script_path)

	# Ensure script path has res:// prefix
	var full_script_path = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	# Check if file exists
	if not FileAccess.file_exists(full_script_path):
		log_error("Script file does not exist: " + full_script_path)
		quit(1)

	# Read existing script content
	var file = FileAccess.open(full_script_path, FileAccess.READ)
	if not file:
		log_error("Failed to open script file: " + full_script_path)
		quit(1)

	var original_content = file.get_as_text()
	file.close()

	var lines = original_content.split("\n")
	var modifications_applied = []

	# Process each modification
	for mod in modifications:
		var mod_type = mod.get("type", "")
		var mod_name = mod.get("name", "")

		if mod_name.is_empty():
			log_error("Modification missing 'name' field")
			continue

		match mod_type:
			"add_variable":
				var result = add_variable_to_script(lines, mod)
				if result["success"]:
					lines = result["lines"]
					modifications_applied.append(
						{"type": "add_variable", "name": mod_name, "line": result["line"]}
					)
			"add_signal":
				var result = add_signal_to_script(lines, mod)
				if result["success"]:
					lines = result["lines"]
					modifications_applied.append(
						{"type": "add_signal", "name": mod_name, "line": result["line"]}
					)
			"add_function":
				var result = add_function_to_script(lines, mod)
				if result["success"]:
					lines = result["lines"]
					modifications_applied.append(
						{"type": "add_function", "name": mod_name, "line": result["line"]}
					)
			_:
				log_error("Unknown modification type: " + mod_type)

	# Write modified content back
	var new_content = "\n".join(lines)
	file = FileAccess.open(full_script_path, FileAccess.WRITE)
	if not file:
		log_error("Failed to write to script file: " + full_script_path)
		quit(1)

	file.store_string(new_content)
	file.close()

	var result = {
		"success": true,
		"script_path": script_path,
		"modifications_applied": modifications_applied,
		"total_modifications": modifications_applied.size()
	}

	print(JSON.stringify(result))


# Helper: Add a variable to script lines
func add_variable_to_script(lines: Array, mod: Dictionary) -> Dictionary:
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
	var insert_line = find_variable_insertion_point(lines)

	# Insert the variable
	lines.insert(insert_line, var_line)

	return {"success": true, "lines": lines, "line": insert_line + 1}


# Helper: Add a signal to script lines
func add_signal_to_script(lines: Array, mod: Dictionary) -> Dictionary:
	var signal_name = mod.get("name", "")
	var signal_params = mod.get("params", "")

	# Build signal declaration
	var signal_line = "signal " + signal_name
	if not signal_params.is_empty():
		signal_line += "(" + signal_params + ")"

	# Find insertion point (after extends/class_name, before variables)
	var insert_line = find_signal_insertion_point(lines)

	# Insert the signal
	lines.insert(insert_line, signal_line)

	return {"success": true, "lines": lines, "line": insert_line + 1}


# Helper: Add a function to script lines
func add_function_to_script(lines: Array, mod: Dictionary) -> Dictionary:
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
	var insert_line = find_function_insertion_point(lines, position)

	# Insert the function
	for i in range(func_lines.size() - 1, -1, -1):
		lines.insert(insert_line, func_lines[i])

	return {"success": true, "lines": lines, "line": insert_line + 1}


# Helper: Find insertion point for variables
func find_variable_insertion_point(lines: Array) -> int:
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


# Helper: Find insertion point for signals
func find_signal_insertion_point(lines: Array) -> int:
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


# Helper: Find insertion point for functions
func find_function_insertion_point(lines: Array, position: String) -> int:
	match position:
		"after_ready":
			# Find _ready function and insert after it
			var in_ready = false
			var ready_end = -1
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


# Analyze a GDScript file and return its structure
func get_gdscript_info(params):
	var script_path = params.script_path
	var include_inherited = params.get("include_inherited", false)

	log_info("Analyzing GDScript: " + script_path)

	# Ensure script path has res:// prefix
	var full_script_path = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	# Check if file exists
	if not FileAccess.file_exists(full_script_path):
		log_error("Script file does not exist: " + full_script_path)
		quit(1)

	# Read script content
	var file = FileAccess.open(full_script_path, FileAccess.READ)
	if not file:
		log_error("Failed to open script file: " + full_script_path)
		quit(1)

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

	var current_enum = null
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
			var signal_info = parse_signal(stripped, i + 1)
			result["signals"].append(signal_info)

		# Parse constants
		elif stripped.begins_with("const "):
			var const_info = parse_constant(stripped, i + 1)
			result["constants"].append(const_info)

		# Parse enums
		elif stripped.begins_with("enum "):
			var enum_info = parse_enum(stripped, i + 1)
			result["enums"].append(enum_info)

		# Parse variables
		elif (
			stripped.begins_with("var ")
			or stripped.begins_with("@export")
			or stripped.begins_with("@onready")
		):
			var var_info = parse_variable(stripped, i + 1)
			result["variables"].append(var_info)

		# Parse functions
		elif stripped.begins_with("func ") or stripped.begins_with("static func "):
			var func_info = parse_function(stripped, i + 1)
			result["functions"].append(func_info)

		# Parse inner classes
		elif stripped.begins_with("class "):
			var cls_name = stripped.substr(6).split(":")[0].split(" ")[0].strip_edges()
			result["inner_classes"].append(cls_name)

		# Parse dependencies (preload, load)
		if "preload(" in stripped or "load(" in stripped:
			var deps = extract_dependencies(stripped)
			for dep in deps:
				if dep not in result["dependencies"]:
					result["dependencies"].append(dep)

	print(JSON.stringify(result))


# Helper: Parse a signal declaration
func parse_signal(line: String, line_num: int) -> Dictionary:
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
					var param = parse_param(p.strip_edges())
					params.append(param)
	else:
		signal_name = signal_text

	return {"name": signal_name, "params": params, "line": line_num}


# Helper: Parse a constant declaration
func parse_constant(line: String, line_num: int) -> Dictionary:
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


# Helper: Parse an enum declaration
func parse_enum(line: String, line_num: int) -> Dictionary:
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


# Helper: Parse a variable declaration
func parse_variable(line: String, line_num: int) -> Dictionary:
	var is_export = line.begins_with("@export")
	var is_onready = "@onready" in line
	var export_hint = ""

	# Extract export hint
	if is_export:
		var export_match = line.find("@export")
		var var_pos = line.find("var ")
		if var_pos > export_match:
			var hint_part = line.substr(export_match + 7, var_pos - export_match - 7).strip_edges()
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


# Helper: Parse a function declaration
func parse_function(line: String, line_num: int) -> Dictionary:
	var is_static = line.begins_with("static ")
	var func_text = line

	if is_static:
		func_text = line.substr(7).strip_edges()

	func_text = func_text.substr(5).strip_edges()  # Remove "func "

	var name = ""
	var params = []
	var return_type = ""
	var is_virtual = false

	if "(" in func_text:
		var paren_start = func_text.find("(")
		name = func_text.substr(0, paren_start).strip_edges()

		var paren_end = func_text.rfind(")")
		if paren_end > paren_start:
			var params_text = func_text.substr(paren_start + 1, paren_end - paren_start - 1)
			if not params_text.is_empty():
				var param_parts = params_text.split(",")
				for p in param_parts:
					var param = parse_param(p.strip_edges())
					params.append(param)

		# Check for return type
		var after_paren = func_text.substr(paren_end + 1).strip_edges()
		if after_paren.begins_with("->"):
			return_type = after_paren.substr(2).replace(":", "").strip_edges()

	is_virtual = name.begins_with("_")

	return {
		"name": name,
		"params": params,
		"return_type": return_type,
		"is_virtual": is_virtual,
		"is_static": is_static,
		"line": line_num
	}


# Helper: Parse a function/signal parameter
func parse_param(param_text: String) -> Dictionary:
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


# Helper: Extract dependencies from a line
func extract_dependencies(line: String) -> Array:
	var deps = []
	var regex = RegEx.new()

	# Match preload("...") and load("...")
	regex.compile("(?:preload|load)\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)")
	var matches = regex.search_all(line)

	for m in matches:
		deps.append(m.get_string(1))

	return deps


# ============================================
# Phase 3: Developer Experience Tools
# ============================================


# Get dependencies for a resource with circular reference detection
func get_dependencies(params):
	var resource_path = params.get("resource_path", "")
	var max_depth = params.get("max_depth", 10)
	var include_built_in = params.get("include_built_in", false)

	log_info(
		(
			"Getting dependencies"
			+ (" for: " + resource_path if not resource_path.is_empty() else " for all resources")
		)
	)

	var result = {
		"dependencies": {},
		"circular_references": [],
		"summary": {"total_resources": 0, "total_dependencies": 0, "circular_count": 0}
	}

	if not resource_path.is_empty():
		# Analyze single resource
		var full_path = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		if not FileAccess.file_exists(full_path):
			log_error("Resource file does not exist: " + full_path)
			quit(1)

		var walk = DependencyWalk.new(max_depth, include_built_in, result)
		result["dependencies"][full_path] = analyze_resource_dependencies(full_path, 0, walk)
		result["summary"]["total_resources"] = 1
	else:
		# Analyze all project resources
		var resource_extensions = ["tscn", "tres", "gd", "gdshader", "shader"]
		var all_resources = []
		for ext in resource_extensions:
			all_resources.append_array(find_files("res://", "." + ext))

		for res_path in all_resources:
			var walk = DependencyWalk.new(max_depth, include_built_in, result)
			var deps = analyze_resource_dependencies(res_path, 0, walk)
			if deps.size() > 0:
				result["dependencies"][res_path] = deps

		result["summary"]["total_resources"] = all_resources.size()

	# Count total dependencies
	var dep_count = 0
	for key in result["dependencies"]:
		dep_count += count_dependencies_recursive(result["dependencies"][key])
	result["summary"]["total_dependencies"] = dep_count
	result["summary"]["circular_count"] = result["circular_references"].size()

	print(JSON.stringify(result))


# Helper to count dependencies recursively
func count_dependencies_recursive(deps: Array) -> int:
	var count = deps.size()
	for dep in deps:
		if dep is Dictionary and dep.has("dependencies"):
			count += count_dependencies_recursive(dep["dependencies"])
	return count


# Helper to analyze dependencies of a single resource
func analyze_resource_dependencies(path: String, current_depth: int, walk: DependencyWalk) -> Array:
	var deps = []

	if current_depth >= walk.max_depth:
		return deps

	# Check for circular reference
	if path in walk.path_stack:
		var cycle = walk.path_stack.slice(walk.path_stack.find(path))
		cycle.append(path)
		if not cycle in walk.result["circular_references"]:
			walk.result["circular_references"].append(cycle)
		return [{"path": path, "circular": true}]

	# Skip if already fully visited
	if walk.visited.has(path):
		return walk.visited[path]

	walk.path_stack.append(path)

	# Parse the file to find dependencies
	var file = FileAccess.open(path, FileAccess.READ)
	if file:
		var content = file.get_as_text()
		file.close()

		# Find resource references
		var patterns = [
			"res://[^\"'\\s\\]\\)]+",  # res:// paths
			'preload\\("([^"]+)"\\)',  # preload
			'load\\("([^"]+)"\\)',  # load
			'ext_resource.*path="([^"]+)"'  # external resources in tscn/tres
		]

		var regex = RegEx.new()
		for pattern in patterns:
			regex.compile(pattern)
			var matches = regex.search_all(content)
			for m in matches:
				var dep_path = m.get_string()

				# Extract path from preload/load patterns
				if "preload" in dep_path or "load" in dep_path:
					var inner_regex = RegEx.new()
					inner_regex.compile('"([^"]+)"')
					var inner_match = inner_regex.search(dep_path)
					if inner_match:
						dep_path = inner_match.get_string(1)
				elif "ext_resource" in dep_path:
					var inner_regex = RegEx.new()
					inner_regex.compile('path="([^"]+)"')
					var inner_match = inner_regex.search(dep_path)
					if inner_match:
						dep_path = inner_match.get_string(1)

				# Clean up path
				if not dep_path.begins_with("res://"):
					continue

				# Skip engine-internal resources unless requested. `addons/` is not one of
				# them: it is ordinary project content, and often shipping content, so
				# treating it as built-in dropped every dependency of anything living there.
				if not walk.include_built_in and dep_path.begins_with("res://."):
					continue

				# Skip if same as source
				if dep_path == path:
					continue

				var dep_info = {"path": dep_path, "exists": FileAccess.file_exists(dep_path)}

				# Recursively analyze if exists and not yet added
				if dep_info["exists"] and current_depth + 1 < walk.max_depth:
					var sub_deps = analyze_resource_dependencies(dep_path, current_depth + 1, walk)
					if sub_deps.size() > 0:
						dep_info["dependencies"] = sub_deps

				# Avoid duplicates
				var already_added = false
				for existing in deps:
					if existing is Dictionary and existing.get("path", "") == dep_path:
						already_added = true
						break
				if not already_added:
					deps.append(dep_info)

	walk.path_stack.pop_back()
	walk.visited[path] = deps
	return deps


# Find all usages of a resource across the project
func find_resource_usages(params):
	var resource_path = params.resource_path
	var search_patterns = params.get("search_patterns", [])
	var file_types = params.get("file_types", ["tscn", "tres", "gd", "gdshader"])

	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	log_info("Finding usages of: " + resource_path)

	var result = {
		"resource_path": resource_path,
		"usages": [],
		"summary": {"total_files_searched": 0, "files_with_usages": 0, "total_usages": 0}
	}

	# Build search patterns
	var patterns_to_search = [resource_path]
	if search_patterns.size() > 0:
		patterns_to_search.append_array(search_patterns)

	# Also search for relative variants
	var relative_path = resource_path.substr(6) if resource_path.begins_with("res://") else resource_path
	patterns_to_search.append(relative_path)

	# Get all searchable files
	var all_files = []
	for ext in file_types:
		all_files.append_array(find_files("res://", "." + ext))

	result["summary"]["total_files_searched"] = all_files.size()

	for file_path in all_files:
		# Skip the resource itself
		if file_path == resource_path:
			continue

		var file = FileAccess.open(file_path, FileAccess.READ)
		if not file:
			continue

		var content = file.get_as_text()
		file.close()

		var file_usages = []
		var lines = content.split("\n")

		for i in range(lines.size()):
			var line = lines[i]
			for pattern in patterns_to_search:
				if pattern in line:
					file_usages.append(
						{"line_number": i + 1, "line_content": line.strip_edges(), "pattern_matched": pattern}
					)
					break

		if file_usages.size() > 0:
			result["usages"].append({"file": file_path, "occurrences": file_usages})
			result["summary"]["files_with_usages"] += 1
			result["summary"]["total_usages"] += file_usages.size()

	print(JSON.stringify(result))


# Parse Godot error log and provide suggestions
func parse_error_log(params):
	var log_path = params.get("log_path", "")
	var log_content = params.get("log_content", "")
	var include_suggestions = params.get("include_suggestions", true)

	log_info("Parsing error log")

	var result = {
		"errors": [],
		"warnings": [],
		"summary": {"total_errors": 0, "total_warnings": 0, "error_categories": {}}
	}

	var content = ""

	if not log_path.is_empty():
		var file = FileAccess.open(log_path, FileAccess.READ)
		if file:
			content = file.get_as_text()
			file.close()
		else:
			log_error("Failed to open log file: " + log_path)
			quit(1)
	elif not log_content.is_empty():
		content = log_content
	else:
		# Try default Godot log location
		var default_paths = ["user://logs/godot.log", OS.get_user_data_dir() + "/logs/godot.log"]
		for path in default_paths:
			var file = FileAccess.open(path, FileAccess.READ)
			if file:
				content = file.get_as_text()
				file.close()
				result["log_source"] = path
				break

	if content.is_empty():
		result["message"] = "No log content provided and default log file not found"
		print(JSON.stringify(result))
		return

	# Error patterns to detect
	var error_patterns = {
		"script_error":
		{
			"pattern": "SCRIPT ERROR:",
			"category": "Script",
			"suggestion": "Check the script file at the mentioned line for syntax or logic errors"
		},
		"parse_error":
		{
			"pattern": "Parse Error:",
			"category": "Syntax",
			"suggestion":
			"Review the syntax at the mentioned location, check for typos or missing punctuation"
		},
		"null_reference":
		{
			"pattern": "Attempt to call function.*on a null instance",
			"category": "Null Reference",
			"suggestion": "Ensure the object is properly initialized before calling methods on it"
		},
		"invalid_call":
		{
			"pattern": "Invalid call.*Nonexistent function",
			"category": "Invalid Call",
			"suggestion": "Check if the function exists and is spelled correctly"
		},
		"type_error":
		{
			"pattern": "Cannot convert.*to.*",
			"category": "Type Error",
			"suggestion": "Ensure you're using compatible types or add explicit type conversion"
		},
		"resource_not_found":
		{
			"pattern": "res://.*not found",
			"category": "Missing Resource",
			"suggestion": "Verify the resource path is correct and the file exists"
		},
		"cyclic_reference":
		{
			"pattern": "Cyclic reference",
			"category": "Cyclic Reference",
			"suggestion": "Break the circular dependency between resources"
		}
	}

	var lines = content.split("\n")

	for i in range(lines.size()):
		var line = lines[i]
		var line_lower = line.to_lower()

		# Check for errors
		if "error" in line_lower or "failed" in line_lower:
			var error_entry = {"line_number": i + 1, "message": line.strip_edges(), "category": "General"}

			# Match specific error patterns
			for pattern_name in error_patterns:
				var pattern_info = error_patterns[pattern_name]
				if pattern_info["pattern"].to_lower() in line_lower:
					error_entry["category"] = pattern_info["category"]
					if include_suggestions:
						error_entry["suggestion"] = pattern_info["suggestion"]
					break

			result["errors"].append(error_entry)

			# Count by category
			if not result["summary"]["error_categories"].has(error_entry["category"]):
				result["summary"]["error_categories"][error_entry["category"]] = 0
			result["summary"]["error_categories"][error_entry["category"]] += 1

		# Check for warnings
		elif "warning" in line_lower:
			result["warnings"].append({"line_number": i + 1, "message": line.strip_edges()})

	result["summary"]["total_errors"] = result["errors"].size()
	result["summary"]["total_warnings"] = result["warnings"].size()

	print(JSON.stringify(result))


# Get comprehensive project health check with scoring
func get_project_health(params):
	var include_details = params.get("include_details", true)
	var check_categories = params.get("categories", ["structure", "resources", "scripts", "scenes", "config"])

	log_info("Performing project health check")

	var result = {"score": 100, "grade": "A", "checks": {}, "issues": [], "recommendations": []}

	var deductions = 0

	# 1. Project Structure Check
	if "structure" in check_categories:
		var structure_check = {"name": "Project Structure", "passed": true, "details": []}

		# Check for project.godot
		if not FileAccess.file_exists("res://project.godot"):
			structure_check["passed"] = false
			structure_check["details"].append("Missing project.godot file")
			deductions += 30

		# Check for common directories
		var recommended_dirs = ["res://scenes", "res://scripts", "res://assets"]
		var missing_dirs = []
		for dir in recommended_dirs:
			if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(dir)):
				missing_dirs.append(dir)

		if missing_dirs.size() > 0:
			structure_check["details"].append(
				"Consider organizing with directories: " + ", ".join(missing_dirs)
			)
			deductions += 2 * missing_dirs.size()

		result["checks"]["structure"] = structure_check

	# 2. Resource Check
	if "resources" in check_categories:
		var resource_check = {"name": "Resources", "passed": true, "details": []}

		# Check for orphaned imports
		var importable_extensions = ["png", "jpg", "wav", "mp3", "ogg"]
		var resources = []
		for ext in importable_extensions:
			resources.append_array(find_files("res://", "." + ext))

		var missing_imports = 0
		for res in resources:
			var import_file = res + ".import"
			if not FileAccess.file_exists(import_file):
				missing_imports += 1

		if missing_imports > 0:
			resource_check["details"].append(str(missing_imports) + " resources may need reimporting")
			deductions += missing_imports

		resource_check["total_resources"] = resources.size()
		result["checks"]["resources"] = resource_check

	# 3. Scripts Check
	if "scripts" in check_categories:
		var scripts_check = {"name": "Scripts", "passed": true, "details": []}

		var script_files = find_files("res://", ".gd")
		var issues_found = 0
		var todo_count = 0
		var empty_functions = 0

		for script_path in script_files:
			var file = FileAccess.open(script_path, FileAccess.READ)
			if file:
				var content = file.get_as_text()
				file.close()

				if "# TODO" in content or "# FIXME" in content:
					todo_count += 1
				if "pass # " in content or content.ends_with("pass\n"):
					empty_functions += 1

		if todo_count > 0:
			scripts_check["details"].append(str(todo_count) + " scripts have TODO/FIXME comments")
			deductions += todo_count

		if empty_functions > 0:
			scripts_check["details"].append(str(empty_functions) + " scripts may have empty functions")
			deductions += empty_functions

		scripts_check["total_scripts"] = script_files.size()
		result["checks"]["scripts"] = scripts_check

	# 4. Scenes Check
	if "scenes" in check_categories:
		var scenes_check = {"name": "Scenes", "passed": true, "details": []}

		var scene_files = find_files("res://", ".tscn")
		scenes_check["total_scenes"] = scene_files.size()

		if scene_files.size() == 0:
			scenes_check["details"].append("No scene files found in project")
			deductions += 5

		result["checks"]["scenes"] = scenes_check

	# 5. Configuration Check
	if "config" in check_categories:
		var config_check = {"name": "Configuration", "passed": true, "details": []}

		# Check main scene
		var main_scene = ProjectSettings.get_setting("application/run/main_scene", "")
		if main_scene.is_empty():
			config_check["details"].append("No main scene configured")
			deductions += 10
		elif not FileAccess.file_exists(main_scene):
			config_check["details"].append("Main scene file does not exist: " + main_scene)
			deductions += 15

		# Check project name
		var project_name = ProjectSettings.get_setting("application/config/name", "")
		if project_name.is_empty():
			config_check["details"].append("No project name set")
			deductions += 2

		# Check for export presets
		if not FileAccess.file_exists("res://export_presets.cfg"):
			config_check["details"].append("No export presets configured")
			deductions += 3

		result["checks"]["config"] = config_check

	# Calculate final score
	result["score"] = max(0, 100 - deductions)

	# Determine grade
	if result["score"] >= 90:
		result["grade"] = "A"
	elif result["score"] >= 80:
		result["grade"] = "B"
	elif result["score"] >= 70:
		result["grade"] = "C"
	elif result["score"] >= 60:
		result["grade"] = "D"
	else:
		result["grade"] = "F"

	# Generate recommendations based on issues
	if deductions > 0:
		if result["score"] < 70:
			result["recommendations"].append("Address critical issues to improve project stability")
		if not FileAccess.file_exists("res://export_presets.cfg"):
			result["recommendations"].append("Configure export presets for your target platforms")

	print(JSON.stringify(result))


# ============================================
# Phase 3: Configuration Management Tools
# ============================================


# Get a project setting value
func get_project_setting(params):
	var setting_path = params.setting
	var include_metadata = params.get("include_metadata", false)

	log_info("Getting project setting: " + setting_path)

	var result = {"setting_path": setting_path, "exists": ProjectSettings.has_setting(setting_path)}

	if result["exists"]:
		var value = ProjectSettings.get_setting(setting_path)
		result["value"] = serialize_value(value)

		if include_metadata:
			result["type"] = typeof(value)
			result["type_name"] = type_string(typeof(value))
	else:
		result["value"] = null
		result["message"] = "Setting does not exist"

	print(JSON.stringify(result))


# Set a project setting value
func set_project_setting(params):
	var setting_path = params.setting
	var value = params.value
	var save_immediately = params.get("save", true)

	log_info("Setting project setting: " + setting_path)

	var old_value = null
	var had_value = ProjectSettings.has_setting(setting_path)
	if had_value:
		old_value = ProjectSettings.get_setting(setting_path)

	# Deserialize value if needed
	var final_value = deserialize_value(value)

	ProjectSettings.set_setting(setting_path, final_value)

	var result = {
		"setting_path": setting_path,
		"old_value": serialize_value(old_value) if had_value else null,
		"new_value": serialize_value(final_value),
		"was_new": not had_value
	}

	if save_immediately:
		var err = ProjectSettings.save()
		result["saved"] = err == OK
		if err != OK:
			result["save_error"] = str(err)

	print(JSON.stringify(result))


# Add an autoload singleton
func add_autoload(params):
	var name = params.name
	var path = params.path
	var enabled = params.get("enabled", true)

	if not path.begins_with("res://"):
		path = "res://" + path

	log_info("Adding autoload: " + name + " -> " + path)

	# Verify the script/scene exists
	if not FileAccess.file_exists(path):
		log_error("Autoload file does not exist: " + path)
		quit(1)

	# Read project.godot file
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		log_error("Failed to load project.godot: " + str(err))
		quit(1)

	# Check if autoload already exists
	var existing_autoloads = []
	if config.has_section("autoload"):
		for key in config.get_section_keys("autoload"):
			existing_autoloads.append(key)

	var was_updated = name in existing_autoloads

	# Format: "*res://path/to/script.gd" (asterisk means enabled)
	var autoload_value = ("*" if enabled else "") + path
	config.set_value("autoload", name, autoload_value)

	err = config.save("res://project.godot")
	if err != OK:
		log_error("Failed to save project.godot: " + str(err))
		quit(1)

	var result = {
		"name": name, "path": path, "enabled": enabled, "action": "updated" if was_updated else "added"
	}

	print(JSON.stringify(result))


# Remove an autoload singleton
func remove_autoload(params):
	var name = params.name

	log_info("Removing autoload: " + name)

	# Read project.godot file
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		log_error("Failed to load project.godot: " + str(err))
		quit(1)

	var existed = false
	var old_value = ""

	if config.has_section("autoload"):
		if config.has_section_key("autoload", name):
			existed = true
			old_value = config.get_value("autoload", name, "")
			config.erase_section_key("autoload", name)

	if not existed:
		log_error("Autoload not found: " + name)
		quit(1)

	err = config.save("res://project.godot")
	if err != OK:
		log_error("Failed to save project.godot: " + str(err))
		quit(1)

	var result = {"name": name, "removed": true, "old_path": old_value.trim_prefix("*")}

	print(JSON.stringify(result))


# List all autoload singletons
func list_autoloads(params):
	var include_status = params.get("include_status", true)

	log_info("Listing autoloads")

	# Read project.godot file
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		log_error("Failed to load project.godot: " + str(err))
		quit(1)

	var autoloads = []

	if config.has_section("autoload"):
		for key in config.get_section_keys("autoload"):
			var value = config.get_value("autoload", key, "")
			var enabled = value.begins_with("*")
			var path = value.trim_prefix("*")

			var autoload_info = {"name": key, "path": path, "enabled": enabled}

			if include_status:
				autoload_info["file_exists"] = FileAccess.file_exists(path)

			autoloads.append(autoload_info)

	var result = {"autoloads": autoloads, "count": autoloads.size()}

	print(JSON.stringify(result))


# Set the main scene
func set_main_scene(params):
	var scene_path = params.scene_path

	if not scene_path.begins_with("res://"):
		scene_path = "res://" + scene_path

	log_info("Setting main scene: " + scene_path)

	# Verify the scene exists
	if not FileAccess.file_exists(scene_path):
		log_error("Scene file does not exist: " + scene_path)
		quit(1)

	var old_main_scene = ProjectSettings.get_setting("application/run/main_scene", "")

	ProjectSettings.set_setting("application/run/main_scene", scene_path)
	var err = ProjectSettings.save()

	if err != OK:
		log_error("Failed to save project settings: " + str(err))
		quit(1)

	var result = {"old_main_scene": old_main_scene, "new_main_scene": scene_path, "saved": true}

	print(JSON.stringify(result))


# ============================================
# Phase 2: Import/Export Pipeline (V3 Enhancement)
# ============================================


# Get import status for resources
func get_import_status(params):
	var resource_path = params.get("resource_path", "")
	var include_up_to_date = params.get("include_up_to_date", false)

	log_info(
		(
			"Getting import status"
			+ (" for: " + resource_path if not resource_path.is_empty() else " for all resources")
		)
	)

	var result = {
		"resources": [], "summary": {"total": 0, "needs_reimport": 0, "up_to_date": 0, "missing_source": 0}
	}

	# Get the .godot/imported directory
	var import_dir = "res://.godot/imported/"

	if not resource_path.is_empty():
		# Check specific resource
		var full_path = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		var import_file = full_path + ".import"
		var status = check_resource_import_status(full_path, import_file)
		result["resources"].append(status)
		result["summary"]["total"] = 1
		if status["status"] == "needs_reimport":
			result["summary"]["needs_reimport"] = 1
		elif status["status"] == "up_to_date":
			result["summary"]["up_to_date"] = 1
		elif status["status"] == "missing_source":
			result["summary"]["missing_source"] = 1
	else:
		# Scan all importable resources
		var importable_extensions = [
			"png",
			"jpg",
			"jpeg",
			"webp",
			"svg",
			"wav",
			"mp3",
			"ogg",
			"ttf",
			"otf",
			"glb",
			"gltf",
			"fbx",
			"obj"
		]
		var resources = find_files_with_extensions("res://", importable_extensions)

		for res_path in resources:
			var import_file = res_path + ".import"
			var status = check_resource_import_status(res_path, import_file)

			if include_up_to_date or status["status"] != "up_to_date":
				result["resources"].append(status)

			result["summary"]["total"] += 1
			if status["status"] == "needs_reimport":
				result["summary"]["needs_reimport"] += 1
			elif status["status"] == "up_to_date":
				result["summary"]["up_to_date"] += 1
			elif status["status"] == "missing_source":
				result["summary"]["missing_source"] += 1

	print(JSON.stringify(result))


# Helper to check import status of a single resource
func check_resource_import_status(resource_path: String, import_file_path: String) -> Dictionary:
	var status = {
		"path": resource_path, "status": "unknown", "import_file_exists": false, "source_exists": false
	}

	# Check if source file exists
	status["source_exists"] = FileAccess.file_exists(resource_path)
	if not status["source_exists"]:
		status["status"] = "missing_source"
		return status

	# Check if .import file exists
	status["import_file_exists"] = FileAccess.file_exists(import_file_path)
	if not status["import_file_exists"]:
		status["status"] = "needs_reimport"
		return status

	# Compare modification times
	var source_modified = FileAccess.get_modified_time(resource_path)
	var import_modified = FileAccess.get_modified_time(import_file_path)

	if source_modified > import_modified:
		status["status"] = "needs_reimport"
	else:
		status["status"] = "up_to_date"

	return status


# Helper to find files with specific extensions
func find_files_with_extensions(path: String, extensions: Array) -> Array:
	var files = []
	var dir = DirAccess.open(path)

	if dir:
		dir.list_dir_begin()
		var file_name = dir.get_next()

		while file_name != "":
			if file_name.begins_with("."):
				file_name = dir.get_next()
				continue

			var full_path = path + file_name
			if dir.current_is_dir():
				files.append_array(find_files_with_extensions(full_path + "/", extensions))
			else:
				var ext = file_name.get_extension().to_lower()
				if ext in extensions:
					files.append(full_path)

			file_name = dir.get_next()

		dir.list_dir_end()

	return files


# Get import options for a resource
func get_import_options(params):
	var resource_path = params.resource_path
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	log_info("Getting import options for: " + resource_path)

	var import_file_path = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		log_error("Import file does not exist: " + import_file_path)
		log_error("This resource may not have been imported yet")
		quit(1)

	# Parse the .import file
	var config = ConfigFile.new()
	var err = config.load(import_file_path)

	if err != OK:
		log_error("Failed to parse import file: " + str(err))
		quit(1)

	var result = {
		"resource_path": resource_path, "import_file": import_file_path, "remap": {}, "deps": {}, "params": {}
	}

	# Get remap section
	if config.has_section("remap"):
		for key in config.get_section_keys("remap"):
			result["remap"][key] = config.get_value("remap", key)

	# Get deps section
	if config.has_section("deps"):
		for key in config.get_section_keys("deps"):
			result["deps"][key] = config.get_value("deps", key)

	# Get params section
	if config.has_section("params"):
		for key in config.get_section_keys("params"):
			result["params"][key] = config.get_value("params", key)

	print(JSON.stringify(result))


# Set import options for a resource
func set_import_options(params):
	var resource_path = params.resource_path
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	var options = params.options
	var do_reimport = params.get("reimport", true)

	log_info("Setting import options for: " + resource_path)

	var import_file_path = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		log_error("Import file does not exist: " + import_file_path)
		log_error("This resource may not have been imported yet")
		quit(1)

	# Parse existing .import file
	var config = ConfigFile.new()
	var err = config.load(import_file_path)

	if err != OK:
		log_error("Failed to parse import file: " + str(err))
		quit(1)

	# Update options in params section
	var updated_keys = []
	for key in options:
		config.set_value("params", key, options[key])
		updated_keys.append(key)
		if debug_mode:
			log_debug("Set " + key + " = " + str(options[key]))

	# Save the updated config
	err = config.save(import_file_path)
	if err != OK:
		log_error("Failed to save import file: " + str(err))
		quit(1)

	var result = {
		"resource_path": resource_path, "updated_options": updated_keys, "reimport_triggered": do_reimport
	}

	# Note: Actual reimport would require editor reimport functionality
	# In headless mode, we can only update the .import file
	if do_reimport:
		result["note"] = "Import file updated. Run the editor or use 'reimport_resource' to apply changes."

	print(JSON.stringify(result))


# Reimport a resource or all resources
func reimport_resource(params):
	var resource_path = params.get("resource_path", "")
	var force = params.get("force", false)

	log_info(
		(
			"Reimporting"
			+ (" resource: " + resource_path if not resource_path.is_empty() else " all modified resources")
		)
	)

	# Note: Full reimport requires editor functionality
	# In headless mode, we can trigger a project rescan
	var result = {
		"status": "requested",
		"resource_path": resource_path if not resource_path.is_empty() else "all",
		"force": force,
		"note": "Reimport in headless mode is limited. For full reimport, open the project in the editor."
	}

	# We can at least verify the resource exists and check its status
	if not resource_path.is_empty():
		var full_path = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		if not FileAccess.file_exists(full_path):
			log_error("Resource file does not exist: " + full_path)
			quit(1)

		var import_file = full_path + ".import"
		var status = check_resource_import_status(full_path, import_file)
		result["current_status"] = status["status"]

	print(JSON.stringify(result))


# List export presets
func list_export_presets(params):
	var include_template_status = params.get("include_template_status", true)

	log_info("Listing export presets")

	var presets_file = "res://export_presets.cfg"

	var result = {"presets": [], "presets_file_exists": FileAccess.file_exists(presets_file)}

	if not result["presets_file_exists"]:
		result["note"] = "No export_presets.cfg found. Configure export presets in the Godot editor."
		print(JSON.stringify(result))
		return

	# Parse export_presets.cfg
	var config = ConfigFile.new()
	var err = config.load(presets_file)

	if err != OK:
		log_error("Failed to parse export_presets.cfg: " + str(err))
		quit(1)

	# Export presets are stored as [preset.0], [preset.1], etc.
	var preset_idx = 0
	while config.has_section("preset." + str(preset_idx)):
		var section = "preset." + str(preset_idx)
		var preset = {
			"index": preset_idx,
			"name": config.get_value(section, "name", "Unknown"),
			"platform": config.get_value(section, "platform", "Unknown"),
			"runnable": config.get_value(section, "runnable", false),
			"export_path": config.get_value(section, "export_path", ""),
			"export_filter": config.get_value(section, "export_filter", "all_resources"),
			"include_filter": config.get_value(section, "include_filter", ""),
			"exclude_filter": config.get_value(section, "exclude_filter", "")
		}

		# Get custom features if present
		if config.has_section_key(section, "custom_features"):
			preset["custom_features"] = config.get_value(section, "custom_features", "")

		# Note: Template status requires runtime check which is limited in headless mode
		if include_template_status:
			preset["template_status"] = "unknown (headless mode)"

		result["presets"].append(preset)
		preset_idx += 1

	result["total_presets"] = preset_idx
	print(JSON.stringify(result))


# Validate project for export
func validate_project(params):
	var preset_name = params.get("preset", "")
	var include_suggestions = params.get("include_suggestions", true)

	log_info("Validating project" + (" for preset: " + preset_name if not preset_name.is_empty() else ""))

	var result = {"valid": true, "issues": [], "warnings": [], "checks_performed": []}

	# Check 1: project.godot exists
	result["checks_performed"].append("project_file")
	if not FileAccess.file_exists("res://project.godot"):
		result["valid"] = false
		var issue = {"type": "error", "check": "project_file", "message": "project.godot not found"}
		if include_suggestions:
			issue["suggestion"] = "Ensure you are running this from a valid Godot project directory"
		result["issues"].append(issue)

	# Check 2: Main scene is set
	result["checks_performed"].append("main_scene")
	var main_scene = ProjectSettings.get_setting("application/run/main_scene", "")
	if main_scene.is_empty():
		result["valid"] = false
		var issue = {"type": "error", "check": "main_scene", "message": "No main scene set"}
		if include_suggestions:
			issue["suggestion"] = "Set a main scene in Project Settings > Application > Run > Main Scene"
		result["issues"].append(issue)
	elif not FileAccess.file_exists(main_scene):
		result["valid"] = false
		var issue = {
			"type": "error", "check": "main_scene", "message": "Main scene file does not exist: " + main_scene
		}
		if include_suggestions:
			issue["suggestion"] = "Update the main scene setting or create the missing scene file"
		result["issues"].append(issue)

	# Check 3: Export presets exist
	result["checks_performed"].append("export_presets")
	if not FileAccess.file_exists("res://export_presets.cfg"):
		var warning = {
			"type": "warning", "check": "export_presets", "message": "No export presets configured"
		}
		if include_suggestions:
			warning["suggestion"] = "Configure export presets in Godot editor: Project > Export"
		result["warnings"].append(warning)

	# Check 4: Icon is set
	result["checks_performed"].append("icon")
	var icon_path = ProjectSettings.get_setting("application/config/icon", "")
	if icon_path.is_empty():
		var warning = {"type": "warning", "check": "icon", "message": "No application icon set"}
		if include_suggestions:
			warning["suggestion"] = "Set an icon in Project Settings > Application > Config > Icon"
		result["warnings"].append(warning)
	elif not FileAccess.file_exists(icon_path):
		var warning = {
			"type": "warning", "check": "icon", "message": "Icon file does not exist: " + icon_path
		}
		if include_suggestions:
			warning["suggestion"] = "Update the icon path or add the missing icon file"
		result["warnings"].append(warning)

	# Check 5: Project name is set
	result["checks_performed"].append("project_name")
	var project_name = ProjectSettings.get_setting("application/config/name", "")
	if project_name.is_empty():
		var warning = {"type": "warning", "check": "project_name", "message": "No project name set"}
		if include_suggestions:
			warning["suggestion"] = "Set a project name in Project Settings > Application > Config > Name"
		result["warnings"].append(warning)

	# Check 6: Look for common issues in scripts (basic check)
	result["checks_performed"].append("scripts")
	var script_files = find_files_with_extensions("res://", ["gd"])
	var scripts_checked = 0
	var script_issues = []

	for script_path in script_files:
		scripts_checked += 1
		if scripts_checked > 100:  # Limit to prevent long execution
			break

		var file = FileAccess.open(script_path, FileAccess.READ)
		if file:
			var content = file.get_as_text()
			file.close()

			# Check for common issues
			if "# TODO" in content or "# FIXME" in content:
				script_issues.append({"path": script_path, "issue": "Contains TODO/FIXME comments"})
			if "pass # TODO" in content:
				script_issues.append({"path": script_path, "issue": "Contains unimplemented functions"})

	if script_issues.size() > 0:
		var warning = {
			"type": "warning",
			"check": "scripts",
			"message": str(script_issues.size()) + " script issues found",
			"details": script_issues.slice(0, 5)
		}
		if include_suggestions:
			warning["suggestion"] = "Review and resolve TODO/FIXME items before release"
		result["warnings"].append(warning)

	result["scripts_checked"] = scripts_checked
	result["issue_count"] = result["issues"].size()
	result["warning_count"] = result["warnings"].size()

	print(JSON.stringify(result))


# ============================================
# Phase 1: Scene Operations (V3 Enhancement)
# ============================================


# Helper function to normalize scene path for Phase 1 operations
func normalize_scene_path_v2(path: String) -> String:
	if not path.begins_with("res://"):
		return "res://" + path
	return path


# Helper function to get node from scene root by path for Phase 1 operations
func get_node_by_path_v2(scene_root: Node, node_path: String) -> Node:
	if node_path == "root" or node_path == "":
		return scene_root

	# Remove "root/" prefix if present
	var clean_path = node_path
	if clean_path.begins_with("root/"):
		clean_path = clean_path.substr(5)
	elif clean_path.begins_with("root"):
		clean_path = clean_path.substr(4)
		if clean_path.begins_with("/"):
			clean_path = clean_path.substr(1)

	if clean_path.is_empty():
		return scene_root

	return scene_root.get_node_or_null(clean_path)


# Backward-compatible alias for newer helpers that still call the old name
func get_node_from_path(scene_root: Node, node_path: String) -> Node:
	return get_node_by_path_v2(scene_root, node_path)


# Helper function to build node tree structure recursively
func build_node_tree(node: Node, current_depth: int, max_depth: int, include_properties: bool) -> Dictionary:
	var result = {
		"name": node.name,
		"type": node.get_class(),
		"path": str(node.get_path()) if node.is_inside_tree() else node.name
	}

	if include_properties:
		result["properties"] = get_non_default_properties(node)

	# Add children if within depth limit
	if max_depth == -1 or current_depth < max_depth:
		var children = []
		for child in node.get_children():
			children.append(build_node_tree(child, current_depth + 1, max_depth, include_properties))
		if children.size() > 0:
			result["children"] = children

	return result


# Helper function to get non-default properties of a node
func get_non_default_properties(node: Node) -> Dictionary:
	var props = {}
	var property_list = node.get_property_list()

	for prop in property_list:
		var prop_name = prop["name"]
		var prop_usage = prop["usage"]

		# Skip internal properties and script/metadata
		if prop_usage & PROPERTY_USAGE_STORAGE == 0:
			continue
		if prop_name.begins_with("_") or prop_name == "script" or prop_name == "metadata":
			continue

		var value = node.get(prop_name)

		# Convert complex types to serializable format
		props[prop_name] = serialize_value(value)

	return props


# Converts a Godot value into something JSON can carry.
#
# Keyed on typeof() rather than written as a chain of `is` tests, so the set of types that
# survive the wire is one table you can read rather than an order you have to trust. The order
# mattered: Resource had to be checked before Object or every resource came back as a bare class
# name with its path dropped, and nothing but a comment said so.
func serialize_value(value: Variant) -> Variant:
	if _serialisers.is_empty():
		_serialisers = _build_serialisers()
	var converter: Callable = _serialisers.get(typeof(value), Callable())
	return converter.call(value) if converter.is_valid() else value


func _build_serialisers() -> Dictionary:
	return {
		TYPE_NIL: func(_value): return null,
		TYPE_VECTOR2: func(v): return {"x": v.x, "y": v.y, "_type": "Vector2"},
		TYPE_VECTOR3: func(v): return {"x": v.x, "y": v.y, "z": v.z, "_type": "Vector3"},
		TYPE_VECTOR2I: func(v): return {"x": v.x, "y": v.y, "_type": "Vector2i"},
		TYPE_VECTOR3I: func(v): return {"x": v.x, "y": v.y, "z": v.z, "_type": "Vector3i"},
		TYPE_COLOR: func(v): return {"r": v.r, "g": v.g, "b": v.b, "a": v.a, "_type": "Color"},
		TYPE_NODE_PATH: func(v): return {"path": str(v), "_type": "NodePath"},
		TYPE_ARRAY: func(v): return v.map(serialize_value),
		TYPE_RECT2: _serialize_rect2,
		TYPE_TRANSFORM2D: _serialize_transform2d,
		TYPE_TRANSFORM3D: _serialize_transform3d,
		TYPE_DICTIONARY: _serialize_dictionary,
		TYPE_OBJECT: serialize_object,
	}


func _serialize_rect2(value: Rect2) -> Dictionary:
	return {
		"position": serialize_value(value.position), "size": serialize_value(value.size), "_type": "Rect2"
	}


func _serialize_transform2d(value: Transform2D) -> Dictionary:
	return {
		"origin": serialize_value(value.origin),
		"x": serialize_value(value.x),
		"y": serialize_value(value.y),
		"_type": "Transform2D"
	}


func _serialize_transform3d(value: Transform3D) -> Dictionary:
	return {
		"origin": serialize_value(value.origin),
		"basis":
		{
			"x": serialize_value(value.basis.x),
			"y": serialize_value(value.basis.y),
			"z": serialize_value(value.basis.z)
		},
		"_type": "Transform3D"
	}


func _serialize_dictionary(value: Dictionary) -> Dictionary:
	var serialised := {}
	for key in value:
		serialised[str(key)] = serialize_value(value[key])
	return serialised


# A pathless Resource says so rather than inventing an empty path for the caller to load.
func serialize_object(value: Object) -> Dictionary:
	if not value is Resource:
		return {"_type": "Object", "class": value.get_class()}
	if value.resource_path.is_empty():
		return {"_type": "Resource", "class": value.get_class()}
	return {"path": value.resource_path, "_type": "Resource", "class": value.get_class()}


# Helper function to deserialize JSON values back to Godot types
func deserialize_value(value) -> Variant:
	if value == null:
		return null
	if value is Array:
		var arr = []
		for item in value:
			arr.append(deserialize_value(item))
		return arr
	if not value is Dictionary:
		return value

	if not value.has("_type"):
		var dict = {}
		for key in value:
			dict[key] = deserialize_value(value[key])
		return dict

	match value["_type"]:
		"Vector2":
			return Vector2(value.get("x", 0), value.get("y", 0))
		"Vector3":
			return Vector3(value.get("x", 0), value.get("y", 0), value.get("z", 0))
		"Vector2i":
			return Vector2i(value.get("x", 0), value.get("y", 0))
		"Vector3i":
			return Vector3i(value.get("x", 0), value.get("y", 0), value.get("z", 0))
		"Color":
			return Color(value.get("r", 0), value.get("g", 0), value.get("b", 0), value.get("a", 1))
		"Rect2":
			var pos = deserialize_value(value.get("position", {}))
			var size = deserialize_value(value.get("size", {}))
			return Rect2(pos, size)
		"NodePath":
			return NodePath(value.get("path", ""))
	return value


# List all nodes in a scene with their hierarchy
func list_scene_nodes(params):
	var scene_path = normalize_scene_path_v2(params.scene_path)
	log_info("Listing nodes in scene: " + scene_path)

	if debug_mode:
		log_debug("Scene path (with res://): " + scene_path)

	if not FileAccess.file_exists(scene_path):
		log_error("Scene file does not exist: " + scene_path)
		quit(1)

	var scene = load(scene_path)
	if not scene:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	if not scene_root:
		log_error("Failed to instantiate scene")
		quit(1)

	if debug_mode:
		log_debug("Scene loaded and instantiated successfully")

	var max_depth = params.get("depth", -1)
	var include_properties = params.get("include_properties", false)

	if debug_mode:
		log_debug("Max depth: " + str(max_depth))
		log_debug("Include properties: " + str(include_properties))

	var tree = build_node_tree(scene_root, 0, max_depth, include_properties)

	var result = {"scene_path": params.scene_path, "root": tree}

	print(JSON.stringify(result))
	scene_root.queue_free()


# Set properties on a node
func set_node_properties(params):
	var scene_path = normalize_scene_path_v2(params.scene_path)
	var node_path = params.node_path
	var properties = params.properties
	var save_scene_after = params.get("save_scene", true)

	log_info("Setting properties on node: " + node_path + " in scene: " + scene_path)

	if debug_mode:
		log_debug("Properties to set: " + JSON.stringify(properties))

	if not FileAccess.file_exists(scene_path):
		log_error("Scene file does not exist: " + scene_path)
		quit(1)

	var scene = load(scene_path)
	if not scene:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	if not scene_root:
		log_error("Failed to instantiate scene")
		quit(1)

	var target_node = get_node_by_path_v2(scene_root, node_path)
	if not target_node:
		log_error("Node not found: " + node_path)
		scene_root.queue_free()
		quit(1)

	if debug_mode:
		log_debug("Found node: " + target_node.name + " of type: " + target_node.get_class())

	var set_count = 0
	var failed_props = []

	for prop_name in properties:
		var raw_value = properties[prop_name]
		var value = deserialize_value(raw_value)

		if debug_mode:
			log_debug("Setting property: " + prop_name + " = " + str(value))

		target_node.set(prop_name, value)
		set_count += 1

	if save_scene_after:
		var packed_scene = PackedScene.new()
		var pack_result = packed_scene.pack(scene_root)

		if pack_result == OK:
			var save_error = ResourceSaver.save(packed_scene, scene_path)
			if save_error != OK:
				log_error("Failed to save scene: " + str(save_error))
				scene_root.queue_free()
				quit(1)
			if debug_mode:
				log_debug("Scene saved successfully")
		else:
			log_error("Failed to pack scene: " + str(pack_result))
			scene_root.queue_free()
			quit(1)

	var result = {
		"scene_path": params.scene_path,
		"node_path": node_path,
		"properties_set": set_count,
		"failed_properties": failed_props,
		"scene_saved": save_scene_after
	}

	print(JSON.stringify(result))
	scene_root.queue_free()


# Helper function to set owner recursively for all children
func set_owner_recursive(node: Node, owner: Node):
	for child in node.get_children():
		child.owner = owner
		set_owner_recursive(child, owner)


# Export a scene as a MeshLibrary resource
func export_mesh_library(params):
	print("Exporting MeshLibrary from scene: " + params.scene_path)

	# Ensure the scene path starts with res:// for Godot's resource system
	var full_scene_path = params.scene_path
	if not full_scene_path.begins_with("res://"):
		full_scene_path = "res://" + full_scene_path

	if debug_mode:
		print("Full scene path (with res://): " + full_scene_path)

	# Ensure the output path starts with res:// for Godot's resource system
	var full_output_path = params.output_path
	if not full_output_path.begins_with("res://"):
		full_output_path = "res://" + full_output_path

	if debug_mode:
		print("Full output path (with res://): " + full_output_path)

	# Check if the scene file exists
	var file_check = FileAccess.file_exists(full_scene_path)
	if debug_mode:
		print("Scene file exists check: " + str(file_check))

	if not file_check:
		printerr("Scene file does not exist at: " + full_scene_path)
		# Get the absolute path for reference
		var absolute_path = ProjectSettings.globalize_path(full_scene_path)
		printerr("Absolute file path that doesn't exist: " + absolute_path)
		quit(1)

	# Load the scene
	if debug_mode:
		print("Loading scene from: " + full_scene_path)
	var scene = load(full_scene_path)
	if not scene:
		printerr("Failed to load scene: " + full_scene_path)
		quit(1)

	if debug_mode:
		print("Scene loaded successfully")

	# Instance the scene
	var scene_root = scene.instantiate()
	if debug_mode:
		print("Scene instantiated")

	# Create a new MeshLibrary
	var mesh_library = MeshLibrary.new()
	if debug_mode:
		print("Created new MeshLibrary")

	# Get mesh item names if provided
	var mesh_item_names = params.mesh_item_names if params.has("mesh_item_names") else []
	var use_specific_items = mesh_item_names.size() > 0

	if debug_mode:
		if use_specific_items:
			print("Using specific mesh items: " + str(mesh_item_names))
		else:
			print("Using all mesh items in the scene")

	# Process all child nodes
	var item_id = 0
	if debug_mode:
		print("Processing child nodes...")

	for child in scene_root.get_children():
		if debug_mode:
			print("Checking child node: " + child.name)

		# Skip if not using all items and this item is not in the list
		if use_specific_items and not (child.name in mesh_item_names):
			if debug_mode:
				print("Skipping node " + child.name + " (not in specified items list)")
			continue

		# Check if the child has a mesh
		var mesh_instance = null
		if child is MeshInstance3D:
			mesh_instance = child
			if debug_mode:
				print("Node " + child.name + " is a MeshInstance3D")
		else:
			# Try to find a MeshInstance3D in the child's descendants
			if debug_mode:
				print("Searching for MeshInstance3D in descendants of " + child.name)
			for descendant in child.get_children():
				if descendant is MeshInstance3D:
					mesh_instance = descendant
					if debug_mode:
						print("Found MeshInstance3D in descendant: " + descendant.name)
					break

		if mesh_instance and mesh_instance.mesh:
			if debug_mode:
				print("Adding mesh: " + child.name)

			# Add the mesh to the library
			mesh_library.create_item(item_id)
			mesh_library.set_item_name(item_id, child.name)
			mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
			if debug_mode:
				print("Added mesh to library with ID: " + str(item_id))

			# Add collision shape if available
			var collision_added = false
			for collision_child in child.get_children():
				if collision_child is CollisionShape3D and collision_child.shape:
					mesh_library.set_item_shapes(item_id, [collision_child.shape])
					if debug_mode:
						print("Added collision shape from: " + collision_child.name)
					collision_added = true
					break

			if debug_mode and not collision_added:
				print("No collision shape found for mesh: " + child.name)

			# Add preview if available
			if mesh_instance.mesh:
				mesh_library.set_item_preview(item_id, mesh_instance.mesh)
				if debug_mode:
					print("Added preview for mesh: " + child.name)

			item_id += 1
		elif debug_mode:
			print("Node " + child.name + " has no valid mesh")

	if debug_mode:
		print("Processed " + str(item_id) + " meshes")

	# Create directory if it doesn't exist
	var dir = DirAccess.open("res://")
	if dir == null:
		printerr("Failed to open res:// directory")
		printerr("DirAccess error: " + str(DirAccess.get_open_error()))
		quit(1)

	var output_dir = full_output_path.get_base_dir()
	if debug_mode:
		print("Output directory: " + output_dir)

	if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):  # Remove "res://" prefix
		if debug_mode:
			print("Creating directory: " + output_dir)
		var dir_error = dir.make_dir_recursive(output_dir.substr(6))  # Remove "res://" prefix
		if dir_error != OK:
			printerr("Failed to create directory: " + output_dir + ", error: " + str(dir_error))
			quit(1)

	# Save the mesh library
	if item_id > 0:
		if debug_mode:
			print("Saving MeshLibrary to: " + full_output_path)
		var save_error = ResourceSaver.save(mesh_library, full_output_path)
		if debug_mode:
			print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")

		if save_error == OK:
			# Verify the file was actually created
			if debug_mode:
				var file_check_after = FileAccess.file_exists(full_output_path)
				print("File exists check after save: " + str(file_check_after))

				if file_check_after:
					print(
						(
							"MeshLibrary exported successfully with "
							+ str(item_id)
							+ " items to: "
							+ full_output_path
						)
					)
					# Get the absolute path for reference
					var absolute_path = ProjectSettings.globalize_path(full_output_path)
					print("Absolute file path: " + absolute_path)
				else:
					printerr("File reported as saved but does not exist at: " + full_output_path)
			else:
				print(
					(
						"MeshLibrary exported successfully with "
						+ str(item_id)
						+ " items to: "
						+ full_output_path
					)
				)
		else:
			printerr("Failed to save MeshLibrary: " + str(save_error))
	else:
		printerr("No valid meshes found in the scene")


# Find files with a specific extension recursively
func find_files(path, extension):
	var files = []
	var dir = DirAccess.open(path)

	if dir:
		dir.list_dir_begin()
		var file_name = dir.get_next()

		while file_name != "":
			if dir.current_is_dir() and not file_name.begins_with("."):
				files.append_array(find_files(path + file_name + "/", extension))
			elif file_name.ends_with(extension):
				files.append(path + file_name)

			file_name = dir.get_next()

	return files


# Get UID for a specific file
func get_uid(params):
	if not params.has("file_path"):
		printerr("File path is required")
		quit(1)

	# Ensure the file path starts with res:// for Godot's resource system
	var file_path = params.file_path
	if not file_path.begins_with("res://"):
		file_path = "res://" + file_path

	print("Getting UID for file: " + file_path)
	if debug_mode:
		print("Full file path (with res://): " + file_path)

	# Get the absolute path for reference
	var absolute_path = ProjectSettings.globalize_path(file_path)
	if debug_mode:
		print("Absolute file path: " + absolute_path)

	# Ensure the file exists
	var file_check = FileAccess.file_exists(file_path)
	if debug_mode:
		print("File exists check: " + str(file_check))

	if not file_check:
		printerr("File does not exist at: " + file_path)
		printerr("Absolute file path that doesn't exist: " + absolute_path)
		quit(1)

	# Check if the UID file exists
	var uid_path = file_path + ".uid"
	if debug_mode:
		print("UID file path: " + uid_path)

	var uid_check = FileAccess.file_exists(uid_path)
	if debug_mode:
		print("UID file exists check: " + str(uid_check))

	var f = FileAccess.open(uid_path, FileAccess.READ)

	if f:
		# Read the UID content
		var uid_content = f.get_as_text()
		f.close()
		if debug_mode:
			print("UID content read successfully")

		# Return the UID content
		var result = {
			"file": file_path, "absolutePath": absolute_path, "uid": uid_content.strip_edges(), "exists": true
		}
		if debug_mode:
			print("UID result: " + JSON.stringify(result))
		print(JSON.stringify(result))
	else:
		if debug_mode:
			print("UID file does not exist or could not be opened")

		# UID file doesn't exist
		var result = {
			"file": file_path,
			"absolutePath": absolute_path,
			"exists": false,
			"message": "UID file does not exist for this file. Use resave_resources to generate UIDs."
		}
		if debug_mode:
			print("UID result: " + JSON.stringify(result))
		print(JSON.stringify(result))


# Resave all resources to update UID references
func resave_resources(params):
	print("Resaving all resources to update UID references...")

	# Get project path if provided
	var project_path = "res://"
	if params.has("project_path"):
		project_path = params.project_path
		if not project_path.begins_with("res://"):
			project_path = "res://" + project_path
		if not project_path.ends_with("/"):
			project_path += "/"

	if debug_mode:
		print("Using project path: " + project_path)

	# Get all .tscn files
	if debug_mode:
		print("Searching for scene files in: " + project_path)
	var scenes = find_files(project_path, ".tscn")
	if debug_mode:
		print("Found " + str(scenes.size()) + " scenes")

	# Resave each scene
	var success_count = 0
	var error_count = 0

	for scene_path in scenes:
		if debug_mode:
			print("Processing scene: " + scene_path)

		# Check if the scene file exists
		var file_check = FileAccess.file_exists(scene_path)
		if debug_mode:
			print("Scene file exists check: " + str(file_check))

		if not file_check:
			printerr("Scene file does not exist at: " + scene_path)
			error_count += 1
			continue

		# Load the scene
		var scene = load(scene_path)
		if scene:
			if debug_mode:
				print("Scene loaded successfully, saving...")
			var error = ResourceSaver.save(scene, scene_path)
			if debug_mode:
				print("Save result: " + str(error) + " (OK=" + str(OK) + ")")

			if error == OK:
				success_count += 1
				if debug_mode:
					print("Scene saved successfully: " + scene_path)

					# Verify the file was actually updated
					var file_check_after = FileAccess.file_exists(scene_path)
					print("File exists check after save: " + str(file_check_after))

					if not file_check_after:
						printerr("File reported as saved but does not exist at: " + scene_path)
			else:
				error_count += 1
				printerr("Failed to save: " + scene_path + ", error: " + str(error))
		else:
			error_count += 1
			printerr("Failed to load: " + scene_path)

	# Get all .gd and .shader files
	if debug_mode:
		print("Searching for script and shader files in: " + project_path)
	var scripts = (
		find_files(project_path, ".gd")
		+ find_files(project_path, ".shader")
		+ find_files(project_path, ".gdshader")
	)
	if debug_mode:
		print("Found " + str(scripts.size()) + " scripts/shaders")

	# Check for missing .uid files
	var missing_uids = 0
	var generated_uids = 0

	for script_path in scripts:
		if debug_mode:
			print("Checking UID for: " + script_path)
		var uid_path = script_path + ".uid"

		var uid_check = FileAccess.file_exists(uid_path)
		if debug_mode:
			print("UID file exists check: " + str(uid_check))

		var f = FileAccess.open(uid_path, FileAccess.READ)
		if not f:
			missing_uids += 1
			if debug_mode:
				print("Missing UID file for: " + script_path + ", generating...")

			# Force a save to generate UID
			var res = load(script_path)
			if res:
				var error = ResourceSaver.save(res, script_path)
				if debug_mode:
					print("Save result: " + str(error) + " (OK=" + str(OK) + ")")

				if error == OK:
					generated_uids += 1
					if debug_mode:
						print("Generated UID for: " + script_path)

						# Verify the UID file was actually created
						var uid_check_after = FileAccess.file_exists(uid_path)
						print("UID file exists check after save: " + str(uid_check_after))

						if not uid_check_after:
							printerr("UID file reported as generated but does not exist at: " + uid_path)
				else:
					printerr("Failed to generate UID for: " + script_path + ", error: " + str(error))
			else:
				printerr("Failed to load resource: " + script_path)
		elif debug_mode:
			print("UID file already exists for: " + script_path)

	if debug_mode:
		print("Summary:")
		print("- Scenes processed: " + str(scenes.size()))
		print("- Scenes successfully saved: " + str(success_count))
		print("- Scenes with errors: " + str(error_count))
		print("- Scripts/shaders missing UIDs: " + str(missing_uids))
		print("- UIDs successfully generated: " + str(generated_uids))
	print("Resave operation complete")


# ============================================
# Signal Management Functions
# ============================================

# ============================================
# Resource Creation Tools
# ============================================


# Particles shader templates
func get_particles_shader_template(template_name: String) -> String:
	match template_name:
		"basic":
			return """shader_type particles;

uniform float spread : hint_range(0.0, 180.0) = 45.0;
uniform float initial_velocity : hint_range(0.0, 100.0) = 5.0;

void start() {
    float angle = radians(spread) * (2.0 * RANDOM.x - 1.0);
    VELOCITY = vec3(sin(angle), cos(angle), 0.0) * initial_velocity;
}

void process() {
    // Apply gravity
    VELOCITY.y -= 9.8 * DELTA;
}
"""
		_:
			return get_particles_shader_template("basic")


# Sky shader templates
func get_sky_shader_template(template_name: String) -> String:
	match template_name:
		"basic":
			return """shader_type sky;

uniform vec4 top_color : source_color = vec4(0.4, 0.6, 1.0, 1.0);
uniform vec4 bottom_color : source_color = vec4(0.8, 0.9, 1.0, 1.0);

void sky() {
    float t = clamp(EYEDIR.y * 0.5 + 0.5, 0.0, 1.0);
    COLOR = mix(bottom_color.rgb, top_color.rgb, t);
}
"""
		_:
			return get_sky_shader_template("basic")


# Fog shader templates
func get_fog_shader_template(template_name: String) -> String:
	match template_name:
		"basic":
			return """shader_type fog;

uniform vec4 fog_color : source_color = vec4(0.5, 0.6, 0.7, 1.0);
uniform float density : hint_range(0.0, 1.0) = 0.1;

void fog() {
    DENSITY = density;
    ALBEDO = fog_color.rgb;
}
"""
		_:
			return get_fog_shader_template("basic")


# ============================================
# Animation Tools
# ============================================

# ============================================
# Plugin Management Tools
# ============================================


# List all plugins in the project with their status
func list_plugins(_params):
	log_info("Listing plugins")

	var result = {"plugins": [], "addons_directory_exists": false, "enabled_count": 0, "disabled_count": 0}

	# Check if addons directory exists
	var addons_path = "res://addons/"
	if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(addons_path)):
		result["addons_directory_exists"] = false
		result["message"] = "No addons directory found in the project"
		print(JSON.stringify(result))
		return

	result["addons_directory_exists"] = true

	# Get enabled plugins from project.godot
	var enabled_plugins = []
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err == OK:
		if config.has_section("editor_plugins"):
			var enabled_value = config.get_value("editor_plugins", "enabled", "")
			if enabled_value is String and not enabled_value.is_empty():
				# Parse the enabled plugins format: PackedStringArray("res://addons/plugin1/plugin.cfg", ...)
				var regex = RegEx.new()
				regex.compile("res://addons/([^/]+)/plugin.cfg")
				var matches = regex.search_all(enabled_value)
				for m in matches:
					enabled_plugins.append(m.get_string(1))

	if debug_mode:
		log_debug("Enabled plugins: " + str(enabled_plugins))

	# Scan addons directory
	var dir = DirAccess.open(addons_path)
	if dir:
		dir.list_dir_begin()
		var folder_name = dir.get_next()

		while folder_name != "":
			if dir.current_is_dir() and not folder_name.begins_with("."):
				var plugin_cfg_path = addons_path + folder_name + "/plugin.cfg"

				if FileAccess.file_exists(plugin_cfg_path):
					var plugin_info = {
						"name": folder_name,
						"path": addons_path + folder_name,
						"enabled": folder_name in enabled_plugins
					}

					# Read plugin.cfg for additional info
					var plugin_config = ConfigFile.new()
					var plugin_err = plugin_config.load(plugin_cfg_path)
					if plugin_err == OK:
						plugin_info["display_name"] = plugin_config.get_value("plugin", "name", folder_name)
						plugin_info["description"] = plugin_config.get_value("plugin", "description", "")
						plugin_info["author"] = plugin_config.get_value("plugin", "author", "")
						plugin_info["version"] = plugin_config.get_value("plugin", "version", "")
						plugin_info["script"] = plugin_config.get_value("plugin", "script", "")

					result["plugins"].append(plugin_info)

					if plugin_info["enabled"]:
						result["enabled_count"] += 1
					else:
						result["disabled_count"] += 1

			folder_name = dir.get_next()

		dir.list_dir_end()

	print(JSON.stringify(result))


# Enable a plugin
func enable_plugin(params):
	var plugin_name = params.plugin_name

	log_info("Enabling plugin: " + plugin_name)

	# Check if plugin exists
	var plugin_cfg_path = "res://addons/" + plugin_name + "/plugin.cfg"
	if not FileAccess.file_exists(plugin_cfg_path):
		log_error("Plugin not found: " + plugin_name)
		log_error("Expected plugin.cfg at: " + plugin_cfg_path)
		quit(1)

	# Read project.godot
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		log_error("Failed to load project.godot: " + str(err))
		quit(1)

	# Get current enabled plugins
	var enabled_plugins = []
	if config.has_section("editor_plugins"):
		var enabled_value = config.get_value("editor_plugins", "enabled", "")
		if enabled_value is String and not enabled_value.is_empty():
			var regex = RegEx.new()
			regex.compile("res://addons/([^/]+)/plugin.cfg")
			var matches = regex.search_all(enabled_value)
			for m in matches:
				enabled_plugins.append(m.get_string(1))

	# Check if already enabled
	if plugin_name in enabled_plugins:
		var result = {
			"plugin_name": plugin_name, "action": "already_enabled", "message": "Plugin is already enabled"
		}
		print(JSON.stringify(result))
		return

	# Add to enabled plugins
	enabled_plugins.append(plugin_name)

	# Build the PackedStringArray format
	var enabled_paths = []
	for p in enabled_plugins:
		enabled_paths.append("res://addons/" + p + "/plugin.cfg")

	var enabled_string = 'PackedStringArray("' + '", "'.join(enabled_paths) + '")'
	config.set_value("editor_plugins", "enabled", enabled_string)

	# Save project.godot
	err = config.save("res://project.godot")
	if err != OK:
		log_error("Failed to save project.godot: " + str(err))
		quit(1)

	var result = {"plugin_name": plugin_name, "action": "enabled", "enabled_plugins": enabled_plugins}

	print(JSON.stringify(result))


# Disable a plugin
func disable_plugin(params):
	var plugin_name = params.plugin_name

	log_info("Disabling plugin: " + plugin_name)

	# Read project.godot
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		log_error("Failed to load project.godot: " + str(err))
		quit(1)

	# Get current enabled plugins
	var enabled_plugins = []
	if config.has_section("editor_plugins"):
		var enabled_value = config.get_value("editor_plugins", "enabled", "")
		if enabled_value is String and not enabled_value.is_empty():
			var regex = RegEx.new()
			regex.compile("res://addons/([^/]+)/plugin.cfg")
			var matches = regex.search_all(enabled_value)
			for m in matches:
				enabled_plugins.append(m.get_string(1))

	# Check if plugin is in enabled list
	if not plugin_name in enabled_plugins:
		var result = {
			"plugin_name": plugin_name,
			"action": "already_disabled",
			"message": "Plugin is not currently enabled"
		}
		print(JSON.stringify(result))
		return

	# Remove from enabled plugins
	enabled_plugins.erase(plugin_name)

	# Build the PackedStringArray format
	if enabled_plugins.size() > 0:
		var enabled_paths = []
		for p in enabled_plugins:
			enabled_paths.append("res://addons/" + p + "/plugin.cfg")
		var enabled_string = 'PackedStringArray("' + '", "'.join(enabled_paths) + '")'
		config.set_value("editor_plugins", "enabled", enabled_string)
	else:
		# Remove the key if no plugins are enabled
		if config.has_section_key("editor_plugins", "enabled"):
			config.erase_section_key("editor_plugins", "enabled")

	# Save project.godot
	err = config.save("res://project.godot")
	if err != OK:
		log_error("Failed to save project.godot: " + str(err))
		quit(1)

	var result = {"plugin_name": plugin_name, "action": "disabled", "enabled_plugins": enabled_plugins}

	print(JSON.stringify(result))


# ============================================
# Input Action Tools
# ============================================


# Add an input action to the InputMap
func add_input_action(params):
	var action_name = params.action_name
	var events = params.events
	var deadzone = params.get("deadzone", 0.5)

	log_info("Adding input action: " + action_name)

	if debug_mode:
		log_debug("Events: " + JSON.stringify(events))
		log_debug("Deadzone: " + str(deadzone))

	# Read project.godot
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		log_error("Failed to load project.godot: " + str(err))
		quit(1)

	# Build the input action configuration
	var events_config = []

	for event in events:
		var event_type = event.get("type", "")
		var event_config = {}

		match event_type:
			"key":
				var keycode = event.get("keycode", "")
				if keycode.is_empty():
					log_error("Keycode is required for key events")
					continue

				event_config = {"class_name": "InputEventKey", "keycode": get_keycode_value(keycode)}

				# Add modifiers
				if event.get("ctrl", false):
					event_config["ctrl_pressed"] = true
				if event.get("alt", false):
					event_config["alt_pressed"] = true
				if event.get("shift", false):
					event_config["shift_pressed"] = true

				events_config.append(event_config)

			"mouse_button":
				var button = event.get("button", 1)
				event_config = {"class_name": "InputEventMouseButton", "button_index": button}
				events_config.append(event_config)

			"joypad_button":
				var button = event.get("button", 0)
				event_config = {"class_name": "InputEventJoypadButton", "button_index": button}
				events_config.append(event_config)

			"joypad_axis":
				var axis = event.get("axis", 0)
				var axis_value = event.get("axis_value", event.get("axisValue", 1))
				event_config = {
					"class_name": "InputEventJoypadMotion", "axis": axis, "axis_value": axis_value
				}
				events_config.append(event_config)

			_:
				log_error("Unknown event type: " + event_type)

	if events_config.size() == 0:
		log_error("No valid events provided")
		quit(1)

	config.set_value("input", action_name, build_input_action(deadzone, events_config))

	# Save project.godot
	err = config.save("res://project.godot")
	if err != OK:
		log_error("Failed to save project.godot: " + str(err))
		quit(1)

	var result = {
		"action_name": action_name,
		"events_count": events_config.size(),
		"deadzone": deadzone,
		"events": events_config
	}

	print(JSON.stringify(result))


# Helper: Get keycode value from key name
func get_keycode_value(key_name: String) -> int:
	# Map common key names to their Godot key codes
	var key_map = {
		# Letters
		"A": KEY_A,
		"B": KEY_B,
		"C": KEY_C,
		"D": KEY_D,
		"E": KEY_E,
		"F": KEY_F,
		"G": KEY_G,
		"H": KEY_H,
		"I": KEY_I,
		"J": KEY_J,
		"K": KEY_K,
		"L": KEY_L,
		"M": KEY_M,
		"N": KEY_N,
		"O": KEY_O,
		"P": KEY_P,
		"Q": KEY_Q,
		"R": KEY_R,
		"S": KEY_S,
		"T": KEY_T,
		"U": KEY_U,
		"V": KEY_V,
		"W": KEY_W,
		"X": KEY_X,
		"Y": KEY_Y,
		"Z": KEY_Z,
		# Numbers
		"0": KEY_0,
		"1": KEY_1,
		"2": KEY_2,
		"3": KEY_3,
		"4": KEY_4,
		"5": KEY_5,
		"6": KEY_6,
		"7": KEY_7,
		"8": KEY_8,
		"9": KEY_9,
		# Function keys
		"F1": KEY_F1,
		"F2": KEY_F2,
		"F3": KEY_F3,
		"F4": KEY_F4,
		"F5": KEY_F5,
		"F6": KEY_F6,
		"F7": KEY_F7,
		"F8": KEY_F8,
		"F9": KEY_F9,
		"F10": KEY_F10,
		"F11": KEY_F11,
		"F12": KEY_F12,
		# Special keys
		"Space": KEY_SPACE,
		"Escape": KEY_ESCAPE,
		"Tab": KEY_TAB,
		"Enter": KEY_ENTER,
		"Return": KEY_ENTER,
		"Backspace": KEY_BACKSPACE,
		"Delete": KEY_DELETE,
		"Up": KEY_UP,
		"Down": KEY_DOWN,
		"Left": KEY_LEFT,
		"Right": KEY_RIGHT,
		"Home": KEY_HOME,
		"End": KEY_END,
		"PageUp": KEY_PAGEUP,
		"PageDown": KEY_PAGEDOWN,
		"Insert": KEY_INSERT,
		"Shift": KEY_SHIFT,
		"Ctrl": KEY_CTRL,
		"Alt": KEY_ALT,
		"CapsLock": KEY_CAPSLOCK,
		"NumLock": KEY_NUMLOCK,
		# Numpad
		"KP0": KEY_KP_0,
		"KP1": KEY_KP_1,
		"KP2": KEY_KP_2,
		"KP3": KEY_KP_3,
		"KP4": KEY_KP_4,
		"KP5": KEY_KP_5,
		"KP6": KEY_KP_6,
		"KP7": KEY_KP_7,
		"KP8": KEY_KP_8,
		"KP9": KEY_KP_9,
		# Punctuation
		"Comma": KEY_COMMA,
		"Period": KEY_PERIOD,
		"Slash": KEY_SLASH,
		"Backslash": KEY_BACKSLASH,
		"Semicolon": KEY_SEMICOLON,
		"Apostrophe": KEY_APOSTROPHE,
		"BracketLeft": KEY_BRACKETLEFT,
		"BracketRight": KEY_BRACKETRIGHT,
		"Minus": KEY_MINUS,
		"Equal": KEY_EQUAL,
	}

	var upper_key = key_name.to_upper()
	if key_map.has(upper_key):
		return key_map[upper_key]
	if key_map.has(key_name):
		return key_map[key_name]

	# If not found, try to find by exact match or lowercase version
	for k in key_map:
		if k.to_lower() == key_name.to_lower():
			return key_map[k]

	log_error("Unknown key: " + key_name)
	return 0


# The value project.godot stores for one input action.
#
# It has to be a Dictionary holding real InputEvent objects. ConfigFile writes those as the
# unquoted expression Godot parses back into an action; hand it the same thing as assembled
# text and it writes a quoted, escaped string, which loads as a String and leaves InputMap
# with no action at all while add_input_action still reports the events it was given.
func build_input_action(deadzone: float, events: Array) -> Dictionary:
	var built: Array = []

	for event in events:
		var evt_class = event.get("class_name", "")

		match evt_class:
			"InputEventKey":
				var key := InputEventKey.new()
				key.keycode = int(event.get("keycode", 0))
				key.ctrl_pressed = bool(event.get("ctrl_pressed", false))
				key.alt_pressed = bool(event.get("alt_pressed", false))
				key.shift_pressed = bool(event.get("shift_pressed", false))
				built.append(key)

			"InputEventMouseButton":
				var mouse := InputEventMouseButton.new()
				mouse.button_index = int(event.get("button_index", MOUSE_BUTTON_LEFT))
				built.append(mouse)

			"InputEventJoypadButton":
				var pad := InputEventJoypadButton.new()
				pad.button_index = int(event.get("button_index", 0))
				built.append(pad)

			"InputEventJoypadMotion":
				var motion := InputEventJoypadMotion.new()
				motion.axis = int(event.get("axis", 0))
				motion.axis_value = float(event.get("axis_value", 1.0))
				built.append(motion)

			_:
				log_error("Unknown input event class: " + str(evt_class))
				quit(1)

	return {"deadzone": deadzone, "events": built}


# ============================================
# Project Search Tool
# ============================================


# Search for text or patterns across project files
func search_project(params):
	var query = params.query
	var file_types = params.get("file_types", ["gd", "tscn", "tres"])
	var use_regex = params.get("regex", false)
	var case_sensitive = params.get("case_sensitive", false)
	var max_results = params.get("max_results", 100)

	log_info("Searching project for: " + query)

	if debug_mode:
		log_debug("File types: " + str(file_types))
		log_debug("Use regex: " + str(use_regex))
		log_debug("Case sensitive: " + str(case_sensitive))
		log_debug("Max results: " + str(max_results))

	var result = {
		"query": query,
		"results": [],
		"summary": {"files_searched": 0, "files_with_matches": 0, "total_matches": 0, "truncated": false}
	}

	# Compile regex if needed
	var regex: RegEx = null
	if use_regex:
		regex = RegEx.new()
		var regex_err = regex.compile(query)
		if regex_err != OK:
			log_error("Invalid regex pattern: " + query)
			quit(1)

	# Get all files to search
	var files_to_search = []
	for ext in file_types:
		files_to_search.append_array(find_files("res://", "." + ext))

	result["summary"]["files_searched"] = files_to_search.size()

	if debug_mode:
		log_debug("Files to search: " + str(files_to_search.size()))

	# Search each file
	for file_path in files_to_search:
		if result["summary"]["total_matches"] >= max_results:
			result["summary"]["truncated"] = true
			break

		var file = FileAccess.open(file_path, FileAccess.READ)
		if not file:
			continue

		var content = file.get_as_text()
		file.close()

		var lines = content.split("\n")
		var file_matches = []

		for i in range(lines.size()):
			if result["summary"]["total_matches"] >= max_results:
				result["summary"]["truncated"] = true
				break

			var line = lines[i]
			var line_to_check = line if case_sensitive else line.to_lower()
			var query_to_check = query if case_sensitive else query.to_lower()
			var matched = false
			var match_content = ""

			if use_regex:
				var match_result = regex.search(line)
				if match_result:
					matched = true
					match_content = match_result.get_string()
			else:
				if query_to_check in line_to_check:
					matched = true
					match_content = query

			if matched:
				file_matches.append({"line": i + 1, "content": line.strip_edges(), "match": match_content})
				result["summary"]["total_matches"] += 1

		if file_matches.size() > 0:
			result["results"].append({"file": file_path, "matches": file_matches})
			result["summary"]["files_with_matches"] += 1

	print(JSON.stringify(result))


# ============================================
# 2D Tile Tools
# ============================================

# ============================================
# Audio System Functions
# ============================================


func create_audio_bus(params: Dictionary):
	var bus_name = params.get("busName", "NewBus")
	var parent_idx = int(params.get("parentBusIndex", 0))

	AudioServer.add_bus(parent_idx + 1)
	var new_idx = AudioServer.bus_count - 1
	AudioServer.set_bus_name(new_idx, bus_name)

	if parent_idx > 0:
		var parent_name = AudioServer.get_bus_name(parent_idx)
		AudioServer.set_bus_send(new_idx, parent_name)

	# Save bus layout
	var layout = AudioServer.generate_bus_layout()
	var save_path = "res://default_bus_layout.tres"
	var err = ResourceSaver.save(layout, save_path)

	var result = {
		"success": err == OK,
		"bus_index": new_idx,
		"bus_name": bus_name,
		"layout_saved": save_path if err == OK else "failed"
	}
	print(JSON.stringify(result))


func get_audio_buses(_params: Dictionary):
	var buses = []
	for i in range(AudioServer.bus_count):
		var bus_info = {
			"index": i,
			"name": AudioServer.get_bus_name(i),
			"volume_db": AudioServer.get_bus_volume_db(i),
			"mute": AudioServer.is_bus_mute(i),
			"solo": AudioServer.is_bus_solo(i),
			"effect_count": AudioServer.get_bus_effect_count(i),
			"send": AudioServer.get_bus_send(i)
		}
		buses.append(bus_info)

	var result = {"success": true, "bus_count": AudioServer.bus_count, "buses": buses}
	print(JSON.stringify(result))


func set_audio_bus_effect(params: Dictionary):
	var bus_idx = int(params.get("busIndex", 0))
	var effect_idx = int(params.get("effectIndex", 0))
	var effect_type = params.get("effectType", "Reverb")
	var enabled = params.get("enabled", true)

	var effect = null
	match effect_type:
		"Reverb":
			effect = AudioEffectReverb.new()
		"Delay":
			effect = AudioEffectDelay.new()
		"Chorus":
			effect = AudioEffectChorus.new()
		"Amplify":
			effect = AudioEffectAmplify.new()
		"Compressor":
			effect = AudioEffectCompressor.new()
		"Limiter":
			effect = AudioEffectLimiter.new()
		"EQ":
			effect = AudioEffectEQ.new()
		"LowPassFilter":
			effect = AudioEffectLowPassFilter.new()
		"HighPassFilter":
			effect = AudioEffectHighPassFilter.new()
		"Distortion":
			effect = AudioEffectDistortion.new()
		_:
			log_error("Unknown effect type: " + effect_type)
			quit(1)

	# Ensure enough effect slots
	while AudioServer.get_bus_effect_count(bus_idx) <= effect_idx:
		AudioServer.add_bus_effect(bus_idx, AudioEffectAmplify.new())

	AudioServer.add_bus_effect(bus_idx, effect, effect_idx)
	AudioServer.set_bus_effect_enabled(bus_idx, effect_idx, enabled)

	var result = {
		"success": true, "bus_index": bus_idx, "effect_index": effect_idx, "effect_type": effect_type
	}
	print(JSON.stringify(result))


func set_audio_bus_volume(params: Dictionary):
	var bus_idx = int(params.get("busIndex", 0))
	var volume_db = float(params.get("volumeDb", 0.0))

	AudioServer.set_bus_volume_db(bus_idx, volume_db)

	var result = {"success": true, "bus_index": bus_idx, "volume_db": volume_db}
	print(JSON.stringify(result))


func create_audio_stream_player(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var parent_path = params.get("parentPath", "root")
	var node_name = params.get("nodeName", "AudioStreamPlayer")
	var player_type = params.get("playerType", "AudioStreamPlayer")
	var audio_path = params.get("audioPath", "")
	var bus = params.get("bus", "Master")
	var autoplay = params.get("autoplay", false)

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var parent = get_node_from_path(scene_root, parent_path)
	if parent == null:
		log_error("Parent not found: " + parent_path)
		scene_root.queue_free()
		quit(1)

	var player = null
	match player_type:
		"AudioStreamPlayer":
			player = AudioStreamPlayer.new()
		"AudioStreamPlayer2D":
			player = AudioStreamPlayer2D.new()
		"AudioStreamPlayer3D":
			player = AudioStreamPlayer3D.new()
		_:
			player = AudioStreamPlayer.new()

	player.name = node_name
	player.bus = bus
	player.autoplay = autoplay

	if audio_path != "" and ResourceLoader.exists("res://" + audio_path):
		player.stream = load("res://" + audio_path)

	parent.add_child(player)
	player.owner = scene_root

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node_name": node_name, "player_type": player_type}
	print(JSON.stringify(result))
	scene_root.queue_free()


# ============================================
# Networking Functions
# ============================================


func create_http_request(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var parent_path = params.get("parentPath", "root")
	var node_name = params.get("nodeName", "HTTPRequest")
	var timeout = float(params.get("timeout", 10.0))

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var parent = get_node_from_path(scene_root, parent_path)
	if parent == null:
		log_error("Parent not found: " + parent_path)
		scene_root.queue_free()
		quit(1)

	var http = HTTPRequest.new()
	http.name = node_name
	http.timeout = timeout

	parent.add_child(http)
	http.owner = scene_root

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node_name": node_name, "timeout": timeout}
	print(JSON.stringify(result))
	scene_root.queue_free()


func create_multiplayer_spawner(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var parent_path = params.get("parentPath", "root")
	var node_name = params.get("nodeName", "MultiplayerSpawner")
	var spawn_path = params.get("spawnPath", "")
	var spawnable_scenes = params.get("spawnableScenes", [])

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var parent = get_node_from_path(scene_root, parent_path)
	if parent == null:
		log_error("Parent not found: " + parent_path)
		scene_root.queue_free()
		quit(1)

	var spawner = MultiplayerSpawner.new()
	spawner.name = node_name
	if spawn_path != "":
		spawner.spawn_path = NodePath(spawn_path)

	parent.add_child(spawner)
	spawner.owner = scene_root

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node_name": node_name}
	print(JSON.stringify(result))
	scene_root.queue_free()


func create_multiplayer_synchronizer(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var parent_path = params.get("parentPath", "root")
	var node_name = params.get("nodeName", "MultiplayerSynchronizer")
	var root_path = params.get("rootPath", "")
	var replication_interval = float(params.get("replicationInterval", 0.0))

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var parent = get_node_from_path(scene_root, parent_path)
	if parent == null:
		log_error("Parent not found: " + parent_path)
		scene_root.queue_free()
		quit(1)

	var synchronizer = MultiplayerSynchronizer.new()
	synchronizer.name = node_name
	if root_path != "":
		synchronizer.root_path = NodePath(root_path)
	synchronizer.replication_interval = replication_interval

	parent.add_child(synchronizer)
	synchronizer.owner = scene_root

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node_name": node_name}
	print(JSON.stringify(result))
	scene_root.queue_free()


# ============================================
# Physics Functions
# ============================================


func configure_physics_layer(params: Dictionary):
	var layer_type = params.get("layerType", "2d")
	var layer_idx = int(params.get("layerIndex", 1))
	var layer_name = params.get("layerName", "")

	var setting_path = "layer_names/" + layer_type + "_physics/layer_" + str(layer_idx)
	ProjectSettings.set_setting(setting_path, layer_name)
	ProjectSettings.save()

	var result = {
		"success": true, "layer_type": layer_type, "layer_index": layer_idx, "layer_name": layer_name
	}
	print(JSON.stringify(result))


func create_physics_material(params: Dictionary):
	var material_path = "res://" + params.get("materialPath", "")
	var friction = float(params.get("friction", 1.0))
	var bounce = float(params.get("bounce", 0.0))
	var rough = params.get("rough", false)
	var absorbent = params.get("absorbent", false)

	var material = PhysicsMaterial.new()
	material.friction = friction
	material.bounce = bounce
	material.rough = rough
	material.absorbent = absorbent

	var err = ResourceSaver.save(material, material_path)

	var result = {"success": err == OK, "path": material_path}
	print(JSON.stringify(result))


func create_raycast(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var parent_path = params.get("parentPath", "root")
	var node_name = params.get("nodeName", "RayCast")
	var is_3d = params.get("is3D", false)
	var target_pos = params.get("targetPosition", {"x": 0, "y": 100, "z": 0})
	var collision_mask = int(params.get("collisionMask", 1))

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var parent = get_node_from_path(scene_root, parent_path)
	if parent == null:
		log_error("Parent not found: " + parent_path)
		scene_root.queue_free()
		quit(1)

	var raycast = null
	if is_3d:
		raycast = RayCast3D.new()
		raycast.target_position = Vector3(
			float(target_pos.x), float(target_pos.y), float(target_pos.get("z", 0))
		)
	else:
		raycast = RayCast2D.new()
		raycast.target_position = Vector2(float(target_pos.x), float(target_pos.y))

	raycast.name = node_name
	raycast.collision_mask = collision_mask
	raycast.enabled = true

	parent.add_child(raycast)
	raycast.owner = scene_root

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node_name": node_name, "is_3d": is_3d}
	print(JSON.stringify(result))
	scene_root.queue_free()


func set_collision_layer_mask(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var node_path = params.get("nodePath", "")
	var collision_layer = int(params.get("collisionLayer", 1))
	var collision_mask = int(params.get("collisionMask", 1))

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var node = get_node_from_path(scene_root, node_path)
	if node == null:
		log_error("Node not found: " + node_path)
		scene_root.queue_free()
		quit(1)

	node.collision_layer = collision_layer
	node.collision_mask = collision_mask

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "collision_layer": collision_layer, "collision_mask": collision_mask}
	print(JSON.stringify(result))
	scene_root.queue_free()


# ============================================
# Navigation Functions
# ============================================


func configure_navigation_layers(params: Dictionary):
	var is_3d = params.get("is3D", false)
	var layer_idx = int(params.get("layerIndex", 1))
	var layer_name = params.get("layerName", "")

	var type_str = "3d" if is_3d else "2d"
	var setting_path = "layer_names/" + type_str + "_navigation/layer_" + str(layer_idx)
	ProjectSettings.set_setting(setting_path, layer_name)
	ProjectSettings.save()

	var result = {"success": true, "is_3d": is_3d, "layer_index": layer_idx, "layer_name": layer_name}
	print(JSON.stringify(result))


# ============================================
# Rendering Functions
# ============================================


func create_environment_resource(params: Dictionary):
	var resource_path = "res://" + params.get("resourcePath", "")
	var bg_mode_str = params.get("backgroundMode", "sky")
	var bg_color = params.get("backgroundColor", {"r": 0.3, "g": 0.3, "b": 0.3})
	var ambient_color = params.get("ambientLightColor", {"r": 1.0, "g": 1.0, "b": 1.0})
	var ambient_energy = float(params.get("ambientLightEnergy", 1.0))
	var glow_enabled = params.get("glowEnabled", false)
	var fog_enabled = params.get("fogEnabled", false)

	var env = Environment.new()

	match bg_mode_str:
		"sky":
			env.background_mode = Environment.BG_SKY
		"color":
			env.background_mode = Environment.BG_COLOR
			env.background_color = Color(float(bg_color.r), float(bg_color.g), float(bg_color.b))
		"canvas":
			env.background_mode = Environment.BG_CANVAS
		_:
			env.background_mode = Environment.BG_SKY

	env.ambient_light_color = Color(float(ambient_color.r), float(ambient_color.g), float(ambient_color.b))
	env.ambient_light_energy = ambient_energy
	env.glow_enabled = glow_enabled
	env.volumetric_fog_enabled = fog_enabled

	var err = ResourceSaver.save(env, resource_path)

	var result = {"success": err == OK, "path": resource_path}
	print(JSON.stringify(result))


func create_world_environment(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var parent_path = params.get("parentPath", "root")
	var node_name = params.get("nodeName", "WorldEnvironment")
	var env_path = params.get("environmentPath", "")

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var parent = get_node_from_path(scene_root, parent_path)
	if parent == null:
		log_error("Parent not found: " + parent_path)
		scene_root.queue_free()
		quit(1)

	var world_env = WorldEnvironment.new()
	world_env.name = node_name

	if env_path != "" and ResourceLoader.exists("res://" + env_path):
		world_env.environment = load("res://" + env_path)
	else:
		world_env.environment = Environment.new()

	parent.add_child(world_env)
	world_env.owner = scene_root

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node_name": node_name}
	print(JSON.stringify(result))
	scene_root.queue_free()


func create_light(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var parent_path = params.get("parentPath", "root")
	var node_name = params.get("nodeName", "Light")
	var light_type = params.get("lightType", "DirectionalLight3D")
	var color = params.get("color", {"r": 1.0, "g": 1.0, "b": 1.0})
	var energy = float(params.get("energy", 1.0))
	var shadow_enabled = params.get("shadowEnabled", false)

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var parent = get_node_from_path(scene_root, parent_path)
	if parent == null:
		log_error("Parent not found: " + parent_path)
		scene_root.queue_free()
		quit(1)

	var light = null
	match light_type:
		"DirectionalLight3D":
			light = DirectionalLight3D.new()
		"OmniLight3D":
			light = OmniLight3D.new()
		"SpotLight3D":
			light = SpotLight3D.new()
		"DirectionalLight2D":
			light = DirectionalLight2D.new()
		"PointLight2D":
			light = PointLight2D.new()
		_:
			light = DirectionalLight3D.new()

	light.name = node_name

	if light is Light3D:
		light.light_color = Color(float(color.r), float(color.g), float(color.b))
		light.light_energy = energy
		light.shadow_enabled = shadow_enabled
	elif light is Light2D:
		light.color = Color(float(color.r), float(color.g), float(color.b))
		light.energy = energy
		light.shadow_enabled = shadow_enabled

	parent.add_child(light)
	light.owner = scene_root

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node_name": node_name, "light_type": light_type}
	print(JSON.stringify(result))
	scene_root.queue_free()


func create_camera(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var parent_path = params.get("parentPath", "root")
	var node_name = params.get("nodeName", "Camera")
	var is_3d = params.get("is3D", false)
	var current = params.get("current", false)
	var fov = float(params.get("fov", 75.0))
	var zoom = params.get("zoom", {"x": 1, "y": 1})

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var parent = get_node_from_path(scene_root, parent_path)
	if parent == null:
		log_error("Parent not found: " + parent_path)
		scene_root.queue_free()
		quit(1)

	var camera = null
	if is_3d:
		camera = Camera3D.new()
		camera.fov = fov
		camera.current = current
	else:
		camera = Camera2D.new()
		camera.zoom = Vector2(float(zoom.x), float(zoom.y))

	camera.name = node_name
	parent.add_child(camera)
	camera.owner = scene_root

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node_name": node_name, "is_3d": is_3d}
	print(JSON.stringify(result))
	scene_root.queue_free()


# ============================================
# Animation Tree Functions
# ============================================


func set_animation_tree_parameter(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var anim_tree_path = params.get("animTreePath", "")
	var parameter_path = params.get("parameterPath", "")
	var value = params.get("value", null)

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var anim_tree = get_node_from_path(scene_root, anim_tree_path)
	if anim_tree == null or not anim_tree is AnimationTree:
		log_error("AnimationTree not found: " + anim_tree_path)
		scene_root.queue_free()
		quit(1)

	anim_tree.set(parameter_path, value)

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "parameter": parameter_path, "value": value}
	print(JSON.stringify(result))
	scene_root.queue_free()


# ============================================
# UI/Theme Functions
# ============================================


func create_theme_resource(params: Dictionary):
	var theme_path = "res://" + params.get("themePath", "")
	var base_theme_path = params.get("baseThemePath", "")

	var theme = Theme.new()

	if base_theme_path != "" and ResourceLoader.exists("res://" + base_theme_path):
		var base = load("res://" + base_theme_path) as Theme
		if base:
			theme = base.duplicate() as Theme

	var err = ResourceSaver.save(theme, theme_path)

	var result = {"success": err == OK, "path": theme_path}
	print(JSON.stringify(result))


func apply_theme_to_node(params: Dictionary):
	var scene_path = "res://" + params.get("scenePath", "")
	var node_path = params.get("nodePath", "")
	var theme_path = "res://" + params.get("themePath", "")

	var scene = load(scene_path)
	if scene == null:
		log_error("Failed to load scene: " + scene_path)
		quit(1)

	var scene_root = scene.instantiate()
	var node = get_node_from_path(scene_root, node_path)
	if node == null:
		log_error("Node not found: " + node_path)
		scene_root.queue_free()
		quit(1)

	if not node is Control:
		log_error("Node is not a Control")
		scene_root.queue_free()
		quit(1)

	if not ResourceLoader.exists(theme_path):
		log_error("Theme not found: " + theme_path)
		scene_root.queue_free()
		quit(1)

	node.theme = load(theme_path)

	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)

	var result = {"success": true, "node": node_path, "theme": theme_path}
	print(JSON.stringify(result))
	scene_root.queue_free()


# ============================================
# ClassDB Introspection Tools
# ============================================


# Query available classes from ClassDB with optional filtering
func query_classes(params):
	var filter = params.get("filter", "")
	var category = params.get("category", "")
	var instantiable_only = params.get("instantiable_only", false)

	log_info(
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

	var all_classes = ClassDB.get_class_list()
	all_classes.sort()

	var filtered_classes = []

	# Category base classes for filtering
	var category_bases = {
		"node": "Node",
		"node2d": "Node2D",
		"node3d": "Node3D",
		"control": "Control",
		"resource": "Resource",
		"physics": "PhysicsBody3D",
		"physics2d": "PhysicsBody2D",
		"audio": "AudioStream",
		"visual": "VisualInstance3D",
		"animation": "AnimationMixer",
	}

	for class_name_str in all_classes:
		# Apply instantiable filter
		if instantiable_only and not ClassDB.can_instantiate(class_name_str):
			continue

		# Apply name filter (case-insensitive substring match)
		if not filter.is_empty() and not class_name_str.to_lower().contains(filter.to_lower()):
			continue

		# Apply category filter
		if not category.is_empty():
			var base_class = category_bases.get(category.to_lower(), "")
			if base_class.is_empty():
				log_error("Unknown category: " + category + ". Valid: " + str(category_bases.keys()))
				quit(1)
			if not ClassDB.is_parent_class(class_name_str, base_class) and class_name_str != base_class:
				continue

		filtered_classes.append(class_name_str)

	var result = {
		"total_classes": all_classes.size(),
		"filtered_count": filtered_classes.size(),
		"filter": filter,
		"category": category,
		"instantiable_only": instantiable_only,
		"classes": filtered_classes
	}

	log_info(
		"Found " + str(filtered_classes.size()) + " classes (out of " + str(all_classes.size()) + " total)"
	)
	print(JSON.stringify(result))


# Query detailed info about a specific class from ClassDB
func query_class_info(params):
	var class_name_str = params.class_name
	var include_inherited = params.get("include_inherited", false)

	log_info(
		"Querying class info for: " + class_name_str + " (include_inherited: " + str(include_inherited) + ")"
	)

	if not ClassDB.class_exists(class_name_str):
		log_error("Class not found: " + class_name_str)
		quit(1)

	# Get methods
	var methods_raw = ClassDB.class_get_method_list(class_name_str, !include_inherited)
	var methods = []
	for m in methods_raw:
		var args = []
		for a in m.get("args", []):
			args.append(
				{
					"name": a.get("name", ""),
					"type": a.get("type", 0),
					"class_name": a.get("class_name", ""),
					"hint_string": a.get("hint_string", "")
				}
			)
		methods.append(
			{
				"name": m.get("name", ""),
				"args": args,
				"return":
				{
					"type": m.get("return", {}).get("type", 0),
					"class_name": m.get("return", {}).get("class_name", "")
				},
				"flags": m.get("flags", 0),
				"default_args": m.get("default_args", [])
			}
		)

	# Get properties
	var props_raw = ClassDB.class_get_property_list(class_name_str, !include_inherited)
	var properties = []
	for p in props_raw:
		# Skip internal properties (usage flag PROPERTY_USAGE_INTERNAL = 2048 + PROPERTY_USAGE_CATEGORY = 128, etc.)
		var usage = p.get("usage", 0)
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP or usage & PROPERTY_USAGE_SUBGROUP:
			continue
		properties.append(
			{
				"name": p.get("name", ""),
				"type": p.get("type", 0),
				"class_name": p.get("class_name", ""),
				"hint": p.get("hint", 0),
				"hint_string": p.get("hint_string", ""),
				"usage": usage
			}
		)

	# Get signals
	var signals_raw = ClassDB.class_get_signal_list(class_name_str, !include_inherited)
	var signals = []
	for s in signals_raw:
		var sig_args = []
		for a in s.get("args", []):
			sig_args.append(
				{"name": a.get("name", ""), "type": a.get("type", 0), "class_name": a.get("class_name", "")}
			)
		signals.append({"name": s.get("name", ""), "args": sig_args})

	# Get enums
	var enum_list = ClassDB.class_get_enum_list(class_name_str, !include_inherited)
	var enums = {}
	for e in enum_list:
		var constants = ClassDB.class_get_enum_constants(class_name_str, e, !include_inherited)
		var enum_values = {}
		for c in constants:
			enum_values[c] = ClassDB.class_get_integer_constant(class_name_str, c)
		enums[e] = enum_values

	var result = {
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
		"enums": enums
	}

	log_info(
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
	print(JSON.stringify(result))


# Inspect class inheritance hierarchy
func inspect_inheritance(params):
	var class_name_str = params.class_name

	log_info("Inspecting inheritance for: " + class_name_str)

	if not ClassDB.class_exists(class_name_str):
		log_error("Class not found: " + class_name_str)
		quit(1)

	# Build ancestor chain
	var ancestors = []
	var current = class_name_str
	while not current.is_empty():
		var parent = ClassDB.get_parent_class(current)
		if parent.is_empty():
			break
		ancestors.append(parent)
		current = parent

	# Get direct subclasses
	var all_classes = ClassDB.get_class_list()
	var direct_children = []
	for c in all_classes:
		if ClassDB.get_parent_class(c) == class_name_str:
			direct_children.append(c)
	direct_children.sort()

	# Get all descendants (recursive)
	var all_descendants = []
	for c in all_classes:
		if c != class_name_str and ClassDB.is_parent_class(c, class_name_str):
			all_descendants.append(c)
	all_descendants.sort()

	var result = {
		"class_name": class_name_str,
		"parent_class": ClassDB.get_parent_class(class_name_str),
		"ancestors": ancestors,
		"direct_children_count": direct_children.size(),
		"direct_children": direct_children,
		"all_descendants_count": all_descendants.size(),
		"all_descendants": all_descendants,
		"can_instantiate": ClassDB.can_instantiate(class_name_str)
	}

	log_info(
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
	print(JSON.stringify(result))

# ============================================
# Resource Modification Tool
# ============================================
