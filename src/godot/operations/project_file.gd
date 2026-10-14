extends RefCounted

## project.godot written through the engine's own save, in the order the file already held.
##
## The engine writes each section's keys in the order it registered them, and an engine running a
## script registers them in another order than the editor does, so a one-setting change moved lines
## nobody touched across several sections and a commit of it read as a rewrite. The save is still the
## engine's, for what only it gets right: the header, each value's text and dropping a key that is
## back at its default. Only the order is taken from the file as it was.

const PATH: String = "res://project.godot"


## Saves the project's settings, keeping the sections and keys already in the file where they were.
## A key or a section new to the file goes where the engine put it relative to its neighbours.
static func save() -> Error:
	var before: String = FileAccess.get_file_as_string(PATH)
	var err: Error = ProjectSettings.save()
	if err != OK or before.is_empty():
		return err
	var written: String = FileAccess.get_file_as_string(PATH)
	var kept: String = in_order_of(before, written)
	if kept == written:
		return OK
	var file: FileAccess = FileAccess.open(PATH, FileAccess.WRITE)
	if file == null:
		return FileAccess.get_open_error()
	if not file.store_string(kept):
		return file.get_error()
	file.close()
	return OK


## [param written] with its sections and their keys put in the order [param before] has them. Every
## line of the result is a line of [param written], so nothing the engine wrote is lost or changed.
static func in_order_of(before: String, written: String) -> String:
	var old: Dictionary = _parsed(before)
	var fresh: Dictionary = _parsed(written)
	var old_sections: Array[Dictionary] = old["sections"]
	var fresh_sections: Array[Dictionary] = fresh["sections"]

	var old_names: Array[String] = []
	var old_keys: Dictionary[String, Array] = {}
	for section: Dictionary in old_sections:
		var name: String = section["name"]
		old_names.append(name)
		var keys: Array[String] = []
		for entry: Dictionary in section["entries"]:
			keys.append(str(entry["key"]))
		old_keys[name] = keys

	var by_name: Dictionary[String, Dictionary] = {}
	var fresh_names: Array[String] = []
	for section: Dictionary in fresh_sections:
		var name: String = section["name"]
		by_name[name] = section
		fresh_names.append(name)

	var text: String = fresh["preamble"]
	var at: int = 0
	for name: String in _merged(old_names, fresh_names):
		var section: Dictionary = by_name[name]
		var entries: Array[Dictionary] = section["entries"]
		var entry_of: Dictionary[String, String] = {}
		var fresh_keys: Array[String] = []
		for entry: Dictionary in entries:
			var key: String = entry["key"]
			entry_of[key] = str(entry["text"])
			fresh_keys.append(key)
		var known: Array = old_keys.get(name, [])
		var held: Array[String] = []
		held.assign(known)
		text += str(section["head"])
		for key: String in _merged(held, fresh_keys):
			text += entry_of[key]
		# The blank lines closing a section belong to its place in the file rather than to the
		# section, so the last one keeps the ending the engine gave the file wherever it moved from.
		var placed: Dictionary = fresh_sections[at]
		text += str(placed["tail"])
		at += 1
	return text


## The names of [param wanted] in the order [param held] lists them, those [param held] lacks each
## placed after the name [param wanted] puts before it. Names [param wanted] lacks are left out.
static func _merged(held: Array[String], wanted: Array[String]) -> Array[String]:
	var order: Array[String] = []
	for name: String in held:
		if name in wanted and not name in order:
			order.append(name)
	var after: int = -1
	for name: String in wanted:
		var placed: int = order.find(name)
		if placed == -1:
			after += 1
			# Not checked: a position inside the array cannot be refused.
			var _inserted: int = order.insert(after, name)
		else:
			after = placed
	return order


## [param text] as a preamble (the header and anything before the first section) and its sections,
## each with its header line and the blank lines after it, its entries, and the blank lines closing it.
static func _parsed(text: String) -> Dictionary:
	var preamble: String = ""
	var sections: Array[Dictionary] = []
	var current: Dictionary = {}
	var body: Array[String] = []
	for line: String in _logical_lines(text):
		var stripped: String = line.strip_edges()
		if stripped.begins_with("[") and stripped.ends_with("]"):
			if not current.is_empty():
				_close(current, body)
				sections.append(current)
			current = {"name": stripped.substr(1, stripped.length() - 2), "head": line}
			body = []
		elif current.is_empty():
			preamble += line
		elif body.is_empty() and stripped.is_empty():
			current["head"] = str(current["head"]) + line
		else:
			body.append(line)
	if not current.is_empty():
		_close(current, body)
		sections.append(current)
	return {"preamble": preamble, "sections": sections}


## Fills in [param section]'s entries and closing blank lines from the lines after its head. A blank
## or comment line between two entries stays with the entry before it.
static func _close(section: Dictionary, body: Array[String]) -> void:
	var tail: String = ""
	while not body.is_empty() and body[body.size() - 1].strip_edges().is_empty():
		tail = body[body.size() - 1] + tail
		body.remove_at(body.size() - 1)
	var entries: Array[Dictionary] = []
	for line: String in body:
		var stripped: String = line.strip_edges()
		if entries.is_empty() or not (stripped.is_empty() or stripped.begins_with(";")):
			entries.append({"key": _key_of(line), "text": line})
		else:
			var last: Dictionary = entries[entries.size() - 1]
			last["text"] = str(last["text"]) + line
	section["entries"] = entries
	section["tail"] = tail


## The key an entry sets: everything before its first `=` outside quotes, since a key with spaces or
## symbols in it is written quoted.
static func _key_of(line: String) -> String:
	var quoted: bool = false
	for i: int in line.length():
		var c: String = line[i]
		if c == '"' and (i == 0 or line[i - 1] != "\\"):
			quoted = not quoted
		elif c == "=" and not quoted:
			return line.substr(0, i).strip_edges()
	return line.strip_edges()


## [param text] split into lines that each end where an entry does: a value holding a dictionary, an
## array or a string runs over several lines, and splitting it there would sort its halves apart.
## Each piece keeps its line ending, so joining them gives the text back.
static func _logical_lines(text: String) -> Array[String]:
	var lines: Array[String] = []
	var start: int = 0
	var depth: int = 0
	var quoted: bool = false
	var escaped: bool = false
	var comment: bool = false
	for i: int in text.length():
		var c: String = text[i]
		if i == start:
			comment = c == ";"
		if comment:
			if c == "\n":
				lines.append(text.substr(start, i + 1 - start))
				start = i + 1
			continue
		if quoted:
			if escaped:
				escaped = false
			elif c == "\\":
				escaped = true
			elif c == '"':
				quoted = false
			continue
		match c:
			'"':
				quoted = true
			"[", "(", "{":
				depth += 1
			"]", ")", "}":
				depth = maxi(depth - 1, 0)
			"\n":
				if depth == 0:
					lines.append(text.substr(start, i + 1 - start))
					start = i + 1
	if start < text.length():
		lines.append(text.substr(start))
	return lines
