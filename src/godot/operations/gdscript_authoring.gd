extends RefCounted

const GdhFileWalk = preload("file_walk.gd")
const GdhRead = preload("reading.gd")
const GdhLog = preload("logger.gd")
const GdhPatterns = preload("patterns.gd")
const GdhScriptCheck = preload("script_check.gd")
const MODIFICATION_TYPES: Array[String] = [
	"add_constant", "add_variable", "add_signal", "add_function",
]
## The class each template's code is written for, and the base a script made from it extends
## when given none: the resource template's code is a Resource's, and on the default of Node it
## does not parse.
const TEMPLATE_BASES: Dictionary = {
	"singleton": "Node", "state_machine": "Node", "component": "Node", "resource": "Resource",
}
const BLANKS_AROUND_FUNCTIONS: int = 2

var _log: GdhLog


func _init(p_log: GdhLog) -> void:
	_log = p_log


# Create a new GDScript file with proper structure and optional templates
func create_gdscript(params: Dictionary) -> Dictionary:
	var script_path: String = str(params.get("script_path", ""))
	var cls_name_param: String = str(params.get("class_name", ""))
	var content: String = str(params.get("content", ""))
	var template: String = str(params.get("template", ""))
	var extends_class: String = str(params.get("extends", ""))
	if extends_class.is_empty():
		extends_class = str(TEMPLATE_BASES.get(template, "Node"))

	_log.info("Creating GDScript: " + script_path)

	# Content is the whole file, so a header written above it would be a second one: a content that
	# starts with its own `extends` did not parse, and one without it was not the file that was
	# sent.
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
		return _log.failure(_not_gdscript(full_script_path, "makes"))

	if FileAccess.file_exists(full_script_path):
		return _log.failure(
			"Script file already exists: " + full_script_path + ". script_edit modify adds to it."
		)

	# Content is left to the parse below: two scripts that name each other are written one at a
	# time, and the first does not compile until the second exists.
	if content.is_empty():
		var header: String = _header_refusal(cls_name_param, extends_class)
		if header.is_empty() and not template.is_empty():
			header = _template_refusal(template, extends_class, full_script_path)
		if not header.is_empty():
			return _log.failure(header + " Nothing was written.")

	var dir: DirAccess = DirAccess.open("res://")
	var script_dir: String = full_script_path.get_base_dir()
	if script_dir != "res://" and not dir.dir_exists(script_dir.substr(6)):
		_log.debug("Creating directory: " + script_dir)
		var error: Error = dir.make_dir_recursive(script_dir.substr(6))
		if error != OK:
			return _log.failure(
				"Failed to create directory: " + script_dir + ", error: " + str(error)
			)

	var script_content: String = content
	if content.is_empty():
		if not cls_name_param.is_empty():
			script_content += "class_name " + cls_name_param + "\n"
		script_content += "extends " + extends_class + "\n"
		# Only what was asked for: with no template the file was given an empty _ready beside a
		# template_used of "none", which a caller had then to delete or leave lying in the script.
		# Each template opens with the class's doc comment, which belongs straight below the header.
		if not template.is_empty():
			script_content += _script_template(template)

	var file: FileAccess = FileAccess.open(full_script_path, FileAccess.WRITE)
	if not file:
		return _log.failure("Failed to create script file: " + full_script_path)

	var stored: bool = file.store_string(script_content)
	file.close()
	if not stored:
		return _log.failure("Failed to write to script file: " + full_script_path)
	# The editor gives a script it makes a .uid beside it. A headless engine writes none until the
	# project is imported, so a script made here was missing from every check tracking the sidecars.
	var uid: String = _uid_beside(full_script_path)

	var written: Script = ResourceLoader.load(
		full_script_path, "Script", ResourceLoader.CACHE_MODE_IGNORE
	)
	var parses: bool = _parses(written)
	var answer: Dictionary = {
		"success": true,
		"script_path": script_path,
		"full_path": full_script_path,
		"absolute_path": ProjectSettings.globalize_path(full_script_path),
		"template_used": template if not template.is_empty() else "none",
		"parses": parses,
		"uid": null,
	}
	if not uid.is_empty():
		answer["uid"] = uid
	# Read off the file as the engine parsed it rather than off the arguments, which content leaves
	# out. A script that does not parse tells the engine nothing, and its empty base and name were
	# answered for a file whose header says otherwise, so those are read off the text instead.
	if parses:
		answer["extends"] = _base_named(written)
		var declared: String = str(written.get_global_name())
		answer["class_name"] = null
		if not declared.is_empty():
			answer["class_name"] = declared
	else:
		answer.merge(_header_written(script_content))
	return answer


