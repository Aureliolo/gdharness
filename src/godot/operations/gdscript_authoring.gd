extends RefCounted

const GdhRead = preload("reading.gd")
const GdhLog = preload("logger.gd")
const GdhPatterns = preload("patterns.gd")

const MODIFICATION_TYPES: Array[String] = ["add_constant", "add_variable", "add_signal", "add_function"]
const BLANKS_AROUND_FUNCTIONS: int = 2

var _log: GdhLog


func _init(p_log: GdhLog) -> void:
	_log = p_log


# Create a new GDScript file with proper structure and optional templates
func create_gdscript(params: Dictionary) -> Dictionary:
	var script_path: String = str(params.get("script_path", ""))
	var cls_name_param: String = str(params.get("class_name", ""))
	var extends_class: String = str(params.get("extends", "Node"))
	if extends_class.is_empty():
		extends_class = "Node"
	var content: String = str(params.get("content", ""))
	var template: String = str(params.get("template", ""))

	_log.info("Creating GDScript: " + script_path)

	# Content is the whole file, so a header written above it would be a second one: a content that
	# starts with its own `extends` did not parse, and one without it was not the file that was sent.
	if not content.is_empty():
		var alongside: Array[String] = []
		for name: String in ["class_name", "extends", "template"]:
			if not str(params.get(name, "")).is_empty():
				alongside.append(name)
		if not alongside.is_empty():
			return _log.failure(
				(
					"content is the whole file, so "
					+ " and ".join(alongside)
					+ " cannot be given with it: write "
					+ ("them" if alongside.size() > 1 else "it")
					+ " into content instead"
				)
			)

	var full_script_path: String = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	if not full_script_path.ends_with(".gd"):
		return _log.failure("Script path must end with .gd extension")

	if FileAccess.file_exists(full_script_path):
		return _log.failure(
			"Script file already exists: " + full_script_path + ". script_edit modify adds to it."
		)

	var dir: DirAccess = DirAccess.open("res://")
	var script_dir: String = full_script_path.get_base_dir()
	if script_dir != "res://" and not dir.dir_exists(script_dir.substr(6)):
		_log.debug("Creating directory: " + script_dir)
		var error: Error = dir.make_dir_recursive(script_dir.substr(6))
		if error != OK:
			return _log.failure("Failed to create directory: " + script_dir + ", error: " + str(error))

	var script_content: String = content
	if content.is_empty():
		if not cls_name_param.is_empty():
			script_content += "class_name " + cls_name_param + "\n"
		script_content += "extends " + extends_class + "\n"
		# Only what was asked for: with no template the file was given an empty _ready beside a
		# template_used of "none", which a caller had then to delete or leave lying in the script.
		if not template.is_empty():
			script_content += "\n" + _script_template(template)

	var file: FileAccess = FileAccess.open(full_script_path, FileAccess.WRITE)
	if not file:
		return _log.failure("Failed to create script file: " + full_script_path)

	var stored: bool = file.store_string(script_content)
	file.close()
	if not stored:
		return _log.failure("Failed to write to script file: " + full_script_path)

	var written: Script = ResourceLoader.load(full_script_path, "Script", ResourceLoader.CACHE_MODE_IGNORE)
	var answer: Dictionary = {
		"success": true,
		"script_path": script_path,
		"full_path": full_script_path,
		"absolute_path": ProjectSettings.globalize_path(full_script_path),
		"template_used": template if not template.is_empty() else "none",
		"parses": _parses(written),
	}
	# Read off the file as the engine parsed it rather than off the arguments, which content leaves out.
	if written != null:
		answer["extends"] = _base_named(written)
		answer["class_name"] = str(written.get_global_name())
	return answer


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

	# All of them checked before any is made, so a call is made whole or not at all: one skipped for a
	# missing name used to leave the rest written and the answer saying success over an empty list.
	var problems: Array[String] = _modification_problems(modifications, _declared(lines))
	if not problems.is_empty():
		return _log.failure("Nothing was changed: " + "; ".join(problems))
	# Each placed line as a zero-based index that moves down whenever a later insertion lands above
	# it, so the numbers answered are where the lines are in the file written, not where each went
	# at the moment it was placed.
	var placed: Array[Dictionary] = []

	for mod: Variant in modifications:
		var fields: Dictionary = mod
		var mod_type: String = str(fields.get("type", ""))
		var at: int = -1
		match mod_type:
			"add_constant":
				at = _add_constant(lines, fields, placed)
			"add_variable":
				at = _add_variable(lines, fields, placed)
			"add_signal":
				at = _add_signal(lines, fields, placed)
			"add_function":
				at = _add_function(lines, fields, placed)
		if at == -1:
			return _log.failure(
				"Nothing was changed: " + mod_type + " " + str(fields.get("name")) + " could not be placed"
			)
		placed.append({"type": mod_type, "name": str(fields.get("name")), "index": at})

	var modifications_applied: Array[Dictionary] = []
	for entry: Dictionary in placed:
		var index: int = entry["index"]
		modifications_applied.append({"type": entry["type"], "name": entry["name"], "line": index + 1})

	file = FileAccess.open(full_script_path, FileAccess.WRITE)
	if not file:
		return _log.failure("Failed to write to script file: " + full_script_path)

	var rewrote: bool = file.store_string("\n".join(lines))
	file.close()
	if not rewrote:
		return _log.failure("Failed to write to script file: " + full_script_path)

	var made: Script = ResourceLoader.load(full_script_path, "Script", ResourceLoader.CACHE_MODE_IGNORE)
	return {
		"success": true,
		"script_path": script_path,
		"modifications_applied": modifications_applied,
		"total_modifications": modifications_applied.size(),
		"parses": _parses(made),
	}


