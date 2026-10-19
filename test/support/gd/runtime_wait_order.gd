extends SceneTree

## A property wait that compares by order or by difference rather than by equality (#1007): a day
## counter on a fast clock stepped from 31 to 34 between two looks, so a wait for 32 ran out. Each
## comparison is checked beside the wait that is not met, so a wait meeting everything fails too.

const Checked = preload("checked.gd")
const GdhRead = preload("res://addons/gdharness_runtime/reading.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")


## A counter stepping by [member step] every frame, as a day does under a fast clock.
class Counter:
	extends Node

	var day: int = 31
	var step: int = 0
	var mood: String = "idle"
	var turns_to_busy: int = -1
	var physics_steps: int = 0

	func _physics_process(_delta: float) -> void:
		physics_steps += 1

	func _process(_delta: float) -> void:
		day += step
		if turns_to_busy > 0:
			turns_to_busy -= 1
			if turns_to_busy == 0:
				mood = "busy"


var failures: Array[String] = []
var node: Runtime
var counter: Counter
var camera: Camera3D


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running here.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR", OS.get_temp_dir().path_join("gdharness-wait-order-%d" % OS.get_process_id())
	)
	node = Runtime.new()
	root.add_child(node)
	counter = Counter.new()
	counter.name = "Clock"
	root.add_child(counter)
	camera = Camera3D.new()
	camera.name = "Eye"
	root.add_child(camera)
	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _fail(message: String) -> void:
	failures.append(message)


func _run() -> void:
	await _check_a_counter_that_steps_past()
	await _check_level_is_at_the_precision_kept()
	await _check_a_fraction_is_a_threshold()
	await _check_a_wait_for_a_difference()
	await _check_what_is_refused()
	await _check_physics_steps_through_a_frame_wait()

	node._cleanup()
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


## A game's _physics_process goes on running while frames are waited for, by the time that passed.
## Reported from a game whose simulation steps there, read three ticks over a 120-frame wait of two
## seconds; measured on its own copy afterwards, the wait let it step with the time, which is what
## this holds. Counted in a node of the game's own rather than by the engine's counter, which goes on
## counting steps for a paused tree that runs nobody's _physics_process. By time rather than frames,
## because a headless run's frames are not paced; a step either way absorbs where the wait began and
## ended inside one.
func _check_physics_steps_through_a_frame_wait() -> void:
	var before: int = counter.physics_steps
	var waited: Dictionary = await node._execute_command("wait_frames", {"frames": 120})
	var stepped: int = counter.physics_steps - before
	var due: int = floori(
		GdhRead.as_float(waited.get("elapsed_ms", 0)) * Engine.physics_ticks_per_second / 1000.0
	)
	if waited.get("type") != "waited" or stepped < due - 2:
		_fail(
			(
				"physics should step through a frame wait by the time it took: %s, stepped %d of %d due"
				% [JSON.stringify(waited), stepped, due]
			)
		)


func _wait(params: Dictionary) -> Dictionary:
	var asked: Dictionary = {"path": "/root/Clock", "timeout_ms": 300}
	asked.merge(params, true)
	return await node._execute_command("wait_until", asked)


## The reported shape: 31, 34, 37, so 32 is never read. Equality runs out; at least 32 is met on the
## first look past it.
func _check_a_counter_that_steps_past() -> void:
	counter.day = 31
	counter.step = 3
	var exactly: Dictionary = await _wait({"property": "day", "value": 32})
	if exactly.get("met") != false or exactly.get("compare") != "==":
		_fail("equality never sees a value stepped over: %s" % JSON.stringify(exactly))
	counter.day = 31
	var past: Dictionary = await _wait({"property": "day", "value": 32, "compare": ">=", "timeout_ms": 3000})
	var reached: int = _as_int(past.get("value"))
	if past.get("met") != true or past.get("compare") != ">=" or reached < 32 or reached > 40:
		_fail("at least 32 is met on the first look past it: %s" % JSON.stringify(past))
	counter.day = 40
	counter.step = -3
	var down: Dictionary = await _wait({"property": "day", "value": 35, "compare": "<", "timeout_ms": 3000})
	if down.get("met") != true or _as_int(down.get("value")) >= 35:
		_fail("less than 35 is met on a counter going down: %s" % JSON.stringify(down))
	counter.step = 0
	counter.day = 5
	var strictly: Dictionary = await _wait({"property": "day", "value": 5, "compare": ">"})
	if strictly.get("met") != false:
		_fail("more than 5 is not met at 5: %s" % JSON.stringify(strictly))
	var level: Dictionary = await _wait({"property": "day", "value": 5, "compare": ">="})
	if level.get("met") != true or level.get("frames") != 0:
		_fail("at least 5 is met at once at 5: %s" % JSON.stringify(level))