## The uid in the .uid file beside [param path], written first when there is none, as the editor
## writes it for a script it makes; empty when it could not be written. A sidecar already there is
## the one the engine reads the script's uid from, so it is kept.
static func _uid_beside(path: String) -> String:
	var sidecar: String = path + ".uid"
	if FileAccess.file_exists(sidecar):
		return FileAccess.get_file_as_string(sidecar).strip_edges()
	var text: String = ResourceUID.id_to_text(ResourceUID.create_id_for_path(path))
	var file: FileAccess = FileAccess.open(sidecar, FileAccess.WRITE)
	if file == null:
		return ""
	var stored: bool = file.store_string(text + "\n")
	file.close()
	return text if stored else ""


## The refusal for [param path], which is no GDScript file, naming what [param doing] it instead:
## a shader is made with resource_edit, and once it exists its text is edited as a file's.
static func _not_gdscript(path: String, doing: String) -> String:
	var refusal: String = "%s is not a .gd file, and script_edit %s GDScript only." % [path, doing]
	if path.get_extension() != "gdshader":
		return refusal
	if doing == "makes":
		return refusal + " resource_edit create_shader makes a shader, with its source as code."
	return refusal + " A shader's text is edited as a file."


## The class_name and extends [param text] declares at its margin, as written. A script with no
## extends extends RefCounted, and one with no class_name answers null for it, as an absent name
## does everywhere else rather than as a name that is empty.
static func _header_written(text: String) -> Dictionary:
	var header: Dictionary = { "extends": "RefCounted", "class_name": null }
	for line: String in text.split("\n"):
		# An inner class's extends is indented, and is not the script's.
		if line.begins_with(" ") or line.begins_with("\t"):
			continue
		var bare: String = GdhPatterns.without_annotations(GdhPatterns.without_comment(line))
		var found: RegExMatch = GdhPatterns.declared_class(bare)
		if found != null:
			header["class_name"] = found.get_string(1)
			if not found.get_string(2).is_empty():
				header["extends"] = found.get_string(2)
		elif bare.begins_with("extends "):
			header["extends"] = bare.substr(8).strip_edges()
	return header


# Modify an existing GDScript file by adding functions, variables, or signals
func modify_gdscript(params: Dictionary) -> Dictionary:
	var script_path: String = str(params.get("script_path", ""))
	var modifications: Array = params.get("modifications", [])

	_log.info("Modifying GDScript: " + script_path)

	var full_script_path: String = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	if not full_script_path.ends_with(".gd"):
		return _log.failure(_not_gdscript(full_script_path, "changes"))

	if not FileAccess.file_exists(full_script_path):
		return _log.failure(
			GdhFileWalk.new().with_nearest_files(
				"Script file does not exist: " + full_script_path, full_script_path
			)
		)

	var file: FileAccess = FileAccess.open(full_script_path, FileAccess.READ)
	if not file:
		return _log.failure("Failed to open script file: " + full_script_path)

	var original_content: String = file.get_as_text()
	file.close()

	var lines: Array[String] = []
	lines.assign(original_content.split("\n"))
	# Loaded only to learn whether it parsed as it was. What the engine says of that file carries
	# its old line numbers, and beside the errors of the file written it named lines that had moved.
	printerr(GdhLog.ASIDE)
	var before: Script = ResourceLoader.load(
		full_script_path, "Script", ResourceLoader.CACHE_MODE_IGNORE
	)
	printerr(GdhLog.RESUMED)
	var parsed_before: bool = _parses(before)

	# All of them checked before any is made, so a call is made whole or not at all: one skipped for
	# a missing name used to leave the rest written and the answer saying success over an empty
	# list.
	var declared: Dictionary = _declared(lines)
	var problems: Array[String] = _modification_problems(modifications, declared)
	if not problems.is_empty():
		var refusal: String = "Nothing was changed: " + "; ".join(problems)
		if _redeclares(modifications, declared):
			refusal += (
				". modify only adds members; to change one the script declares already,"
				+ " edit its lines in the file"
			)
		return _log.failure(refusal)
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
				(
					"Nothing was changed: "
					+ mod_type
					+ " "
					+ str(fields.get("name"))
					+ " could not be placed"
				)
			)
		placed.append({ "type": mod_type, "name": str(fields.get("name")), "index": at })

	var modifications_applied: Array[Dictionary] = []
	for entry: Dictionary in placed:
		var index: int = entry["index"]
		modifications_applied.append(
			{ "type": entry["type"], "name": entry["name"], "line": index + 1 }
		)

	file = FileAccess.open(full_script_path, FileAccess.WRITE)
	if not file:
		return _log.failure("Failed to write to script file: " + full_script_path)

	var rewrote: bool = file.store_string("\n".join(lines))
	file.close()
	if not rewrote:
		return _log.failure("Failed to write to script file: " + full_script_path)

	var caught: GdhScriptCheck.GdhCaught = GdhScriptCheck.GdhCaught.new()
	OS.add_logger(caught)
	var made: Script = ResourceLoader.load(
		full_script_path, "Script", ResourceLoader.CACHE_MODE_IGNORE
	)
	OS.remove_logger(caught)
	var parses: bool = _parses(made)
	# The names checked above are the script's own, and a member the base class declares, or a body
	# that does not compile, is found only by the engine; a script left broken by an addition breaks
	# every scene that uses it, so it goes back as it was. One already broken is written, as the
	# addition can be what mends it.
	if parsed_before and not parses:
		file = FileAccess.open(full_script_path, FileAccess.WRITE)
		var restored: bool = file != null and file.store_string(original_content)
		if file != null:
			file.close()
		if not restored:
			return _log.failure(
				(
					"%s would not parse with these additions, and could not be put back as it was"
					% script_path
				)
			)
		return _log.failure(
			(
				"Nothing was changed: %s parses now, and would not with these additions: %s"
				% [script_path, _reasons(caught.raised, full_script_path)]
			)
		)
	return {
		"success": true,
		"script_path": script_path,
		"modifications_applied": modifications_applied,
		"total_modifications": modifications_applied.size(),
		"parses": parses,
	}