# Every reason [param modifications] cannot be made as asked, each naming the entry by position.
#
# A name the script already declares is one of them, as is one the call adds twice. GDScript gives a
# class one namespace for its members, so a second `maximum` does not parse; and the engine reports
# only the first error it meets, so a second `func damage` behind it was written with nothing said.
static func _modification_problems(modifications: Array, declared: Dictionary) -> Array[String]:
	var problems: Array[String] = []
	if modifications.is_empty():
		problems.append("modifications is empty")
	var added: Dictionary = {}
	for index: int in range(modifications.size()):
		var mod: Variant = modifications[index]
		var which: String = "modification " + str(index + 1)
		if not mod is Dictionary:
			problems.append(which + " is not an object")
			continue
		var fields: Dictionary = mod
		var mod_type: String = str(fields.get("type", ""))
		var mod_name: String = str(fields.get("name", ""))
		if mod_type not in MODIFICATION_TYPES:
			problems.append(
				(
					which
					+ " has type '"
					+ mod_type
					+ "', not add_constant, add_variable, add_signal or add_function"
				)
			)
		if mod_type == "add_constant" and str(fields.get("defaultValue", "")).is_empty():
			problems.append(which + " is a constant with no defaultValue, and a constant needs a value")
		if mod_name.is_empty():
			problems.append(which + " has no name")
			continue
		if not mod_name.is_valid_unicode_identifier():
			problems.append(which + " is named '" + mod_name + "', which GDScript does not accept as a name")
			continue
		if declared.has(mod_name):
			var existing: Dictionary = declared[mod_name]
			problems.append(
				(
					"%s adds %s, and the script already declares %s %s on line %d"
					% [which, mod_name, existing["kind"], mod_name, existing["line"]]
				)
			)
		elif added.has(mod_name):
			problems.append("%s adds %s, which modification %d adds too" % [which, mod_name, added[mod_name]])
		else:
			added[mod_name] = index + 1
	return problems


