extends SceneTree

## The runtime's capture, driven the way the socket drives it. A headless engine has no window
## and draws nothing, which is the same state as a minimised one: the viewport texture holds
## whatever was drawn last, here nothing at all, and a capture of it used to answer with a
## picture. The refusal is the whole check, since no fixture can minimise a window it has not
## got; what it proves is that a frame nobody drew is not handed back as a success.

const CaptureCommands = preload("res://addons/gdharness_runtime/runtime_capture.gd")
const Checked = preload("checked.gd")

var failures: Array[String] = []
var host: Node = Node.new()


func _init() -> void:
	root.add_child(host)
	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _run() -> void:
	var capture: CaptureCommands = CaptureCommands.new(host)

	var output_path: String = OS.get_temp_dir().path_join("gdharness-capture-fixture.png")
	_check_refused(capture.capture_screenshot({"output_path": output_path}), "screenshot", output_path)
	_check_refused(capture.capture_viewport({"output_path": output_path}), "viewport", output_path)

	var without_path: Dictionary = capture.capture_screenshot({})
	if (
		without_path.get("type", "") != "error"
		or not str(without_path.get("message", "")).contains("output_path")
	):
		_fail("a capture with no path should be refused for the path: %s" % JSON.stringify(without_path))

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _check_refused(answer: Dictionary, what: String, output_path: String) -> void:
	if answer.get("type", "") != "error":
		_fail("a %s of a window nothing is drawn to should be refused: %s" % [what, JSON.stringify(answer)])
		return
	var message: String = str(answer.get("message", ""))
	if not message.contains("Nothing is being drawn"):
		_fail("the %s refusal should say nothing is being drawn: %s" % [what, message])
	if FileAccess.file_exists(output_path):
		_fail("a refused %s should write no file, but %s exists" % [what, output_path])
