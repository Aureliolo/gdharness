extends SceneTree
## The modules that answer commands are compiled on a loading thread from a served game's first
## frame, one at a time, never as the runtime starts: compiling them all took most of a second of
## every debug start. A command whose module is not ready yet finishes it in its own frame, which is
## left out of the frame time. Once they are ready, a module's first command holds no frame for it:
## a game's frame bench read a 590 ms frame spent compiling as its own stall. Which scripts were
## loaded is the resource cache's to say.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
const Frames = preload("res://addons/gdharness_runtime/runtime_frames.gd")
## What the runtime compiles as it starts: itself and what it preloads.
const AT_START: PackedStringArray = [
	"runtime_autoload.gd", "error_report.gd", "reading.gd", "runtime_frames.gd",
]

var node: Runtime
var failures: Array[String] = []


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine. Served although it is a script run, so its frames are timed as a game's are.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR",
		OS.get_temp_dir().path_join("gdharness-lazy-%d" % OS.get_process_id())
	)
	ProjectSettings.set_setting(Runtime.SCRIPT_RUNS_SETTING, true)
	node = Runtime.new()
	root.add_child(node)
	var started: PackedStringArray = _loaded()
	for file: String in AT_START:
		if not started.has(file):
			failures.append("%s is loaded as the runtime starts: %s" % [file, ", ".join(started)])
	for file: String in Runtime.MODULES:
		if started.has(file):
			failures.append("%s is not compiled as the runtime starts" % file)
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


## The file of the module a loading thread is part way through, or "".
func _on_a_thread() -> String:
	var path: String = node._in_flight
	if path.is_empty():
		return ""
	var status: ResourceLoader.ThreadLoadStatus = ResourceLoader.load_threaded_get_status(path)
	return path.get_file() if status == ResourceLoader.THREAD_LOAD_IN_PROGRESS else ""


func _every_module_loaded() -> bool:
	var held: PackedStringArray = _loaded()
	return Array(Runtime.MODULES).all(func(file: String) -> bool: return held.has(file))


## How long compiling [param file] takes in a frame, with nothing it preloads cached either.
func _compiling_usec(file: String) -> int:
	var from: int = Time.get_ticks_usec()
	var _fresh: Resource = ResourceLoader.load(
		Runtime.ADDON_DIR + file, "GDScript", ResourceLoader.CACHE_MODE_IGNORE_DEEP
	)
	return Time.get_ticks_usec() - from


func _run() -> void:
	for answered_by: Array in Runtime.MODULE_COMMANDS.values():
		var file: String = answered_by[0]
		if not Runtime.MODULES.has(file):
			failures.append("%s answers a command and is compiled on a loading thread" % file)

	# The last module the thread compiles, asked for before it has: finished in this frame, which
	# the frame time leaves out, and the frame after it is timed as usual.
	# Two frames first, so the runtime is timing frames and there is a frame to leave out.
	await process_frame
	await process_frame
	if ResourceLoader.has_cached(Runtime.ADDON_DIR + Runtime.ACCESSIBILITY):
		failures.append("the last module is still compiling two frames in")
	var timed_before: int = node._frames.usec.size()
	var _refused: Dictionary = await node._execute_command("get_accessibility", {})
	if not node._modules.has(Runtime.ACCESSIBILITY):
		failures.append("get_accessibility loads its module in its own frame")
	await process_frame
	var timed_over: int = node._frames.usec.size()
	await process_frame
	var timed_after: int = node._frames.usec.size()
	if timed_over != timed_before or timed_after != timed_before + 1:
		failures.append(
			(
				"the frame a module was finished in is left out and the next is timed: %d, %d, %d"
				% [timed_before, timed_over, timed_after]
			)
		)

	# The rest come over the frames that follow, each compiling on a thread while the frames go on.
	# Seen from here, which runs on the main thread: a module compiled in a frame is never caught
	# part done. Frame times cannot tell it, since a macOS runner's idle frames reached 67 ms.
	var waiting: PackedStringArray = []
	for file: String in Runtime.MODULES:
		if not ResourceLoader.has_cached(Runtime.ADDON_DIR + file):
			var _added: bool = waiting.push_back(file)
	var seen: Dictionary = {}
	var frames: int = 0
	var until: int = Time.get_ticks_msec() + 20000
	var timeline: Array[String] = []
	# The thread runs beside this code, so the cache is read once a frame and each frame's reading
	# is compared with the last one. Two readings would let a module become ready between them.
	var cached_before: PackedStringArray = _loaded()
	var threaded_before: String = _on_a_thread()
	while (
		not waiting.is_empty()
		and Array(waiting).any(func(file: String) -> bool: return not cached_before.has(file))
		and Time.get_ticks_msec() < until
	):
		if not threaded_before.is_empty():
			var counted: int = seen.get(threaded_before, 0)
			seen[threaded_before] = counted + 1
		await process_frame
		frames += 1
		var cached_after: PackedStringArray = _loaded()
		var threaded_after: String = _on_a_thread()
		# A module another one preloads compiles inside that one's load, on the same thread. The
		# runtime may ask for that one after this check in the same frame, so either end counts.
		for file: String in waiting:
			if not cached_before.has(file) and cached_after.has(file):
				timeline.append(
					"frame %d: %s ready, %s to %s" % [frames, file, threaded_before, threaded_after]
				)
				if not threaded_before.is_empty() or not threaded_after.is_empty():
					var pulled_in: int = seen.get(file, 0)
					seen[file] = pulled_in + 1
		cached_before = cached_after
		threaded_before = threaded_after
	if not _every_module_loaded():
		failures.append("a served game compiles every module: %s" % ", ".join(_loaded()))
	for file: String in waiting:
		if not seen.has(file):
			failures.append(
				(
					"%s compiles on a loading thread while frames go on, over %d frames: %s"
					% [file, frames, "; ".join(timeline)]
				)
			)

	# A module's first command, once the thread has it, holds the frame for no compile.
	var held_from: int = Time.get_ticks_usec()
	var metrics: Dictionary = await node._execute_command("get_metrics", {})
	var held: int = Time.get_ticks_usec() - held_from
	var compiling: int = _compiling_usec(Runtime.QUERIES)
	if held * 4 > compiling:
		failures.append(
			(
				"a module's first command held the frame %d us, against %d us to compile it"
				% [held, compiling]
			)
		)
	var readings: Dictionary = metrics.get("data", {})
	var timed: int = readings.get("frames_timed", 0)
	if timed < mini(frames, Frames.FRAMES_TIMED):
		failures.append(
			"the first get_metrics covers the frames before it: %s" % JSON.stringify(metrics)
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
		print(
			JSON.stringify(
				{
					"ok": true,
					"frames_timed": timed,
					"frames_compiling": frames,
					"frames_seen_compiling": seen,
					"held_usec": held,
					"compiling_usec": compiling,
				}
			)
		)
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)