# The members [param lines] declares at the top level, by name, as {"kind", "line"} counted from
# one: variables, constants, signals, functions, enums and inner classes, which share one namespace.
static func _declared(lines: Array[String]) -> Dictionary:
	var found: Dictionary = {}
	var declaration: RegEx = GdhPatterns.compiled(
		"^(?:static\\s+)?(var|const|signal|func|enum|class)\\s+([A-Za-z_][A-Za-z0-9_]*)"
	)
	for i: int in range(lines.size()):
		var raw: String = lines[i]
		if raw.is_empty() or raw[0] == "\t" or raw[0] == " ":
			continue
		var matched: RegExMatch = declaration.search(GdhPatterns.without_annotations(raw))
		if matched != null and not found.has(matched.get_string(2)):
			found[matched.get_string(2)] = {"kind": matched.get_string(1), "line": i + 1}
	return found


# Inserts [param new_lines] at [param at] and moves every placed line at or below it down by as many.
static func _insert(
	lines: Array[String], at: int, new_lines: Array[String], placed: Array[Dictionary]
) -> bool:
	for i: int in range(new_lines.size() - 1, -1, -1):
		if lines.insert(at, new_lines[i]) != OK:
			push_error("gdharness: could not place a line at " + str(at))
			return false
	for entry: Dictionary in placed:
		var index: int = entry["index"]
		if index >= at:
			entry["index"] = index + new_lines.size()
	return true


# Whether the engine accepts [param script], parsed under this project's own warning settings: a
# script that does not load is one the caller wants to hear about now, and the reason is on stderr,
# which comes back with the answer. A script that fails to parse still loads, as one that cannot be
# instantiated; an abstract one that parses can be, on 4.7.
static func _parses(script: Script) -> bool:
	return script != null and script.can_instantiate()


# What [param script] extends: the base script by class name or path, or the native class.
static func _base_named(script: Script) -> String:
	var base: Script = script.get_base_script()
	if base == null:
		return str(script.get_instance_base_type())
	var named: String = str(base.get_global_name())
	return named if not named.is_empty() else base.resource_path


# A constant, typed as a variable is and placed after the header, the signals and the constants
# already there, which is where the style guide puts them. Its zero-based index, or -1.
func _add_constant(lines: Array[String], mod: Dictionary, placed: Array[Dictionary]) -> int:
	var value: String = str(mod.get("defaultValue", ""))
	var declared_type: String = str(mod.get("varType", ""))
	if declared_type.is_empty():
		declared_type = _type_of_literal(value)
	var const_line: String = "const %s: %s = %s" % [str(mod.get("name", "")), declared_type, value]
	var after: int = 0
	for i: int in range(lines.size()):
		var line: String = GdhPatterns.without_annotations(lines[i])
		if (
			line.begins_with("extends ")
			or line.begins_with("class_name ")
			or line.begins_with("signal ")
			or line.begins_with("const ")
		):
			after = i + 1
		elif (
			line.begins_with("var ")
			or line.begins_with("func ")
			or line.begins_with("static ")
			or line.begins_with("enum ")
			or line.begins_with("class ")
		):
			break
	return after if _insert(lines, after, [const_line], placed) else -1


# Inserts the declaration and answers with its zero-based index, or -1 for one that could not be placed.
func _add_variable(lines: Array[String], mod: Dictionary, placed: Array[Dictionary]) -> int:
	var var_name: String = str(mod.get("name", ""))
	var var_type: String = str(mod.get("varType", ""))
	var default_value: String = str(mod.get("defaultValue", ""))
	var is_export: bool = GdhRead.as_bool(mod.get("isExport", false))
	var export_hint: String = str(mod.get("exportHint", ""))
	var is_onready: bool = GdhRead.as_bool(mod.get("isOnready", false))

	var var_line: String = ""

	if is_export:
		if not export_hint.is_empty():
			var_line += "@export_" + export_hint + " "
		else:
			var_line += "@export "

	if is_onready:
		var_line += "@onready "

	var_line += "var " + var_name

	# Every declaration this writes carries a type, so it parses in a project that treats an
	# untyped or an inferred declaration as an error, which is the strictest setting Godot has.
	# A value with no type gets the type the value evaluates to; a value nothing can evaluate
	# here, and a declaration with neither, are spelled out as Variant.
	if not var_type.is_empty():
		var_line += ": " + var_type
		if not default_value.is_empty():
			var_line += " = " + default_value
	elif not default_value.is_empty():
		var_line += ": " + _type_of_literal(default_value) + " = " + default_value
	else:
		var_line += ": Variant"

	var insert_line: int = _variable_insertion_point(lines)
	return insert_line if _insert(lines, insert_line, [var_line], placed) else -1


