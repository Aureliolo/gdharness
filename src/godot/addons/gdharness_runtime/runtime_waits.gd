extends RefCounted

## The commands that take time: they let the game run and answer when what was waited for has
## happened, or when the time ran out, so the caller never sleeps for a guessed length.

const GdhChanges = preload("runtime_changes.gd")
const GdhDeclared = preload("declared_values.gd")
const GdhPaths = preload("runtime_paths.gd")
const GdhQueries = preload("runtime_queries.gd")
const GdhRead = preload("reading.gd")
const GdhSays = preload("runtime_says.gd")
const GdhValues = preload("runtime_values.gd")

## The longest one wait may last, whatever the request says: past this the server has long
## since given up on the reply.
const CEILING_MSEC: int = 120000

## The most frames one wait may cover, which is about half a minute of a game drawing slowly.
const MOST_FRAMES: int = 600

## How long a wait for words leaves between looks, as a multiple of what the last look took: nine
## gives looking about a tenth of the time.
const LOOKS_APART: int = 9

## How a property wait compares what it reads with the value: equality by default, and order for a
## number that steps rather than lands, as a day counter on a fast clock goes from 31 to 34 between
## two looks and a wait for 32 never sees it.
const COMPARES: Array[String] = ["==", "!=", ">=", "<=", ">", "<"]

## The most signal watches kept at once; arming one past this lets the oldest go. Property watches
## are counted apart, to the same number.
const MOST_WATCHES: int = 16

## The most changes a property watch keeps. Past it, each new one takes the last place, so what is
## kept still ends on the latest value.
const MOST_CHANGES: int = 1000

## The commands that can change the game, by the tool call that sends each, which a property watch
## notes as they arrive.
const CALLS_NAMED: Dictionary[String, String] = {
	"set_property": "runtime_invoke set",
	"call_method": "runtime_invoke call",
	"click": "runtime_input click",
	"choose": "runtime_input choose",
	"inject_action": "runtime_input action",
	"inject_key": "runtime_input key",
	"inject_text": "runtime_input text",
	"inject_mouse_click": "runtime_input mouse_click",
	"inject_mouse_motion": "runtime_input mouse_motion",
	"inject_mouse_drag": "runtime_input mouse_drag",
	"inject_joypad_button": "runtime_input joypad_button",
	"inject_joypad_motion": "runtime_input joypad_motion",
}

## What a call noted by a property watch carries of its parameters, when it was given them.
const CALL_FIELDS: Array[String] = [
	"path", "method", "property", "action", "keycode", "button", "pressed", "says"
]

var _host: Node
var _values: GdhValues
var _watches: Dictionary[int, GdhWatch] = {}
var _traces: Dictionary[int, GdhTrace] = {}
var _next_watch: int = 1


func _init(host: Node, values: GdhValues) -> void:
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


## The refusal for [param signal_name], which [param node] lacks, naming the nearest signals it has,
## or every one when none is near: a name to send instead.
static func _no_signal(node: Node, node_path: String, signal_name: String) -> Dictionary:
	var said: String = "%s has no signal %s" % [node_path, signal_name]
	return {"type": "error", "message": GdhRead.offered(said, signal_name, GdhRead.signals_of(node)) + "."}


func wait_frames(params: Dictionary) -> Dictionary:
	var frames: int = GdhRead.as_int(params.get("frames", 1), 1)
	if frames < 1 or frames > MOST_FRAMES:
		return _out_of_range("frames", frames, 1, MOST_FRAMES)
	var started: int = Time.get_ticks_msec()
	for _frame: int in frames:
		await _host.get_tree().process_frame
	return {"type": "waited", "frames": frames, "elapsed_ms": Time.get_ticks_msec() - started}