## A 32-bit float given 0.3 holds 0.30000001192, which is above 0.3 in 64 bits. Level is read at
## the precision the property keeps, as equality is, so at most 0.3 is met and more than 0.3 is not.
func _check_level_is_at_the_precision_kept() -> void:
	camera.h_offset = 0.3
	var at_most: Dictionary = await _wait(
		{"path": "/root/Eye", "property": "h_offset", "value": 0.3, "compare": "<="}
	)
	if at_most.get("met") != true:
		_fail("at most 0.3 is met by a 32-bit float given 0.3: %s" % JSON.stringify(at_most))
	var above: Dictionary = await _wait(
		{"path": "/root/Eye", "property": "h_offset", "value": 0.3, "compare": ">"}
	)
	if above.get("met") != false:
		_fail("more than 0.3 is not met by a 32-bit float given 0.3: %s" % JSON.stringify(above))


## Fitting 31.5 to a whole number truncates it to 31, which at least 31.5 would then meet at 31.
func _check_a_fraction_is_a_threshold() -> void:
	counter.step = 0
	counter.day = 31
	var short: Dictionary = await _wait({"property": "day", "value": 31.5, "compare": ">="})
	if short.get("met") != false:
		_fail("at least 31.5 is not met at 31: %s" % JSON.stringify(short))
	counter.day = 32
	var over: Dictionary = await _wait({"property": "day", "value": "31.5", "compare": ">="})
	if over.get("met") != true:
		_fail("and is met at 32, the value given as text too: %s" % JSON.stringify(over))


## Different from the value: not met while it reads the same, met on the look after it changes.
func _check_a_wait_for_a_difference() -> void:
	counter.mood = "idle"
	counter.turns_to_busy = -1
	var same: Dictionary = await _wait({"property": "mood", "value": "idle", "compare": "!="})
	if same.get("met") != false or same.get("value") != "idle":
		_fail("other than idle is not met while it reads idle: %s" % JSON.stringify(same))
	counter.turns_to_busy = 5
	var changed: Dictionary = await _wait(
		{"property": "mood", "value": "idle", "compare": "!=", "timeout_ms": 3000}
	)
	if changed.get("met") != true or changed.get("value") != "busy":
		_fail("other than idle is met once it reads busy: %s" % JSON.stringify(changed))


func _check_what_is_refused() -> void:
	var unknown: Dictionary = await _wait({"property": "day", "value": 1, "compare": "~"})
	if str(unknown.get("message", "")) != 'compare is one of ==, !=, >=, <=, >, <, not "~"':
		_fail("a comparison not offered is refused: %s" % JSON.stringify(unknown))
	var words: Dictionary = await _wait({"property": "mood", "value": "idle", "compare": ">="})
	if not str(words.get("message", "")).begins_with("/root/Clock.mood holds String, which has no order"):
		_fail("a property that is not a number cannot be put in order: %s" % JSON.stringify(words))
	var vague: Dictionary = await _wait({"property": "day", "value": "lots", "compare": ">="})
	if not str(vague.get("message", "")).contains("give a number"):
		_fail("a value that is not a number cannot be a threshold: %s" % JSON.stringify(vague))
	var both: Dictionary = await _wait({"path": "/root", "says": "Go", "compare": ">="})
	if not str(both.get("message", "")).begins_with("A wait takes says or a property, not both"):
		_fail("compare goes with a property, not with says: %s" % JSON.stringify(both))


static func _as_int(value: Variant) -> int:
	return GdhRead.as_int(value, -1) if typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT else -1
