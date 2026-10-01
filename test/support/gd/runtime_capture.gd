extends SceneTree

## The runtime's capture, driven the way the socket drives it. A headless engine has no window
## and draws nothing, which is the same state as a minimised one: the viewport texture holds
## whatever was drawn last, here nothing at all, and a capture of it used to answer with a
## picture. The refusal is the whole check, since no fixture can minimise a window it has not
## got; what it proves is that a frame nobody drew is not handed back as a success.

const CaptureCommands = preload("res://addons/gdharness_runtime/runtime_capture.gd")
const Values = preload("res://addons/gdharness_runtime/runtime_values.gd")
const Checked = preload("checked.gd")

var failures: Array[String] = []
var host: Node = Node.new()


func _init() -> void:
	root.add_child(host)
	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _run() -> void:
	var capture: CaptureCommands = CaptureCommands.new(host, Values.new())

	var output_path: String = OS.get_temp_dir().path_join("gdharness-capture-fixture.png")
	_check_refused(await capture.capture_screenshot({"output_path": output_path}), "screenshot", output_path)
	_check_refused(await capture.capture_viewport({"output_path": output_path}), "viewport", output_path)

	var without_path: Dictionary = await capture.capture_screenshot({})
	if (
		without_path.get("type", "") != "error"
		or not str(without_path.get("message", "")).contains("output_path")
	):
		_fail("a capture with no path should be refused for the path: %s" % JSON.stringify(without_path))

	_check_scaling()
	await _check_what_is_asked(capture, output_path)
	_check_regions()
	_check_cutting()
	_check_where_nodes_are_drawn()

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


## What a capture is scaled to. A width alone was ignored unless a height came with it, so asking for
## a smaller picture sent back the full-size one; one side now keeps the picture's proportions.
func _check_scaling() -> void:
	var drawn: Vector2i = Vector2i(1920, 1080)
	var cases: Array[Array] = [
		[0, 0, Vector2i(1920, 1080)],
		[960, 0, Vector2i(960, 540)],
		[0, 270, Vector2i(480, 270)],
		[100, 100, Vector2i(100, 100)],
		[1, 0, Vector2i(1, 1)],
	]
	for case: Array in cases:
		var width: int = case[0]
		var height: int = case[1]
		var scaled: Vector2i = CaptureCommands.scaled_to(drawn, width, height)
		if scaled != case[2]:
			_fail("width %d and height %d scale 1920x1080 to %s, not %s" % [width, height, case[2], scaled])


## Asking that cannot be answered is refused before a frame is waited for, so here, where nothing is
## drawn, each comes back as its own refusal rather than as the window being minimised.
func _check_what_is_asked(capture: CaptureCommands, output_path: String) -> void:
	var cases: Array[Array] = [
		[{"region": {"x": 0, "y": 0, "width": 4, "height": 4}, "nodePath": "/root"}, "give one of them"],
		[{"zoom": 0}, "from 1 to 16, and 0"],
		[{"zoom": 17}, "from 1 to 16, and 17"],
		[{"zoom": 2, "width": 100}, "give one or the other"],
		[{"region": {"x": 0, "y": 0, "width": 0, "height": 4}}, "with an area"],
		[{"region": "the corner"}, "with an area"],
	]
	for case: Array in cases:
		var asked: Dictionary = case[0]
		var params: Dictionary = asked.duplicate()
		params["output_path"] = output_path
		var answer: Dictionary = await capture.capture_screenshot(params)
		var message: String = str(answer.get("message", ""))
		var why: String = case[1]
		if answer.get("type", "") != "error" or not message.contains(why):
			_fail("%s should be refused for what was asked (%s): %s" % [asked, why, message])

	# A SubViewport's texture is in its own pixels, so window pixels name nothing in it.
	var sub: SubViewport = SubViewport.new()
	sub.name = "Inset"
	host.add_child(sub)
	var into_inset: Dictionary = {
		"output_path": output_path,
		"viewportPath": str(sub.get_path()),
		"region": {"x": 0, "y": 0, "width": 4, "height": 4},
	}
	var inset: Dictionary = await capture.capture_viewport(into_inset)
	if not str(inset.get("message", "")).contains("this viewport's texture is in its own"):
		_fail("a region on a SubViewport should be refused: %s" % JSON.stringify(inset))
	sub.free()