# The engine's errors in [param raised] for [param path], each with its line, as one sentence part.
static func _reasons(raised: Array[Dictionary], path: String) -> String:
	var reasons: PackedStringArray = []
	for error: Dictionary in raised:
		var reason: String = "line %d, %s" % [GdhRead.as_int(error["line"]), str(error["message"])]
		if str(error["path"]) == path and not reason in reasons:
			var _added: bool = reasons.append(reason)
	if reasons.is_empty():
		return "the engine would not load it as a script."
	var last: String = reasons[-1]
	return "; ".join(reasons) + ("" if last.ends_with(".") or last.ends_with(".)") else ".")


# Why a script with [param named] as its class_name and extending [param base] cannot be written,
# or "". A class_name another script holds does not compile ("hides a global script class"), and nor
# does a base no class answers to; both were written and answered as made. Classes are read off the
# scripts as well as the class list, which a fresh clone has not written yet.
static func _header_refusal(named: String, base: String) -> String:
	var declared: Dictionary = _declared_classes()
	if not named.is_empty():
		if ClassDB.class_exists(named):
			return (
				"class_name %s is the name of an engine class, which a script cannot take." % named
			)
		if declared.has(named):
			return (
				(
					"class_name %s is taken: %s declares it, and a second script of that name does "
					+ "not compile. Give this one another class_name, or script_edit rename the "
					+ "first."
				)
				% [named, declared[named]]
			)
	if base.begins_with('"') or base.begins_with("'") or "." in base:
		return ""
	if ClassDB.class_exists(base) or declared.has(base):
		return ""
	var said: String = (
		"extends names %s, which is neither an engine class nor a class_name this project declares"
		% base
	)
	var close: PackedStringArray = GdhRead.nearest(base, PackedStringArray(declared.keys()))
	if close.is_empty():
		close = GdhRead.nearest(base, ClassDB.get_class_list())
	if close.is_empty():
		return said + "."
	return said + "; the nearest %s %s." % ["is" if close.size() == 1 else "are", ", ".join(close)]


## Why [param template] cannot be written on [param base], or "". Each template's code calls
## methods of the class it is written for, so a base outside it makes a script that does not parse.
## A base whose engine class cannot be read here is left to the engine's parse.
static func _template_refusal(template: String, base: String, script_path: String) -> String:
	var wanted: String = str(TEMPLATE_BASES.get(template, ""))
	var native: String = _engine_class_of(base, script_path)
	if wanted.is_empty() or native.is_empty():
		return ""
	if native == wanted or ClassDB.is_parent_class(native, wanted):
		return ""
	var named: String = base if native == base else "%s, a %s," % [base, native]
	return (
		(
			"The %s template is written for a %s, and extends %s is not one. Give extends a %s "
			+ "class, or leave it out for %s."
		)
		% [template, wanted, named, wanted, wanted]
	)


