extends SceneTree
## A controller button and a stick moved through the runtime, as the events a pad sends: a node
## reading the pad in _unhandled_input sees an InputEventJoypadButton pressed and released and an
## InputEventJoypadMotion, where an action sent instead reached it as an event it never reads. Each
## refusal is checked beside the event that is sent, so a runtime refusing everything fails.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

var failures: Array[String] = []
var node: Runtime
var recorder: Recorder


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR",
		OS.get_temp_dir().path_join("gdharness-pad-%d" % OS.get_process_id())
	)
	node = Runtime.new()
	root.add_child(node)
	recorder = Recorder.new()
	recorder.name = "Recorder"
	root.add_child(recorder)
	Checked.done(
		process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame"
	)


func _fail(message: String) -> void:
	failures.append(message)


func _run() -> void:
	await _check_the_events_sent()
	await _check_what_is_refused()

	node._cleanup()
	# Not checked: the directory is gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


## The issue's own check: dpad_down pressed and let go, then the right stick pushed all the way up,
## and a held button on a second controller named by its number.
func _check_the_events_sent() -> void:
	recorder.seen.clear()
	var pressed: Dictionary = await node._execute_command(
		"inject_joypad_button", { "button": "dpad_down" }
	)
	if pressed.get("button") != JOY_BUTTON_DPAD_DOWN or pressed.get("whole") != true:
		_fail("a named button is pressed and released: %s" % JSON.stringify(pressed))
	var moved: Dictionary = await node._execute_command(
		"inject_joypad_motion", { "axis": "right_y", "value": -1 }
	)
	if moved.get("axis") != JOY_AXIS_RIGHT_Y or moved.get("axis_name") != "right_y":
		_fail("a named axis is moved: %s" % JSON.stringify(moved))
	var held: Dictionary = await node._execute_command(
		"inject_joypad_button", { "button": 0, "pressed": true, "device": 1 }
	)
	if held.get("button_name") != "a" or held.get("pressed") != true or held.get("whole") != false:
		_fail("a numbered button is held: %s" % JSON.stringify(held))
	await process_frame
	var wanted: Array = [
		["button", JOY_BUTTON_DPAD_DOWN, true, 0],
		["button", JOY_BUTTON_DPAD_DOWN, false, 0],
		["motion", JOY_AXIS_RIGHT_Y, -1.0, 0],
		["button", JOY_BUTTON_A, true, 1],
	]
	if recorder.seen != wanted:
		_fail("the game reads the pad's own events: %s" % JSON.stringify(recorder.seen))
	var _let_go: Dictionary = await node._execute_command(
		"inject_joypad_button", { "button": 0, "pressed": false, "device": 1 }
	)


func _check_what_is_refused() -> void:
	var unnamed: Dictionary = await node._execute_command(
		"inject_joypad_button", { "button": "trigger" }
	)
	if unnamed.get("type") != "error" or not str(unnamed.get("message", "")).contains("dpad_down"):
		_fail(
			"a button by no name it has is refused naming the names: %s" % JSON.stringify(unnamed)
		)
	var beyond: Dictionary = await node._execute_command(
		"inject_joypad_motion", { "axis": "left_x", "value": 2 }
	)
	if beyond.get("type") != "error" or not str(beyond.get("message", "")).contains("-1 to 1"):
		_fail("a value past the axis's travel is refused: %s" % JSON.stringify(beyond))
	var unplaced: Dictionary = await node._execute_command(
		"inject_joypad_motion", { "axis": "left_x" }
	)
	if unplaced.get("type") != "error":
		_fail("a motion with no value is refused: %s" % JSON.stringify(unplaced))


## Records the controller events it is handed, as a game's pad layout reads them.
class Recorder:
	extends Node

	var seen: Array = []

	func _unhandled_input(event: InputEvent) -> void:
		var button: InputEventJoypadButton = event as InputEventJoypadButton
		if button != null:
			seen.append(["button", button.button_index, button.pressed, button.device])
			return
		var motion: InputEventJoypadMotion = event as InputEventJoypadMotion
		if motion != null:
			seen.append(["motion", motion.axis, motion.axis_value, motion.device])
