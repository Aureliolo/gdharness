extends SceneTree
## What a game tells a screen reader, asked of a headless run: there is no window, so the answer
## says to start the run with one rather than walking nothing. The ping beside it shows the runtime
## was answering, so a runtime refusing everything fails.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
const Accessibility = preload("res://addons/gdharness_runtime/runtime_accessibility.gd")

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
	Checked.done(
		process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame"
	)


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
		failures.append(
			"a headless run is told it has no window to read: %s" % JSON.stringify(asked)
		)

	# A client stopped at the deadline says how far its marks got, started at 1000 ms.
	var reached: Dictionary = {
		"": "PowerShell had not begun the client",
		"began 1100\n":
		"PowerShell began the client after 100 ms and was still loading UI Automation",
		"began 1100\nloaded 1600\n":
		(
			"PowerShell began the client after 100 ms and loaded UI Automation in 500 ms, and the "
			+ "first walk of the windows had not ended"
		),
		"began 1100\nloaded 1600\nwalked 1 1700\n":
		(
			"PowerShell began the client after 100 ms and loaded UI Automation in 500 ms, and the"
			+ " windows were walked 1 time, the last finding 1 element and ending 300 ms before the"
			+ " client was stopped"
		),
		"began 1100\nloaded 1600\nwalked 1 1700\nwalked 12 1900\n":
		(
			"PowerShell began the client after 100 ms and loaded UI Automation in 500 ms, and the"
			+ " windows were walked 2 times, the last finding 12 elements and ending 100 ms before"
			+ " the client was stopped"
		),
	}
	for progress: String in reached:
		var said: String = Accessibility._reached(progress, 1000, 2000)
		if said != reached[progress]:
			failures.append("marks %s are said as: %s" % [JSON.stringify(progress), said])
	var took: Dictionary = Accessibility._took(
		"began 1100\nloaded 1600\nwalked 3 1700\n", 1000, 2000
	)
	if took != { "start": 100, "load": 500, "walk": 400 }:
		failures.append("a read's time is split as: %s" % JSON.stringify(took))
	if not Accessibility._took("began 1100\n", 1000, 2000).is_empty():
		failures.append("a client that never loaded UI Automation splits nothing")
	# A cold start has its own budget, and the walks theirs from when UI Automation was seen loaded,
	# so a start taking most of a minute still leaves the walks all of theirs.
	var deadlines: Array[int] = [
		Accessibility._deadline(1000, -1, 1),
		Accessibility._deadline(1000, 40000, 1),
		Accessibility._deadline(1000, 40000, 2),
	]
	if deadlines != [46000, 55000, 63000]:
		failures.append("a client is stopped at %s" % JSON.stringify(deadlines))

	node._cleanup()
	# Not checked: the directory is gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)