# The type name a constant expression evaluates to, or Variant when it is not one: a call
# into the script's own scope cannot be evaluated from here, and a type guessed for it would
# be a claim the engine then refuses at load.
func _type_of_literal(expression: String) -> String:
	var parser: Expression = Expression.new()
	if parser.parse(expression) != OK:
		return "Variant"
	var value: Variant = parser.execute([], null, false)
	if parser.has_execute_failed() or value == null:
		return "Variant"
	if value is Object:
		var object: Object = value
		return object.get_class()
	return type_string(typeof(value))


func _add_signal(lines: Array[String], mod: Dictionary, placed: Array[Dictionary]) -> int:
	var signal_name: String = str(mod.get("name", ""))
	var signal_params: String = str(mod.get("params", ""))

	var signal_line: String = "signal " + signal_name
	if not signal_params.is_empty():
		signal_line += "(" + signal_params + ")"

	var insert_line: int = _signal_insertion_point(lines)
	return insert_line if _insert(lines, insert_line, [signal_line], placed) else -1


# Answers with the zero-based index of the `func` line, below the blank lines that separate it.
#
# Two blank lines on each side, counting those already there, because that is the spacing GDScript's
# style guide gives functions and the one gdformat writes and gdlint checks: one blank line passed
# the engine and failed every project gating on either. A function last in the file ends it with a
# newline, which the file is written with only when its last line is empty.
func _add_function(lines: Array[String], mod: Dictionary, placed: Array[Dictionary]) -> int:
	var func_name: String = str(mod.get("name", ""))
	var func_params: String = str(mod.get("params", ""))
	# A function that names no return type returns nothing, and says so, for the same reason
	# the variable above does.
	var return_type: String = str(mod.get("returnType", ""))
	if return_type.is_empty():
		return_type = "void"
	var body: String = str(mod.get("body", "pass"))
	var position: String = str(mod.get("position", "end"))

	var insert_line: int = _function_insertion_point(lines, position)
	var func_lines: Array[String] = []
	for i: int in range(_blank_run(lines, insert_line - 1, -1), BLANKS_AROUND_FUNCTIONS):
		func_lines.append("")
	var declared_at: int = insert_line + func_lines.size()
	func_lines.append("func " + func_name + "(" + func_params + ") -> " + return_type + ":")

	# The body's statements relative to the function, whether or not the caller indented them for
	# it: a body written with its tab already on came out two levels in. A blank line stays empty,
	# since an indent alone on it is trailing whitespace to every formatter.
	for bl: String in body.dedent().split("\n"):
		func_lines.append("" if bl.strip_edges().is_empty() else "\t" + bl)

	var below: int = _blank_run(lines, insert_line, 1)
	if insert_line + below < lines.size():
		for i: int in range(below, BLANKS_AROUND_FUNCTIONS):
			func_lines.append("")
	elif below == 0:
		func_lines.append("")

	return declared_at if _insert(lines, insert_line, func_lines, placed) else -1


# How many blank lines run from [param from] on in the direction of [param step], 1 or -1.
static func _blank_run(lines: Array[String], from: int, step: int) -> int:
	var count: int = 0
	var at: int = from
	while at >= 0 and at < lines.size() and lines[at].strip_edges().is_empty():
		count += 1
		at += step
	return count


