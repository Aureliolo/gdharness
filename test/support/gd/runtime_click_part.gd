extends SceneTree

## A click on a control only part of which is on screen. A button taller than the list showing it
## has its centre out of sight at every scroll, and was refused as one nothing could click, while
## a player presses the part they see. One placed where no scroll reaches is checked beside it,
## so a click that presses everything fails too.
##
## Everything sits in the 64 by 64 viewport a script run with no window has.

const Checked = preload("checked.gd")
const GdhInputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const GdhValues = preload("res://addons/gdharness_runtime/runtime_values.gd")

var failures: Array[String] = []
var pressed: Dictionary = {}
var input: GdhInputCommands = null
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
	input = GdhInputCommands.new(host, GdhValues.new())

	await _check_a_control_taller_than_its_scroll()
	await _check_a_list_with_nothing_to_scroll()

	host.queue_free()
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _count(named: String) -> void:
	var so_far: int = pressed.get(named, 0)
	pressed[named] = so_far + 1


func _presses(named: String) -> int:
	return pressed.get(named, 0)


func _button(named: String, at: Vector2, parent: Node) -> Button:
	var made: Button = Button.new()
	made.name = named
	made.flat = true
	made.custom_minimum_size = Vector2(10, 10)
	made.position = at
	made.size = Vector2(10, 10)
	parent.add_child(made)
	Checked.done(made.pressed.connect(_count.bind(named)) as Error, "counting presses of %s" % named)
	return made


func _check_a_control_taller_than_its_scroll() -> void:
	var scroll: ScrollContainer = ScrollContainer.new()
	scroll.name = "Tall"
	# Below the viewport's top edge, so a centre scrolled out of the list is still inside the
	# viewport, as it was in the game it was reported from.
	scroll.position = Vector2(0, 20)
	scroll.size = Vector2(30, 20)
	root.add_child(scroll)
	var column: VBoxContainer = VBoxContainer.new()
	column.name = "Column"
	scroll.add_child(column)
	var spacer: Control = Control.new()
	spacer.custom_minimum_size = Vector2(10, 100)
	column.add_child(spacer)
	var tall: Button = _button("Tall", Vector2.ZERO, column)
	tall.custom_minimum_size = Vector2(10, 60)
	await process_frame

	var clicked: Dictionary = await input.click({"path": "/root/Tall/Column/Tall"})
	var shown: Rect2 = scroll.get_global_rect().intersection(tall.get_global_rect())
	var said_at: Dictionary = clicked.get("position", {})
	var x: float = said_at.get("x", -1.0)
	var y: float = said_at.get("y", -1.0)
	if (
		clicked.get("landed") != true
		or _presses("Tall") != 1
		or not shown.has_area()
		or not shown.has_point(Vector2(x, y))
		or (
			clicked.get("pressed_on")
			!= "the middle of the part on screen, since no scroll brings its centre into view"
		)
	):
		_fail(
			(
				"a button taller than its list is pressed where it shows, %s: %s"
				% [shown, JSON.stringify(clicked)]
			)
		)
	scroll.queue_free()
	await process_frame


## Inside a list with nothing to scroll: one button half below the part the list shows, pressed on
## the half inside it, which the list's own cut decides, and one wholly below it, refused.
func _check_a_list_with_nothing_to_scroll() -> void:
	var fixed: ScrollContainer = ScrollContainer.new()
	fixed.name = "Fixed"
	fixed.size = Vector2(30, 20)
	root.add_child(fixed)
	var plain: Control = Control.new()
	plain.name = "Plain"
	plain.custom_minimum_size = Vector2(30, 20)
	fixed.add_child(plain)
	var _under: Button = _button("Under", Vector2(0, 30), plain)
	var half: Button = _button("Half", Vector2(12, 12), plain)
	half.custom_minimum_size = Vector2(10, 20)
	half.size = Vector2(10, 20)
	await process_frame

	var halved: Dictionary = await input.click({"path": "/root/Fixed/Plain/Half"})
	var inside: Rect2 = fixed.get_global_rect().intersection(half.get_global_rect())
	var said_at: Dictionary = halved.get("position", {})
	var x: float = said_at.get("x", -1.0)
	var y: float = said_at.get("y", -1.0)
	if halved.get("landed") != true or _presses("Half") != 1 or not inside.has_point(Vector2(x, y)):
		_fail(
			(
				"a button half inside a list that cannot scroll is pressed on that half, %s: %s"
				% [inside, JSON.stringify(halved)]
			)
		)

	var under: Dictionary = await input.click({"path": "/root/Fixed/Plain/Under"})
	var message: String = str(under.get("message", ""))
	if (
		under.get("type") != "error"
		or not message.contains("outside the part of /root/Fixed that shows it")
		or _presses("Under") != 0
	):
		_fail("a button no scroll brings into view is still refused: %s" % JSON.stringify(under))
	fixed.queue_free()
	await process_frame