## The engine class [param base] comes down to: itself, the one beneath the script a class_name or
## a quoted path names, or "" when that script cannot be read.
static func _engine_class_of(base: String, script_path: String) -> String:
	if ClassDB.class_exists(base):
		return base
	var path: String = ""
	if base.begins_with('"') or base.begins_with("'"):
		path = base.substr(1, base.length() - 2)
		if not path.begins_with("res://") and not path.begins_with("uid://"):
			path = script_path.get_base_dir().path_join(path)
	else:
		path = str(_declared_classes().get(base, ""))
	if path.is_empty() or not ResourceLoader.exists(path):
		return ""
	var script: Script = ResourceLoader.load(path, "Script") as Script
	return "" if script == null else str(script.get_instance_base_type())


# The class_name each script of the project declares, by name, with its path.
static func _declared_classes() -> Dictionary:
	var declared: Dictionary = {}
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		var path: String = str(entry.get("path", ""))
		if FileAccess.file_exists(path):
			declared[str(entry.get("class", ""))] = path
	for path: String in GdhFileWalk.new().find_files("res://", ".gd"):
		for line: String in FileAccess.get_file_as_string(path).split("\n"):
			var found: RegExMatch = GdhPatterns.declared_class(
				GdhPatterns.without_annotations(line)
			)
			if found != null and not declared.has(found.get_string(1)):
				declared[found.get_string(1)] = path
	return declared


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
			problems.append(
				which + " is a constant with no defaultValue, and a constant needs a value"
			)
		if (
			not str(fields.get("exportHint", "")).is_empty()
			and fields.has("isExport")
			and not GdhRead.as_bool(fields["isExport"])
		):
			(
				problems
				. append(
					(
						which
						+ " has an exportHint and isExport false, and a hint is written only on an "
						+ "export"
					)
				)
			)
		if mod_name.is_empty():
			problems.append(which + " has no name")
			continue
		if not mod_name.is_valid_unicode_identifier():
			problems.append(
				which + " is named '" + mod_name + "', which GDScript does not accept as a name"
			)
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
			problems.append(
				"%s adds %s, which modification %d adds too" % [which, mod_name, added[mod_name]]
			)
		else:
			added[mod_name] = index + 1
	return problems


static func _redeclares(modifications: Array, declared: Dictionary) -> bool:
	for mod: Variant in modifications:
		if mod is Dictionary:
			var fields: Dictionary = mod
			if declared.has(str(fields.get("name", ""))):
				return true
	return false


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
			found[matched.get_string(2)] = { "kind": matched.get_string(1), "line": i + 1 }
	return found


# Inserts [param new_lines] at [param at] and moves every placed line at or below it down by as
# many.
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
	after = _past_class_doc(lines, after)
	# Set apart from the header or the signals above and from what follows, as the style guide lays
	# out its groups; one below the constants already there joins them.
	var block: Array[String] = [const_line]
	var above: String = lines[after - 1].strip_edges() if after > 0 else ""
	var below: String = lines[after].strip_edges() if after < lines.size() else ""
	if not above.is_empty() and not GdhPatterns.without_annotations(above).begins_with("const "):
		block.push_front("")
	if not below.is_empty() and not GdhPatterns.without_annotations(below).begins_with("const "):
		block.push_back("")
	return after + block.find(const_line) if _insert(lines, after, block, placed) else -1


# Inserts the declaration and answers with its zero-based index, or -1 for one that could not be
# placed.
func _add_variable(lines: Array[String], mod: Dictionary, placed: Array[Dictionary]) -> int:
	var var_name: String = str(mod.get("name", ""))
	var var_type: String = str(mod.get("varType", ""))
	var default_value: String = str(mod.get("defaultValue", ""))
	var export_hint: String = str(mod.get("exportHint", ""))
	# A hint can only mean an export, so a hint given alone writes one.
	var is_export: bool = GdhRead.as_bool(mod.get("isExport", not export_hint.is_empty()))
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
	# The first variable below the header or the signals is set apart from them by a blank line, as
	# the style guide and gdformat lay a script out.
	var above: String = lines[insert_line - 1].strip_edges() if insert_line > 0 else ""
	if not above.is_empty() and not GdhPatterns.without_annotations(above).begins_with("var "):
		return insert_line + 1 if _insert(lines, insert_line, ["", var_line], placed) else -1
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
	# Set apart by a blank line from the header above and from whatever follows that is not a
	# signal, as the style guide and gdformat lay the signals out.
	var block: Array[String] = [signal_line]
	var above: String = lines[insert_line - 1].strip_edges() if insert_line > 0 else ""
	var at: int = insert_line
	if not above.is_empty() and not GdhPatterns.without_annotations(above).begins_with("signal "):
		block.push_front("")
		at += 1
	var below: String = lines[insert_line].strip_edges() if insert_line < lines.size() else ""
	if not below.is_empty() and not GdhPatterns.without_annotations(below).begins_with("signal "):
		block.append("")
	return at if _insert(lines, insert_line, block, placed) else -1


