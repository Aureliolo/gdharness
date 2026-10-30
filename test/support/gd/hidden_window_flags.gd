extends SceneTree
## The editor addon's run arguments for a game a hidden editor plays: the flags go in front of what
## the project gives, where a `--` cannot make them the game's own, and after a `%command%`, where
## what comes before is the command that runs the engine.

const GdhPlayTools = preload("res://addons/gdharness_editor/tools/play_tools.gd")

var failures: Array[String] = []


func _initialize() -> void:
	var flags: String = "--disable-vsync --max-fps %d" % GdhPlayTools.HIDDEN_WINDOW_FPS
	var cases: Array = [
		["", true, false, flags],
		["-- level=3", true, false, flags + " -- level=3"],
		["--max-fps 30 -- level=3", true, false, "--disable-vsync --max-fps 30 -- level=3"],
		["", true, true, "--disable-vsync"],
		[
			"prime-run %command% --verbose",
			true,
			false,
			"prime-run %command% " + flags + " --verbose",
		],
		["--headless", true, false, "--headless"],
		["-- level=3", false, false, "-- level=3"],
	]
	for case: Array in cases:
		var held: String = case[0]
		var hidden: bool = case[1]
		var capped: bool = case[2]
		var given: String = GdhPlayTools.with_hidden_window_flags(held, hidden, capped)
		if given != case[3]:
			_fail("%s gives %s, not %s" % [JSON.stringify(case.slice(0, 3)), given, case[3]])
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)
