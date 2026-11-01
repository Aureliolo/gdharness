extends SceneTree
## A game that quits while a loading thread is compiling a module leaves nothing behind. A threaded
## request nobody takes keeps its load token, which the engine reports at exit as a leaked instance,
## and a game's suite reads that line as its own leak. The leg fails a fixture on that line.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

var node: Runtime


func _init() -> void:
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR",
		OS.get_temp_dir().path_join("gdharness-lazy-quit-%d" % OS.get_process_id())
	)
	ProjectSettings.set_setting(Runtime.SCRIPT_RUNS_SETTING, true)
	node = Runtime.new()
	root.add_child(node)
	Checked.done(
		process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the first frame"
	)


func _run() -> void:
	var until: int = Time.get_ticks_msec() + 10000
	while node._in_flight.is_empty() and Time.get_ticks_msec() < until:
		await process_frame
	var compiling: String = node._in_flight
	node.queue_free()
	await process_frame
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if compiling.is_empty():
		printerr("a served game compiles its modules on a loading thread")
		quit(1)
		return
	print(JSON.stringify({ "ok": true, "quit_while_compiling": compiling }))
	quit(0)