## What a region names, and where that falls in a picture drawn at the window's size or at the
## project's own and stretched.
func _check_regions() -> void:
	var values: Values = Values.new()
	var expected: Rect2 = Rect2(40, 30, 20, 10)
	var spelled: Array = [
		{"x": 40, "y": 30, "width": 20, "height": 10},
		values.serialize(expected),
		values.serialize(Rect2i(40, 30, 20, 10)),
	]
	for given: Variant in spelled:
		var read: Variant = CaptureCommands.region_of(values, given)
		if read != expected:
			_fail("%s should be read as %s, not %s" % [JSON.stringify(given), expected, read])
	if CaptureCommands.region_of(values, {"x": 1, "y": 1, "width": 5, "height": 0}) != null:
		_fail("a region with no area should be read as none")

	var window: Vector2i = Vector2i(200, 100)
	var cases: Array[Array] = [
		[Rect2(40, 30, 20, 10), window, Rect2i(40, 30, 20, 10)],
		# Drawn at half the window's size and stretched to it: half as many of the picture's pixels.
		[Rect2(40, 30, 20, 10), Vector2i(100, 50), Rect2i(20, 15, 10, 5)],
		# An edge inside a pixel keeps that pixel.
		[Rect2(1.5, 1.5, 1, 1), window, Rect2i(1, 1, 2, 2)],
		[Rect2(190, 90, 20, 20), window, Rect2i(190, 90, 10, 10)],
	]
	for case: Array in cases:
		var region: Rect2 = case[0]
		var drawn: Vector2i = case[1]
		var picture: Rect2i = CaptureCommands.in_picture(region, window, drawn)
		if picture != case[2]:
			var said: String = "%s in a window of %s drawn at %s should be %s, not %s"
			_fail(said % [region, window, drawn, case[2], picture])
	if CaptureCommands.in_picture(Rect2(300, 300, 10, 10), window, window).has_area():
		_fail("a region outside the picture should cut to nothing")
	var back: Dictionary = CaptureCommands.in_window_pixels(Rect2i(20, 15, 10, 5), window, Vector2i(100, 50))
	if back != {"x": 40.0, "y": 30.0, "width": 20.0, "height": 10.0}:
		_fail("picture pixels should be named as the window pixels they cover: %s" % back)


## Enlarged by a whole factor with each pixel kept as a square of them: a red pixel beside a blue one
## stays red up to the seam, with no blend of the two.
func _check_cutting() -> void:
	var image: Image = Image.create(3, 1, false, Image.FORMAT_RGB8)
	image.set_pixel(0, 0, Color.WHITE)
	image.set_pixel(1, 0, Color.RED)
	image.set_pixel(2, 0, Color.BLUE)
	var part: Image = CaptureCommands.cut(image, Rect2i(1, 0, 2, 1), 3)
	if part.get_size() != Vector2i(6, 3):
		_fail("two pixels at zoom 3 should be 6x3, not %s" % part.get_size())
		return
	var reds: Array[Color] = [part.get_pixel(0, 0), part.get_pixel(2, 2)]
	var blues: Array[Color] = [part.get_pixel(3, 0), part.get_pixel(5, 2)]
	for red: Color in reds:
		if not red.is_equal_approx(Color.RED):
			_fail("the red pixel should stay red to the seam: %s" % red)
	for blue: Color in blues:
		if not blue.is_equal_approx(Color.BLUE):
			_fail("the blue pixel should stay blue from the seam: %s" % blue)


## Where a node is drawn, as runtime_inspect rect answers it, and a refusal for a node with no extent.
func _check_where_nodes_are_drawn() -> void:
	var panel: Control = Control.new()
	panel.position = Vector2(40, 30)
	panel.size = Vector2(20, 10)
	host.add_child(panel)
	var at: Variant = CaptureCommands.drawn_rect_of(panel)
	if not (at is Rect2 and at == Rect2(40, 30, 20, 10)):
		_fail("a Control is captured over its rectangle: %s" % at)

	var glyph: Sprite2D = Sprite2D.new()
	glyph.texture = ImageTexture.create_from_image(Image.create(8, 4, false, Image.FORMAT_RGB8))
	glyph.position = Vector2(100, 50)
	host.add_child(glyph)
	var drawn: Variant = CaptureCommands.drawn_rect_of(glyph)
	if not (drawn is Rect2 and drawn == Rect2(96, 48, 8, 4)):
		_fail("a Sprite2D is captured over what it draws: %s" % drawn)

	var marker: Node2D = Node2D.new()
	host.add_child(marker)
	var none: Variant = CaptureCommands.drawn_rect_of(marker)
	if not (none is String and str(none).contains("has a position on screen and no extent")):
		_fail("a Node2D with no rectangle should be refused: %s" % none)
	panel.free()
	glyph.free()
	marker.free()


func _check_refused(answer: Dictionary, what: String, output_path: String) -> void:
	if answer.get("type", "") != "error":
		_fail("a %s of a window nothing is drawn to should be refused: %s" % [what, JSON.stringify(answer)])
		return
	var message: String = str(answer.get("message", ""))
	if not message.contains("Nothing is being drawn"):
		_fail("the %s refusal should say nothing is being drawn: %s" % [what, message])
	if FileAccess.file_exists(output_path):
		_fail("a refused %s should write no file, but %s exists" % [what, output_path])
