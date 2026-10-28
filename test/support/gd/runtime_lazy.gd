extends SceneTree
## A runtime nobody has asked anything has compiled none of the modules that answer commands, since
## compiling them all took most of a second of every debug start, in games nobody asks anything. The
## first command loads the module that answers it and leaves the others, and the frame time it
## answers still covers the frames before it. Which scripts were loaded is the resource cache's to
## say.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
## What the runtime compiles as it starts: itself and what it preloads.
const AT_START: PackedStringArray = [
	"runtime_autoload.gd", "error_report.gd", "reading.gd", "runtime_frames.gd",
]
## Frames run before the first request, so the frame time has some to cover.
const FRAMES_BEFORE: int = 5

var node: Runtime
var failures: Array[String] = []


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine; served although it is a script run, so its frames are timed as a game's are.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR",
		OS.get_temp_dir().path_join("gdharness-lazy-%d" % OS.get_process_id())
	)
	ProjectSettings.set_setting(Runtime.SCRIPT_RUNS_SETTING, true)
	node = Runtime.new()
	root.add_child(node)
	Checked.done(
		process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the first frame"
	)


## Every script of the runtime addon the resource cache holds, by file name.
func _loaded() -> PackedStringArray:
	var held: PackedStringArray = []
	for file: String in DirAccess.get_files_at(Runtime.ADDON_DIR):
		if file.ends_with(".gd") and ResourceLoader.has_cached(Runtime.ADDON_DIR + file):
			var _added: bool = held.push_back(file)
	held.sort()
	return held


## The scripts the cache holds that the runtime does not compile as it starts.
func _beyond_the_start() -> PackedStringArray:
	var beyond: PackedStringArray = []
	for file: String in _loaded():
		if not AT_START.has(file):
			var _added: bool = beyond.push_back(file)
	return beyond


func _run() -> void:
	for _frame: int in FRAMES_BEFORE:
		await process_frame
	var started: PackedStringArray = _loaded()
	for file: String in AT_START:
		if not started.has(file):
			failures.append("%s is loaded as the runtime starts: %s" % [file, ", ".join(started)])
	if not _beyond_the_start().is_empty():
		failures.append(
			"nothing beyond the runtime's start is loaded before a command: %s" % ", ".join(started)
		)

	var pong: Dictionary = await node._execute_command("ping", {})
	if pong.get("type") != "pong":
		failures.append("the runtime answers: %s" % JSON.stringify(pong))
	if not _beyond_the_start().is_empty():
		failures.append("a ping loads no module: %s" % ", ".join(_loaded()))

	var metrics: Dictionary = await node._execute_command("get_metrics", {})
	var readings: Dictionary = metrics.get("data", {})
	var timed: int = readings.get("frames_timed", 0)
	if timed < FRAMES_BEFORE - 1:
		failures.append(
			"the first get_metrics covers the frames before it: %s" % JSON.stringify(metrics)
		)
	var after: PackedStringArray = _beyond_the_start()
	if not after.has("runtime_queries.gd") or not after.has("runtime_values.gd"):
		failures.append("get_metrics loads the queries and the values: %s" % ", ".join(after))
	for other: String in ["runtime_input.gd", "runtime_typing.gd", "runtime_waits.gd"]:
		if after.has(other):
			failures.append("get_metrics leaves %s unloaded: %s" % [other, ", ".join(after)])

	# The frame a module compiles in is the runtime's slowness, not the game's: it is left out of
	# the frame time, and the frame after it is timed as usual.
	var timed_before: int = node._frames.usec.size()
	var _refused: Dictionary = await node._execute_command("get_accessibility", {})
	if not _beyond_the_start().has("runtime_accessibility.gd"):
		failures.append("get_accessibility loads its module: %s" % ", ".join(_loaded()))
	await process_frame
	var timed_over: int = node._frames.usec.size()
	await process_frame
	var timed_after: int = node._frames.usec.size()
	if timed_over != timed_before or timed_after != timed_before + 1:
		failures.append(
			(
				"the frame a module compiled in is left out and the next is timed: %d, %d, %d"
				% [timed_before, timed_over, timed_after]
			)
		)

	var known: Dictionary = await node._execute_command("no_such_command", {})
	if not str(known.get("message", "")).contains("wait_until"):
		failures.append(
			(
				"an unknown command lists the modules' commands, loaded or not: %s"
				% JSON.stringify(known)
			)
		)

	node._cleanup()
	# Not checked: the directory is gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({ "ok": true, "frames_timed": timed, "loaded": after }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)
