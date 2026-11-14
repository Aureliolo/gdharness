@tool
extends Node
## The engine's script profiler on a game the editor plays, summed here for the server.
##
## The editor is that game's debugger, so the profiler is switched on through the editor's own
## session, and what the game sends back is read where the editor reads it. The editor's handlers
## take the `servers:*` messages before any EditorDebuggerPlugin is asked (script_editor_debugger
## .cpp at 4.7.2), so a plugin's capture never sees them. The one place they pass through is the
## `debug_data` signal every ScriptEditorDebugger emits for every message, on a node Godot does not
## expose to scripts: found by its class in the editor's tree and connected to by name.
##
## The same session also holds a game's error breaks off for the length of one evaluate. See
## [method error_breaks]. And it asks for the engine's object snapshot, which the editor's ObjectDB
## Profiler fetches. See [method object_snapshot].

const GdhRead = preload("../reading.gd")
## The most functions a frame may carry when the server does not say. The engine names a function
## once, as it first appears, and the game's debugger queue drops those messages past its size, so
## the server keeps this below the queue the project sets. This is that for the engine's default.
const FRAME_FUNCTIONS: int = 1536
const DEBUGGER_CLASS: String = "ScriptEditorDebugger"
## The tooltip of the debugger's button that switches error breaks, as Godot 4.7 words it.
const IGNORE_ERROR_BREAKS: String = "Ignore Error Breaks"
## What a quitting game sends after its profile's totals, and the answer it waits for. Kept in step
## with the runtime addon's runtime_autoload.gd.
const PROFILE_CAPTURE: String = "gdharness"
const PROFILE_SENT: String = "gdharness:profile_sent"
const PROFILE_RECEIVED: String = "gdharness:profile_received"
## Set in the environment a played game inherits, when the play is to be profiled from its start.
## Kept in step with the runtime addon's runtime_autoload.gd.
const PROFILE_FROM_START: String = "GDHARNESS_PROFILE_FROM_START"
## Where the editor's ObjectDB Profiler saves each snapshot it fetches, and how it ends their names.
const SNAPSHOT_FOLDER: String = "user://objectdb_snapshots"
const SNAPSHOT_EXTENSION: String = ".odb_snapshot"
## The first id a snapshot asked from here takes. The profiler's own button counts up from 0.
const SNAPSHOT_IDS_FROM: int = 1 << 30
## How long a snapshot is waited for, inside the server's wait for an editor's answer.
const SNAPSHOT_WAIT_SECONDS: int = 20

var _editor_plugin: EditorPlugin = null
var _sessions: GdhSessions = null
## The debugger tabs connected to, by instance id, so none is connected twice.
var _hooked: Dictionary[int, bool] = {}
## A play asked to be profiled before its session started.
var _armed: bool = false
var _session: int = -1
var _started_msec: int = 0
var _last_frame_msec: int = -1
var _frames: int = 0
var _complete: bool = false
var _frame_functions: int = FRAME_FUNCTIONS
## Whether native calls are timed, which the server asks for. Off by default, because the engine
## reads an object's class after a dynamic call to free() has destroyed it.
var _engine_calls: bool = false
## Frames that carried as many functions as were asked for, and whether the totals did.
var _capped_frames: int = 0
var _total_capped: bool = false
var _names: Dictionary[int, String] = {}
## Per signature: calls, self seconds, total seconds.
var _totals: Dictionary[String, PackedFloat64Array] = {}
var _snapshots_asked: int = 0
## Per snapshot asked from here, by id: the size the game prepared, -1 until it says, and the bytes
## seen go to the profiler since.
var _snapshot_sizes: Dictionary[int, int] = {}
var _snapshot_received: Dictionary[int, int] = {}


func _exit_tree() -> void:
	if _editor_plugin != null and _sessions != null:
		_editor_plugin.remove_debugger_plugin(_sessions)
	_sessions = null


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin
	_sessions = GdhSessions.new()
	var joined: int = _sessions.session_started.connect(_on_session_started)
	if joined != OK:
		push_error("gdharness could not watch debugger sessions start: %d" % joined)
	plugin.add_debugger_plugin(_sessions)


