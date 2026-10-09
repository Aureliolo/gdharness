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

const Read = preload("../reading.gd")

## The most functions a frame may carry when the server does not say. The engine names a function
## once, as it first appears, and the game's debugger queue drops those messages past its size, so
## the server keeps this below the queue the project sets; this is that for the engine's default.
const FRAME_FUNCTIONS: int = 1536
const DEBUGGER_CLASS: String = "ScriptEditorDebugger"
## What a quitting game sends after its profile's totals, and the answer it waits for. Kept in step
## with the runtime addon's runtime_autoload.gd.
const PROFILE_CAPTURE: String = "gdharness"
const PROFILE_SENT: String = "gdharness:profile_sent"
const PROFILE_RECEIVED: String = "gdharness:profile_received"


## The editor's debugger sessions, numbered as the editor numbers its debugger tabs.
class Sessions:
	extends EditorDebuggerPlugin

	signal session_started(session_id: int)

	func _setup_session(session_id: int) -> void:
		var session: EditorDebuggerSession = get_session(session_id)
		# int rather than Error: Signal.connect answers with a plain int.
		var joined: int = session.started.connect(func() -> void: session_started.emit(session_id))
		if joined != OK:
			push_error("gdharness could not watch debugger session %d start: %d" % [session_id, joined])

	func _has_capture(capture: String) -> bool:
		return capture == PROFILE_CAPTURE

	## Answers a quitting game that its profile's totals arrived, which it waits for before it exits.
	## The editor reads a session's messages in order, so the totals sent before this have been read.
	func _capture(message: String, _data: Array, session_id: int) -> bool:
		if message != PROFILE_SENT:
			return false
		get_session(session_id).send_message(PROFILE_RECEIVED, [])
		return true


var _editor_plugin: EditorPlugin = null
var _sessions: Sessions = null
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
## Frames that carried as many functions as were asked for, and whether the totals did.
var _capped_frames: int = 0
var _total_capped: bool = false
var _names: Dictionary[int, String] = {}
## Per signature: calls, self seconds, total seconds.
var _totals: Dictionary[String, PackedFloat64Array] = {}


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin
	_sessions = Sessions.new()
	var joined: int = _sessions.session_started.connect(_on_session_started)
	if joined != OK:
		push_error("gdharness could not watch debugger sessions start: %d" % joined)
	plugin.add_debugger_plugin(_sessions)


func _exit_tree() -> void:
	if _editor_plugin != null and _sessions != null:
		_editor_plugin.remove_debugger_plugin(_sessions)
	_sessions = null


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
					"This editor's debugger has no %s node to read the profiler from, which is where Godot"
					+ " 4.7 keeps it: a Godot that moved it has to be met by a gdharness that knows where."
				)
				% DEBUGGER_CLASS
			),
		}
	_reset()
	var asked: int = Read.as_int(args.get("frameFunctions", FRAME_FUNCTIONS))
	_frame_functions = asked if asked > 0 else FRAME_FUNCTIONS
	if Read.as_bool(args.get("arm", false)):
		_armed = true
		return {"ok": true, "started": false, "armed": true, "session": -1}
	var active: int = _active_session()
	if active < 0:
		return {"ok": true, "started": false, "armed": false, "session": -1}
	_switch_on(active)
	return {"ok": true, "started": true, "armed": false, "session": active}


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
		"cappedFrames": _capped_frames,
		"totalCapped": _total_capped,
		"coveredMs": _last_frame_msec - _started_msec if _last_frame_msec >= 0 else 0,
		"functions": functions,
	}


func _reset() -> void:
	_armed = false
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
	session.toggle_profiler("servers", true, [_frame_functions, false])


## A play that was asked to be profiled is switched on as it starts. Any other play drops what is
## held: the editor plays the next game in the same session, and a profile kept past it was read as
## the new game's.
func _on_session_started(session_id: int) -> void:
	if not _armed:
		_reset()
		return
	_armed = false
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
	if session_id != _session:
		return
	if message == "servers:function_signature" and data.size() >= 2:
		_names[Read.as_int(data[1])] = str(data[0])
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
	var servers: int = Read.as_int(data[at])
	at += 1
	for _server: int in servers:
		if data.size() <= at + 1:
			return -1
		at += 2 + Read.as_int(data[at + 1])
	if data.size() <= at:
		return -1
	var values: int = Read.as_int(data[at])
	at += 1
	if values % 5 != 0 or data.size() < at + values:
		return -1
	var carried: int = 0
	for index: int in range(at, at + values, 5):
		var id: int = Read.as_int(data[index])
		var signature: String = _names[id] if _names.has(id) else "#%d" % id
		var sum: PackedFloat64Array = (
			into[signature] if into.has(signature) else PackedFloat64Array([0, 0, 0])
		)
		sum[0] += Read.as_float(data[index + 1])
		sum[1] += Read.as_float(data[index + 2])
		sum[2] += Read.as_float(data[index + 3])
		into[signature] = sum
		carried += 1
	return carried
