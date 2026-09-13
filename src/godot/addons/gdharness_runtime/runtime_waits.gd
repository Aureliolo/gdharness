extends RefCounted

## The commands that take time: they let the game run and answer when what was waited for has
## happened, or when the time ran out, so the caller never sleeps for a guessed length.

const Values = preload("runtime_values.gd")

## The longest one wait may last, whatever the request says: past this the server has long
## since given up on the reply.
const CEILING_MSEC: int = 120000

var _host: Node
var _values: Values


func _init(host: Node, values: Values) -> void:
	_host = host
	_values = values


func wait_frames(params: Dictionary) -> Dictionary:
	var frames: int = clampi(int(params.get("frames", 1)), 1, 600)
	var started: int = Time.get_ticks_msec()
	for _frame: int in frames:
		await _host.get_tree().process_frame
	return {"type": "waited", "frames": frames, "elapsed_ms": Time.get_ticks_msec() - started}


## Waits for a signal to fire, and answers with what it carried, or that the time ran out.
func wait_signal(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var signal_name: String = str(params.get("signal", ""))
	var timeout_ms: int = clampi(int(params.get("timeout_ms", 5000)), 1, CEILING_MSEC)
	if node_path.is_empty() or signal_name.is_empty():
		return {"type": "error", "message": "Node path and signal name required"}

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}
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


## Waits until a property reads as the value given, or the time runs out, and answers with
## what it read last either way.
func wait_until(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var timeout_ms: int = clampi(int(params.get("timeout_ms", 5000)), 1, CEILING_MSEC)
	if node_path.is_empty() or property.is_empty():
		return {"type": "error", "message": "Node path and property required"}
	if not params.has("value"):
		return {"type": "error", "message": "A value to wait for is required"}

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

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