## Switches the profiler on for the game being played, or with [code]arm[/code] for the next one
## to start and never the one playing: a start ends the game before it, which can still be going.
## Either way what was summed before is dropped.
func profile_start(args: Dictionary) -> Dictionary:
	if _hook() == 0:
		return {
			"ok": false,
			"error":
			(
				(
					"This editor's debugger has no %s node to read the profiler from, which is "
					+ "where Godot 4.7 keeps it: a Godot that moved it has to be met by a "
					+ "gdharness that knows where."
				)
				% DEBUGGER_CLASS
			),
		}
	_reset()
	var asked: int = GdhRead.as_int(args.get("frameFunctions", FRAME_FUNCTIONS))
	_frame_functions = asked if asked > 0 else FRAME_FUNCTIONS
	_engine_calls = GdhRead.as_bool(args.get("engineCalls", false))
	if GdhRead.as_bool(args.get("arm", false)):
		_armed = true
		# The game the editor starts next inherits the editor's environment, and this tells its
		# runtime addon to hold its start until the profiler is on, which the session's start
		# switches on with a message the game reads only on a later poll.
		OS.set_environment(PROFILE_FROM_START, "1")
		return { "ok": true, "started": false, "armed": true, "session": -1 }
	var active: int = _active_session()
	if active < 0:
		return { "ok": true, "started": false, "armed": false, "session": -1 }
	_switch_on(active)
	return { "ok": true, "started": true, "armed": false, "session": active }


## What has been summed, for the server to put into an answer.
func profile_read(_args: Dictionary) -> Dictionary:
	var functions: Dictionary = {}
	for signature: String in _totals:
		functions[signature] = Array(_totals[signature])
	return {
		"ok": true,
		"profiled": _session >= 0,
		"armed": _armed,
		"session": _session,
		"playing": EditorInterface.is_playing_scene(),
		"frames": _frames,
		"complete": _complete,
		"frameFunctions": _frame_functions,
		"engineCalls": _engine_calls,
		"cappedFrames": _capped_frames,
		"totalCapped": _total_capped,
		"coveredMs": _last_frame_msec - _started_msec if _last_frame_msec >= 0 else 0,
		"functions": functions,
	}


## Holds the played game's error breaks off with [code]ignore[/code], and otherwise hands them back
## to the editor's own "Ignore Error Breaks" button.
##
## An evaluate loads the script of every global class, and one that does not parse breaks the held
## game on its parse error inside the evaluate, before the engine prints it. The editor then asks
## that break for nothing, so its adapter waits on a stack that never comes, the evaluate is never
## answered and the game stays held where nothing can reach it. The message is the one the button
## sends. The button's state is not readable from a script, so it is given back by pressing the
## button twice, which sends the game whatever it was.
func error_breaks(args: Dictionary) -> Dictionary:
	var active: int = _active_session()
	if active < 0:
		return { "ok": true, "session": -1 }
	if GdhRead.as_bool(args.get("ignore", false)):
		_sessions.get_session(active).send_message("set_ignore_error_breaks", [true])
		return { "ok": true, "session": active }
	var tabs: Array[Node] = EditorInterface.get_base_control().find_children(
		"*", DEBUGGER_CLASS, true, false
	)
	if active < tabs.size():
		for found: Node in tabs[active].find_children("*", "Button", true, false):
			var button: Button = found as Button
			if button.tooltip_text == IGNORE_ERROR_BREAKS:
				button.pressed.emit()
				button.pressed.emit()
				return { "ok": true, "session": active }
	_sessions.get_session(active).send_message("set_ignore_error_breaks", [false])
	return {
		"ok": true,
		"session": active,
		"note":
		(
			"This editor's debugger has no %s button, so the game breaks on errors again whatever "
			+ "the editor is set to."
		) % IGNORE_ERROR_BREAKS,
	}


