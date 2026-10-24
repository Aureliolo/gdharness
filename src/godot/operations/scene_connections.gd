extends RefCounted

## The signal connections the project's scenes hold that cannot work: a method the node it calls
## does not have, which fails on every emission, or a signal the node it leaves does not have, which
## the engine drops as the scene loads. Read from the text of each scene and script, so nothing is
## loaded and no script runs: a scene loaded to be checked loads every texture and mesh it uses, and
## a script loaded that does not compile prints its errors here as well as where the scripts check
## names it.
##
## A node whose type or script the text does not settle (a built-in script, a C# one, a child of an
## instance the scene does not list) is not judged, since nothing here could say it is wrong.

const GdhDependencies = preload("dependencies.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhLog = preload("logger.gd")

const EXT_RESOURCE: String = '^\\[ext_resource [^\\]]*?path="([^"]+)"[^\\]]*? id="([^"]+)"'
const NODE: String = "^\\[node ([^\\]]*)\\]"
const CONNECTION: String = "^\\[connection ([^\\]]*)\\]"
const ATTRIBUTE: String = '(\\w+)="([^"]*)"'
const INSTANCE: String = 'instance=ExtResource\\(\\s*"([^"]+)"\\s*\\)'
const SCRIPT_LINE: String = '^script = (Ext|Sub)Resource\\(\\s*"([^"]+)"\\s*\\)'
const FUNC_LINE: String = "^(?:static\\s+)?func\\s+(\\w+)"
const SIGNAL_LINE: String = "^signal\\s+(\\w+)"
const EXTENDS_LINE: String = "^(?:@\\w+\\s+)*(?:class_name\\s+\\w+\\s+)?extends\\s+([^\\s:#]+)"

var _files: GdhFileWalk = GdhFileWalk.new()
## What each script declares, by path: {class, methods, signals}, or {} when it cannot be read.
var _scripts: Dictionary = {}
## What each scene's root is, by path: {class, script}, as a node instancing it is.
var _roots: Dictionary = {}
## The class each class_name names, read from the scripts rather than the class cache, which only a
## scan rewrites.
var _globals: Dictionary = {}


func _init(p_log: GdhLog) -> void:
	_globals = GdhDependencies.new(p_log).classes_declared()


## Every connection that cannot work, as {scene, from, signal, to, method, missing}, where missing is
## "method" or "signal".
func broken() -> Array[Dictionary]:
	var found: Array[Dictionary] = []
	for scene: String in _files.find_files_with_extensions("res://", ["tscn"]):
		var content: String = FileAccess.get_file_as_string(scene)
		var nodes: Dictionary = _nodes_of(content, scene)
		for attributes: Dictionary in _matches(CONNECTION, content):
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
				entry["missing"] = "signal"
				found.append(entry)
			elif _lacks(nodes, to, method, "methods"):
				entry["missing"] = "method"
				found.append(entry)
	return found


## One line for [param entry], one of [method broken].
static func broken_line(entry: Dictionary) -> String:
	var connected: String = (
		"%s connects %s.%s to %s.%s"
		% [entry["scene"], entry["from"], entry["signal"], entry["to"], entry["method"]]
	)
	if entry["missing"] == "signal":
		return connected + ", a signal that node does not have, so the engine drops it as the scene loads."
	return connected + ", a method that node does not have, so every emission fails to call it."


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
			current = "." if parent == null else (name if parent == "." else "%s/%s" % [parent, name])
			var node: Dictionary = {"class": str(attributes.get("type", "")), "script": "", "name": name}
			var instanced: RegExMatch = instance.search(heading.get_string(1))
			if instanced != null:
				var root: Dictionary = _root_of(str(resources.get(instanced.get_string(1), "")), scene)
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
			node["script"] = str(resources.get(scripted.get_string(2), "?")) if external else "built-in"
	return nodes


## What the root of the scene at [param path] is, as [method _nodes_of] gives a node, or a node that
## says nothing when it cannot be read or instances [param from], which would never end.
func _root_of(path: String, from: String) -> Dictionary:
	if _roots.has(path):
		return _roots[path]
	_roots[path] = {"class": "", "script": ""}
	if path.is_empty() or path == from or not path.ends_with(".tscn") or not FileAccess.file_exists(path):
		return _roots[path]
	var nodes: Dictionary = _nodes_of(FileAccess.get_file_as_string(path), path)
	_roots[path] = nodes.get(".", {"class": "", "script": ""})
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
	for line: String in FileAccess.get_file_as_string(path).split("\n"):
		var named: RegExMatch = func_line.search(line)
		if named != null:
			methods[named.get_string(1)] = true
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
	_scripts[path] = {"class": engine_class, "methods": methods, "signals": signals}
	return _scripts[path]


## The attributes of every line of [param content] [param pattern] matches, one Dictionary each.
func _matches(pattern: String, content: String) -> Array[Dictionary]:
	var expression: RegEx = RegEx.create_from_string(pattern)
	var all: Array[Dictionary] = []
	for line: String in content.split("\n"):
		var matched: RegExMatch = expression.search(line)
		if matched != null:
			all.append(_attributes(matched.get_string(1)))
	return all


static func _attributes(text: String) -> Dictionary:
	var attributes: Dictionary = {}
	for matched: RegExMatch in RegEx.create_from_string(ATTRIBUTE).search_all(text):
		attributes[matched.get_string(1)] = matched.get_string(2)
	return attributes
