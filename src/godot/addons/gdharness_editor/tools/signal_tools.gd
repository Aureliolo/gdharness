@tool
extends Node
## Signal connections in a scene file, made, removed and listed on a copy of the file as the other
## scene tools edit one.

const GdhRead = preload("../reading.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhSerialisation = preload("../serialisation.gd")
## What every emission meets when a connection cannot call its method.
const FAILS: String = ", so every emission fails to call it."
## The engine's CONNECT_INHERITED, which GDScript is not given: on a connection an instanced or
## inherited scene makes, as a scene holding one loads it.
const CONNECT_INHERITED: int = 32
## The names Object.ConnectFlags gives each bit. The number alone left a reader guessing that 2 is
## the persistence every connection in a saved scene carries.
const CONNECT_FLAG_NAMES: Dictionary[int, String] = {
	Object.CONNECT_DEFERRED: "deferred",
	Object.CONNECT_PERSIST: "persist",
	Object.CONNECT_ONE_SHOT: "one_shot",
	Object.CONNECT_REFERENCE_COUNTED: "reference_counted",
	Object.CONNECT_APPEND_SOURCE_OBJECT: "append_source_object",
	CONNECT_INHERITED: "inherited",
}
## The flags a caller may give: the engine's own CONNECT_INHERITED marks a connection an instanced
## scene makes, and is never one a scene makes for itself.
const GIVEN_FLAGS: int = (
	Object.CONNECT_DEFERRED
	| Object.CONNECT_PERSIST
	| Object.CONNECT_ONE_SHOT
	| Object.CONNECT_REFERENCE_COUNTED
	| Object.CONNECT_APPEND_SOURCE_OBJECT
)

var _values: GdhSerialisation = GdhSerialisation.new()


func connect_signal(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var source_node_path: String = str(args.get("sourceNodePath", ""))
	var signal_name: String = str(args.get("signalName", ""))
	var target_node_path: String = str(args.get("targetNodePath", ""))
	var method_name: String = str(args.get("methodName", ""))
	# A connection without CONNECT_PERSIST is a runtime one, and PackedScene.pack drops those on
	# the way out: without this the scene saves unchanged and this answers success over nothing.
	var given_flags: int = GdhRead.as_int(args.get("flags", 0))
	var flags: int = given_flags | Object.CONNECT_PERSIST

	if (
		source_node_path.is_empty()
		or signal_name.is_empty()
		or target_node_path.is_empty()
		or method_name.is_empty()
	):
		return { "ok": false, "error": "Missing required signal connection arguments" }
	var unasked: String = _unasked(given_flags)
	if not unasked.is_empty():
		return { "ok": false, "error": unasked }

	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, true)
	if not refused.is_empty():
		return refused

	var ends: Array = _connection_ends(scene, source_node_path, signal_name, target_node_path)
	if ends[0] == null:
		return scene.refuse(str(ends[1]))
	var source: Node = ends[0]
	var target: Node = ends[1]

	# Reconnected rather than left alone when the flags differ, so the connection saved is the one
	# asked for. Left alone, the answer gave the flags asked for and the file kept the old ones.
	# Found by its object and method, as the engine finds it: a connection carrying binds is another
	# callable, so comparing callables missed it, and the engine's is_connected then found it, took
	# it out and put a bare one in its place, losing the binds without a word.
	var before: Dictionary = _held(source, signal_name, target, method_name)
	var binds: Array = []
	var unbinds: int = 0
	if not before.is_empty():
		binds = before["binds"]
		unbinds = before["unbinds"]
	if args.has("unbinds"):
		unbinds = GdhRead.as_int(args["unbinds"])
	if args.has("binds"):
		var given: Array = args["binds"]
		binds = _bound_values(
			given, source, signal_name, Callable(target, method_name), unbinds, flags
		)
	var callable: Callable = Callable(target, method_name)
	if not binds.is_empty():
		callable = callable.bindv(binds)
	if unbinds > 0:
		callable = callable.unbind(unbinds)
	var method_found: bool = target.has_method(method_name)
	var misfit: String = _misfit(source, signal_name, callable, flags)
	if not before.is_empty():
		var held: Callable = before["callable"]
		source.disconnect(signal_name, held)
	var connect_result: Error = source.connect(signal_name, callable, flags)
	if connect_result != OK:
		return scene.refuse("Failed to connect signal: " + error_string(connect_result))

	var from: String = scene.path_of(source)
	var to: String = scene.path_of(target)
	var saved: Dictionary = {}
	var written: Dictionary = scene.write(
		func(loaded: Node) -> String:
			var found: Dictionary = _saved(loaded, from, signal_name, to, method_name)
			saved.merge(found)
			if found.is_empty():
				return "the connection would not be in the scene when it loads."
			return ""
	)
	if not written.is_empty():
		return written

	var saved_flags: int = saved["flags"]
	var answer: Dictionary = {
		"ok": true,
		"sourceNodePath": from,
		"signalName": signal_name,
		"targetNodePath": to,
		"methodName": method_name,
		"flags": saved_flags,
		"flagNames": flag_names(saved_flags),
		# Connected either way, as the editor's own dialog allows, since the method may be written
		# next; a caller told nothing learnt of a misspelt one only when the signal fired.
		"methodFound": method_found,
	}
	# Written all the same, for the reason a missing method is: the method may be changed next.
	if method_found:
		answer["argumentsFit"] = misfit.is_empty()
	if not misfit.is_empty():
		answer["misfit"] = misfit
	# A second connect of the same pair read exactly like the first, so a caller could not tell a
	# connection made from one that was already there, and a list showing one where two were made
	# looked like a lost write.
	_bound_into(answer, saved)
	if not before.is_empty():
		answer["alreadyConnected"] = true
		var flags_before: int = before["flags"]
		if flags_before != saved_flags:
			answer["flagsBefore"] = flag_names(flags_before)
		var binds_before: Variant = _values.serialize_value(before["binds"])
		if JSON.stringify(binds_before) != JSON.stringify(answer.get("binds", [])):
			answer["bindsBefore"] = binds_before
		if before["unbinds"] != saved["unbinds"]:
			answer["unbindsBefore"] = before["unbinds"]
	return answer


## Why [param given_flags] cannot be connected with, or "" when it can: a bit no flag a scene
## connects with has. The server checks the type of every argument, and nothing knows the bits.
static func _unasked(given_flags: int) -> String:
	if given_flags >= 0 and not given_flags & ~GIVEN_FLAGS:
		return ""
	var named: Array[String] = []
	for bit: int in CONNECT_FLAG_NAMES:
		if bit & GIVEN_FLAGS:
			named.append("%s %d" % [CONNECT_FLAG_NAMES[bit], bit])
	return (
		"flags %d holds bits no flag a scene connects with has: they are %s, added together."
		% [given_flags, ", ".join(named)]
	)


## [param given] as the values [param called] is bound with, each number fitted to the parameter it
## lands on. JSON has one kind of number, so 3 arrived as 3.0, the file said [3.0], and a whole
## number for an untyped parameter is an int, as GDScript reads the literal 3.
func _bound_values(
	given: Array, source: Node, signal_name: String, called: Callable, unbinds: int, flags: int
) -> Array:
	var passed: int = 0
	for info: Dictionary in source.get_signal_list():
		if str(info.get("name", "")) == signal_name:
			var arguments: Array = info.get("args", [])
			passed = arguments.size()
	if flags & Object.CONNECT_APPEND_SOURCE_OBJECT:
		passed += 1
	passed = maxi(passed - unbinds, 0)
	var parameters: Array = []
	for info: Dictionary in called.get_object().get_method_list():
		if str(info.get("name", "")) == str(called.get_method()):
			parameters = info.get("args", [])
			break
	var values: Array = []
	for at: int in given.size():
		var value: Variant = _values.deserialize_value(given[at])
		var declared: int = TYPE_NIL
		if passed + at < parameters.size():
			var parameter: Dictionary = parameters[passed + at]
			declared = GdhRead.as_int(parameter.get("type", TYPE_NIL))
		if value is float and declared != TYPE_FLOAT:
			var number: float = value
			if (is_finite(number)
					and number == floorf(number)
					and absf(number) < 9_007_199_254_740_992.0):
				value = int(number)
		values.append(value)
	return values


## The connection from [param signal_name] of [param source] to [param method] on [param target],
## as {callable, flags, binds, unbinds}, or {} when there is none.
static func _held(source: Node, signal_name: String, target: Object, method: String) -> Dictionary:
	for conn: Dictionary in source.get_signal_connection_list(signal_name):
		var callable: Callable = conn.get("callable", Callable())
		if callable.get_object() == target and str(callable.get_method()) == method:
			return {
				"callable": callable,
				"flags": GdhRead.as_int(conn.get("flags", 0)),
				"binds": callable.get_bound_arguments(),
				"unbinds": callable.get_unbound_arguments_count(),
			}
	return {}


## [param held]'s binds and unbinds into [param answer], each only when it has any, as the scene
## file writes them.
func _bound_into(answer: Dictionary, held: Dictionary) -> void:
	var binds: Array = held["binds"]
	if not binds.is_empty():
		answer["binds"] = _values.serialize_value(binds)
	var unbinds: int = held["unbinds"]
	if unbinds > 0:
		answer["unbinds"] = unbinds


## Each bit set in [param flags], a connection's, by name, and any bits left unnamed as one number.
static func flag_names(flags: int) -> Array[String]:
	var names: Array[String] = []
	var rest: int = flags
	for bit: int in CONNECT_FLAG_NAMES:
		if flags & bit:
			names.append(CONNECT_FLAG_NAMES[bit])
			rest &= ~bit
	if rest != 0:
		names.append(str(rest))
	return names


## The two ends of a connection in [param scene], as [source, target], or [null, why not].
func _connection_ends(
	scene: GdhSceneFile, source_node_path: String, signal_name: String, target_node_path: String
) -> Array:
	var source: Node = GdhSceneFile.node_at(scene.root, source_node_path)
	var target: Node = GdhSceneFile.node_at(scene.root, target_node_path)
	if not source:
		return [
			null, scene.not_found("Source node not found: " + source_node_path, source_node_path),
		]
	if not target:
		return [
			null, scene.not_found("Target node not found: " + target_node_path, target_node_path),
		]
	# pack drops a connection with either end inside an instanced scene, and the answer said it was
	# made or removed.
	for end: Node in [source, target]:
		var foreign: String = scene.foreign(end)
		if not foreign.is_empty():
			return [null, foreign]
	if not source.has_signal(signal_name):
		var said: String = "%s has no signal %s" % [source_node_path, signal_name]
		var offered: String = GdhRead.offered(said, signal_name, GdhRead.signals_of(source))
		return [null, GdhSceneFile.missing_on(source, offered)]
	return [source, target]


## The persistent connection from [param from]'s [param signal_name] to [param method] on [param to]
## in the tree under [param root], as [method _held] answers it, or {} when there is none.
static func _saved(
	root: Node, from: String, signal_name: String, to: String, method: String
) -> Dictionary:
	var source: Node = root.get_node_or_null(from)
	var target: Node = root.get_node_or_null(to)
	if source == null or target == null or not source.has_signal(signal_name):
		return {}
	var held: Dictionary = _held(source, signal_name, target, method)
	if held.is_empty() or not GdhRead.as_int(held["flags"]) & Object.CONNECT_PERSIST:
		return {}
	return held


## Why what [param signal_name] of [param source] passes cannot reach [param callable], or "" when
## it can or the method is not there to judge. Only what fails on every emission is named: too few
## or too many arguments, an object passed where the method takes a value or the reverse, and an
## engine class unrelated to the one the method takes. Anything that may convert or narrow when it
## runs is left alone, since a warning about a connection that works is one nobody can act on.
static func _misfit(source: Node, signal_name: String, callable: Callable, flags: int) -> String:
	var target: Object = callable.get_object()
	var method: String = str(callable.get_method())
	var taken: Dictionary = {}
	for info: Dictionary in target.get_method_list() if target != null else []:
		if str(info.get("name", "")) == method:
			taken = info
			break
	if taken.is_empty() or GdhRead.as_int(taken.get("flags", 0)) & METHOD_FLAG_VARARG:
		return ""
	var passed: Array[Dictionary] = []
	for info: Dictionary in source.get_signal_list():
		if str(info.get("name", "")) == signal_name:
			for argument: Dictionary in info.get("args", []):
				passed.append(argument)
			break
	if flags & Object.CONNECT_APPEND_SOURCE_OBJECT:
		passed.append({ "name": "source", "type": TYPE_OBJECT, "class_name": source.get_class() })
	var emitted: int = passed.size()
	var unbound: int = callable.get_unbound_arguments_count()
	passed = passed.slice(0, maxi(emitted - unbound, 0))
	var from_signal: int = passed.size()
	for bound: Variant in callable.get_bound_arguments():
		var bound_class: String = ""
		if bound is Object:
			var object: Object = bound
			bound_class = object.get_class()
		passed.append({ "name": "bound", "type": typeof(bound), "class_name": bound_class })
	var binds: int = passed.size() - from_signal

	# What the method is called with, said in the parts that make it: an answer counting the bound
	# arguments among the signal's said the signal passed more than it declares.
	var called: String = "%s passes %s" % [signal_name, _count(emitted)]
	if unbound > 0 or binds > 0:
		var changed: Array[String] = []
		if unbound > 0:
			changed.append("unbinds %d" % unbound)
		if binds > 0:
			changed.append("binds %d" % binds)
		called += (
			" and the connection %s, so %s is called with %s, and"
			% [" and ".join(PackedStringArray(changed)), method, _count(passed.size())]
		)
	else:
		called += ", and " + method

	var parameters: Array = taken.get("args", [])
	var defaults: Array = taken.get("default_args", [])
	var needed: int = parameters.size() - defaults.size()
	if passed.size() < needed:
		return "%s needs %d%s" % [called, needed, FAILS]
	if passed.size() > parameters.size():
		var most: String = "none" if parameters.is_empty() else "at most %d" % parameters.size()
		# Said with the misfit, since unbinds is what a connection to a method wanting less is for,
		# and only when the extra arguments are the signal's: a scene's connection unbinds the
		# arguments the signal passes before it adds the bound ones, so a bound one is never
		# dropped.
		var extra: int = passed.size() - parameters.size()
		var remedy: String = (
			(
				" Connect it with unbinds %d to leave out the last %s the signal passes."
				% [extra + unbound, "argument" if extra == 1 else "%d arguments" % extra]
			)
			if extra <= from_signal
			else ""
		)
		return "%s takes %s%s%s" % [called, most, FAILS, remedy]
	for at: int in passed.size():
		var given: Dictionary = passed[at]
		var parameter: Dictionary = parameters[at]
		if not _unrelated(given, parameter):
			continue
		var whose: String = (
			"%s passes argument %d" % [signal_name, at + 1]
			if at < from_signal
			else "the connection binds argument %d" % (at + 1)
		)
		return (
			"%s as %s, and %s takes it as %s: %s%s"
			% [
				whose,
				_type_named(given),
				method,
				str(parameter.get("name", "")),
				_type_named(parameter),
				FAILS,
			]
		)
	return ""


## Whether a value declared as [param given] can never be passed as [param parameter].
static func _unrelated(given: Dictionary, parameter: Dictionary) -> bool:
	var given_type: int = GdhRead.as_int(given.get("type", TYPE_NIL))
	var taken_type: int = GdhRead.as_int(parameter.get("type", TYPE_NIL))
	if given_type == TYPE_NIL or taken_type == TYPE_NIL:
		return false
	if (given_type == TYPE_OBJECT) != (taken_type == TYPE_OBJECT):
		return true
	if given_type != TYPE_OBJECT:
		return false
	var given_class: String = str(given.get("class_name", ""))
	var taken_class: String = str(parameter.get("class_name", ""))
	# A class a script declares is not in ClassDB, and an engine class can still hold an instance of
	# one, so only two engine classes are judged.
	if not ClassDB.class_exists(given_class) or not ClassDB.class_exists(taken_class):
		return false
	return (
		not ClassDB.is_parent_class(given_class, taken_class)
		and not ClassDB.is_parent_class(taken_class, given_class)
	)


static func _type_named(declared: Dictionary) -> String:
	var type: int = GdhRead.as_int(declared.get("type", TYPE_NIL))
	var named: String = str(declared.get("class_name", ""))
	if type == TYPE_OBJECT and not named.is_empty():
		return named
	return type_string(type)


## The scene that makes the connection [param source] holds with [param flags], as a path, or "" for
## one this scene makes. The engine marks such a connection inherited as the scene holding it loads:
## from an instance, the scene instanced, and from the root of an inherited scene, the one it
## inherits.
static func _made_in(scene: GdhSceneFile, source: Node, flags: int) -> String:
	if not flags & CONNECT_INHERITED:
		return ""
	if source != scene.root and not source.scene_file_path.is_empty():
		return source.scene_file_path
	var holder: Node = source if source == scene.root else source.owner
	while holder != null and holder != scene.root and holder.scene_file_path.is_empty():
		holder = holder.owner
	if holder != null and holder != scene.root:
		return holder.scene_file_path
	var packed: PackedScene = load(scene.path) as PackedScene
	var base: SceneState = packed.get_state().get_base_scene_state() if packed != null else null
	return base.get_path() if base != null else "a scene this one inherits"


static func _count(arguments: int) -> String:
	if arguments == 0:
		return "no arguments"
	return "1 argument" if arguments == 1 else "%d arguments" % arguments


func disconnect_signal(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var source_node_path: String = str(args.get("sourceNodePath", ""))
	var signal_name: String = str(args.get("signalName", ""))
	var target_node_path: String = str(args.get("targetNodePath", ""))
	var method_name: String = str(args.get("methodName", ""))

	if (
		source_node_path.is_empty()
		or signal_name.is_empty()
		or target_node_path.is_empty()
		or method_name.is_empty()
	):
		return { "ok": false, "error": "Missing required signal disconnection arguments" }

	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, true)
	if not refused.is_empty():
		return refused

	var ends: Array = _connection_ends(scene, source_node_path, signal_name, target_node_path)
	if ends[0] == null:
		return scene.refuse(str(ends[1]))
	var source: Node = ends[0]
	var target: Node = ends[1]

	var from: String = scene.path_of(source)
	var to: String = scene.path_of(target)
	# A connection that was never there saved the scene unchanged and answered as removed, so a
	# typo in either name read as success.
	var held: Dictionary = _saved(scene.root, from, signal_name, to, method_name)
	if held.is_empty():
		# The root's path is ".", which before ".method" read as "..method".
		var said_from: String = str(source.name) if source == scene.root else from
		var said_to: String = str(target.name) if target == scene.root else to
		return scene.refuse(
			(
				"%s has no connection from %s.%s to %s.%s."
				% [scene_path, said_from, signal_name, said_to, method_name]
			)
		)
	var made_in: String = _made_in(scene, source, GdhRead.as_int(held["flags"]))
	if not made_in.is_empty():
		var named_from: String = str(source.name) if source == scene.root else from
		var named_to: String = str(target.name) if target == scene.root else to
		var made_by: String = (
			"The connection from %s.%s to %s.%s is made by %s"
			% [named_from, signal_name, named_to, method_name, made_in]
		)
		return (
			scene
			. refuse(
				(
					made_by
					+ ", and this scene saves nothing about it: disconnect it there, which changes "
					+ "every scene using it."
				)
			)
		)
	var callable: Callable = held["callable"]
	source.disconnect(signal_name, callable)

	var written: Dictionary = scene.write(
		func(loaded: Node) -> String:
			if not _saved(loaded, from, signal_name, to, method_name).is_empty():
				return "the connection would still be in the scene when it loads."
			return ""
	)
	if not written.is_empty():
		return written

	var removed_flags: int = held["flags"]
	var answer: Dictionary = {
		"ok": true,
		"removed": true,
		"sourceNodePath": from,
		"signalName": signal_name,
		"targetNodePath": to,
		"methodName": method_name,
		"flags": removed_flags,
		"flagNames": flag_names(removed_flags),
	}
	_bound_into(answer, held)
	return answer


func list_connections(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var filter_path: String = str(args.get("nodePath", ""))

	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, false)
	if not refused.is_empty():
		return refused

	var root: Node = scene.root
	var filtered: Node = null
	if not filter_path.is_empty():
		filtered = GdhSceneFile.node_at(root, filter_path)
		if filtered == null:
			return scene.refuse(scene.not_found("Node not found: " + filter_path, filter_path))
	var nodes: Array = []
	_collect_nodes_recursive(root, ".", nodes)

	# Only persistent connections, which are the ones a scene file holds: a Container connects
	# signals of each child to itself as the child is added, and those were answered as if the file
	# held them. Matched on either end, since the filter is for connections involving the node.
	var connections: Array = []
	for entry: Dictionary in nodes:
		var path: String = str(entry["path"])
		var node: Node = entry["node"]
		for signal_info: Dictionary in node.get_signal_list():
			var signal_name: String = str(signal_info.get("name", ""))
			if signal_name.is_empty():
				continue
			for conn: Dictionary in node.get_signal_connection_list(signal_name):
				var flags: int = GdhRead.as_int(conn.get("flags", 0))
				if not flags & Object.CONNECT_PERSIST:
					continue
				var callable: Callable = conn.get("callable", Callable())
				var target_obj: Object = callable.get_object()
				if filtered != null and node != filtered and target_obj != filtered:
					continue
				var target_path: String = ""
				var editable: bool = scene.foreign(node).is_empty()
				if target_obj is Node:
					target_path = str(root.get_path_to(target_obj as Node))
					editable = editable and scene.foreign(target_obj as Node).is_empty()
				# A connection an instanced scene makes on its own root sits on a node this scene
				# owns, so the ends alone read it as one this scene could change.
				var made_in: String = _made_in(scene, node, flags)
				var listed: Dictionary = {
					"sourceNodePath": path,
					"signalName": signal_name,
					"targetNodePath": target_path,
					"methodName": str(callable.get_method()),
					"flags": flags,
					"flagNames": flag_names(flags),
					"editable": editable and made_in.is_empty(),
					"methodFound":
					target_obj != null and target_obj.has_method(callable.get_method()),
				}
				if not made_in.is_empty():
					listed["madeIn"] = made_in
				var bound: Dictionary = {
					"binds": callable.get_bound_arguments(),
					"unbinds": callable.get_unbound_arguments_count(),
				}
				_bound_into(listed, bound)
				var misfit: String = _misfit(node, signal_name, callable, flags)
				if not misfit.is_empty():
					listed["misfit"] = misfit
				connections.append(listed)

	scene.close()
	var answer: Dictionary = { "ok": true, "connections": connections }
	if Engine.is_editor_hint():
		answer["unsavedInEditor"] = GdhSceneFile.unsaved(scene_path)
	return answer


func _collect_nodes_recursive(node: Node, path: String, out_nodes: Array) -> void:
	out_nodes.append({ "path": path, "node": node })
	for child: Node in node.get_children():
		var child_path: String = str(child.name) if path == "." else path + "/" + str(child.name)
		_collect_nodes_recursive(child, child_path, out_nodes)