func _variable_insertion_point(lines: Array[String]) -> int:
	var after_header: int = 0
	var before_func: int = lines.size()

	for i: int in range(lines.size()):
		# Annotations off first. `@abstract class_name X` is one line in Godot 4.5 and later, and
		# unstripped it matches nothing here, so the header is only found when some other line
		# carries it. A script whose whole header is that one line leaves `after_header` at 0 and
		# takes the new line above the `class_name`, where it does not parse; one that declares
		# `extends` first takes it between the two, which does not parse either. Stripping also
		# turns `@export var x` into `var x`, which is why the annotation names are gone below.
		var line: String = GdhPatterns.without_annotations(lines[i])
		if line.begins_with("extends ") or line.begins_with("class_name "):
			after_header = i + 1
		elif line.begins_with("signal "):
			after_header = i + 1
		elif line.begins_with("func ") or line.begins_with("static func "):
			before_func = i
			break

	for i: int in range(after_header, before_func):
		if GdhPatterns.without_annotations(lines[i]).begins_with("var "):
			after_header = i + 1

	return after_header


func _signal_insertion_point(lines: Array[String]) -> int:
	var after_header: int = 0

	for i: int in range(lines.size()):
		# As above: the annotations come off before the line is read, so an abstract class has a
		# header to find and `@export var x` reads as the var it is.
		var line: String = GdhPatterns.without_annotations(lines[i])
		if line.begins_with("extends ") or line.begins_with("class_name "):
			after_header = i + 1
		elif line.begins_with("signal "):
			after_header = i + 1
		elif line.begins_with("var ") or line.begins_with("func "):
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
		# As above: an annotated `func` is still a `func`, and reading the raw line missed both
		# ends of this. An annotated `_ready` was never found, so `after_ready` placed the new
		# function at the end of the file, and an annotated function after `_ready` was not the
		# boundary it is, so the new one went in after whichever later function was plain.
		var line: String = GdhPatterns.without_annotations(lines[i])
		if line.begins_with(prefix):
			inside = true
		elif inside and (line.begins_with("func ") or line.begins_with("static func ")):
			return _start_of_declaration(lines, i)
	return lines.size()


# The first line belonging to the declaration on [param at]: the comments and the lines holding only
# annotations directly above it, at its indentation. A function placed on [param at] itself takes the
# next function's doc comment, which then documents the wrong one, and its `@rpc` line, which then
# annotates it. A comment indented further is the end of the body above, and stays with it.
static func _start_of_declaration(lines: Array[String], at: int) -> int:
	var indent: String = _indentation(lines[at])
	var start: int = at
	while start > 0 and _indentation(lines[start - 1]) == indent:
		var above: String = lines[start - 1].strip_edges()
		var annotation_only: bool = (
			above.begins_with("@") and GdhPatterns.without_annotations(above).is_empty()
		)
		if not above.begins_with("#") and not annotation_only:
			break
		start -= 1
	return start


static func _indentation(line: String) -> String:
	return line.substr(0, line.length() - line.strip_edges(true, false).length())


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
## State objects by name. A state may define enter(), exit(), process(delta) and
## physics_process(delta); whichever it has are called.
var states: Dictionary = {}

func _ready() -> void:
\t_setup_states()
\tif states.size() > 0:
\t\tchange_state(str(states.keys()[0]))

func _setup_states() -> void:
\t# Override this to add states
\t# Example: states["idle"] = IdleState.new()
\tpass

func _process(delta: float) -> void:
\t_call_state(current_state, "process", [delta])

func _physics_process(delta: float) -> void:
\t_call_state(current_state, "physics_process", [delta])

func change_state(new_state: String) -> void:
\tif not states.has(new_state):
\t\tpush_error("State not found: " + new_state)
\t\treturn

\tvar old_state: String = current_state
\t_call_state(old_state, "exit", [])
\tcurrent_state = new_state
\t_call_state(current_state, "enter", [])
\tstate_changed.emit(old_state, new_state)

## Calls a method on the named state when it has one; a state without it is left alone.
func _call_state(state_name: String, method: String, args: Array) -> void:
\tif state_name.is_empty() or not states.has(state_name):
\t\treturn
\tvar state: Object = states[state_name]
\tif state != null and state.has_method(method):
\t\tstate.callv(method, args)
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
