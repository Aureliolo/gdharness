extends SceneTree

## What a game tells a screen reader, asked of a headless run: there is no window, so the answer says
## to start the run with one rather than walking nothing. The ping beside it shows the runtime was
## answering, so a runtime refusing everything fails.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

var node: Runtime


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR",
		OS.get_temp_dir().path_join("gdharness-accessibility-%d" % OS.get_process_id())
	)
	node = Runtime.new()
	root.add_child(node)
	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _run() -> void:
	var failures: Array[String] = []
	var pong: Dictionary = await node._execute_command("ping", {})
	if pong.get("type") != "pong":
		failures.append("the runtime answers: %s" % JSON.stringify(pong))
	var asked: Dictionary = await node._execute_command("get_accessibility", {})
	if (
		asked.get("type") != "error"
		or not str(asked.get("message", "")).contains("start the run with headless: false")
	):
		failures.append("a headless run is told it has no window to read: %s" % JSON.stringify(asked))

	node._cleanup()
	# Not checked: the directory is gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)
