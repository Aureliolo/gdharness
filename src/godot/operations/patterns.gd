extends RefCounted

# A compiled regular expression, with a pattern that will not compile said rather than dropped.
#
# `RegEx.compile()` answers with an Error, and every caller here passes a literal its author had
# already checked by eye, so the answer was thrown away eleven times. A project holding
# `return_value_discarded` at error level will not compile a script that does that, and these
# scripts are compiled under the target project's warning levels rather than under this package's:
# one project turning that warning on loses every headless operation at once.
#
# A pattern that fails here is a mistake in this repository rather than anything a caller did, so
# it goes to the engine's error stream, where the operation's answer carries it back under
# `engine_messages`. The empty RegEx it then returns matches nothing, which is the honest result of
# a pattern that does not exist.

# Kept, because the readers below call these per line of every script in a project and a fresh
# compile each time is the whole cost of the scan. The patterns are literals in this repository, so
# the set is bounded by the source rather than by anything a caller passes.
static var _compiled: Dictionary = {}


static func compiled(expression: String) -> RegEx:
	if _compiled.has(expression):
		var held: RegEx = _compiled[expression]
		return held
	var regex: RegEx = RegEx.new()
	var built: Error = regex.compile(expression)
	if built != OK:
		push_error("gdharness: could not compile the pattern " + expression)
	_compiled[expression] = regex
	return regex


# What a header line declares: the class name, and the base named on the same line if there is one.
#
# `class_name X extends Y` is one line, so a reader that takes the rest of the line as the name gets
# `Blade extends Node2D` for the class and never sees the base at all.
static func declared_class(line: String) -> RegExMatch:
	return compiled("^class_name\\s+([A-Za-z_][A-Za-z0-9_]*)(?:\\s+extends\\s+(\\S+))?").search(line)


# A line with its leading annotations taken off, for anything reading a script's header.
#
# Annotations may share a line with what they annotate: `@abstract class_name X` is one line in
# Godot 4.5 and later, and `@tool` and `@icon("res://x.svg")` sit there too. Four readers here
# matched on `class_name` at the start of a line and so saw none of those as a declaration at all,
# which cost a project with gdUnit4 in it 23 classes reported as declared nowhere, and put a
# `script_edit` insertion above the `class_name` of a script whose whole header is that one line,
# where it does not parse. The scanner that writes the class cache had its own copy of this and was
# right, which is why only the readings were wrong.
#
# One home, because five spellings of the same rule is five things to remember when the language
# adds the next annotation.
static func without_annotations(line: String) -> String:
	var annotation: RegEx = compiled('^@[a-z_]+(?:\\(\\s*(?:"[^"]*")?[^)]*\\))?\\s*')
	var rest: String = line.strip_edges()
	var found: RegExMatch = annotation.search(rest)
	while found != null:
		rest = rest.substr(found.get_end()).strip_edges()
		found = annotation.search(rest)
	return rest
