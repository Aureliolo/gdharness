extends SceneTree

## A window whose content scale is not 1 is told a point missed only when it missed.
##
## A point is in window pixels and the viewport's visible rect in canvas units, and the two differ by
## the content scale. Compared as they were, a project drawing 1280x720 in a 2560x1440 window was told
## the points that landed had missed, and nothing about the canvas positions that missed. The headless
## window is 64 pixels square, so both directions are drawn here: a canvas twenty times the window,
## and one half its size. In each, the button's centre in window pixels hovers it and says nothing,
## and its centre in canvas units hovers what is there in window pixels, which the answer has to say
## when that is outside the window.

const Checked = preload("checked.gd")
const GdhInputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const GdhValues = preload("res://addons/gdharness_runtime/runtime_values.gd")

var failures: Array[String] = []
var _begun: bool = false


func _process(_delta: float) -> bool:
	if _begun:
		return false
	_begun = true
	_everything.call_deferred()
	return false


func _everything() -> void:
	var host: Node = Node.new()
	root.add_child(host)
	var input: GdhInputCommands = GdhInputCommands.new(host, GdhValues.new())
	root.content_scale_mode = Window.CONTENT_SCALE_MODE_CANVAS_ITEMS
	root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_EXPAND

	root.content_scale_size = Vector2i(1280, 720)
	await _check_a_button(input, Rect2(400, 640, 160, 80), "a canvas larger than the window")
	root.content_scale_size = Vector2i(32, 32)
	await _check_a_button(input, Rect2(14, 14, 10, 10), "a canvas smaller than the window")

	host.queue_free()
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _check_a_button(input: GdhInputCommands, at: Rect2, scaled: String) -> void:
	var target: Button = Button.new()
	target.position = at.position
	target.size = at.size
	root.add_child(target)
	await process_frame

	var window_centre: Vector2 = (root.get_final_transform() * target.get_global_rect()).get_center()
	var landed: Dictionary = await _moved(input, window_centre)
	if landed.has("outside_viewport"):
		_fail("%s: a point inside the window is not outside it: %s" % [scaled, JSON.stringify(landed)])
	if root.gui_get_hovered_control() != target:
		_fail("%s: and it hovers the button there: %s" % [scaled, root.gui_get_hovered_control()])

	var canvas_centre: Vector2 = target.get_global_rect().get_center()
	var in_window: bool = Rect2(Vector2.ZERO, Vector2(root.size)).has_point(canvas_centre)
	var elsewhere: Dictionary = await _moved(input, canvas_centre)
	var said: String = str(elsewhere.get("outside_viewport", ""))
	var window: String = "%s in window pixels" % Rect2(Vector2.ZERO, Vector2(root.size))
	if in_window and said != "":
		_fail("%s: the canvas position is inside the window: %s" % [scaled, JSON.stringify(elsewhere)])
	if not in_window and not said.contains(window):
		_fail(
			(
				"%s: the canvas position is outside the window, named in its pixels: %s"
				% [scaled, JSON.stringify(elsewhere)]
			)
		)
	if root.gui_get_hovered_control() == target:
		_fail("%s: and the canvas position does not hover the button" % scaled)

	target.queue_free()
	await process_frame


## Moves the pointer to [param at] in window pixels, and answers what the command said once the
## motion has been delivered.
func _moved(input: GdhInputCommands, at: Vector2) -> Dictionary:
	var said: Dictionary = await input.inject_mouse_motion({"x": at.x, "y": at.y})
	await process_frame
	await process_frame
	return said


func _fail(message: String) -> void:
	failures.append(message)
