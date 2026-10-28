@tool
extends RefCounted
## The node paths a GDScript names in its own source, from the node it is on: `$Path`, `%Unique`,
## and a string handed to get_node, get_node_or_null or has_node called on itself. Read from the
## tokens rather than the lines, so a `$` or a `%` inside a string or a comment names nothing, and
## a `%` after an operand is the remainder of a division rather than a unique name.

enum {
	NAME,
	STRING,
	MARK,
}

## The calls that take a path from the node they are called on.
const CALLS: Array[String] = ["get_node", "get_node_or_null", "has_node"]
## The words after which a `%` starts an operand.
const OPERAND_AFTER: Array[String] = [
	"return", "and", "or", "not", "in", "if", "elif", "while", "await", "match", "when", "else",
]
## The marks after which a `%` starts an operand: an opening bracket, a separator or an operator.
const OPERAND_AFTER_MARKS: String = "([{,=:;+-*/<>!&|^~%"
const MARKS: String = "+-*/%<>=!&|^~()[]{},.:;$@?\\"
const QUOTES: String = "\"'"


## Each path [param source] names, as {line, path}: the line it is on, counted from 1, and the path
## as a NodePath writes it, a unique name with its `%`.
static func named(source: String) -> Array[Dictionary]:
	var tokens: Array[Array] = _tokens(source)
	var found: Array[Dictionary] = []
	for at: int in tokens.size():
		var token: Array = tokens[at]
		var path: String = ""
		if _is_mark(token, "$"):
			path = _path_from(tokens, at + 1)
		elif _is_mark(token, "%") and _starts_operand(tokens, at):
			path = _path_from(tokens, at)
		elif token[0] == NAME and CALLS.has(str(token[1])) and _on_itself(tokens, at):
			if (
				at + 2 < tokens.size()
				and _is_mark(tokens[at + 1], "(")
				and tokens[at + 2][0] == STRING
			):
				path = str(tokens[at + 2][1])
		if not path.is_empty():
			found.append({ "line": token[2], "path": path })
	return found


## The path written from [param at]: a string, or names joined by `/`, each a word, `.` or `..`,
## and any of them a unique name after a `%`. "" when nothing there is a path.
static func _path_from(tokens: Array[Array], at: int) -> String:
	if at < tokens.size() and tokens[at][0] == STRING:
		return str(tokens[at][1])
	var parts: PackedStringArray = []
	var more: bool = true
	while more:
		var part: Array = _part_at(tokens, at)
		if part.is_empty():
			break
		var _added: bool = parts.append(str(part[0]))
		at = part[1]
		more = at + 1 < tokens.size() and _is_mark(tokens[at], "/")
		at += 1
	return "/".join(parts)


## The name of a path at [param at], as [its text, where the next token is], or [] when there is
## none.
static func _part_at(tokens: Array[Array], at: int) -> Array:
	var unique: String = ""
	if at < tokens.size() and _is_mark(tokens[at], "%"):
		unique = "%"
		at += 1
	if at >= tokens.size():
		return []
	var token: Array = tokens[at]
	if token[0] == NAME or (unique.is_empty() and _is_mark(token, ".", "..")):
		return [unique + str(token[1]), at + 1]
	if token[0] == STRING and not unique.is_empty():
		return [unique + str(token[1]), at + 1]
	return []


## Whether the `%` at [param at] begins an operand, where after one it is a division's remainder.
static func _starts_operand(tokens: Array[Array], at: int) -> bool:
	if at == 0:
		return true
	var before: Array = tokens[at - 1]
	if before[0] == MARK:
		return OPERAND_AFTER_MARKS.contains(str(before[1]))
	return before[0] == NAME and OPERAND_AFTER.has(str(before[1]))


## Whether the call named at [param at] is made on the script's own node: bare, or on `self`.
static func _on_itself(tokens: Array[Array], at: int) -> bool:
	if at == 0 or not _is_mark(tokens[at - 1], "."):
		return true
	return at >= 2 and tokens[at - 2][0] == NAME and tokens[at - 2][1] == "self"


static func _is_mark(token: Array, mark: String, other: String = "") -> bool:
	return token[0] == MARK and (token[1] == mark or (not other.is_empty() and token[1] == other))


## [param source] as [kind, text, line] tokens, without comments or blank space. A string's text is
## what is between its quotes, as written.
static func _tokens(source: String) -> Array[Array]:
	var tokens: Array[Array] = []
	var line: int = 1
	var at: int = 0
	while at < source.length():
		var c: String = source[at]
		var next: String = source[at + 1] if at + 1 < source.length() else ""
		if c == "\n":
			line += 1
			at += 1
		elif c == "#":
			while at < source.length() and source[at] != "\n":
				at += 1
		elif c in " \t\r":
			at += 1
		elif (
			QUOTES.contains(c)
			or ("r^&".contains(c) and QUOTES.contains(next) and not next.is_empty())
		):
			var quoted: Array = _string(source, at if QUOTES.contains(c) else at + 1)
			tokens.append([STRING, quoted[0], line])
			line += str(quoted[0]).count("\n")
			at = quoted[1]
		elif c == "." and next == ".":
			tokens.append([MARK, "..", line])
			at += 2
		elif MARKS.contains(c):
			tokens.append([MARK, c, line])
			at += 1
		else:
			var start: int = at
			at += 1
			while at < source.length() and not _ends_a_word(source[at]):
				at += 1
			tokens.append([NAME, source.substr(start, at - start), line])
	return tokens


## The string whose opening quote is at [param at], as [what is between its quotes, where it ends].
## A backslash keeps the character after it inside the string, raw or not, as the tokenizer reads
## it.
static func _string(source: String, at: int) -> Array:
	var quote: String = source[at]
	var closing: String = quote.repeat(3) if source.substr(at, 3) == quote.repeat(3) else quote
	var start: int = at + closing.length()
	var end: int = start
	while end < source.length() and source.substr(end, closing.length()) != closing:
		end += 2 if source[end] == "\\" else 1
	return [source.substr(start, end - start), mini(end + closing.length(), source.length())]


static func _ends_a_word(c: String) -> bool:
	return c in " \t\r\n#" or MARKS.contains(c) or QUOTES.contains(c)
