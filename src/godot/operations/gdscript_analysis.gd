extends RefCounted

const GdhDependencies = preload("dependencies.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhPatterns = preload("patterns.gd")
const GdhRead = preload("reading.gd")
const GdhLog = preload("logger.gd")

var _log: GdhLog
## Kept for the call, so the project's class names are read once however many bases are walked.
var _dependencies: GdhDependencies = null
## The script being read, which an inner class's base is resolved against.
var _reading: String = ""


func _init(p_log: GdhLog) -> void:
	_log = p_log


# Analyze a GDScript file and return its structure
func get_gdscript_info(params: Dictionary) -> Dictionary:
	var script_path: String = str(params.get("script_path", ""))

	_log.info("Analyzing GDScript: " + script_path)

	var full_script_path: String = script_path
	if not full_script_path.begins_with("res://"):
		full_script_path = "res://" + full_script_path

	# Read as GDScript, a scene came back as a script extending RefCounted with nothing in it.
	if full_script_path.get_extension().to_lower() != "gd":
		return _log.failure(_not_a_script(full_script_path))
	if not FileAccess.file_exists(full_script_path):
		return _log.failure(
			GdhFileWalk.new().with_nearest_files(
				"Script file does not exist: " + full_script_path, full_script_path
			)
		)

	var file: FileAccess = FileAccess.open(full_script_path, FileAccess.READ)
	if not file:
		return _log.failure("Failed to open script file: " + full_script_path)

	var content: String = file.get_as_text()
	file.close()

	var lines: PackedStringArray = content.split("\n")

	var dependencies: Array[String] = []
	_reading = full_script_path
	var own: GdhMembers = _members(lines, 0, "", dependencies)
	var extends_name: String = own.extends_name
	var functions: Array[Dictionary] = own.functions

	# After the walk, because it needs the base the walk reads, and a file that declared one after
	# its first function would otherwise be judged against the default.
	_mark_virtuals(functions, extends_name, full_script_path)

	# The engine loads a base named by its path and a constant handed to load or preload as surely
	# as a path written in the call, and both were left out while project_dependencies named them: a
	# script extending "frame.gd" did not depend on it, nor one calling load(TYPE_CASE).
	for written: String in _based_on_paths(extends_name, own.inner_classes):
		if not written in dependencies:
			dependencies.append(written)
	var held: Dictionary = {}
	for constant: Dictionary in own.constants:
		held[str(constant.get("name", ""))] = _unquoted(str(constant.get("value", "")))
	for code: String in GdhDependencies.code_by_line(content):
		for loading: RegExMatch in (
			GdhPatterns
			. compiled("(?<![\\w.])(?:preload|load)\\s*\\(\\s*([A-Za-z_]\\w*)\\s*\\)")
			. search_all(code)
		):
			var written: String = str(held.get(loading.get_string(1), ""))
			if not written.is_empty() and not written in dependencies:
				dependencies.append(written)

	# A script typed by its class_name is depended on as surely as one preloaded, and the answer
	# listed only the preloads: a `var stats: Stats` left stats.gd out, while project_dependencies
	# named it. The same reading as that tool's, so the two agree.
	var classes_used: Array[Dictionary] = []
	if _dependencies == null:
		_dependencies = GdhDependencies.new(_log)
	var declared_by: Dictionary = _dependencies.classes_declared()
	for used: String in GdhDependencies.classes_used_in(content, declared_by):
		var declaring: String = str(declared_by[used])
		if declaring == full_script_path:
			continue
		classes_used.append({ "name": used, "path": declaring })
		if not declaring in dependencies:
			dependencies.append(declaring)

	# An autoload is named the way a class is, and its script is one this one needs to compile, but
	# the project loads it rather than this script, so it is answered apart from dependencies.
	var global_autoloads: Dictionary = {}
	for property: Dictionary in ProjectSettings.get_property_list():
		var setting: String = str(property.get("name", ""))
		var value: String = (
			str(ProjectSettings.get_setting(setting)) if setting.begins_with("autoload/") else ""
		)
		if value.begins_with("*"):
			global_autoloads[setting.trim_prefix("autoload/")] = value.trim_prefix("*")
	var autoloads_used: Array[Dictionary] = []
	for used: String in GdhDependencies.classes_used_in(content, global_autoloads):
		if str(global_autoloads[used]) != full_script_path:
			autoloads_used.append({ "name": used, "path": str(global_autoloads[used]) })

	var answer: Dictionary = {
		"path": script_path,
		"full_path": full_script_path,
		"class_name": own.declared_class_name,
		"extends": extends_name,
		"signals": own.signals,
		"variables": own.variables,
		"functions": functions,
		"constants": own.constants,
		"enums": own.enums,
		"inner_classes": own.inner_classes,
		"dependencies": dependencies,
		"classes_used": classes_used,
		"autoloads_used": autoloads_used,
		"line_count":
		lines.size() - 1 if content.is_empty() or content.ends_with("\n") else lines.size(),
	}
	if not own.doc.is_empty():
		answer["class_doc"] = own.doc
	if GdhRead.as_bool(params.get("include_inherited", false)):
		_add_inherited(answer, [full_script_path])
	return answer


## What one class body declares: the script's own at the left margin, or an inner class's at the
## indent [param margin] its body is written at, read from line [param first] to the first line
## less indented than that. [param dependencies] collects what every line loads, bodies included.
func _members(
	lines: PackedStringArray, first: int, margin: String, dependencies: Array[String]
) -> GdhMembers:
	var own: GdhMembers = GdhMembers.new()
	var in_multiline_string: bool = false
	var doc: Array[String] = []

	var i: int = first - 1
	while i + 1 < lines.size():
		i += 1
		# The comment off first, so nothing downstream has to know about them. It was reaching the
		# answer: a `var x: int = 5  # note` carried `5  # note` as its default, and correcting the
		# end of a parameter list put the comment into the return type, where `rfind(")")` had been
		# hiding it by stopping inside the comment instead.
		var raw: String = lines[i]
		# Inside a string the raw line is counted, because a `#` in it is text and taking it for a
		# comment would cut off the quotes that close the string.
		if in_multiline_string:
			if GdhPatterns.triple_quotes(raw) % 2 == 1:
				in_multiline_string = false
			continue
		# A `##` block documents what it sits directly above: the class when that is its class_name
		# or extends line, or when a blank line follows it before any member, and otherwise the next
		# member. One at a shallower indent is the outer body's, for what follows this inner class.
		var trimmed: String = raw.strip_edges()
		if trimmed.begins_with("##"):
			if not raw.begins_with(margin):
				own.last = i - 1
				return own
			if _indentation(raw).length() <= margin.length():
				var said: String = trimmed.substr(2)
				doc.append(said.substr(1) if said.begins_with(" ") else said)
			continue
		var stripped: String = GdhPatterns.without_comment(raw)

		if stripped.is_empty():
			if trimmed.is_empty() and not doc.is_empty():
				if not own.declares_members():
					own.take_doc(doc)
				doc.clear()
			continue

		# A line back at a shallower indent closes an inner class's body, and is the outer body's
		# to read.
		if not raw.begins_with(margin):
			own.last = i - 1
			return own

		# An odd count opens a string that runs on. An even one is a string that closed on the line
		# it opened on. Toggling on any count lost `const HELP := """Usage"""`, and everything after
		# it up to the next triple quote, with the state inverted from there to the end of the file.
		# The line that opens one is still read: it can be the declaration the string belongs to.
		if GdhPatterns.triple_quotes(stripped) % 2 == 1:
			in_multiline_string = true

		# Only a line at this body's own margin declares one of its members. Deeper, it is a
		# function's local or an inner class's member, and each was answered as the script's own:
		# every `var` in every body, and an inner class's `extends` taken for the script's base.
		var indented: String = raw.substr(margin.length())
		if indented.begins_with(" ") or indented.begins_with("\t"):
			_collect_dependencies(stripped, dependencies)
			continue

		# Annotations may share the line with anything they annotate, so every branch below decides
		# on the line with them off. `@abstract class_name X` was reported as no declared class,
		# and `@abstract func x()` and `@warning_ignore("...") func x()` as no function at all:
		# gdUnit4 alone declares 248 methods that way and this answered with none of them.
		var header: String = GdhPatterns.without_annotations(stripped)

		var at: int = i
		# A declaration wrapped across lines is one declaration, and reading the first line alone
		# answered with the half that was not wrapped away: `values: []` for every `enum X {` on its
		# own line and `params: []` with no return type for every `func x(`. `gdformat` wraps
		# anything past the line length, so that is what a formatted project looks like: 23 and 19
		# of them in gdUnit4 v6.2.1, 55 in one game project, and four in this addon.
		#
		# Only a declaration, because an unbalanced line anywhere else is a file mid-edit and
		# joining from one swallows the rest of it: a body holding `print(` with nothing closing it
		# took every declaration below it, which is the state an agent is most likely to ask about.
		# `header` rather than `stripped`: an annotation in front pushes the keyword off the start
		# of the line, so asking the raw line whether it can wrap says no to every annotated
		# declaration that does. Held by the combined case, which nothing else in the fixture
		# reaches: the single-feature cases each carry one of these and never a second.
		if _can_wrap(header):
			while _bracket_depth(stripped) > 0 and i + 1 < lines.size():
				i += 1
				stripped = (stripped + " " + GdhPatterns.without_comment(lines[i])).strip_edges()
			header = GdhPatterns.without_annotations(stripped)
		# A value that opens a triple-quoted string ends where the string does, and read from its
		# first line alone it was the opening quotes and the text up to the line break.
		if in_multiline_string and (header.begins_with("const ") or _declares_variable(header)):
			while i + 1 < lines.size():
				i += 1
				stripped += "\n" + lines[i]
				if GdhPatterns.triple_quotes(lines[i]) % 2 == 1:
					break
			in_multiline_string = false
			header = GdhPatterns.without_annotations(stripped)
		var declaration: RegExMatch = GdhPatterns.declared_class(header)
		var entry: Dictionary = {}
		if declaration != null:
			own.declared_class_name = declaration.get_string(1)
			# `class_name X extends Y` is also one line, and taking the rest of it as the name
			# reported `Blade extends Node2D` as the class while `extends` kept its default of
			# `RefCounted`: the name unusable and the base flatly wrong.
			if not declaration.get_string(2).is_empty():
				own.extends_name = declaration.get_string(2)
			own.take_doc(doc)
		elif header.begins_with("extends "):
			own.extends_name = header.substr(8).strip_edges()
			own.take_doc(doc)
		elif header.begins_with("signal "):
			# `at`, not `i`: a wrapped declaration starts where it starts, and `i` is now sitting on
			# the line that closed it.
			entry = _parse_signal(header, at + 1)
			own.signals.append(entry)
		elif header.begins_with("const "):
			entry = _parse_constant(header, at + 1)
			own.constants.append(entry)
		elif header.begins_with("enum "):
			entry = _parse_enum(header, at + 1)
			own.enums.append(entry)
		elif _declares_variable(header):
			# The whole line here, not the header: which annotations a variable carries is the
			# answer rather than noise in front of it, and `@export_range(0, 1)` is the hint.
			entry = _parse_variable(stripped, at + 1)
			own.variables.append(entry)
		elif header.begins_with("func ") or header.begins_with("static func "):
			entry = _parse_function(header, at + 1, stripped)
			own.functions.append(entry)
		elif header.begins_with("class "):
			_collect_dependencies(stripped, dependencies)
			var inner: GdhMembers = _inner_class(lines, i, margin, header, dependencies)
			entry = inner.as_inner()
			if not doc.is_empty():
				entry["doc"] = "\n".join(PackedStringArray(doc))
			doc.clear()
			own.inner_classes.append(entry)
			i = inner.last
			continue

		if not entry.is_empty() and not doc.is_empty():
			entry["doc"] = "\n".join(PackedStringArray(doc))
		# A line of annotations alone, `@tool` or `@export` above its variable, is between a comment
		# and what it documents rather than after it.
		if not header.is_empty():
			doc.clear()

		_collect_dependencies(stripped, dependencies)

	own.last = lines.size() - 1
	return own


## The inner class whose `class` line is [param at], [param header] with its annotations and
## comment off, read with the members its body declares. Answered as a name alone, its members
## were in no answer at all.
func _inner_class(
	lines: PackedStringArray, at: int, margin: String, header: String, dependencies: Array[String]
) -> GdhMembers:
	var signature: String = _up_to(header.substr(6), ":").strip_edges()
	var based: String = ""
	if " extends " in signature:
		based = signature.get_slice(" extends ", 1).strip_edges()
	# The body is at the indent of its first line, whatever this file indents with.
	var body_margin: String = ""
	for next: int in range(at + 1, lines.size()):
		if GdhPatterns.without_comment(lines[next]).is_empty():
			continue
		var indent: String = _indentation(lines[next])
		if indent.length() > margin.length() and lines[next].begins_with(margin):
			body_margin = indent
		break
	var body: GdhMembers = (
		GdhMembers.new()
		if body_margin.is_empty()
		else _members(lines, at + 1, body_margin, dependencies)
	)
	if body_margin.is_empty():
		body.last = at
	if not based.is_empty():
		body.extends_name = based
	body.inner_name = signature.get_slice(" ", 0)
	body.line = at + 1
	_mark_virtuals(body.functions, body.extends_name, _reading)
	return body


## The refusal for [param path], which is not a .gd file, with the tool that reads what it is.
static func _not_a_script(path: String) -> String:
	var said: String = "%s is not a GDScript file, and script_info reads .gd files only" % path
	match path.get_extension().to_lower():
		"tscn", "scn":
			return (
				said
				+ ": scene_tree reads a scene's nodes, and with properties the script each carries."
			)
		"tres", "res":
			return said + ": resource_edit read reads a resource."
		"":
			# A class name given where the path goes.
			var named: String = path.get_file()
			for entry: Dictionary in ProjectSettings.get_global_class_list():
				if str(entry.get("class", "")) == named:
					return (
						said
						+ (
							": %s is the class_name of %s. Call script_info with that path."
							% [named, str(entry.get("path", ""))]
						)
					)
			if ClassDB.class_exists(named):
				return (
					said
					+ ": %s is an engine class. Call editor_classes info for its members." % named
				)
	return said + "."


static func _indentation(line: String) -> String:
	return line.substr(0, line.length() - line.strip_edges(true, false).length())


# Which of these functions the engine will call, asked of the engine.
#
# `is_virtual` was `name.begins_with("_")`, which is the convention for a private method and not
# what the field says: it reported `_compute_damage` as something the engine calls, on every script
# with a private helper in it. The virtuals are the ones the native ancestor declares with
# `METHOD_FLAG_VIRTUAL`, which is a question `ClassDB` answers exactly, and `class_has_method` does
# not: it says false for `_ready` on `Node`, so the method list is what has to be walked.
func _mark_virtuals(functions: Array[Dictionary], extends_name: String, from_path: String) -> void:
	var native: String = _native_ancestor(extends_name, from_path)
	var virtuals: Dictionary = {}
	if not native.is_empty():
		for m: Dictionary in ClassDB.class_get_method_list(native, false):
			var flags: int = GdhRead.as_int(m.get("flags", 0))
			if flags & METHOD_FLAG_VIRTUAL:
				virtuals[str(m.get("name", ""))] = true
	for one: Dictionary in functions:
		one["is_virtual"] = virtuals.has(str(one.get("name", "")))


# The native class at the top of this script's chain, or empty when the chain does not reach one.
#
# A base named by a script is followed. A base that is neither a script nor a class the engine knows
# leaves nothing to ask, and then no function is called virtual rather than every underscore being
# guessed at.
func _native_ancestor(base: String, from_path: String) -> String:
	var seen: Array[String] = []
	var current: String = base
	var declared_in: String = from_path
	while true:
		var path: String = _script_named(current, declared_in)
		if path.is_empty():
			break
		if path in seen:
			return ""
		seen.append(path)
		var above: Dictionary = get_gdscript_info({ "script_path": path })
		if above.is_empty():
			return ""
		current = str(above.get("extends", ""))
		declared_in = path
	return current if ClassDB.class_exists(current) else ""


# The members this script's ancestors declare, appended to the lists they belong in.
#
# Only the script ancestors: `extends` naming a native class is ClassDB's question and
# `editor_classes info` answers it with the whole hierarchy. A base is reachable either as a quoted
# `res://` path or as a `class_name` in the project's class list, and a script whose base is neither
# has no ancestor to read, which the answer says by leaving `inherits_from` short rather than by
# refusing. Each entry carries `inherited_from`, so a caller can tell a member the script declares
# from one it is given. A name a script overrides appears twice, at both lines, on purpose.
func _add_inherited(answer: Dictionary, seen: Array[String]) -> void:
	var inherits_from: Array[String] = []
	var base: String = str(answer.get("extends", ""))
	var declared_in: String = str(answer.get("full_path", ""))
	while true:
		var base_path: String = _script_named(base, declared_in)
		if base_path.is_empty() or base_path in seen:
			break
		seen.append(base_path)
		var above: Dictionary = get_gdscript_info({ "script_path": base_path })
		# A read that failed answers with an empty dictionary rather than with a flag, so that is
		# what is asked. `_script_named` has already checked the file is there, which leaves only
		# an open that fails, and the chain stops without recording a file nothing was read from.
		if above.is_empty():
			break
		inherits_from.append(base_path)
		for list_name: String in [
			"signals", "variables", "functions", "constants", "enums", "inner_classes",
		]:
			var mine: Array[Dictionary] = answer[list_name]
			var theirs: Array[Dictionary] = above[list_name]
			for member: Dictionary in theirs:
				var carried: Dictionary = member.duplicate()
				carried["inherited_from"] = base_path
				mine.append(carried)
		base = str(above.get("extends", ""))
		declared_in = base_path
	answer["inherits_from"] = inherits_from


# The file a base names, whether it named a path or a class, or empty for a native class.
#
# A quoted path is resolved the way the engine resolves it: `extends "base.gd"` is relative to the
# script [param declared_in], and asking whether `base.gd` exists asked about nothing, so such a
# script had no ancestor and none of its engine callbacks were virtual.
func _script_named(base: String, declared_in: String) -> String:
	if base.is_empty():
		return ""
	var quoted: String = ""
	if base.length() >= 2 and (base[0] == '"' or base[0] == "'") and base.ends_with(base[0]):
		quoted = base.substr(1, base.length() - 2)
	if not quoted.is_empty():
		if quoted.begins_with("uid://"):
			var id: int = ResourceUID.text_to_id(quoted)
			quoted = ResourceUID.get_id_path(id) if ResourceUID.has_id(id) else ""
		elif not quoted.begins_with("res://"):
			quoted = declared_in.get_base_dir().path_join(quoted).simplify_path()
		return quoted if not quoted.is_empty() and FileAccess.file_exists(quoted) else ""
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
		var paren_start: int = signal_text.find("(")
		signal_name = signal_text.substr(0, paren_start).strip_edges()
		# Through the same reader as a function's, because a signal's parameters are written the
		# same way: `signal changed(d: Dictionary[String, int])` has one, and splitting on every
		# comma answered with two.
		var paren_end: int = _closing_paren(signal_text, paren_start)
		if paren_end > paren_start:
			for p: String in _arguments_in(
				signal_text.substr(paren_start + 1, paren_end - paren_start - 1)
			):
				params.append(_parse_param(p))
	else:
		signal_name = signal_text

	return { "name": signal_name, "params": params, "line": line_num }


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

	var constant: Dictionary = { "name": name, "value": value, "type": type_hint, "line": line_num }
	# A constant has its value's type whether or not it is written with :=.
	if type_hint.is_empty():
		_infer(constant, value)
	return constant


## Gives [param declared] the type GDScript infers from [param value], marked inferred, when the
## value is a literal or a built-in type's constructor: `const MAX_STACK := 99` read as having no
## type though the engine holds an int. Any other expression is left without one, since only the
## engine's analyser knows what it gives.
static func _infer(declared: Dictionary, value: String) -> void:
	# A variable with a setter or getter ends its line with the colon that opens them.
	var text: String = value.strip_edges().trim_suffix(":").strip_edges()
	var type: String = ""
	if text == "true" or text == "false":
		type = "bool"
	elif text.is_valid_int() or text.is_valid_hex_number(true):
		type = "int"
	elif text.is_valid_float():
		type = "float"
	elif text.begins_with('&"') and text.ends_with('"'):
		type = "StringName"
	elif text.begins_with('^"') and text.ends_with('"'):
		type = "NodePath"
	elif text.length() > 1 and text[0] in ['"', "'"] and text.ends_with(text[0]):
		type = "String"
	elif _whole(text, "[", "]"):
		type = "Array"
	elif _whole(text, "{", "}"):
		type = "Dictionary"
	else:
		var called: String = text.get_slice("(", 0).strip_edges()
		if _whole(text.substr(called.length()), "(", ")") and _built_in_types().has(called):
			type = called
	if not type.is_empty():
		declared["type"] = type
		declared["inferred"] = true


## Whether [param text] is one bracketed whole, its first [param opening] closed by its last
## character, so `[1, 2]` is a list and `[1, 2].size()` is not.
static func _whole(text: String, opening: String, closing: String) -> bool:
	if not text.begins_with(opening) or not text.ends_with(closing):
		return false
	var depth: int = 0
	for index: int in text.length():
		if text[index] == opening:
			depth += 1
		elif text[index] == closing:
			depth -= 1
			if depth == 0:
				return index == text.length() - 1
	return false


static func _built_in_types() -> Dictionary:
	var names: Dictionary = {}
	for type: int in TYPE_MAX:
		names[type_string(type)] = true
	return names


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

	return { "name": enum_name, "values": values, "line": line_num }


func _parse_variable(line: String, line_num: int) -> Dictionary:
	var is_export: bool = false
	var is_onready: bool = false
	var export_hint: String = ""

	# From the annotations themselves rather than from where they sit. `@onready @export var x` put
	# the export second and so read as not exported, and a hint with a space in it was cut at it.
	for one: String in GdhPatterns.annotations_on(line):
		if one.begins_with("export"):
			is_export = true
			var after: String = one.substr(6)
			if after.begins_with("_"):
				export_hint = after.substr(1)
		elif one == "onready":
			is_onready = true

	var var_pos: int = line.find("var ")
	if var_pos == -1:
		return { "name": "", "line": line_num }

	var var_text: String = line.substr(var_pos + 4).strip_edges()
	# A colon closing the line opens the variable's setter and getter, and was read as the end of
	# its default: `= Kind.ROUND:`.
	if var_text.ends_with(":"):
		var_text = var_text.left(-1).strip_edges()
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

	# Null for a declaration with no value, which as an empty string read as `= ""`.
	var stated_default: Variant = null
	if "=" in var_text:
		stated_default = default_value

	var variable: Dictionary = {
		"name": name,
		"type": type_hint,
		"default_value": stated_default,
		"is_export": is_export,
		"export_hint": export_hint,
		"is_onready": is_onready,
		# One per class rather than per instance, which a caller reading a counter needs to know.
		"is_static": GdhPatterns.without_annotations(line).begins_with("static "),
		"line": line_num,
	}
	# Only := types a variable by its value. One written with = alone holds any type.
	var walrus: bool = (
		"=" in var_text and var_text.split("=", true, 1)[0].strip_edges().ends_with(":")
	)
	if walrus and type_hint.is_empty():
		_infer(variable, default_value)
	return variable


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

		var paren_end: int = _closing_paren(func_text, paren_start)
		if paren_end > paren_start:
			var params_text: String = func_text.substr(paren_start + 1, paren_end - paren_start - 1)
			for p: String in _arguments_in(params_text):
				params.append(_parse_param(p))

		var after_paren: String = func_text.substr(paren_end + 1).strip_edges()
		if after_paren.begins_with("->"):
			# Cut at the colon that ends the signature rather than deleting every colon in the
			# rest of the line: `func noted(a: int) -> void: print(a)` is one line, and the old
			# reading answered with `void print(a)` as the return type.
			return_type = _up_to(after_paren.substr(2), ":").strip_edges()

	return {
		"name": name,
		"params": params,
		"return_type": return_type,
		# Filled in after the whole file is read, once the base is known. See `_mark_virtuals`.
		"is_virtual": false,
		"is_static": is_static,
		# Said rather than left to be inferred: an abstract method has no body, so a caller that
		# saw only the declaration would otherwise take it for one whose body it failed to read.
		"is_abstract": "abstract" in GdhPatterns.annotations_on(annotated),
		"line": line_num,
	}


# The commas that separate arguments are the ones outside every bracket and every string, and
# `split(",")` could not tell them from the rest.
#
# `func place(at: Vector2 = Vector2(1, 2), name: String = "a,b")` has two parameters and was
# answered with five, three of them invented and named after the pieces the split left behind:
# `2)`, `b"`. Each real one also lost its default to the truncation, `Vector2(1`. A `Vector2` or
# `Color` default is ordinary Godot, and a caller building a call from that signature writes
# arguments that are not identifiers.
func _arguments_in(text: String) -> Array[String]:
	var pieces: Array[String] = []
	var depth: int = 0
	var quote: String = ""
	var current: String = ""
	for i: int in range(text.length()):
		var ch: String = text[i]
		if not quote.is_empty():
			current += ch
			if ch == quote and text[i - 1] != "\\":
				quote = ""
			continue
		if ch == '"' or ch == "'":
			quote = ch
			current += ch
			continue
		if ch == "(" or ch == "[" or ch == "{":
			depth += 1
		elif ch == ")" or ch == "]" or ch == "}":
			depth -= 1
		elif ch == "," and depth == 0:
			pieces.append(current.strip_edges())
			current = ""
			continue
		current += ch
	if not current.strip_edges().is_empty():
		pieces.append(current.strip_edges())
	return pieces


# Whether this is a declaration whose brackets may carry on to the next line.
func _can_wrap(header: String) -> bool:
	for keyword: String in ["func ", "static func ", "enum ", "signal ", "var ", "const "]:
		if header.begins_with(keyword):
			return true
	return false


# How much this line opens that it does not close, ignoring brackets inside strings.
func _bracket_depth(text: String) -> int:
	var depth: int = 0
	var quote: String = ""
	for i: int in range(text.length()):
		var ch: String = text[i]
		if not quote.is_empty():
			if ch == quote and text[i - 1] != "\\":
				quote = ""
			continue
		if ch == '"' or ch == "'":
			quote = ch
		elif ch == "(" or ch == "[" or ch == "{":
			depth += 1
		elif ch == ")" or ch == "]" or ch == "}":
			depth -= 1
	return depth


# The text up to the first [needle] outside every bracket and every string, or all of it.
func _up_to(text: String, needle: String) -> String:
	var depth: int = 0
	var quote: String = ""
	for i: int in range(text.length()):
		var ch: String = text[i]
		if not quote.is_empty():
			if ch == quote and text[i - 1] != "\\":
				quote = ""
			continue
		if ch == '"' or ch == "'":
			quote = ch
		elif ch == "(" or ch == "[" or ch == "{":
			depth += 1
		elif ch == ")" or ch == "]" or ch == "}":
			depth -= 1
		elif ch == needle and depth == 0:
			return text.substr(0, i)
	return text


# Where the bracket opened at [from] closes, or -1 if it does not.
#
# `rfind(")")` took the last one on the line, which is the right answer until something after the
# signature has a bracket in it: a trailing comment, or a string in a default value.
func _closing_paren(text: String, from: int) -> int:
	var depth: int = 0
	var quote: String = ""
	for i: int in range(from, text.length()):
		var ch: String = text[i]
		if not quote.is_empty():
			if ch == quote and text[i - 1] != "\\":
				quote = ""
			continue
		if ch == '"' or ch == "'":
			quote = ch
			continue
		if ch == "(" or ch == "[" or ch == "{":
			depth += 1
		elif ch == ")" or ch == "]" or ch == "}":
			depth -= 1
			if depth == 0:
				return i
	return -1


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

	# `...rest: Array` is a rest parameter, and the dots are the syntax rather than part of what it
	# is called: answering `...rest` as the name gives a caller building a call site a name it
	# cannot use. gdUnit4 alone declares 56 of these.
	var is_rest: bool = name.begins_with("...")
	if is_rest:
		name = name.substr(3).strip_edges()

	var stated_default: Variant = null
	if "=" in param_text:
		stated_default = default_value
	return { "name": name, "type": type_hint, "default": stated_default, "is_rest": is_rest }


func _collect_dependencies(line: String, into: Array[String]) -> void:
	if "load(" not in line:
		return
	for dep: String in _extract_dependencies(line):
		if dep not in into:
			into.append(dep)


## The paths a script and its inner classes extend by, as written: [param extends_name] the
## script's own extends, and [param inner_classes] its inner classes as answered.
static func _based_on_paths(extends_name: String, inner_classes: Array) -> Array[String]:
	var paths: Array[String] = []
	var written: String = _unquoted(extends_name)
	if not written.is_empty():
		paths.append(written)
	for inner: Dictionary in inner_classes:
		var deeper: Array = inner.get("inner_classes", [])
		for path: String in _based_on_paths(str(inner.get("extends", "")), deeper):
			if not path in paths:
				paths.append(path)
	return paths


## The text of [param literal], a string literal as written. Empty for anything else.
static func _unquoted(literal: String) -> String:
	var text: String = literal.strip_edges()
	if text.length() >= 2 and text[0] in ["\"", "'"] and text[-1] == text[0]:
		return text.substr(1, text.length() - 2)
	return ""


static func _declares_variable(header: String) -> bool:
	return header.begins_with("var ") or header.begins_with("static var ")


func _extract_dependencies(line: String) -> Array[String]:
	var deps: Array[String] = []
	var regex: RegEx = GdhPatterns.compiled("(?:preload|load)\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)")

	for m: RegExMatch in regex.search_all(line):
		deps.append(m.get_string(1))

	return deps


## What one class body declares, the script's own or an inner class's.
class GdhMembers:
	var declared_class_name: Variant = null

	var extends_name: String = "RefCounted"

	var signals: Array[Dictionary] = []

	var variables: Array[Dictionary] = []

	var functions: Array[Dictionary] = []

	var constants: Array[Dictionary] = []

	var enums: Array[Dictionary] = []

	var inner_classes: Array[Dictionary] = []

	## The `##` comment the class is documented with, empty when it has none.
	var doc: String = ""

	## The index of the last line the body holds.
	var last: int = -1

	## An inner class's name and the line its `class` is on.
	var inner_name: String = ""

	var line: int = 0

	## The inner class as its entry under inner_classes, in the fields a script's own are in.
	func as_inner() -> Dictionary:
		return {
			"name": inner_name,
			"line": line,
			"extends": extends_name,
			"signals": signals,
			"variables": variables,
			"functions": functions,
			"constants": constants,
			"enums": enums,
			"inner_classes": inner_classes,
		}

	## Whether a member is declared yet, past which a `##` block no longer documents the class.
	func declares_members() -> bool:
		return not (
			signals.is_empty()
			and variables.is_empty()
			and functions.is_empty()
			and constants.is_empty()
			and enums.is_empty()
			and inner_classes.is_empty()
		)

	## [param lines] as the class's documentation, when it has none yet.
	func take_doc(lines: Array[String]) -> void:
		if doc.is_empty() and not lines.is_empty():
			doc = "\n".join(PackedStringArray(lines))
