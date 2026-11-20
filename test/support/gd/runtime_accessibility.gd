extends SceneTree
## What a game tells a screen reader, asked of a headless run: there is no window, so the answer
## says to start the run with one rather than walking nothing. The ping beside it shows the runtime
## was answering, so a runtime refusing everything fails.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")
const Accessibility = preload("res://addons/gdharness_runtime/runtime_accessibility.gd")
const Readers = preload("res://addons/gdharness_runtime/runtime_readers.gd")
## What a client may take to begin on a cold cache, against the 9 to 22 s PowerShell took on a
## loaded runner. Measured warm at about 0.1 s, so this is a bound a loaded machine stays under.
const START_BOUND_MS: int = 5000
## A program that compiles and does nothing, for the cache cases.
const TRIVIAL: String = "static class Trivial { static int Main() { return 0; } }"
## How long the macOS client may take to answer an empty read before the case fails.
const AX_WAIT_MS: int = 30000

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
		"began 1100\nassemblies 1400\n":
		(
			"PowerShell began the client after 100 ms and loaded UI Automation's assemblies in 300"
			+ " ms, and was still setting up the description reader and the JSON serialiser"
		),
		"began 1100\nassemblies 1400\nloaded 1600\n":
		(
			"PowerShell began the client after 100 ms and loaded UI Automation in 500 ms, and the "
			+ "first walk of the windows had not ended"
		),
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
		"began 1100\nloaded 1600\nwalked 1 1700\nanswering 1750\n":
		(
			"PowerShell began the client after 100 ms and loaded UI Automation in 500 ms, and the"
			+ " windows were walked 1 time, the last finding 1 element and ending 300 ms before the"
			+ " client was stopped, which had been writing the answer for 250 ms"
		),
	}
	for progress: String in reached:
		var said: String = Accessibility._reached(progress, 1000, 2000)
		if said != reached[progress]:
			failures.append("marks %s are said as: %s" % [JSON.stringify(progress), said])
	var stopped: String = Accessibility._stopped(45017, "PowerShell had not begun the client", 1)
	if stopped != (
		"UI Automation had not read the tree after 45017 ms, so it was stopped: PowerShell had not"
		+ " begun the client. The game ran 1 frame in that time."
	):
		failures.append("a stopped client is said as: %s" % stopped)
	var many: String = Accessibility._stopped(45017, "PowerShell had not begun the client", 1080)
	if not many.ends_with("client. The game ran 1080 frames in that time."):
		failures.append("frames are counted in the plural: %s" % many)
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

	failures.append_array(_how_other_systems_are_said())
	failures.append_array(await _the_readers())

	node._cleanup()
	# Not checked: the directory is gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


## How a stopped client and the notes read for the systems whose clients are not PowerShell's.
func _how_other_systems_are_said() -> Array[String]:
	var failures: Array[String] = []
	var linux: Dictionary = { "system": "AT-SPI", "starter": "The python3 process" }
	var mac: Dictionary = {
		"system": "the AX API", "starter": "The osascript process", "element_ids": false,
	}
	var said: Dictionary = {
		Accessibility._reached("began 1100\nloaded 1600\n", 1000, 2000, linux):
		(
			"The python3 process began the client after 100 ms and loaded AT-SPI in 500 ms, and the"
			+ " first walk of the windows had not ended"
		),
		Accessibility._reached("", 1000, 2000, mac):
		"The osascript process had not begun the client",
		Accessibility._stopped(45017, "x", 2, mac):
		(
			"The AX API had not read the tree after 45017 ms, so it was stopped: x. The game ran 2 "
			+ "frames in that time."
		),
	}
	for got: String in said:
		if got != said[got]:
			failures.append("a client of another system is said as: %s" % got)
	var result: Dictionary = {}
	Accessibility._note_reading(result, Accessibility.GdhPlacing.new(), {}, mac)
	if not str(result.get("node_note", "")).begins_with("The AX API gives no element ids"):
		failures.append("a system with no element ids says so: %s" % JSON.stringify(result))
	if not Accessibility._tree_unbuilt(linux).begins_with("AT-SPI found nothing in the game's"):
		failures.append("an unbuilt tree is named for the system that read it")
	var needing: Dictionary = { "system": "the AX API", "needs": "x allowed" }
	var unanswered: Dictionary = {
		Accessibility._unanswered("", null, needing, ""):
		"The AX API answered nothing readable: . Reading it needs x allowed.",
		Accessibility._unanswered("", null, needing, "Error: -2700"):
		(
			"The AX API answered nothing readable: . It printed: Error: -2700. Reading it needs x"
			+ " allowed."
		),
	}
	for got: String in unanswered:
		if got != unanswered[got]:
			failures.append("a client that answered nothing is said as: %s" % got)
	return failures


