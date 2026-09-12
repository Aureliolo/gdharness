extends SceneTree

## project.godot stores an input action as an engine expression, not as JSON, and what goes in
## has to be a Dictionary of real InputEvent objects: ConfigFile writes a String quoted and
## escaped, which loads back as a String and leaves InputMap with no action while the tool still
## reports the events it was handed. So every action is written through the real code, saved,
## loaded back the way the engine loads it, and asserted on the events that came out.

const InputActions = preload("res://operations/input_actions.gd")
const Log = preload("res://operations/logger.gd")

var failures: Array[String] = []
var actions := InputActions.new(Log.new())


func _init() -> void:
	_check_key()
	_check_mouse_button()
	_check_joypad()
	_check_written_form()

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


## Saves one action and reads it back through ConfigFile, which is how Godot itself loads
## project.godot, and hands back whatever the engine made of the stored value.
func _round_trip(action: Dictionary) -> Variant:
	var path := "user://input_action_fixture.cfg"
	var config := ConfigFile.new()
	config.set_value("input", "fixture", action)
	if config.save(path) != OK:
		_fail("could not save the fixture config")
		return null

	var reread := ConfigFile.new()
	if reread.load(path) != OK:
		_fail("could not load the fixture config back")
		return null
	return reread.get_value("input", "fixture", null)


func _events_of(label: String, action: Dictionary, expected_count: int) -> Array:
	var stored = _round_trip(action)
	if not stored is Dictionary:
		_fail(
			"%s did not survive project.godot as a dictionary, got %s" % [label, type_string(typeof(stored))]
		)
		return []

	var events: Array = stored.get("events", [])
	if events.size() != expected_count:
		_fail("%s event count: expected %d, got %d" % [label, expected_count, events.size()])
		return []
	return events


func _check_key() -> void:
	var action := actions.build_input_action(
		0.5,
		[
			{
				"class_name": "InputEventKey",
				"keycode": KEY_SPACE,
				"ctrl_pressed": true,
				"alt_pressed": false,
				"shift_pressed": true,
			}
		]
	)

	if not is_equal_approx(action.get("deadzone", -1.0), 0.5):
		_fail("key action deadzone: %s" % str(action.get("deadzone")))

	var events := _events_of("key action", action, 1)
	if events.is_empty():
		return

	var event := events[0] as InputEventKey
	if event == null:
		_fail("key action event is not an InputEventKey: %s" % str(events[0]))
		return
	if event.keycode != KEY_SPACE:
		_fail("key action keycode: %d" % event.keycode)
	if not event.ctrl_pressed:
		_fail("key action lost ctrl_pressed")
	if not event.shift_pressed:
		_fail("key action lost shift_pressed")
	if event.alt_pressed:
		_fail("key action gained alt_pressed")


func _check_mouse_button() -> void:
	var action := actions.build_input_action(
		0.2, [{"class_name": "InputEventMouseButton", "button_index": MOUSE_BUTTON_RIGHT}]
	)

	var events := _events_of("mouse action", action, 1)
	if events.is_empty():
		return

	var event := events[0] as InputEventMouseButton
	if event == null:
		_fail("mouse action event is not an InputEventMouseButton: %s" % str(events[0]))
		return
	if event.button_index != MOUSE_BUTTON_RIGHT:
		_fail("mouse action button index: %d" % event.button_index)


func _check_joypad() -> void:
	var action := actions.build_input_action(
		0.3,
		[
			{"class_name": "InputEventJoypadButton", "button_index": JOY_BUTTON_A},
			{"class_name": "InputEventJoypadMotion", "axis": JOY_AXIS_LEFT_X, "axis_value": -1.0},
		]
	)

	var events := _events_of("joypad action", action, 2)
	if events.is_empty():
		return

	var button := events[0] as InputEventJoypadButton
	if button == null:
		_fail("joypad button event is not an InputEventJoypadButton: %s" % str(events[0]))
	elif button.button_index != JOY_BUTTON_A:
		_fail("joypad button index: %d" % button.button_index)

	var motion := events[1] as InputEventJoypadMotion
	if motion == null:
		_fail("joypad motion event is not an InputEventJoypadMotion: %s" % str(events[1]))
		return
	if motion.axis != JOY_AXIS_LEFT_X:
		_fail("joypad motion axis: %d" % motion.axis)
	if not is_equal_approx(motion.axis_value, -1.0):
		_fail("joypad motion axis value: %f" % motion.axis_value)


## The bug this replaced wrote a quoted, escaped string into [input]. It read back as a String
## and every assertion above would have caught that, but the file itself is what a human opens,
## so the shape on disk is pinned too.
func _check_written_form() -> void:
	var path := "user://input_action_written.cfg"
	var config := ConfigFile.new()
	config.set_value("input", "fixture", actions.build_input_action(0.5, [{"class_name": "InputEventKey"}]))
	if config.save(path) != OK:
		_fail("could not save the written-form config")
		return

	var text := FileAccess.get_file_as_string(path)
	if text.contains('fixture="'):
		_fail("the action was written as a quoted string:\n%s" % text)
	if not text.contains("Object(InputEventKey"):
		_fail("the action does not carry an InputEventKey:\n%s" % text)
