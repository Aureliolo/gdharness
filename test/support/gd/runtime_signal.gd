extends SceneTree

## The wait for a signal: one that fires, one that does not, one a node lacks, and one carrying
## more arguments than any engine signal. It needs the main loop running, so the checks start on
## the first frame rather than in _init.

const Checked = preload("checked.gd")
const Read = preload("res://addons/gdharness_runtime/reading.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

var failures: Array[String] = []
var node: Runtime


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR", OS.get_temp_dir().path_join("gdharness-signal-%d" % OS.get_process_id())
	)
	node = Runtime.new()
	root.add_child(node)

	var panel: Panel = Panel.new()
	panel.name = "Panel"
	root.add_child(panel)
	var button: Button = Button.new()
	button.name = "Go"
	button.toggle_mode = true
	panel.add_child(button)

	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _fail(message: String) -> void:
	failures.append(message)


func _run() -> void:
	await _check_signal()

	node._cleanup()
	# Not checked: the directory is gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _check_signal() -> void:
	var timer: Timer = Timer.new()
	timer.name = "Fuse"
	timer.one_shot = true
	timer.wait_time = 0.05
	root.add_child(timer)
	timer.start()
	var fired: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Fuse", "signal": "timeout"}
	)
	if fired.get("fired") != true:
		_fail("a signal that fires should be reported as fired: %s" % str(fired))

	var expired: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Fuse", "signal": "timeout", "timeout_ms": 60}
	)
	if expired.get("fired") != false or Read.as_int(expired.get("elapsed_ms", 0)) < 60:
		_fail(
			"a signal that never fires should be reported as not fired after the timeout: %s" % str(expired)
		)
	if not timer.timeout.get_connections().is_empty():
		_fail("the catcher should be disconnected once the wait gives up")

	var with_args: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Panel/Go", "signal": "toggled", "timeout_ms": 500}
	)
	if with_args.get("fired") != false:
		_fail("toggled should not fire on its own: %s" % str(with_args))

	var unknown: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Fuse", "signal": "nonesuch"}
	)
	if unknown.get("type") != "error":
		_fail("a signal the node does not have is refused: %s" % str(unknown))

	# A game's own signal can carry more than any engine one. The handler took five, a sixth was
	# never delivered, and the wait ran out saying the signal had not fired.
	timer.add_user_signal(
		"settled", [{"name": "a"}, {"name": "b"}, {"name": "c"}, {"name": "d"}, {"name": "e"}, {"name": "f"}]
	)
	var emit_late: Callable = func() -> void:
		await process_frame
		Checked.done(timer.emit_signal("settled", 1, 2, 3, 4, 5, 6) as Error, "emitting settled")
	emit_late.call()
	var six: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Fuse", "signal": "settled", "timeout_ms": 2000}
	)
	if six.get("fired") != true or str(six.get("args")) != str([1, 2, 3, 4, 5, 6]):
		_fail("a signal with six arguments is caught with all six: %s" % str(six))
	if fired.get("args") != []:
		_fail("a signal with none is caught with none: %s" % str(fired))
	timer.free()
