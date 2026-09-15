extends RefCounted

## The commands that take time: they let the game run and answer when what was waited for has
## happened, or when the time ran out, so the caller never sleeps for a guessed length.

const Queries = preload("runtime_queries.gd")
const Values = preload("runtime_values.gd")

## The longest one wait may last, whatever the request says: past this the server has long
## since given up on the reply.
const CEILING_MSEC: int = 120000

## The most frames one wait may cover, which is about half a minute of a game drawing slowly.
const MOST_FRAMES: int = 600

var _host: Node
var _values: Values


func _init(host: Node, values: Values) -> void:
	_host = host
	_values = values


## Refuses [param asked] rather than bringing it inside [param least] to [param most].
##
## A number quietly brought inside the range is a wait that did not last as long as the caller
## believes and a timeout that gave up sooner: asking for 900 frames and waiting 600 reads as 900
## frames of the game having passed, and everything measured off it is out by that much.
static func _out_of_range(named: String, asked: int, least: int, most: int) -> Dictionary:
	return {
		"type": "error", "message": "%s is %d, and %s takes %d to %d." % [named, asked, named, least, most]
	}


func wait_frames(params: Dictionary) -> Dictionary:
	var frames: int = int(params.get("frames", 1))
	if frames < 1 or frames > MOST_FRAMES:
		return _out_of_range("frames", frames, 1, MOST_FRAMES)
	var started: int = Time.get_ticks_msec()
	for _frame: int in frames:
		await _host.get_tree().process_frame
	return {"type": "waited", "frames": frames, "elapsed_ms": Time.get_ticks_msec() - started}


## Waits for a signal to fire, and answers with what it carried, or that the time ran out.
func wait_signal(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var signal_name: String = str(params.get("signal", ""))
	var timeout_ms: int = int(params.get("timeout_ms", 5000))
	if timeout_ms < 1 or timeout_ms > CEILING_MSEC:
		return _out_of_range("timeout_ms", timeout_ms, 1, CEILING_MSEC)
	if node_path.is_empty() or signal_name.is_empty():
		return {"type": "error", "message": "Node path and signal name required"}

	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	if not node.has_signal(signal_name):
		return {"type": "error", "message": "%s has no signal %s" % [node_path, signal_name]}

	var catcher: SignalCatcher = SignalCatcher.new()
	catcher.arity = _signal_arity(node, signal_name)
	var callable: Callable = catcher._on_fired
	node.connect(signal_name, callable, CONNECT_ONE_SHOT)
	var started: int = Time.get_ticks_msec()
	while not catcher.fired and Time.get_ticks_msec() - started < timeout_ms:
		await _host.get_tree().process_frame
	if not catcher.fired and is_instance_valid(node) and node.is_connected(signal_name, callable):
		node.disconnect(signal_name, callable)

	return {
		"type": "signal",
		"path": node_path,
		"signal": signal_name,
		"fired": catcher.fired,
		"args": _values.serialize(catcher.args),
		"elapsed_ms": Time.get_ticks_msec() - started,
	}


## Waits until a property reads as the value given, or until something under the path says what
## was given, or the time runs out, and answers with what it read last either way.
func wait_until(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var says: String = str(params.get("says", ""))
	var timeout_ms: int = int(params.get("timeout_ms", 5000))
	if timeout_ms < 1 or timeout_ms > CEILING_MSEC:
		return _out_of_range("timeout_ms", timeout_ms, 1, CEILING_MSEC)
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}
	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	if not says.is_empty():
		return await _wait_until_said(node_path, says, timeout_ms)
	if property.is_empty():
		return {"type": "error", "message": "A property and a value, or says, are required"}
	if not params.has("value"):
		return {"type": "error", "message": "A value to wait for is required"}

	var node: Node = standing["node"]

	var current: Variant = node.get(property)
	var wanted: Variant = _values.fitted(params["value"], typeof(current))
	var started: int = Time.get_ticks_msec()
	while current != wanted and Time.get_ticks_msec() - started < timeout_ms:
		await _host.get_tree().process_frame
		if not is_instance_valid(node):
			return {"type": "error", "message": "%s was freed while waiting" % node_path}
		current = node.get(property)

	return {
		"type": "condition",
		"path": node_path,
		"property": property,
		"met": current == wanted,
		"value": _values.serialize(current),
		"elapsed_ms": Time.get_ticks_msec() - started,
	}


## Waits until something under [param node_path] has [param said] written on it.
##
## A screen rather than one node, because a panel following a clock builds its labels again every
## time it redraws and the engine names those `@Label@1163`. A wait holding one of them is waiting
## on a node that was freed a frame later, and that is what it answered: the date along the top of a
## hall could not be waited on at all. What a caller is watching for is a word arriving on a screen,
## and the screen is the part that stays put.
func _wait_until_said(node_path: String, said: String, timeout_ms: int) -> Dictionary:
	var started: int = Time.get_ticks_msec()
	var found: bool = _anything_says(node_path, said)
	while not found and Time.get_ticks_msec() - started < timeout_ms:
		await _host.get_tree().process_frame
		found = _anything_says(node_path, said)

	return {
		"type": "condition",
		"path": node_path,
		"says": said,
		"met": found,
		"elapsed_ms": Time.get_ticks_msec() - started,
	}


## Whether anything under [param node_path] says [param said], the node itself included. Hidden
## nodes count, for the reason a find answers off them: a caller may be waiting for a dialog that
## is built before it is shown.
func _anything_says(node_path: String, said: String) -> bool:
	var root: Node = _host.get_tree().root.get_node_or_null(node_path)
	if root == null:
		return false
	var pending: Array[Node] = [root]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		if Queries.said_by(node).containsn(said):
			return true
		pending.append_array(node.get_children(true))
	return false


func _signal_arity(node: Node, signal_name: String) -> int:
	for entry: Dictionary in node.get_signal_list():
		if entry.get("name", "") == signal_name:
			var declared: Array = entry.get("args", [])
			return declared.size()
	return 0


## Remembers that a signal fired and what it carried, for a wait that polls rather than
## awaits the signal directly, so the wait can also give up. The handler accepts up to five
## arguments, which covers every signal the engine declares, and records as many as the signal
## has.
class SignalCatcher:
	extends RefCounted
	var fired: bool = false
	var arity: int = 0
	var args: Array = []

	func _on_fired(
		a: Variant = null, b: Variant = null, c: Variant = null, d: Variant = null, e: Variant = null
	) -> void:
		fired = true
		args = [a, b, c, d, e].slice(0, mini(arity, 5))