## Has the editor's ObjectDB Profiler take the engine's object snapshot of the played game, and
## answers the file it saved, for the server to read and remove.
##
## The profiler answers every snapshot a game prepares, whoever asked: it fetches the bytes and
## saves them as user://objectdb_snapshots/<date>_<time>.odb_snapshot, with _2 and on for a second
## in the same second (objectdb_profiler_panel.cpp at 4.7.2). So the request goes out on the
## session, as its own button sends it, under an id far above the ones the button counts up from 0.
## The file is told from any other by being new since the request and of the size the game said.
func object_snapshot(_args: Dictionary) -> Dictionary:
	var active: int = _active_session()
	if active < 0:
		return { "ok": false, "error": "The editor is playing no game to snapshot." }
	var _watching: int = _hook()
	var before: PackedStringArray = _snapshot_files()
	_snapshots_asked += 1
	var id: int = SNAPSHOT_IDS_FROM + _snapshots_asked
	_snapshot_sizes[id] = -1
	_snapshot_received[id] = 0
	var started: int = Time.get_ticks_msec()
	var version: String = str(Engine.get_version_info().get("string", ""))
	_sessions.get_session(active).send_message("snapshot:request_prepare_snapshot", [id, version])
	var found: String = ""
	while found.is_empty() and Time.get_ticks_msec() - started < SNAPSHOT_WAIT_SECONDS * 1000:
		await get_tree().process_frame
		found = _new_snapshot_file(before, id)
	var size: int = _snapshot_sizes[id]
	var received: int = _snapshot_received[id]
	var _sized: bool = _snapshot_sizes.erase(id)
	var _counted: bool = _snapshot_received.erase(id)
	if found.is_empty():
		return { "ok": false, "error": _snapshot_failure(size, received) }
	return { "ok": true, "path": ProjectSettings.globalize_path(found), "size": size }


func _snapshot_failure(size: int, received: int) -> String:
	if size < 0:
		return (
			"The game answered no object snapshot within %d s. An engine has the snapshot only "
			+ "when built with debug features, as the editor and the debug export templates are."
		) % SNAPSHOT_WAIT_SECONDS
	if received == 0:
		return (
			"The game prepared a snapshot of %d bytes and the editor's ObjectDB Profiler never "
			+ "fetched it, so this editor has no ObjectDB Profiler."
		) % size
	return (
		"The editor's ObjectDB Profiler fetched %d of the snapshot's %d bytes and saved no file "
		+ "of that size under %s within %d s."
	) % [received, size, SNAPSHOT_FOLDER, SNAPSHOT_WAIT_SECONDS]


func _snapshot_files() -> PackedStringArray:
	if not DirAccess.dir_exists_absolute(SNAPSHOT_FOLDER):
		return PackedStringArray()
	return DirAccess.get_files_at(SNAPSHOT_FOLDER)


## The file the profiler saved for snapshot [param id], once every byte has arrived, or "".
func _new_snapshot_file(before: PackedStringArray, id: int) -> String:
	var size: int = _snapshot_sizes[id]
	if size < 0 or _snapshot_received[id] < size:
		return ""
	for listed: String in _snapshot_files():
		if listed in before or not listed.ends_with(SNAPSHOT_EXTENSION):
			continue
		var path: String = SNAPSHOT_FOLDER.path_join(listed)
		var file: FileAccess = FileAccess.open(path, FileAccess.READ)
		if file != null and file.get_length() == size:
			return path
	return ""


func _on_snapshot_data(message: String, data: Array) -> void:
	if data.size() < 2 or not _snapshot_sizes.has(GdhRead.as_int(data[0])):
		return
	var id: int = GdhRead.as_int(data[0])
	if message == "snapshot:snapshot_prepared":
		_snapshot_sizes[id] = GdhRead.as_int(data[1])
	elif message == "snapshot:snapshot_chunk" and data[1] is PackedByteArray:
		var part: PackedByteArray = data[1]
		_snapshot_received[id] += part.size()


func _reset() -> void:
	_armed = false
	OS.unset_environment(PROFILE_FROM_START)
	_session = -1
	_frames = 0
	_complete = false
	_capped_frames = 0
	_total_capped = false
	_last_frame_msec = -1
	_names.clear()
	_totals.clear()


func _active_session() -> int:
	if _sessions == null:
		return -1
	var all: Array[EditorDebuggerSession] = _sessions.get_sessions()
	for index: int in all.size():
		if all[index].is_active():
			return index
	return -1


func _switch_on(session_id: int) -> void:
	_session = session_id
	_started_msec = Time.get_ticks_msec()
	var session: EditorDebuggerSession = _sessions.get_session(session_id)
	# With native calls timed, a call through an engine method leaves the caller's self time.
	session.toggle_profiler("servers", true, [_frame_functions, _engine_calls])


## A play that was asked to be profiled is switched on as it starts. Any other play drops what is
## held: the editor plays the next game in the same session, and a profile kept past it was read as
## the new game's.
func _on_session_started(session_id: int) -> void:
	if not _armed:
		_reset()
		return
	_armed = false
	# The game has started with it by now, and a later play must not.
	OS.unset_environment(PROFILE_FROM_START)
	if _hook() > 0:
		_switch_on(session_id)