## Waits for a signal to fire, and answers with what it carried, or that the time ran out. Given a
## watch, collects that instead: see [method watch_signal].
func wait_signal(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var signal_name: String = str(params.get("signal", ""))
	var timeout_ms: int = GdhRead.as_int(params.get("timeout_ms", 5000), 5000)
	if timeout_ms < 1 or timeout_ms > CEILING_MSEC:
		return _out_of_range("timeout_ms", timeout_ms, 1, CEILING_MSEC)
	if params.has("watch"):
		return await _collect(GdhRead.as_int(params["watch"], 0), timeout_ms)
	if node_path.is_empty() or signal_name.is_empty():
		return {"type": "error", "message": "Node path and signal name required"}

	var standing: Dictionary = GdhValues.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	if not node.has_signal(signal_name):
		return _no_signal(node, node_path, signal_name)

	var catcher: GdhSignalCatcher = GdhSignalCatcher.new()
	var callable: Callable = catcher._on_fired
	var listening: Error = node.connect(signal_name, callable, CONNECT_ONE_SHOT)
	if listening != OK:
		return {"type": "error", "message": "Could not listen to signal: " + signal_name}
	var started: int = Time.get_ticks_msec()
	while not catcher.fired and Time.get_ticks_msec() - started < timeout_ms:
		await _host.get_tree().process_frame
	if not catcher.fired and is_instance_valid(node) and node.is_connected(signal_name, callable):
		node.disconnect(signal_name, callable)

	var answer: Dictionary = {
		"type": "signal",
		"path": node_path,
		"signal": signal_name,
		"fired": catcher.fired,
		"args": _values.serialize(catcher.args),
		"elapsed_ms": Time.get_ticks_msec() - started,
	}
	if not catcher.fired:
		answer["note"] = (
			"A wait hears the signal only from when it begins, so one that fired before it is not"
			+ " counted. If a call meant to set the signal off was sent beside this wait, it may have run"
			+ " only after the wait answered, as a client can run its calls in turn: arm runtime_wait"
			+ " watch first, make the call, then wait with signal and that watch"
		)
	return answer


## Starts recording a signal and answers at once with the watch to collect it by.
##
## A wait sent beside the call meant to set its signal off does not see it when the client runs the
## two in turn: Claude Code ran a key press only after the signal wait beside it had answered, so the
## wait ran out and the press landed after it. A watch is armed before the call and collected after.
func watch_signal(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var signal_name: String = str(params.get("signal", ""))
	var property: String = str(params.get("property", ""))
	if not signal_name.is_empty() and not property.is_empty():
		return {
			"type": "error",
			"message":
			(
				"A watch records a signal or a property, not both: this one has signal %s and property %s"
				% [signal_name, property]
			)
		}
	if not property.is_empty():
		return _watch_property(node_path, property)
	if node_path.is_empty() or signal_name.is_empty():
		return {"type": "error", "message": "Node path and signal name required"}
	var standing: Dictionary = GdhValues.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	if not node.has_signal(signal_name):
		return _no_signal(node, node_path, signal_name)
	var watch: GdhWatch = GdhWatch.new(node, node_path, signal_name)
	var listening: Error = node.connect(signal_name, watch.catcher._on_fired)
	if listening != OK:
		return {"type": "error", "message": "Could not listen to signal: " + signal_name}
	while _watches.size() >= MOST_WATCHES:
		var oldest: int = _watches.keys().min()
		_let_go(oldest)
	var id: int = _next_watch
	_next_watch += 1
	_watches[id] = watch
	return {"type": "watching", "watch": id, "path": node_path, "signal": signal_name}


## Answers at once with the first emission recorded since watch [param id] was armed, otherwise
## waits for the next until the time runs out. The watch goes either way.
func _collect(id: int, timeout_ms: int) -> Dictionary:
	if _traces.has(id):
		return {
			"type": "error",
			"message":
			(
				"Watch %d records %s:%s, a property, and is collected with runtime_wait recorded"
				% [id, _traces[id].node_path, _traces[id].property]
			)
		}
	if not _watches.has(id):
		return {
			"type": "error",
			"message":
			(
				(
					"No watch %d is armed in this game: it was collected already, %d armed after it let it"
					+ " go, or the game started again since"
				)
				% [id, MOST_WATCHES]
			),
		}
	var watch: GdhWatch = _watches[id]
	var started: int = Time.get_ticks_msec()
	var before: bool = watch.catcher.fired
	while not watch.catcher.fired and Time.get_ticks_msec() - started < timeout_ms:
		await _host.get_tree().process_frame
	_let_go(id)
	var answer: Dictionary = {
		"type": "signal",
		"path": watch.node_path,
		"signal": watch.signal_name,
		"watch": id,
		"fired": watch.catcher.fired,
		"times": watch.catcher.times,
		"args": _values.serialize(watch.catcher.args),
		"elapsed_ms": Time.get_ticks_msec() - started,
	}
	if watch.catcher.fired:
		answer["fired_after_ms"] = watch.catcher.fired_after_ms
	if before:
		answer["fired_before_wait"] = true
	return answer


func _let_go(id: int) -> void:
	var watch: GdhWatch = _watches.get(id)
	var _gone: bool = _watches.erase(id)
	if watch == null:
		return
	var held: Object = watch.node.get_ref()
	var node: Node = held as Node
	var callable: Callable = watch.catcher._on_fired
	if node != null and node.is_connected(watch.signal_name, callable):
		node.disconnect(watch.signal_name, callable)


## Starts recording [param property] every frame and answers at once with the watch and what it
## reads now.
##
## A tween or an animation is over before a client's next call reaches the game: a slide of 0.3
## seconds had finished by the time a wait sent after the click began, so its middle could be read
## only by slowing the game's clock. Armed before the click, the watch has every frame of it.
func _watch_property(node_path: String, property: String) -> Dictionary:
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}
	var standing: Dictionary = GdhValues.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	var watched: Dictionary = _watched(node, node_path, property)
	if watched.has("message"):
		return watched
	var trace: GdhTrace = GdhTrace.new(node, node_path, property)
	trace.see(0, 0, 0.0, watched["value"], _values)
	while _traces.size() >= MOST_WATCHES:
		var _gone: bool = _traces.erase(_traces.keys().min())
	var id: int = _next_watch
	_next_watch += 1
	_traces[id] = trace
	# Left to run across frames while the answer goes now. Deferred calls run once the frame's
	# _process is done and before its tweens step, so the recording starts in the frame it was armed in.
	_record.call_deferred(trace)
	return {
		"type": "watching",
		"watch": id,
		"path": node_path,
		"property": property,
		"value": _values.serialize(watched["value"]),
	}


## Reads the watched property at the start of every frame until the watch is collected, the node
## goes or the ceiling a wait has is reached.
##
## Read where a frame begins, which is after the last one's tweens and _process ran: the game time
## beside each reading is the time those had been given, which counts the frame the watch was armed
## in, since commands run before that frame's tweens step.
func _record(trace: GdhTrace) -> void:
	var started: int = Time.get_ticks_msec()
	var given: float = _host.get_process_delta_time()
	var game_time: float = 0.0
	var frame: int = 0
	while not trace.collected:
		await _host.get_tree().process_frame
		if trace.collected:
			return
		frame += 1
		game_time += given
		given = _host.get_process_delta_time()
		var elapsed: int = Time.get_ticks_msec() - started
		var held: Object = trace.node.get_ref()
		var node: Node = held as Node
		if node == null:
			trace.ended = "%s was freed %d frames after the watch was armed" % [trace.node_path, frame]
			return
		var watched: Dictionary = _watched(node, trace.node_path, trace.property)
		if watched.has("message"):
			trace.ended = "%d frames after the watch was armed: %s" % [frame, watched["message"]]
			return
		trace.see(frame, elapsed, game_time, watched["value"], _values)
		trace.frames = frame
		trace.elapsed_ms = elapsed
		if elapsed >= CEILING_MSEC:
			trace.ended = (
				"recording stopped %d ms after the watch was armed, the longest a wait lasts" % elapsed
			)
			return


## Notes [param command] in every property watch still recording, beside the last reading taken
## before it ran, so a recording shows where the call that started a change landed. A call two
## round trips apart from another lands dozens of frames later, which only this tells apart from
## the game's own delay.
func saw_call(command: String, params: Dictionary) -> void:
	var named: String = CALLS_NAMED.get(command, "")
	if named.is_empty():
		return
	for trace: GdhTrace in _traces.values():
		if trace.collected or not trace.ended.is_empty():
			continue
		if trace.calls.size() >= MOST_CHANGES:
			trace.calls_dropped += 1
			continue
		var noted: Dictionary = {"frame": trace.frames, "call": named}
		for field: String in CALL_FIELDS:
			if params.has(field):
				noted[field] = params[field]
		trace.calls.append(noted)


## What a property watch recorded, each change with the frame, the time and the game time it was
## read at. The watch goes with the answer.
func recorded(params: Dictionary) -> Dictionary:
	var id: int = GdhRead.as_int(params.get("watch", 0), 0)
	if _watches.has(id):
		return {
			"type": "error",
			"message":
			(
				"Watch %d records the signal %s of %s, and is collected with runtime_wait signal"
				% [id, _watches[id].signal_name, _watches[id].node_path]
			)
		}
	if not _traces.has(id):
		return {
			"type": "error",
			"message":
			(
				(
					"No property watch %d is armed in this game: it was collected already, %d armed after"
					+ " it let it go, or the game started again since"
				)
				% [id, MOST_WATCHES]
			),
		}
	var trace: GdhTrace = _traces[id]
	trace.collected = true
	var _gone: bool = _traces.erase(id)
	var answer: Dictionary = {
		"type": "recorded",
		"watch": id,
		"path": trace.node_path,
		"property": trace.property,
		"changes": trace.changes,
		"calls": trace.calls,
		"frames": trace.frames,
		"elapsed_ms": trace.elapsed_ms,
	}
	if trace.calls_dropped > 0:
		answer["calls_dropped"] = trace.calls_dropped
	if trace.dropped > 0:
		answer["dropped"] = (
			(
				"%d changes are left out: past %d, each new one took the last place, so the list ends on"
				+ " the latest"
			)
			% [trace.dropped, MOST_CHANGES]
		)
	if not trace.ended.is_empty():
		answer["ended"] = trace.ended
	return answer


## Waits until a property reads as the value given, or until something under the path says what
## was given, or the time runs out, and answers with what it read last either way.
func wait_until(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var says: String = str(params.get("says", ""))
	var timeout_ms: int = GdhRead.as_int(params.get("timeout_ms", 5000), 5000)
	if timeout_ms < 1 or timeout_ms > CEILING_MSEC:
		return _out_of_range("timeout_ms", timeout_ms, 1, CEILING_MSEC)
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}
	var standing: Dictionary = GdhValues.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	# Two different questions, not two ways of asking one: says looks for words anywhere under the
	# path, a property compares one value on one node. Taking says and dropping the other left a
	# caller watching a screen while believing they were watching a property, and the answer says
	# which of them it is about only if you already know that says wins.
	if not says.is_empty() and (not property.is_empty() or params.has("value") or params.has("compare")):
		var other: String = (
			property if not property.is_empty() else ("value" if params.has("value") else "compare")
		)
		return {
			"type": "error",
			"message":
			(
				(
					'A wait takes says or a property, not both: this one has says "%s" and %s as well.'
					+ " Ask for one of them."
				)
				% [says, other]
			)
		}
	if not says.is_empty():
		var include_hidden: bool = GdhRead.as_bool(params.get("include_hidden", false))
		return await _wait_until_said(node_path, says, timeout_ms, include_hidden)
	var unasked: String = _property_wait_unasked(property, params)
	if not unasked.is_empty():
		return {"type": "error", "message": unasked}
	var compare: String = str(params.get("compare", "=="))

	var node: Node = standing["node"]

	# A property the node has not got, refused here rather than waited on. Waiting answered "not
	# met" after the whole timeout, which is what a game that never reached the state answers too,
	# so a mistyped name and a condition that did not happen read the same. The property read
	# refuses that typo in one call, and two tools disagreeing about it is the fault.
	var watched: Dictionary = _watched(node, node_path, property)
	if watched.has("message"):
		return watched

	var current: Variant = watched["value"]
	if compare in [">=", "<=", ">", "<"]:
		return await _wait_in_order(node, params, current, timeout_ms)
	var by_name: Array = _enum_by_name(watched, params["value"], node_path)
	var sent: Variant = by_name[1] if not by_name.is_empty() and by_name[0] else params["value"]
	var wanted: Variant = _values.fitted(sent, typeof(current))
	# Read against what the property is declared as, not only against what it holds this frame: an
	# object property holding null holds nothing typed, so any value was taken as it came and compared
	# with null until the time ran out. #772 waited a minute for "null" that way and answered met
	# false with value null beside it.
	var declared: int = watched["declared"]
	# An untyped slot holding null or an object is read the same way, as set reads it: otherwise the
	# two ops would disagree about one property, and the wait would run out on the text null.
	var untyped_object: bool = declared == TYPE_NIL and (current == null or typeof(current) == TYPE_OBJECT)
	var holds_objects: bool = declared == TYPE_OBJECT or untyped_object
	if holds_objects and GdhChanges.names_no_object(wanted):
		wanted = null
	# A word no value of an enum is called, refused naming the values before it is compared as text.
	var refused: String = "" if by_name.is_empty() or by_name[0] else str(by_name[1])
	if refused.is_empty():
		refused = _not_comparable(current, wanted, node_path, property)
	if refused.is_empty():
		refused = _cut_to_fit(sent, typeof(current), node_path, property)
	var rounded: String = GdhValues.inexact(sent, typeof(current))
	if refused.is_empty() and not rounded.is_empty():
		refused = "%s.%s holds int: %s." % [node_path, property, rounded]
	var never_held: bool = typeof(wanted) != TYPE_NIL and typeof(wanted) != TYPE_OBJECT
	if refused.is_empty() and declared == TYPE_OBJECT and never_held:
		refused = (
			(
				"%s.%s is declared to hold an object and the value to wait for is %s, which it can"
				+ " never hold: wait for null, or for the object's own value on a property of it."
			)
			% [node_path, property, type_string(typeof(wanted))]
		)
	if not refused.is_empty():
		return {"type": "error", "message": refused}

	var started: int = Time.get_ticks_msec()
	var frames: int = 0
	# The type is checked every time round, not only at the top: a property that holds an object a
	# frame later is the same error arriving late.
	# At the precision the property keeps, as set compares: a float arrives as 64 bits and most
	# engine properties keep 32, so h_offset waited on as -1.1 read -1.10000002384186 every frame and
	# the wait ran out on a value the game had reached.
	var differs: bool = compare == "!="
	while (
		GdhValues.comparable(current, wanted)
		and GdhChanges.held_already(wanted, current) == differs
		and Time.get_ticks_msec() - started < timeout_ms
	):
		await _host.get_tree().process_frame
		frames += 1
		if not is_instance_valid(node):
			return {"type": "error", "message": "%s was freed while waiting" % node_path}
		watched = _watched(node, node_path, property)
		if watched.has("message"):
			return watched
		current = watched["value"]

	var answer: Dictionary = {
		"type": "condition",
		"path": node_path,
		"property": property,
		"compare": compare,
		"met": GdhValues.comparable(current, wanted) and GdhChanges.held_already(wanted, current) != differs,
		"value": _values.serialize(current),
		"elapsed_ms": Time.get_ticks_msec() - started,
		"frames": frames,
	}
	# Said rather than refused, since a game may store a number no value has, as set says it stores
	# one: a wait for 7 on an enum of three ran its whole timeout and answered only that it was not met.
	if watched["holder"] is Object:
		var owner: Object = watched["holder"]
		var shown: String = JSON.stringify(_values.serialize(wanted), "", false)
		var declaration: Dictionary = watched["declaration"]
		var outside: String = GdhDeclared.outside(owner, declaration, wanted, shown)
		if not outside.is_empty():
			answer["outside_declared"] = outside
	return answer


## What a property wait is missing or was given wrongly, or "" when it can go ahead.
static func _property_wait_unasked(property: String, params: Dictionary) -> String:
	if property.is_empty():
		return "A property and a value, or says, are required"
	if not params.has("value"):
		return "A value to wait for is required"
	var compare: String = str(params.get("compare", "=="))
	if not COMPARES.has(compare):
		return 'compare is one of %s, not "%s"' % [", ".join(COMPARES), compare]
	return ""


## [method wait_until] for a number compared by order: met on the first look at which the property
## is past the value, or level with it at the precision the property keeps, as `==` compares.
##
## The value is read as the number it is rather than fitted to the property's type, since fitting
## truncates: 31.5 on a whole-number property became 31, and a wait for "at least 31.5" was met at 31.
func _wait_in_order(node: Node, params: Dictionary, current: Variant, timeout_ms: int) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var compare: String = str(params.get("compare", ""))
	var given: Variant = params["value"]
	# The property first: a string waited on in order is refused for being a string, whatever value
	# came with it, since no number would make the wait answerable.
	var unordered: String = _no_order(current, node_path, property, compare)
	if not unordered.is_empty():
		return {"type": "error", "message": unordered}
	var number: Variant = given
	if given is String:
		var text: String = given
		number = GdhRead.json_or_null(text)
	if typeof(number) != TYPE_INT and typeof(number) != TYPE_FLOAT:
		return {
			"type": "error",
			"message":
			(
				"compare %s puts a number in order, and the value to wait for is %s: give a number."
				% [compare, str(given)]
			)
		}
	var limit: float = GdhRead.as_float(number)

	var started: int = Time.get_ticks_msec()
	var frames: int = 0
	while not _in_order(compare, limit, current) and Time.get_ticks_msec() - started < timeout_ms:
		await _host.get_tree().process_frame
		frames += 1
		if not is_instance_valid(node):
			return {"type": "error", "message": "%s was freed while waiting" % node_path}
		var watched: Dictionary = _watched(node, node_path, property)
		if watched.has("message"):
			return watched
		current = watched["value"]
		unordered = _no_order(current, node_path, property, compare)
		if not unordered.is_empty():
			return {"type": "error", "message": unordered}

	return {
		"type": "condition",
		"path": node_path,
		"property": property,
		"compare": compare,
		"met": _in_order(compare, limit, current),
		"value": _values.serialize(current),
		"elapsed_ms": Time.get_ticks_msec() - started,
		"frames": frames,
	}


## Why [param current] cannot be put in order, or "" when it is a number.
static func _no_order(current: Variant, node_path: String, property: String, compare: String) -> String:
	if typeof(current) == TYPE_INT or typeof(current) == TYPE_FLOAT:
		return ""
	return (
		"%s.%s holds %s, which has no order, so compare %s cannot be asked of it: use == or !=."
		% [node_path, property, type_string(typeof(current)), compare]
	)


## Whether [param current], a number, stands to [param limit] as [param compare] says. Level counts
## at the precision the property keeps, so a 32-bit float holding 0.30000001 is at least 0.3.
static func _in_order(compare: String, limit: float, current: Variant) -> bool:
	var reading: float = GdhRead.as_float(current)
	var level: bool = (
		reading == limit or (typeof(current) == TYPE_FLOAT and GdhChanges.held_already(limit, current))
	)
	match compare:
		">=":
			return level or reading > limit
		"<=":
			return level or reading < limit
		">":
			return not level and reading > limit
		_:
			return not level and reading < limit


## Why [param given] would have to be cut to be waited on a whole number or a truth, or "" when not.
##
## A number arrives from JSON as a float, so one is converted to what the property holds, and the
## conversion truncates: 3.5 waited on an int became 3 and 0.2 on a bool became true, and a property
## already holding that answered met at once, about a state nobody asked for.
static func _cut_to_fit(given: Variant, type: int, node_path: String, property: String) -> String:
	if not GdhValues.cuts(given, type):
		return ""
	return (
		(
			"%s.%s holds %s and the value to wait for is %s, which %s cannot hold without changing it:"
			+ " waiting on it would answer about a state nobody asked for."
		)
		% [node_path, property, type_string(type), str(given), GdhValues.cut_by(type)]
	)


## Why [param wanted] cannot be waited for against [param current], or "" when it can.
##
## Refused before anything is evaluated, because the evaluation is what does the damage: an object
## compared against anything else is a hard error in GDScript, raised inside the game, which holds
## it at a debugger break. Both types are named because the caller cannot see either from where
## they are standing.
##
## And a value that cannot become what the property holds, which lands worse than the halt: a word
## where a number goes became 0.0, 0.0 already equalled the property, and the wait answered met the
## instant it started, about a state nobody asked about, with the real value beside it. A refusal
## is read and a met is acted on.
static func _not_comparable(current: Variant, wanted: Variant, node_path: String, property: String) -> String:
	var types: Array[String] = [
		node_path, property, type_string(typeof(current)), type_string(typeof(wanted))
	]
	# A value that cannot become what the property holds is said as that, which names the remedy,
	# before the comparison it would also fail; an object on either side is said as the comparison.
	var objects: bool = typeof(current) == TYPE_OBJECT or typeof(wanted) == TYPE_OBJECT
	if not objects and not GdhValues.acceptable(wanted, typeof(current)):
		return (
			(
				(
					"%s.%s holds %s and the value to wait for is %s, which cannot become one:"
					+ " waiting on it would answer about a state nobody asked for."
				)
				% types
			)
			+ GdhValues.remedy(wanted, typeof(current))
		)
	if not GdhValues.comparable(current, wanted):
		return (
			(
				"%s.%s holds %s and the value to wait for is %s. Those cannot be compared, and"
				+ " waiting on it would stop the game rather than answer about it."
			)
			% types
		)
	if not GdhValues.acceptable(wanted, typeof(current)):
		return (
			(
				(
					"%s.%s holds %s and the value to wait for is %s, which cannot become one:"
					+ " waiting on it would answer about a state nobody asked for."
				)
				% types
			)
			+ GdhValues.remedy(wanted, typeof(current))
		)
	return ""


## [param sent] as the number of the value an enum property names by it, as
## [method GdhDeclared.enum_by_name] answers, for a word waited for on what [param watched] read; []
## when the property is no enum or the value no word.
static func _enum_by_name(watched: Dictionary, sent: Variant, node_path: String) -> Array:
	var declaration: Dictionary = watched["declaration"]
	var enum_hint: bool = GdhRead.as_int(declaration.get("hint", PROPERTY_HINT_NONE)) == PROPERTY_HINT_ENUM
	if watched["declared"] != TYPE_INT or not enum_hint or not sent is String:
		return []
	if not watched["holder"] is Object:
		return []
	var owner: Object = watched["holder"]
	return GdhDeclared.enum_by_name(owner, declaration, str(sent), node_path)


## What [param property] reads as on [param node] right now, under `value`, or a `message` saying
## why it cannot be read.
##
## Through the same walk as the property read, so a wait can watch what a node holds,
## "_game:run:day", and what a call answers, "get_viewport():gui_get_focus_owner()". Walked from the
## node every time rather than read off the holder found at the start, because a game replaces what
## its nodes hold: a run object built afresh each day would leave a wait watching the day before. A
## step that has gone in the meantime ends the wait with what went.
static func _watched(node: Node, node_path: String, property: String) -> Dictionary:
	var reached: Dictionary = GdhPaths.walk_to(node, node_path, property)
	if reached.has("message"):
		return reached
	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	var missing: String = GdhPaths.nothing_under(holder, named, str(reached["called"]))
	if not missing.is_empty():
		return {"type": "error", "message": missing}
	var slot: Dictionary = _declared_slot(holder, named)
	return {
		"value": GdhPaths.read_under(holder, named),
		"declared": slot["type"],
		"declaration": slot["declared"],
		"holder": holder,
	}


## What [param named] is declared with on [param holder], as [method GdhValues.slot_declared] answers,
## read the way a set reads it, so the two refuse the same values: a property's declaration, or a
## typed list's or map's element type. Read off properties alone, an element of an Array[Node] holding
## null declares nothing, and a wait for 5 on it runs out the timeout while a set of 5 on it is refused
## at once. TYPE_NIL for anything declaring none, and for a call, whose answer nothing declares.
static func _declared_slot(holder: Variant, named: String) -> Dictionary:
	if not GdhPaths.method_of(named).is_empty():
		return {"type": TYPE_NIL, "class": "", "script": null, "declared": {}}
	return GdhValues.slot_declared(holder, named)


## Waits until something under [param node_path] has [param said] written on it.
##
## A screen rather than one node, because a panel following a clock builds its labels again every
## time it redraws and the engine names those `@Label@1163`. A wait holding one of them is waiting
## on a node that was freed a frame later, and that is what it answered: the date along the top of a
## hall could not be waited on at all. What a caller is watching for is a word arriving on a screen,
## and the screen is the part that stays put.
##
## On the screen, which is to say shown: a control carrying the words while hidden satisfied the
## wait at once, so a duel screen whose "Carry on" button exists hidden through the whole sweep
## answered met in two milliseconds while the sweep was still animating, and every wait on that
## screen fell back to counting frames. [param include_hidden] asks the other question, for a
## caller waiting on words a hidden node holds.
##
## Paced by what a look costs, so the watching leaves the game its speed: every frame while a look is
## cheap, and on a screen large enough for one to cost a real share of a frame, often enough that
## looking takes about a tenth of the time. Every frame on a hall of 3,500 nodes held the game at a
## sixth of its frame rate, and its clock, which advances by the frame's delta, lost three quarters
## of its time, so a wait for a date timed out on a clock that turned a day every thirty seconds.
## The answer says how many frames the wait spanned, how many looks it took and how long they took
## between them, which is how a caller sees what it cost and whether the game lost its speed to the
## looks or to something else.
func _wait_until_said(node_path: String, said: String, timeout_ms: int, include_hidden: bool) -> Dictionary:
	var started: int = Time.get_ticks_msec()
	var frames: int = 0
	var looks: int = 0
	var looked_usec: int = 0
	var next_look: int = 0
	var looked_at_frame: int = 0
	var found: bool = false
	while true:
		if Time.get_ticks_usec() >= next_look:
			var looking: int = Time.get_ticks_usec()
			found = _anything_says(node_path, said, include_hidden)
			looks += 1
			var took: int = Time.get_ticks_usec() - looking
			looked_usec += took
			next_look = Time.get_ticks_usec() + took * LOOKS_APART
			looked_at_frame = frames
		if found or Time.get_ticks_msec() - started >= timeout_ms:
			break
		await _host.get_tree().process_frame
		frames += 1
	# One more look at the end, so words that arrived between two paced looks are not answered as
	# never having come. Taken once a whole frame has run since the last look, which is two frame
	# starts: a first look that outlasted the timeout otherwise left none, so the wait answered with
	# the game not having run at all, and a command sent during that look not yet read.
	if not found:
		while frames - looked_at_frame < 2:
			await _host.get_tree().process_frame
			frames += 1
		var last: int = Time.get_ticks_usec()
		found = _anything_says(node_path, said, include_hidden)
		looks += 1
		looked_usec += Time.get_ticks_usec() - last

	var answer: Dictionary = {
		"type": "condition",
		"path": node_path,
		"says": said,
		"met": found,
		"include_hidden": include_hidden,
		"elapsed_ms": Time.get_ticks_msec() - started,
		"frames": frames,
		"looks": looks,
		"looking_ms": looked_usec / 1000.0,
	}
	# Words that are there and cannot be read look, from a wait that ran out, like words that never
	# came.
	if not found and not include_hidden and _anything_says(node_path, said, true):
		answer["unseen_note"] = (
			(
				"Something under %s says it, but is hidden or drawn outside the viewport or a"
				+ " ScrollContainer, where the player cannot read it; includeHidden true counts it there too"
			)
			% node_path
		)
	return answer


## Whether anything under [param node_path] says [param said], the node itself included, and where
## the player can read it unless hidden ones are wanted too. Matched as a find and a click match
## `says`, a glob over the whole text when it has `*` or `?`: read as literal words, a glob a click
## had just pressed by was waited on for the whole timeout with its label on screen, and answered as
## words never arriving.
func _anything_says(node_path: String, said: String, include_hidden: bool) -> bool:
	var root: Node = _host.get_tree().root.get_node_or_null(node_path)
	if root == null:
		return false
	var pending: Array[Node] = [root]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		if GdhSays.says(node, said) and (include_hidden or GdhQueries.readable(node)):
			return true
		pending.append_array(node.get_children(true))
	return false


## Remembers that a signal fired and what it carried, for a wait that polls rather than
## awaits the signal directly, so the wait can also give up. Takes any number of arguments: a
## handler of five fixed ones covered the engine's signals, and a game's own signal with six was
## never delivered to it, so the wait ran out and said the signal had not fired.
class GdhSignalCatcher:
	extends RefCounted
	var fired: bool = false
	## How many times it fired; [member args] holds what the first carried.
	var times: int = 0
	var args: Array = []
	## Milliseconds from when this began listening to the first emission, -1 before one. A wait
	## collecting a watch measured only itself, so a call made between the arming and the wait left
	## nothing saying how long after it the signal came.
	var fired_after_ms: int = -1
	var _armed_at: int = Time.get_ticks_msec()

	func _on_fired(...carried: Array) -> void:
		if not fired:
			args = carried
			fired_after_ms = Time.get_ticks_msec() - _armed_at
		fired = true
		times += 1


## A property recorded from when it was armed until it is collected: the reading at arming, then
## each frame's that differs from the one before.
class GdhTrace:
	extends RefCounted
	var node: WeakRef
	var node_path: String
	var property: String
	var changes: Array[Dictionary] = []
	var dropped: int = 0
	var calls: Array[Dictionary] = []
	var calls_dropped: int = 0
	var frames: int = 0
	var elapsed_ms: int = 0
	var ended: String = ""
	var collected: bool = false
	var _last: Variant = null
	var _seen: bool = false

	func _init(watched: Node, path: String, named: String) -> void:
		node = weakref(watched)
		node_path = path
		property = named

	func see(frame: int, elapsed: int, game_time: float, value: Variant, values: GdhValues) -> void:
		if _seen and typeof(value) == typeof(_last) and value == _last:
			return
		_seen = true
		# A copy of a list or a map, which the game may change in place: held as it is, the reading
		# kept is the game's own, and it reads the same as every later one.
		_last = value
		if value is Array:
			var list: Array = value
			_last = list.duplicate(true)
		elif value is Dictionary:
			var map: Dictionary = value
			_last = map.duplicate(true)
		# Game time unrounded: a frame can be a tenth of a millisecond long, and a rate worked out over
		# one from times cut to a ten-thousandth was off by its own size.
		var change: Dictionary = {
			"frame": frame,
			"elapsed_ms": elapsed,
			"game_time": game_time,
			"value": values.serialize(value),
		}
		if changes.size() < MOST_CHANGES:
			changes.append(change)
		else:
			changes[changes.size() - 1] = change
			dropped += 1


## A signal recorded from when it was armed until it is collected.
class GdhWatch:
	extends RefCounted
	var node: WeakRef
	var node_path: String
	var signal_name: String
	var catcher: GdhSignalCatcher = GdhSignalCatcher.new()

	func _init(watched: Node, path: String, named: String) -> void:
		node = weakref(watched)
		node_path = path
		signal_name = named