## The clients on the system this runs on: its profile, and for Windows the compiled client's cache
## and refusals, for Linux the refusal when no accessibility bus answers and for macOS that the
## client runs and answers or names the permission.
func _the_readers() -> Array[String]:
	var failures: Array[String] = []
	var readers: Readers = Readers.new(root)
	var dir: String = OS.get_temp_dir().path_join("gdharness-readers-%d" % OS.get_process_id())
	var profile: Dictionary = Readers.profile()
	for key: String in ["system", "starter", "needs", "element_ids"]:
		if not profile.has(key):
			failures.append("%s has a reader with its %s: %s" % [OS.get_name(), key, profile])
	var absent: String = dir.path_join("absent/csc.exe")
	var missing: Dictionary = await readers.compile_client(dir, TRIVIAL, absent)
	if not str(missing.get("error", "")).contains("absent/csc.exe is missing"):
		failures.append("a compiler that is not there is named: %s" % JSON.stringify(missing))
	match OS.get_name():
		"Windows":
			failures.append_array(await _compiled(readers, dir))
		"Linux":
			failures.append_array(_atspi_without_a_bus(dir))
			failures.append_array(await _error_output_read())
		"macOS":
			failures.append_array(await _ax_asked(readers, dir))
			failures.append_array(await _error_output_read())
	_remove_all(dir)
	return failures


## Windows: the compiled client is made once, reused, made again when its source changes, refused
## with the compiler's words when it does not compile, and starts and answers within the bound.
func _compiled(readers: Readers, dir: String) -> Array[String]:
	var failures: Array[String] = []
	var csc: String = Readers.compiler()
	var first: Dictionary = await readers.compile_client(dir, TRIVIAL, csc)
	var exe: String = str(first.get("exe", ""))
	var compile_ms: int = first.get("compile_ms", 0)
	if exe.is_empty() or not FileAccess.file_exists(exe) or compile_ms <= 0:
		failures.append("a client is compiled: %s" % JSON.stringify(first))
		return failures
	# The source written beside the client is the mark of a compile: a reuse writes nothing.
	var written: String = exe.trim_suffix(".exe") + ".cs"
	var _removed: Error = DirAccess.remove_absolute(written)
	var again: Dictionary = await readers.compile_client(dir, TRIVIAL, csc)
	var reused_ms: int = again.get("compile_ms", -1)
	if again.get("exe") != exe or reused_ms != 0 or FileAccess.file_exists(written):
		failures.append("an unchanged client is reused: %s" % JSON.stringify(again))
	var changed: Dictionary = await readers.compile_client(dir, TRIVIAL + "\n// changed", csc)
	var changed_exe: String = str(changed.get("exe", ""))
	if (
		changed_exe.is_empty()
		or changed_exe == exe
		or not FileAccess.file_exists(changed_exe)
		or FileAccess.file_exists(exe)
	):
		failures.append("a changed client is compiled again: %s" % JSON.stringify(changed))
	var broken: Dictionary = await readers.compile_client(dir, "this is not C#", csc)
	if not str(broken.get("error", "")).contains("error CS"):
		failures.append("a client that does not compile says why: %s" % JSON.stringify(broken))
	var real: Dictionary = await readers.compile_client(dir, Readers.UIA_CLIENT, csc)
	var real_exe: String = str(real.get("exe", ""))
	if real_exe.is_empty():
		failures.append("the UI Automation client compiles: %s" % JSON.stringify(real))
		return failures
	# No window handles: the client starts, loads UI Automation and answers an empty read.
	var out: String = dir.path_join("answer.json")
	var progress: String = out + ".progress"
	var asked_at: int = int(Time.get_unix_time_from_system() * 1000.0)
	var output: Array = []
	var code: int = OS.execute(real_exe, [out, progress, "100", "100", "40"], output, true)
	var done_at: int = int(Time.get_unix_time_from_system() * 1000.0)
	var took: Dictionary = Accessibility._took(
		FileAccess.get_file_as_string(progress), asked_at, done_at
	)
	if code != 0 or FileAccess.get_file_as_string(out) != '{"windows":[]}':
		failures.append("the client answers an empty read: %d %s" % [code, output])
	var began_ms: int = took.get("start", START_BOUND_MS + 1)
	if began_ms > START_BOUND_MS:
		failures.append("the client begins in %d ms: %s" % [START_BOUND_MS, JSON.stringify(took)])
	return failures


