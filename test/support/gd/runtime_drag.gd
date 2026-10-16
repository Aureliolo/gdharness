extends SceneTree

## A drag in one call, read off a node in the game as a hand's would be: the press first, one
## motion a frame with the button held, and the release last, with the motions' relatives adding up
## to the stroke. The answer's own count says only what was sent, so every check reads the events
## the game was handed. Then a stroke through a point between, and the drags that are refused, each
## beside a drag that is not, so a runtime refusing everything fails.

const InputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const Values = preload("res://addons/gdharness_runtime/runtime_values.gd")
const Checked = preload("checked.gd")


## Every pointer event the game is handed, in order, which is what a game acting on each motion of a
## stroke reads.
class Stroke:
	extends Node

	var seen: Array[String] = []
	var dragged: int = 0
	var last: Vector2 = Vector2.ZERO
	var travelled: Vector2 = Vector2.ZERO

	func _input(event: InputEvent) -> void:
		if event is InputEventMouseButton:
			var button: InputEventMouseButton = event
			seen.append("press" if button.pressed else "release")
		elif event is InputEventMouseMotion:
			var motion: InputEventMouseMotion = event
			seen.append("motion")
			if motion.button_mask & MOUSE_BUTTON_MASK_LEFT:
				dragged += 1
			last = motion.position
			travelled += motion.relative

	func clear() -> void:
		seen.clear()
		dragged = 0
		last = Vector2.ZERO
		travelled = Vector2.ZERO


var failures: Array[String] = []


func _init() -> void:
	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _fail(message: String) -> void:
	failures.append(message)


func _run() -> void:
	var host: Node = Node.new()
	root.add_child(host)
	var stroke: Stroke = Stroke.new()
	root.add_child(stroke)
	await process_frame
	var input: InputCommands = InputCommands.new(host, Values.new())

	await _check_a_straight_stroke(input, stroke)
	await _check_a_stroke_through_a_point(input, stroke)
	await _check_what_is_refused(input, stroke)

	host.queue_free()
	stroke.queue_free()
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _check_a_straight_stroke(input: InputCommands, stroke: Stroke) -> void:
	var answer: Dictionary = await input.inject_mouse_drag(
		{"x": 100, "y": 100, "toX": 300, "toY": 100, "frames": 20}
	)
	await process_frame
	var motions: int = stroke.seen.count("motion")
	if answer.get("motions", 0) != 20 or motions != 20 or stroke.dragged != 20:
		_fail(
			(
				"a drag over 20 frames is 20 motions with the button held: %s, %s"
				% [JSON.stringify(answer), stroke.seen]
			)
		)
	if stroke.seen.front() != "press" or stroke.seen.back() != "release":
		_fail("a drag presses first and releases last: %s" % [stroke.seen])
	if stroke.last != Vector2(300, 100) or not stroke.travelled.is_equal_approx(Vector2(200, 0)):
		_fail("a drag ends where it was sent, having moved that far: %s %s" % [stroke.last, stroke.travelled])


func _check_a_stroke_through_a_point(input: InputCommands, stroke: Stroke) -> void:
	stroke.clear()
	var answer: Dictionary = await input.inject_mouse_drag(
		{"x": 0, "y": 0, "via": [[10, 0]], "toX": 10, "toY": 10, "frames": 4}
	)
	await process_frame
	if stroke.last != Vector2(10, 10) or not stroke.travelled.is_equal_approx(Vector2(10, 10)):
		_fail("a stroke through a point ends at its end: %s %s" % [stroke.last, stroke.travelled])
	if answer.get("relative_total", []) != [10.0, 10.0]:
		_fail("the answer adds up the relatives it sent: %s" % JSON.stringify(answer))
	# Fractions, where working the end out along the stroke lands a rounding short of it.
	stroke.clear()
	var _fine: Dictionary = await input.inject_mouse_drag(
		{"x": 0.1, "y": 0.7, "via": [[0.2, 0.3]], "toX": 0.3, "toY": 0.9, "frames": 3}
	)
	await process_frame
	if stroke.last != Vector2(0.3, 0.9):
		_fail("a stroke ends exactly where it was sent: %s" % stroke.last)


func _check_what_is_refused(input: InputCommands, stroke: Stroke) -> void:
	var refusals: Array[Dictionary] = [
		{"x": 0, "y": 0, "toX": 10, "frames": 4},
		{"x": 0, "y": 0, "toX": 10, "toY": 10, "frames": 0},
		{"x": 0, "y": 0, "toX": 10, "toY": 10, "frames": 4, "button": "wheel_up"},
		{"x": 0, "y": 0, "toX": 10, "toY": 10, "frames": 4, "via": [[1]]},
	]
	for refused: Dictionary in refusals:
		stroke.clear()
		var said: Dictionary = await input.inject_mouse_drag(refused)
		await process_frame
		if said.get("type", "") != "error":
			_fail("a drag of %s should be refused: %s" % [JSON.stringify(refused), JSON.stringify(said)])
		if not stroke.seen.is_empty():
			_fail("a refused drag sends nothing: %s %s" % [JSON.stringify(refused), stroke.seen])
	stroke.clear()
	var right: Dictionary = await input.inject_mouse_drag(
		{"x": 0, "y": 0, "toX": 10, "toY": 10, "frames": 2, "button": "right"}
	)
	if right.get("type", "") != "input_injected" or right.get("button", 0) != MOUSE_BUTTON_RIGHT:
		_fail("a right drag is not refused: %s" % JSON.stringify(right))