## Connects to every debugger tab not connected yet, in tab order, which is session order.
func _hook() -> int:
	var found: Array[Node] = EditorInterface.get_base_control().find_children(
		"*", DEBUGGER_CLASS, true, false
	)
	for index: int in found.size():
		var tab: Node = found[index]
		var id: int = tab.get_instance_id()
		if not _hooked.has(id) and tab.has_signal("debug_data"):
			var joined: Error = tab.connect("debug_data", _on_debug_data.bind(index))
			if joined != OK:
				push_error("gdharness could not read debugger tab %d: %d" % [index, joined])
			_hooked[id] = true
	return found.size()


func _on_debug_data(message: String, data: Array, session_id: int) -> void:
	if message.begins_with("snapshot:"):
		_on_snapshot_data(message, data)
		return
	if session_id != _session:
		return
	if message == "servers:function_signature" and data.size() >= 2:
		_names[GdhRead.as_int(data[1])] = str(data[0])
	elif message == "servers:profile_frame":
		var carried: int = _add(data, _totals)
		if carried >= 0:
			_frames += 1
			_capped_frames += 1 if carried >= _frame_functions else 0
			_last_frame_msec = Time.get_ticks_msec()
	elif message == "servers:profile_total":
		# The engine's own count since the profiler started, so it replaces the frames' sum.
		var whole: Dictionary[String, PackedFloat64Array] = {}
		var carried: int = _add(data, whole)
		if carried >= 0:
			# Apart from engine time: GDScript clears a function's engine calls at each frame's
			# end, so its totals hold only those since the last frame, and the frames hold the rest.
			for signature: String in whole:
				if _totals.has(signature):
					var sum: PackedFloat64Array = whole[signature]
					sum[3] += _totals[signature][3]
					whole[signature] = sum
			_totals = whole
			_complete = true
			_total_capped = carried >= _frame_functions
			_last_frame_msec = Time.get_ticks_msec()


## Adds one frame's functions into [param into], reading past the servers' section to reach them:
## six frame times, the server count, each server's name and field count and fields, then five
## numbers per function. Answers how many functions it carried, or -1 for a frame it cannot read.
func _add(data: Array, into: Dictionary[String, PackedFloat64Array]) -> int:
	var at: int = 6
	if data.size() <= at:
		return -1
	var servers: int = GdhRead.as_int(data[at])
	at += 1
	for _server: int in servers:
		if data.size() <= at + 1:
			return -1
		at += 2 + GdhRead.as_int(data[at + 1])
	if data.size() <= at:
		return -1
	var values: int = GdhRead.as_int(data[at])
	at += 1
	if values % 5 != 0 or data.size() < at + values:
		return -1
	var carried: int = 0
	for index: int in range(at, at + values, 5):
		var id: int = GdhRead.as_int(data[index])
		var signature: String = _names[id] if _names.has(id) else "#%d" % id
		var sum: PackedFloat64Array = (
			into[signature] if into.has(signature) else PackedFloat64Array([0, 0, 0, 0])
		)
		sum[0] += GdhRead.as_float(data[index + 1])
		sum[1] += GdhRead.as_float(data[index + 2])
		sum[2] += GdhRead.as_float(data[index + 3])
		sum[3] += GdhRead.as_float(data[index + 4])
		into[signature] = sum
		carried += 1
	return carried


## The editor's debugger sessions, numbered as the editor numbers its debugger tabs.
class GdhSessions:
	extends EditorDebuggerPlugin

	signal session_started(session_id: int)

	func _setup_session(session_id: int) -> void:
		var session: EditorDebuggerSession = get_session(session_id)
		# int rather than Error: Signal.connect answers with a plain int.
		var joined: int = session.started.connect(func() -> void: session_started.emit(session_id))
		if joined != OK:
			push_error(
				"gdharness could not watch debugger session %d start: %d" % [session_id, joined]
			)

	func _has_capture(capture: String) -> bool:
		return capture == PROFILE_CAPTURE

	## Answers a quitting game that its profile's totals arrived, which it waits for before it
	## exits. The editor reads a session's messages in order, so the totals sent before this have
	## been read.
	func _capture(message: String, _data: Array, session_id: int) -> bool:
		if message != PROFILE_SENT:
			return false
		get_session(session_id).send_message(PROFILE_RECEIVED, [])
		return true