# Answers with the zero-based index of the `func` line, below the blank lines that separate it.
#
# Two blank lines on each side, counting those already there, because that is the spacing GDScript's
# style guide gives functions and the one gdstyle and gdformat write: one blank line passed
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
	# since an indent alone on it is trailing whitespace to every formatter. Each level is the
	# file's own unit, because the engine refuses a file indented with spaces in one place and tabs
	# in another, so a tab put into a script indented with spaces stopped it parsing.
	var unit: String = _indent_unit(lines)
	var body_lines: Array[String] = []
	body_lines.assign(body.dedent().strip_edges(false, true).split("\n"))
	var given_unit: String = _indent_unit(body_lines)
	for bl: String in body_lines:
		if bl.strip_edges().is_empty():
			func_lines.append("")
			continue
		var stripped: String = bl.lstrip(" \t")
		var leading: String = bl.substr(0, bl.length() - stripped.length())
		var levels: int = floori(float(leading.length()) / given_unit.length())
		if leading != given_unit.repeat(levels):
			func_lines.append(unit + bl)
			continue
		func_lines.append(unit.repeat(levels + 1) + stripped)

	var below: int = _blank_run(lines, insert_line, 1)
	if insert_line + below < lines.size():
		for i: int in range(below, BLANKS_AROUND_FUNCTIONS):
			func_lines.append("")
	elif below == 0:
		func_lines.append("")

	return declared_at if _insert(lines, insert_line, func_lines, placed) else -1


## One level of indentation in [param lines]: what the first line indented below an unindented
## line ending a block opens with, or a tab, the engine's default, when no line is.
static func _indent_unit(lines: Array[String]) -> String:
	var opener: bool = false
	for line: String in lines:
		var stripped: String = line.strip_edges()
		if stripped.is_empty() or stripped.begins_with("#"):
			continue
		var leading: String = line.substr(0, line.length() - line.lstrip(" \t").length())
		if opener and not leading.is_empty():
			return leading
		opener = leading.is_empty() and stripped.ends_with(":")
	return "\t"


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
		# takes the new line above the `class_name`, where it does not parse. One that declares
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

	after_header = _past_class_doc(lines, after_header)
	for i: int in range(after_header, before_func):
		if GdhPatterns.without_annotations(lines[i]).begins_with("var "):
			after_header = i + 1

	return after_header


## [param at], or the line after the class's doc comment when [param at] follows the header and
## one opens there. Godot reads the `##` lines straight below `extends` as the class's own
## documentation, and a line put between them handed that documentation to the line put there.
static func _past_class_doc(lines: Array[String], at: int) -> int:
	if at == 0 or at > lines.size():
		return at
	var above: String = GdhPatterns.without_annotations(lines[at - 1])
	if not (above.begins_with("extends ") or above.begins_with("class_name ")):
		return at
	while at < lines.size() and lines[at].strip_edges().begins_with("##"):
		at += 1
	return at


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

	return _past_class_doc(lines, after_header)


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
# annotations directly above it, at its indentation. A function placed on [param at] itself takes
# the next function's doc comment, which then documents the wrong one, and its `@rpc` line, which
# then annotates it. A comment indented further is the end of the body above, and stays with it.
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
			return """## One instance for the whole game, which the project makes at start once
## project_settings add_autoload names it, and every script reaches by that name.


func _ready() -> void:
\tpass
"""
		"state_machine":
			# The made script's first line, which is under the limit in the file it is written to.
			# gdstyle:ignore=format/max-line-length
			return """## A finite state machine: one state at a time, entered and left through change_state.

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
			# gdstyle:ignore=format/max-line-length
			return """## A component: a child node that adds one behaviour to its parent, switched off with disable().

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
			# gdstyle:ignore=format/max-line-length
			return """## Data kept in a .tres file, which resource_edit create makes and the game loads.

@export var id: String = ""
@export var display_name: String = ""
@export var description: String = ""


func _init(p_id: String = "", p_name: String = "", p_desc: String = "") -> void:
\tid = p_id
\tdisplay_name = p_name
\tdescription = p_desc
"""
		_:
			return ""
