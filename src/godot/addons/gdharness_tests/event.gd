class_name GdhEvent
extends RefCounted
## Input events built in one line, for a case that hands them to a control or to the engine.
##
## A position is the point in the window, which is where `Input.parse_input_event` delivers the
## event and what a control's own `_gui_input` reads when it is handed the event directly. The
## global position is set to the same point, as the window's own events carry it, for code that
## reads that field instead.


## [param button] pressed at [param at], or released when [param pressed] is false.
static func click(
	at: Vector2, button: MouseButton = MOUSE_BUTTON_LEFT, pressed: bool = true
) -> InputEventMouseButton:
	var made: InputEventMouseButton = InputEventMouseButton.new()
	made.button_index = button
	made.pressed = pressed
	made.position = at
	made.global_position = at
	if pressed:
		made.button_mask = _mask_of(button)
	return made


## The release of [param button] at [param at], which ends the press [method click] began.
static func release(at: Vector2, button: MouseButton = MOUSE_BUTTON_LEFT) -> InputEventMouseButton:
	return click(at, button, false)


## One turn of the wheel at [param at], up or down. The engine sends a wheel turn as a press.
static func wheel(at: Vector2, up: bool = true) -> InputEventMouseButton:
	return click(at, MOUSE_BUTTON_WHEEL_UP if up else MOUSE_BUTTON_WHEEL_DOWN)


## The mouse moved to [param at] by [param moved], holding [param held], a mask of buttons such
## as MOUSE_BUTTON_MASK_LEFT for a drag.
static func motion(at: Vector2, moved: Vector2 = Vector2.ZERO, held: int = 0) -> InputEventMouseMotion:
	var made: InputEventMouseMotion = InputEventMouseMotion.new()
	made.position = at
	made.global_position = at
	made.relative = moved
	made.button_mask = held
	return made


## [param key_pressed] pressed, or released when [param pressed] is false. The key is set as both the
## keycode and the physical keycode, so a binding to either matches it.
static func key(key_pressed: Key, pressed: bool = true) -> InputEventKey:
	var made: InputEventKey = InputEventKey.new()
	made.keycode = key_pressed
	made.physical_keycode = key_pressed
	made.pressed = pressed
	return made


## [param button] of the pad [param device] pressed, or released when [param pressed] is false.
static func pad(button: JoyButton, pressed: bool = true, device: int = 0) -> InputEventJoypadButton:
	var made: InputEventJoypadButton = InputEventJoypadButton.new()
	made.button_index = button
	made.pressed = pressed
	made.pressure = 1.0 if pressed else 0.0
	made.device = device
	return made


## [param axis_moved] of the pad [param device] at [param value], from -1 to 1.
static func axis(axis_moved: JoyAxis, value: float, device: int = 0) -> InputEventJoypadMotion:
	var made: InputEventJoypadMotion = InputEventJoypadMotion.new()
	made.axis = axis_moved
	made.axis_value = value
	made.device = device
	return made


## The action [param action_named] pressed at [param strength], or released when [param pressed] is false.
static func action(action_named: StringName, pressed: bool = true, strength: float = 1.0) -> InputEventAction:
	var made: InputEventAction = InputEventAction.new()
	made.action = action_named
	made.pressed = pressed
	made.strength = strength if pressed else 0.0
	return made


static func _mask_of(button: MouseButton) -> int:
	match button:
		MOUSE_BUTTON_LEFT:
			return MOUSE_BUTTON_MASK_LEFT
		MOUSE_BUTTON_RIGHT:
			return MOUSE_BUTTON_MASK_RIGHT
		MOUSE_BUTTON_MIDDLE:
			return MOUSE_BUTTON_MASK_MIDDLE
	return 0