## Linux and macOS: what a client started through a pipe prints on its error output is read once
## it has ended.
func _error_output_read() -> Array[String]:
	var piped: Dictionary = OS.execute_with_pipe("/bin/sh", ["-c", "echo broken >&2"], false)
	var pid: int = piped.get("pid", -1)
	var began: int = Time.get_ticks_msec()
	while pid > 0 and OS.is_process_running(pid) and Time.get_ticks_msec() - began < AX_WAIT_MS:
		await process_frame
	var said: String = Readers.said(piped)
	if said != "broken":
		return ["a client's error output is read as: %s" % JSON.stringify(said)]
	return []


## Linux: with no session bus to reach, the client answers naming what it needs.
func _atspi_without_a_bus(dir: String) -> Array[String]:
	var failures: Array[String] = []
	var is_made: Error = DirAccess.make_dir_recursive_absolute(dir)
	var out: String = dir.path_join("answer.json")
	var before: String = OS.get_environment("DBUS_SESSION_BUS_ADDRESS")
	OS.set_environment("DBUS_SESSION_BUS_ADDRESS", "unix:path=" + dir.path_join("no-bus"))
	var output: Array = []
	var code: int = OS.execute(
		"python3",
		["-c", Readers.ATSPI_CLIENT, out, out + ".progress", "100", "100", "40", "0", "0"],
		output,
		true
	)
	if before.is_empty():
		OS.unset_environment("DBUS_SESSION_BUS_ADDRESS")
	else:
		OS.set_environment("DBUS_SESSION_BUS_ADDRESS", before)
	var answer: Variant = JSON.parse_string(FileAccess.get_file_as_string(out))
	var said: String = ""
	if answer is Dictionary:
		var held: Dictionary = answer
		said = str(held.get("error", ""))
	if (
		is_made != OK
		or code != 0
		or not said.contains("It needs python3 with the gi module")
		or not (said.contains("no accessibility bus") or said.contains("cannot load AT-SPI"))
	):
		failures.append("no accessibility bus names what it needs: %d %s" % [code, output])
	return failures


## macOS: the client started as a read starts it runs, and answers a read or names the missing
## Accessibility permission. It is started by [method Readers.start] rather than OS.execute, whose
## output capture runs the command through sh and so would expand the client's $(...) calls.
func _ax_asked(readers: Readers, dir: String) -> Array[String]:
	var failures: Array[String] = []
	var is_made: Error = DirAccess.make_dir_recursive_absolute(dir)
	var out: String = dir.path_join("answer.json")
	var no_windows: Array[String] = []
	var limits: Array[int] = [100, 100, 40]
	var started: Dictionary = await readers.start(out, out + ".progress", no_windows, limits)
	var pid: int = started.get("pid", 0)
	var began: int = Time.get_ticks_msec()
	while pid > 0 and OS.is_process_running(pid) and Time.get_ticks_msec() - began < AX_WAIT_MS:
		await process_frame
	var code: int = OS.get_process_exit_code(pid) if pid > 0 else -1
	var answered: String = FileAccess.get_file_as_string(out)
	var output: String = "%s, answered %s" % [JSON.stringify(started), answered]
	var answer: Variant = JSON.parse_string(answered)
	var shown: bool = false
	if answer is Dictionary:
		var held: Dictionary = answer
		shown = (
			held.has("windows")
			or (
				held.get("permission") == true
				and str(held.get("error", "")).contains("Accessibility is not allowed")
			)
		)
	if is_made != OK or code != 0 or not shown:
		failures.append("the AX client answers or names the permission: %d %s" % [code, output])
	return failures


static func _remove_all(dir: String) -> void:
	for file_name: String in DirAccess.get_files_at(dir):
		var _file_removed: Error = DirAccess.remove_absolute(dir.path_join(file_name))
	for sub: String in DirAccess.get_directories_at(dir):
		_remove_all(dir.path_join(sub))
	var _dir_removed: Error = DirAccess.remove_absolute(dir)
