extends RefCounted
## The signal connections the project's scenes hold that cannot work: a method the node it calls
## does not have, or one taking a number of arguments other than the connection passes, both of
## which fail on every emission, or a signal the node it leaves does not have, which the engine
## drops as the scene loads. Read from the text of each scene and script, so nothing is
## loaded and no script runs: a scene loaded to be checked loads every texture and mesh it uses, and
## a script loaded that does not compile prints its errors here as well as where the scripts check
## names it.
##
## A node whose type or script the text does not settle (a built-in script, a C# one, a child of an
## instance the scene does not list) is not judged, since nothing here could say it is wrong.
## Nor are the arguments of a signal a script declares, since the engine does not hold an emission
## to them.

const GdhDependencies = preload("dependencies.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhLog = preload("logger.gd")
const GdhRead = preload("reading.gd")
const EXT_RESOURCE: String = '^\\[ext_resource [^\\]]*?path="([^"]+)"[^\\]]*? id="([^"]+)"'
const NODE: String = "^\\[node ([^\\]]*)\\]"
const CONNECTION: String = "^\\[connection ([^\\]]*)\\]"
const ATTRIBUTE: String = '(\\w+)="([^"]*)"'
## The unquoted attributes Godot writes as `flags=18`, `unbinds=1` and `binds= [5, "a"]`.
const FLAGS: String = "\\bflags=(\\d+)"
const UNBINDS: String = "\\bunbinds=(\\d+)"
const BINDS: String = "\\bbinds=\\s*\\["
const INSTANCE: String = 'instance=ExtResource\\(\\s*"([^"]+)"\\s*\\)'
const SCRIPT_LINE: String = '^script = (Ext|Sub)Resource\\(\\s*"([^"]+)"\\s*\\)'
const FUNC_LINE: String = "^(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:static\\s+)?func\\s+(\\w+)"
const SIGNAL_LINE: String = "^signal\\s+(\\w+)"
const EXTENDS_LINE: String = "^(?:@\\w+\\s+)*(?:class_name\\s+\\w+\\s+)?extends\\s+([^\\s:#]+)"

var _files: GdhFileWalk = GdhFileWalk.new()
## What each script declares, by path: {class, methods, signals}, or {} when it cannot be read.
## methods holds each method's arguments as [method _arguments_of] reads them.
var _scripts: Dictionary = {}
## What each scene's root is, by path: {class, script}, as a node instancing it is.
var _roots: Dictionary = {}
## The class each class_name names, read from the scripts rather than the class cache, which only a
## scan rewrites.
var _globals: Dictionary = {}


func _init(p_log: GdhLog) -> void:
	_globals = GdhDependencies.new(p_log).classes_declared()


## Every connection that cannot work, as {scene, from, signal, to, method, fault}, where fault is
## "method", "signal" or "arguments". An "arguments" entry also holds passed, the count the
## connection passes, and least and most, what the method takes, most -1 for no limit.
func broken() -> Array[Dictionary]:
	var found: Array[Dictionary] = []
	var connection: RegEx = RegEx.create_from_string(CONNECTION)
	for scene: String in _files.find_files_with_extensions("res://", ["tscn"]):
		var content: String = FileAccess.get_file_as_string(scene)
		var nodes: Dictionary = _nodes_of(content, scene)
		for line: String in content.split("\n"):
			var matched: RegExMatch = connection.search(line)
			if matched == null:
				continue
			var heading: String = matched.get_string(1)
			var attributes: Dictionary = _attributes(heading)
			var from: String = str(attributes.get("from", ""))
			var to: String = str(attributes.get("to", ""))
			var signal_name: String = str(attributes.get("signal", ""))
			var method: String = str(attributes.get("method", ""))
			# The root by its name, since its path, ".", runs into the member's dot.
			var root: Dictionary = nodes.get(".", {})
			var root_name: String = str(root.get("name", "."))
			var entry: Dictionary = {
				"scene": scene,
				"from": root_name if from == "." else from,
				"signal": signal_name,
				"to": root_name if to == "." else to,
				"method": method,
			}
			if _lacks(nodes, from, signal_name, "signals"):
				entry["fault"] = "signal"
				found.append(entry)
				continue
			if _lacks(nodes, to, method, "methods"):
				entry["fault"] = "method"
				found.append(entry)
				continue
			var sent: int = _signal_arguments(nodes, from, signal_name)
			var takes: Dictionary = _method_arguments(nodes, to, method)
			if sent < 0 or takes.is_empty():
				continue
			# More unbound than the signal sends is a fault of its own, which this does not judge.
			var kept: int = sent - _unbinds(line)
			if kept < 0:
				continue
			# The engine puts the source after what unbinds leaves, so no unbinds drops it.
			var appended: int = 1 if _flags(line) & Object.CONNECT_APPEND_SOURCE_OBJECT else 0
			var passed: int = kept + appended + _binds(line)
			var least: int = takes["least"]
			var most: int = takes["most"]
			if passed < least or (most >= 0 and passed > most):
				var misfit: Dictionary = {
					"fault": "arguments", "passed": passed, "least": least, "most": most,
				}
				entry.merge(misfit)
				found.append(entry)
	return found


## One line for [param entry], one of [method broken].
static func broken_line(entry: Dictionary) -> String:
	var connected: String = (
		"%s connects %s.%s to %s.%s"
		% [entry["scene"], entry["from"], entry["signal"], entry["to"], entry["method"]]
	)
	if entry["fault"] == "signal":
		return (
			connected
			+ ", a signal that node does not have, so the engine drops it as the scene loads."
		)
	if entry["fault"] == "method":
		return (
			connected + ", a method that node does not have, so every emission fails to call it."
		)
	var least: int = entry["least"]
	var most: int = entry["most"]
	var takes: String = (
		"at least %d" % least
		if most < 0
		else (str(least) if least == most else "%d to %d" % [least, most])
	)
	var noun: String = "argument" if least == 1 and most <= 1 else "arguments"
	return (
		connected
		+ ", which takes %s %s where the connection passes %d" % [takes, noun, entry["passed"]]
		+ ", so every emission fails to call it."
	)


## Each node [param content] declares, by its path from the root, as {class, script}, either of
## which may be "" when the text does not say.
func _nodes_of(content: String, scene: String) -> Dictionary:
	var resources: Dictionary = {}
	var expression: RegEx = RegEx.create_from_string(EXT_RESOURCE)
	for line: String in content.split("\n"):
		var matched: RegExMatch = expression.search(line)
		if matched != null:
			resources[matched.get_string(2)] = matched.get_string(1)
	var nodes: Dictionary = {}
	var node_line: RegEx = RegEx.create_from_string(NODE)
	var script_line: RegEx = RegEx.create_from_string(SCRIPT_LINE)
	var instance: RegEx = RegEx.create_from_string(INSTANCE)
	var current: String = ""
	for line: String in content.split("\n"):
		var heading: RegExMatch = node_line.search(line)
		if heading != null:
			var attributes: Dictionary = _attributes(heading.get_string(1))
			var name: String = str(attributes.get("name", ""))
			var parent: Variant = attributes.get("parent")
			current = (
				"." if parent == null else (name if parent == "." else "%s/%s" % [parent, name])
			)
			var node: Dictionary = {
				"class": str(attributes.get("type", "")), "script": "", "name": name,
			}
			var instanced: RegExMatch = instance.search(heading.get_string(1))
			if instanced != null:
				var root: Dictionary = _root_of(
					str(resources.get(instanced.get_string(1), "")), scene
				)
				node = root.duplicate()
				node["name"] = name
			nodes[current] = node
			continue
		if line.begins_with("["):
			current = ""
			continue
		var scripted: RegExMatch = script_line.search(line)
		if scripted != null and nodes.has(current):
			var node: Dictionary = nodes[current]
			# A built-in script lives in the scene, where this does not read it, so its node is one
			# nothing here can judge, which a path that is no script file says.
			var external: bool = scripted.get_string(1) == "Ext"
			node["script"] = (
				str(resources.get(scripted.get_string(2), "?")) if external else "built-in"
			)
	return nodes


## What the root of the scene at [param path] is, as [method _nodes_of] gives a node, or a node that
## says nothing when it cannot be read or instances [param from], which would never end.
func _root_of(path: String, from: String) -> Dictionary:
	if _roots.has(path):
		return _roots[path]
	_roots[path] = { "class": "", "script": "" }
	if (
		path.is_empty()
		or path == from
		or not path.ends_with(".tscn")
		or not FileAccess.file_exists(path)
	):
		return _roots[path]
	var nodes: Dictionary = _nodes_of(FileAccess.get_file_as_string(path), path)
	_roots[path] = nodes.get(".", { "class": "", "script": "" })
	return _roots[path]


## Whether the node at [param path] among [param nodes] surely has no [param member] among its
## [param kind], "methods" or "signals": false whenever what it is cannot be read.
func _lacks(nodes: Dictionary, path: String, member: String, kind: String) -> bool:
	if not nodes.has(path):
		return false
	var node: Dictionary = nodes[path]
	var engine_class: String = str(node["class"])
	var script: String = str(node["script"])
	if not script.is_empty():
		var declared: Dictionary = _script(script, {})
		if declared.is_empty():
			return false
		var declared_members: Dictionary = declared[kind]
		if declared_members.has(member):
			return false
		engine_class = str(declared["class"])
	if engine_class.is_empty() or not ClassDB.class_exists(engine_class):
		return false
	if kind == "signals":
		return not ClassDB.class_has_signal(engine_class, member)
	return not ClassDB.class_has_method(engine_class, member)


## How many arguments the engine signal [param signal_name] of the node at [param path] sends, or -1
## when the node cannot be read or a script declares the signal.
func _signal_arguments(nodes: Dictionary, path: String, signal_name: String) -> int:
	var engine_class: String = _engine_class(nodes, path, signal_name, "signals")
	if engine_class.is_empty():
		return -1
	var info: Dictionary = ClassDB.class_get_signal(engine_class, signal_name)
	if info.is_empty():
		return -1
	var arguments: Array = info.get("args", [])
	return arguments.size()


## What the method [param method] of the node at [param path] takes, as {least, most} with most -1
## for no limit, or {} when the node or the method's arguments cannot be read.
func _method_arguments(nodes: Dictionary, path: String, method: String) -> Dictionary:
	if not nodes.has(path):
		return {}
	var node: Dictionary = nodes[path]
	var script: String = str(node["script"])
	if not script.is_empty():
		var declared: Dictionary = _script(script, {})
		if declared.is_empty():
			return {}
		var methods: Dictionary = declared["methods"]
		if methods.has(method):
			return methods[method]
	var engine_class: String = _engine_class(nodes, path, method, "methods")
	if engine_class.is_empty():
		return {}
	for info: Dictionary in ClassDB.class_get_method_list(engine_class):
		if str(info.get("name", "")) != method:
			continue
		var arguments: Array = info.get("args", [])
		var defaults: Array = info.get("default_args", [])
		var varied: bool = (GdhRead.as_int(info.get("flags", 0)) & METHOD_FLAG_VARARG) != 0
		return {
			"least": arguments.size() - defaults.size(),
			"most": -1 if varied else arguments.size(),
		}
	return {}


## The engine class to read [param member] of the node at [param path] from, or "" when the node
## cannot be read or a script it carries declares [param member] among its [param kind].
func _engine_class(nodes: Dictionary, path: String, member: String, kind: String) -> String:
	if not nodes.has(path):
		return ""
	var node: Dictionary = nodes[path]
	var engine_class: String = str(node["class"])
	var script: String = str(node["script"])
	if not script.is_empty():
		var declared: Dictionary = _script(script, {})
		if declared.is_empty():
			return ""
		var declared_members: Dictionary = declared[kind]
		if declared_members.has(member):
			return ""
		engine_class = str(declared["class"])
	return engine_class if ClassDB.class_exists(engine_class) else ""


## The flags the connection line [param line] is written with, 0 when it names none.
static func _flags(line: String) -> int:
	var matched: RegExMatch = RegEx.create_from_string(FLAGS).search(line)
	return 0 if matched == null else matched.get_string(1).to_int()


## How many of the signal's last arguments the connection line [param line] drops.
static func _unbinds(line: String) -> int:
	var matched: RegExMatch = RegEx.create_from_string(UNBINDS).search(line)
	return 0 if matched == null else matched.get_string(1).to_int()


## How many arguments the connection line [param line] binds, counted at the top level of its list,
## so a bound Vector2(1, 2) or "a, b" is one.
static func _binds(line: String) -> int:
	var matched: RegExMatch = RegEx.create_from_string(BINDS).search(line)
	if matched == null:
		return 0
	return _top_level_items(line.substr(matched.get_end())).size()


## [param text] split at its commas outside brackets and strings, up to the bracket that closes a
## list it starts inside, each part stripped, empty ones left out.
static func _top_level_items(text: String) -> Array[String]:
	var items: Array[String] = []
	var depth: int = 0
	var quote: String = ""
	var start: int = 0
	var at: int = 0
	while at < text.length():
		var character: String = text[at]
		if not quote.is_empty():
			if character == "\\":
				at += 1
			elif character == quote:
				quote = ""
		elif character == '"' or character == "'":
			quote = character
		elif character in "([{":
			depth += 1
		elif character in ")]}":
			depth -= 1
			if depth < 0:
				break
		elif character == "," and depth == 0:
			_append_item(items, text.substr(start, at - start))
			start = at + 1
		at += 1
	_append_item(items, text.substr(start, at - start))
	return items


static func _append_item(items: Array[String], item: String) -> void:
	var stripped: String = item.strip_edges()
	if not stripped.is_empty():
		items.append(stripped)


## What the method whose name ends at [param from] in [param source] takes, as {least, most}, most
## -1 after a rest parameter, read from its parameter list through every line it spans and past any
## comment in it; {} when the list does not close.
static func _arguments_of(source: String, from: int) -> Dictionary:
	var opened: int = source.find("(", from)
	if opened < 0 or not source.substr(from, opened - from).strip_edges().is_empty():
		return {}
	var listed: String = ""
	var depth: int = 1
	var quote: String = ""
	var at: int = opened + 1
	while at < source.length():
		var character: String = source[at]
		if not quote.is_empty():
			if character == "\\":
				listed += character
				at += 1
				character = source[at] if at < source.length() else ""
			elif character == quote:
				quote = ""
		elif character == "#":
			var ends: int = source.find("\n", at)
			at = source.length() if ends < 0 else ends
			continue
		elif character == '"' or character == "'":
			quote = character
		elif character in "([{":
			depth += 1
		elif character in ")]}":
			depth -= 1
			if depth == 0:
				break
		listed += character
		at += 1
	if depth != 0:
		return {}
	var least: int = 0
	var most: int = 0
	for parameter: String in _top_level_items(listed):
		if parameter.begins_with("..."):
			return { "least": least, "most": -1 }
		most += 1
		if not _has_default(parameter):
			least = most
	return { "least": least, "most": most }


## Whether [param parameter] gives a default, by an = outside its brackets and strings.
static func _has_default(parameter: String) -> bool:
	var depth: int = 0
	var quote: String = ""
	for character: String in parameter:
		if not quote.is_empty():
			if character == quote:
				quote = ""
		elif character == '"' or character == "'":
			quote = character
		elif character in "([{":
			depth += 1
		elif character in ")]}":
			depth -= 1
		elif character == "=" and depth == 0:
			return true
	return false


## What the script at [param path] declares with every script it extends, as {class, methods,
## signals}, where class is the engine class at the bottom; {} for one this cannot read through.
## [param seen] stops a loop of scripts extending each other.
func _script(path: String, seen: Dictionary) -> Dictionary:
	if _scripts.has(path):
		return _scripts[path]
	if seen.has(path) or not path.ends_with(".gd") or not FileAccess.file_exists(path):
		return {}
	seen[path] = true
	var methods: Dictionary = {}
	var signals: Dictionary = {}
	var base: String = "RefCounted"
	var func_line: RegEx = RegEx.create_from_string(FUNC_LINE)
	var signal_line: RegEx = RegEx.create_from_string(SIGNAL_LINE)
	var extends_line: RegEx = RegEx.create_from_string(EXTENDS_LINE)
	var source: String = FileAccess.get_file_as_string(path)
	var line_starts: int = 0
	for line: String in source.split("\n"):
		var named: RegExMatch = func_line.search(line)
		if named != null:
			methods[named.get_string(1)] = _arguments_of(source, line_starts + named.get_end(1))
		line_starts += line.length() + 1
		var sent: RegExMatch = signal_line.search(line)
		if sent != null:
			signals[sent.get_string(1)] = true
		var extended: RegExMatch = extends_line.search(line)
		if extended != null:
			base = extended.get_string(1)
	var engine_class: String = base
	var base_path: String = ""
	if base.begins_with('"') or base.begins_with("'"):
		base_path = base.substr(1, base.length() - 2)
		if base_path.is_relative_path():
			base_path = path.get_base_dir().path_join(base_path)
	elif _globals.has(base):
		base_path = _globals[base]
	if not base_path.is_empty():
		var inherited: Dictionary = _script(base_path, seen)
		if inherited.is_empty():
			return {}
		var inherited_methods: Dictionary = inherited["methods"]
		var inherited_signals: Dictionary = inherited["signals"]
		methods.merge(inherited_methods)
		signals.merge(inherited_signals)
		engine_class = str(inherited["class"])
	_scripts[path] = { "class": engine_class, "methods": methods, "signals": signals }
	return _scripts[path]


static func _attributes(text: String) -> Dictionary:
	var attributes: Dictionary = {}
	for matched: RegExMatch in RegEx.create_from_string(ATTRIBUTE).search_all(text):
		attributes[matched.get_string(1)] = matched.get_string(2)
	return attributes
