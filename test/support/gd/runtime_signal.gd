extends SceneTree
## The wait for a signal: one that fires, one that does not, one a node lacks, and one carrying
## more arguments than any engine signal. It needs the main loop running, so the checks start on
## the first frame rather than in _init.

const Checked = preload("checked.gd")
const GdhRead = preload("res://addons/gdharness_runtime/reading.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

var failures: Array[String] = []
var node: Runtime


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR",
		OS.get_temp_dir().path_join("gdharness-signal-%d" % OS.get_process_id())
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

	Checked.done(
		process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame"
	)


func _fail(message: String) -> void:
	failures.append(message)


func _run() -> void:
	await _check_signal()

	node._cleanup()
	# Not checked: the directory is gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
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
		"wait_signal", { "path": "/root/Fuse", "signal": "timeout" }
	)
	if fired.get("fired") != true:
		_fail("a signal that fires should be reported as fired: %s" % str(fired))

	var expired: Dictionary = await node._execute_command(
		"wait_signal", { "path": "/root/Fuse", "signal": "timeout", "timeout_ms": 60 }
	)
	if expired.get("fired") != false or GdhRead.as_int(expired.get("elapsed_ms", 0)) < 60:
		_fail(
			(
				"a signal that never fires should be reported as not fired after the timeout: %s"
				% str(expired)
			)
		)
	if not timer.timeout.get_connections().is_empty():
		_fail("the catcher should be disconnected once the wait gives up")

	var with_args: Dictionary = await node._execute_command(
		"wait_signal", { "path": "/root/Panel/Go", "signal": "toggled", "timeout_ms": 500 }
	)
	if with_args.get("fired") != false:
		_fail("toggled should not fire on its own: %s" % str(with_args))

	var unknown: Dictionary = await node._execute_command(
		"wait_signal", { "path": "/root/Fuse", "signal": "nonesuch" }
	)
	if unknown.get("type") != "error":
		_fail("a signal the node does not have is refused: %s" % str(unknown))

	# A game's own signal can carry more than any engine one. The handler took five, a sixth was
	# never delivered, and the wait ran out saying the signal had not fired.
	timer.add_user_signal(
		"settled",
		[
			{ "name": "a" },
			{ "name": "b" },
			{ "name": "c" },
			{ "name": "d" },
			{ "name": "e" },
			{ "name": "f" },
		]
	)
	var emit_late: Callable = func() -> void:
		await process_frame
		Checked.done(timer.emit_signal("settled", 1, 2, 3, 4, 5, 6) as Error, "emitting settled")
	emit_late.call()
	var six: Dictionary = await node._execute_command(
		"wait_signal", { "path": "/root/Fuse", "signal": "settled", "timeout_ms": 2000 }
	)
	if six.get("fired") != true or str(six.get("args")) != str([1, 2, 3, 4, 5, 6]):
		_fail("a signal with six arguments is caught with all six: %s" % str(six))
	if fired.get("args") != []:
		_fail("a signal with none is caught with none: %s" % str(fired))
	if not str(expired.get("note", "")).contains(
		"If a call meant to set the signal off was sent beside this wait"
	):
		_fail("a wait that ran out says how to catch a signal a call sets off: %s" % str(expired))
	if not str(expired.get("note", "")).begins_with(
		"A wait hears the signal only from when it begins"
	):
		_fail("and that one fired before it began is not counted: %s" % str(expired))
	if fired.has("note"):
		_fail("and one that fired says nothing of it: %s" % str(fired))
	await _check_watch(timer)
	timer.free()


## A watch armed before the signal fires catches it, though the wait collecting it starts after:
## a client running the call that sets it off before the wait is what a plain wait misses.
func _check_watch(timer: Timer) -> void:
	var armed: Dictionary = await node._execute_command(
		"watch_signal", { "path": "/root/Fuse", "signal": "settled" }
	)
	if armed.get("type") != "watching" or typeof(armed.get("watch")) != TYPE_INT:
		_fail("a watch is armed and named: %s" % str(armed))
		return
	# Time between the arming and the first emission, as a call made between them takes, which the
	# wait collecting it does not see.
	await create_timer(0.15).timeout
	Checked.done(timer.emit_signal("settled", 1, 2, 3, 4, 5, 6) as Error, "emitting settled")
	Checked.done(
		timer.emit_signal("settled", 7, 8, 9, 10, 11, 12) as Error, "emitting settled again"
	)
	await process_frame
	var caught: Dictionary = await node._execute_command(
		"wait_signal", { "watch": armed["watch"], "timeout_ms": 2000 }
	)
	if (
		caught.get("fired") != true
		or caught.get("fired_before_wait") != true
		or caught.get("times") != 2
		or str(caught.get("args")) != str([1, 2, 3, 4, 5, 6])
		or GdhRead.as_int(caught.get("elapsed_ms", 9999)) > 100
	):
		_fail(
			(
				"a signal fired before the wait is collected at once, with the first's args: %s"
				% str(caught)
			)
		)
	var after: int = GdhRead.as_int(caught.get("fired_after_ms", -1), -1)
	# A timer of 0.15 s came due 145 ms after it was made: it counts frame deltas, not the clock.
	if after < 100 or after > 1000:
		_fail("and says how long after the arming the first came: %s" % str(caught))
	var again: Dictionary = await node._execute_command("wait_signal", { "watch": armed["watch"] })
	if (
		again.get("type") != "error"
		or not str(again.get("message", "")).contains("collected already")
	):
		_fail("a watch is collected once: %s" % str(again))

	var quiet: Dictionary = await node._execute_command(
		"watch_signal", { "path": "/root/Fuse", "signal": "timeout" }
	)
	var nothing: Dictionary = await node._execute_command(
		"wait_signal", { "watch": quiet.get("watch"), "timeout_ms": 60 }
	)
	if (
		nothing.get("fired") != false
		or nothing.get("times") != 0
		or nothing.has("fired_before_wait")
		or nothing.has("fired_after_ms")
	):
		_fail("a watch nothing fired on runs out: %s" % str(nothing))
	if (
		not timer.timeout.get_connections().is_empty()
		or not timer.get_signal_connection_list("settled").is_empty()
	):
		_fail("and a collected watch listens no more")

	var first: Dictionary = await node._execute_command(
		"watch_signal", { "path": "/root/Fuse", "signal": "timeout" }
	)
	for _more: int in 16:
		var _armed: Dictionary = await node._execute_command(
			"watch_signal", { "path": "/root/Fuse", "signal": "timeout" }
		)
	if timer.timeout.get_connections().size() != 16:
		_fail("sixteen watches are kept: %d" % timer.timeout.get_connections().size())
	var dropped: Dictionary = await node._execute_command(
		"wait_signal", { "watch": first.get("watch") }
	)
	if (
		dropped.get("type") != "error"
		or not str(dropped.get("message", "")).contains("16 armed after it")
	):
		_fail("the oldest goes when a seventeenth is armed: %s" % str(dropped))
