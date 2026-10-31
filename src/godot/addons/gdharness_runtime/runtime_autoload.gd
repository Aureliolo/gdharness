extends Node
## The runtime autoload: a TCP server inside the running game that the gdharness server asks
## about the scene tree, drives with input, and captures. This file is the server and the
## command table. What each command does lives in a sibling module.
##
## The port is whatever the operating system hands out, and the game announces it by writing
## one file named after its process id into a directory the server derives the same way. Two
## games can therefore run at once, and a headless operation never takes the port a game
## wanted. Both directions of the socket carry one JSON object per line. Every request names an
## id and the reply carries it back.

const GdhErrorReport = preload("error_report.gd")
const GdhFrames = preload("runtime_frames.gd")
const GdhRead = preload("reading.gd")
## Where the modules are loaded from. Kept in step with the markers below.
const ADDON_DIR: String = "res://addons/gdharness_runtime/"
## The modules that answer commands, loaded at the first command one answers rather than preloaded.
## A preload compiles as this script parses, and the modules are twelve thousand lines: compiling
## them took most of a second of every debug start, in games nobody asks anything, a bench's quiet
## workers and script runs among them.
const QUERIES: String = "runtime_queries.gd"
const CHANGES: String = "runtime_changes.gd"
const INPUT: String = "runtime_input.gd"
const TYPING: String = "runtime_typing.gd"
const PAD: String = "runtime_pad.gd"
const TOUCH: String = "runtime_touch.gd"
const CAPTURE: String = "runtime_capture.gd"
const WAITS: String = "runtime_waits.gd"
const ACCESSIBILITY: String = "runtime_accessibility.gd"
const VALUES: String = "runtime_values.gd"
## Every module command, by the name a request uses, as the module and the method that answers it.
const MODULE_COMMANDS: Dictionary = {
	"get_tree": [QUERIES, "get_tree"],
	"find_nodes": [QUERIES, "find_nodes"],
	"read_text": [QUERIES, "read_text"],
	"get_rect": [QUERIES, "get_rect"],
	"get_property": [QUERIES, "get_property"],
	"set_property": [CHANGES, "set_property"],
	"call_method": [CHANGES, "call_method"],
	"get_metrics": [QUERIES, "get_metrics"],
	"get_accessibility": [ACCESSIBILITY, "get_accessibility"],
	"capture_screenshot": [CAPTURE, "capture_screenshot"],
	"capture_viewport": [CAPTURE, "capture_viewport"],
	"inject_action": [INPUT, "inject_action"],
	"inject_key": [INPUT, "inject_key"],
	"inject_text": [TYPING, "inject_text"],
	"inject_mouse_click": [INPUT, "inject_mouse_click"],
	"inject_mouse_motion": [INPUT, "inject_mouse_motion"],
	"inject_mouse_drag": [INPUT, "inject_mouse_drag"],
	"inject_joypad_button": [PAD, "inject_joypad_button"],
	"inject_joypad_motion": [PAD, "inject_joypad_motion"],
	"inject_touch": [TOUCH, "inject_touch"],
	"inject_touch_drag": [TOUCH, "inject_touch_drag"],
	"click": [INPUT, "click"],
	"choose": [TYPING, "choose"],
	"wait_frames": [WAITS, "wait_frames"],
	"wait_signal": [WAITS, "wait_signal"],
	"watch_signal": [WAITS, "watch_signal"],
	"watch_recorded": [WAITS, "recorded"],
	"wait_until": [WAITS, "wait_until"],
}
## The size the engine gives a headless game's root viewport. Kept in step with
## `HEADLESS_VIEWPORT` in runtime_targets.gd, which this script does not load as it starts.
const HEADLESS_VIEWPORT: Vector2 = Vector2(64, 64)
const PROTOCOL: int = 3
const DEFAULT_BIND_ADDRESS: String = "127.0.0.1"
const BIND_ADDRESS_SETTING: String = "gdharness/runtime/bind_address"
## 0 asks the operating system for a free port, which is the default and what the server
## expects. A fixed port is for a client that cannot read the announcement.
const PORT_SETTING: String = "gdharness/runtime/port"
## The debugger messages that confirm a profile's totals arrived: the game sends the first after
## them, and the debugger answers with the second once it has read that far. Kept in step with
## `PROFILE_SENT` and `PROFILE_RECEIVED` in src/script-profile.ts and the editor addon's
## profile_tools.gd.
const PROFILE_CAPTURE: String = "gdharness"
const PROFILE_SENT: String = "gdharness:profile_sent"
const PROFILE_RECEIVED: String = "gdharness:profile_received"
## The longest a quitting game waits for that answer from a debugger that may not give one, such as
## an editor without the gdharness addon, which holds every profiled exit this long.
const PROFILE_CONFIRM_MS: int = 3000
## The longest it waits for a debugger gdharness gave it, which answers once it has read that far:
## long enough for one far behind, and an end for one that has hung.
const PROFILE_ANSWERED_MS: int = 60000
## How many times the empty function is called to measure what the profiler costs per call: enough
## that the clock's microsecond steps are lost in the sum, and a few milliseconds of one frame.
const PROFILER_PROBE_CALLS: int = 10000
## How many calls of `EngineDebugger.line_poll` read the debugger's messages once: it reads them
## on every 2048th call and only counts the others.
const POLLS_PER_READ: int = 2048
## The most frames a close waits for its answer to leave: a client that stopped reading would
## otherwise hold the close for ever, and the server is past caring about the answer by then.
const CLOSE_AFTER_FRAMES: int = 30
## Set in a game's environment by whatever starts it to be profiled from its start: the server for
## a run it spawns, the editor for a play. Kept in step with `PROFILE_FROM_START` in the server.
const PROFILE_FROM_START: String = "GDHARNESS_PROFILE_FROM_START"
## How long such a game waits for its debugger to switch the profiler on before carrying on.
const PROFILER_WAIT_MS: int = 5000
## How the engine is told to run a script instead of the game: `godot -s thing.gd`.
const SCRIPT_FLAGS: PackedStringArray = ["-s", "--script"]
## Serve a script run anyway, for somebody driving a `-s` script rather than a game.
const SCRIPT_RUNS_SETTING: String = "gdharness/runtime/serve_script_runs"
## The `res://` folders of scenes that are not the game, such as a bench: a run started on one is
## not served. Kept in step with `QUIET_SCENES_SETTING` in src/setup.ts.
const QUIET_SCENES_SETTING: String = "gdharness/runtime/quiet_scenes_under"
## What every user argument `gdharness spread` hands its engines starts with. Kept in step with
## the constants of GdhShare in addons/gdharness_tests/share.gd.
const SPREAD_ARGUMENTS: String = "--gdh-share"
## What the engine takes a bare argument for as the scene to run, by its extension.
const SCENE_EXTENSIONS: PackedStringArray = ["tscn", "scn", "escn", "res", "tres"]
## The variable the editor addon puts into its own environment, which every game the editor plays
## inherits: it says which editor played this game, so a server can tell the editor's game from
## another of the same project that some other server started. Kept in step with
## `EDITOR_PID_VARIABLE` in the editor addon's bridge client.
const EDITOR_PID_VARIABLE: String = "GDHARNESS_EDITOR_PID"
## The directory the keeper holding this run reads, once the game has exited, to learn whether it
## set a restart with OS.set_restart_on_exit. The engine starts the process it restarts into after
## the tree has gone, and from outside that looks like a worker the game started in its last
## moments, so only the game can say which it was. Kept in step with `EXIT_NOTES_VARIABLE` in
## src/keeper.ts.
const EXIT_NOTES_VARIABLE: String = "GDHARNESS_EXIT_NOTES"
## The file the engine's error reports go to, beside the announcement and named the same way,
## which is where the server reads them for a run the editor plays. Kept in step with
## `errorReportPath` in src/runtime-client.ts.
const ERROR_REPORT_NAME: String = "runtime-%d.log"
## Written beside this addon by setup and upgrade. Kept in step with `VERSION_MARKER` and
## `DIGEST_MARKER` in src/setup.ts.
const VERSION_MARKER: String = "res://addons/gdharness_runtime/.gdharness-version"
const DIGEST_MARKER: String = "res://addons/gdharness_runtime/.gdharness-digest"

## The values module every other module reads and writes values with, one for them all, loaded with
## the first of them.
var values: RefCounted:
	get:
		if _values == null:
			_values = _loaded(VALUES).new()
		return _values

var _values: RefCounted
var _frames: GdhFrames = GdhFrames.new()
## Each module loaded so far, by its file. Held here because a Callable holds its object by id
## rather than by reference, and a module referenced only by the Callable answering one command
## would be freed once it answered.
var _modules: Dictionary = {}
var _server: TCPServer
var _clients: Array[StreamPeerTCP] = []
## Bytes received from each client that do not yet end in a newline, keyed by the peer.
var _pending: Dictionary = {}
## Bytes owed to each client that the socket has not taken yet, keyed by the peer.
##
## A reply is queued rather than written, because the write happens on the main thread and
## `put_data` blocks until every byte is gone. A client that asked a large question and then
## stopped reading, which is exactly what our own server does when a call times out, leaves that
## write with nowhere to go: the frame never ends, the game freezes, and the listener never
## accepts again, so every later request times out too. One timeout would take the game with it.
var _outgoing: Dictionary = {}
var _port: int = 0
var _enabled: bool = true
var _announcement: String = ""
## Held for as long as the game runs: a Logger the engine has is kept by reference, and one
## that goes away mid-run takes the report with it.
var _errors: GdhErrorReport
## The commands this script answers itself, by the name a request uses.
var _commands: Dictionary = {}
## The addon this game loaded, read once at start: an upgrade rewrites the markers under a running
## game, whose code stays what it loaded, and reading them later would call that code current.
## Empty when the markers cannot be read, as in a copy made by hand.
var _loaded_version: String = _read_marker(VERSION_MARKER)
var _loaded_digest: String = _read_marker(DIGEST_MARKER)
var _profile_received: bool = false
## Whether whatever started this game asked for a profile from its start, read before the variable
## is taken out of the environment.
var _profiled_from_start: bool = false
var _close_asked: bool = false
var _close_frames: int = 0
var _profiler_calibrated: bool = false


func _init() -> void:
	_commands = {
		"ping": _ping,
		"send_profile": _send_profile_now,
		"close_game": _close_game,
	}
	_wait_for_the_profiler()


func _ready() -> void:
	name = "GdharnessRuntime"
	# The TCP control loop runs in _process. With the default PROCESS_MODE_INHERIT it stops
	# while the tree is paused, so the runtime silently goes unreachable and the game cannot
	# even be un-paused over the socket. A debug server has to stay responsive while the game
	# is frozen, to inspect, capture, inject or resume it.
	process_mode = Node.PROCESS_MODE_ALWAYS
	_size_a_windowless_game()
	var watched: int = get_tree().root.tree_exiting.connect(_send_the_profile)
	if watched != OK:
		push_error("gdharness could not watch for the game quitting: %d" % watched)
	if not OS.get_environment(EXIT_NOTES_VARIABLE).is_empty():
		var noted: int = get_tree().root.tree_exited.connect(_note_the_exit)
		if noted != OK:
			push_error("gdharness could not watch for the game's tree ending: %d" % noted)
	_report_errors()
	_start_server()


func _exit_tree() -> void:
	if _errors != null:
		OS.remove_logger(_errors)
		_errors.close()
		_errors = null
	_cleanup()


func _process(_delta: float) -> void:
	if not _enabled or _server == null:
		return
	_frames.note_frame(Time.get_ticks_usec())
	_calibrate_the_profiler()

	# Every connection waiting rather than one a frame: the engine queues eight a game has not taken
	# and refuses the rest, so calls sent together would be refused as if the game were not up.
	while _server.is_connection_available():
		var client: StreamPeerTCP = _server.take_connection()
		if client == null:
			break
		_clients.append(client)
		_send_welcome(client)
		# Out before the request that came with it is read: a request can hold the game in a
		# breakpoint before the frame's drain, and the server, never welcomed, took a game held
		# inside its call for one that had not taken it. A client gone already is dropped below.
		var _welcomed: bool = _drain(client)

	var gone: Array[StreamPeerTCP] = []
	for client: StreamPeerTCP in _clients:
		# A poll that fails is a client that has already gone, which the status check below is
		# about to find. The answer is read so it is not dropped, not because it adds anything.
		var polled: Error = client.poll()
		if polled != OK or client.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			gone.append(client)
			continue
		var available: int = client.get_available_bytes()
		if available > 0:
			var received: Array = client.get_data(available)
			var bytes: PackedByteArray = received[1]
			_receive(client, bytes)
		if not _drain(client):
			gone.append(client)

	for client: StreamPeerTCP in gone:
		_clients.erase(client)
		# Dictionary.erase answers with whether the key was there, and underscore-prefixed locals
		# are how GDScript says an answer is deliberately unwanted: a client that had nothing
		# pending or owed is as forgotten as one that had both.
		var _had_pending: bool = _pending.erase(client)
		var _had_outgoing: bool = _outgoing.erase(client)

	# After the answer to the close has gone out: the close request reaches this node too, which
	# then drops its clients and whatever they were still owed.
	if _close_asked:
		_close_frames += 1
		if _close_frames >= CLOSE_AFTER_FRAMES or _outgoing.values().all(_is_empty):
			_close_asked = false
			_deliver_close()


## Down with the window only when the close is taken. A game that asks before quitting turns
## auto_accept_quit off and decides for itself, and one whose player answered No went on running
## with no runtime and no announcement, so every later call said no game was running. A quit it
## does take ends the tree, which [method _exit_tree] cleans up after.
##
## One line for every notification, and the last this node runs in a frame, after [method _process]:
## a pause that stops in this addon is let go to a breakpoint here and stepped once into the game's
## own script, rather than stepped through the frame a line at a time.
func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST and _takes_the_close():
		_cleanup()


## The script of the module in [param file], compiled at the first call that needs it.
static func _loaded(file: String) -> GDScript:
	return load(ADDON_DIR + file) as GDScript


## The module in [param file], built at its first command with what it is built with.
func _module(file: String) -> Object:
	var made: Object = _modules.get(file)
	if made != null:
		return made
	var script: GDScript = _loaded(file)
	match file:
		QUERIES:
			made = script.new(self, values, _frames)
		TYPING, PAD, TOUCH, ACCESSIBILITY:
			made = script.new(self)
		_:
			made = script.new(self, values)
	_modules[file] = made
	_frames.skip_this_frame()
	return made


## What answers [param command], loading its module if no command has needed it yet, or an invalid
## Callable for a command nothing answers.
func _handler(command: String) -> Callable:
	if _commands.has(command):
		return _commands[command]
	var answered_by: Array = MODULE_COMMANDS.get(command, [])
	if answered_by.is_empty():
		return Callable()
	var file: String = answered_by[0]
	var method: String = answered_by[1]
	return Callable(_module(file), method)


## Every command the runtime answers, its own and the modules', loaded or not.
func _command_names() -> Array:
	return _commands.keys() + MODULE_COMMANDS.keys()


## Gives a game with no window the size the project opens its window at. Measured: a
## headless engine's root viewport is 64 by 64 whatever the project settings or --resolution say, so
## a headless game laid its interface out in 64 pixels, and a button every windowed run shows was
## refused as off screen. The root takes a size set once the autoloads are in the tree, before the
## main scene enters it, and the scene lays out at it from its first frame. A size set at the
## autoload's construction does not hold: the root is a 100 by 100 placeholder then, and the engine
## gives it the 64 by 64 afterwards. A script run is not a game and keeps the viewport its own code
## gives it, and a release build is left as the engine made it.
func _size_a_windowless_game() -> void:
	if DisplayServer.get_name() != "headless" or _script_run() or not OS.is_debug_build():
		return
	var root: Window = get_tree().root
	if Vector2(root.size) != HEADLESS_VIEWPORT:
		return
	root.size = Vector2i(_window_dimension("width", 1152), _window_dimension("height", 648))


## The window's [param axis] as the project opens it: the override when one is set, otherwise the
## viewport's size, whose engine default is [param fallback].
static func _window_dimension(axis: String, fallback: int) -> int:
	var override: int = GdhRead.as_int(
		ProjectSettings.get_setting("display/window/size/window_%s_override" % axis, 0)
	)
	if override > 0:
		return override
	return GdhRead.as_int(
		ProjectSettings.get_setting("display/window/size/viewport_%s" % axis, fallback), fallback
	)


## Holds the game's start until the profiler is on, when whatever started the game asked for a
## profile from its start. The debugger switches the profiler on with a message the game reads only
## on a poll, which comes every [constant POLLS_PER_READ] lines of script, so the main scene's
## _ready could run first: a game played on a macOS runner counted 25 calls of a function called 26
## times, the first of them from _ready. Run at the autoload's construction, before the main scene
## loads.
func _wait_for_the_profiler() -> void:
	if OS.get_environment(PROFILE_FROM_START).is_empty():
		return
	_profiled_from_start = true
	# Read once: a process this game starts inherits its environment and must not wait as well, nor
	# be served as a profiled run where a quiet scene would not be, as a bench's workers are.
	OS.unset_environment(PROFILE_FROM_START)
	if not EngineDebugger.is_active():
		return
	var deadline: int = Time.get_ticks_msec() + PROFILER_WAIT_MS
	while not EngineDebugger.is_profiling("servers"):
		if Time.get_ticks_msec() >= deadline:
			push_warning(
				(
					(
						"gdharness: this game was started to be profiled from its start, and the "
						+ "profiler was not on %d ms later, so what ran before it is not counted"
					)
					% PROFILER_WAIT_MS
				)
			)
			return
		for _poll: int in POLLS_PER_READ:
			EngineDebugger.line_poll()
		OS.delay_msec(1)


## Whether this runtime is listening for gdharness's server. It is not in a release build, a script
## run, a scene the project keeps quiet, an engine `gdharness spread` started, or a game that could
## not have its port, though the node is there in all of them, so ask this rather than whether the
## node exists.
func serving() -> bool:
	return _enabled and _server != null and _server.is_listening()


## Says whether this game restarts as it exits, once the whole tree has gone, so a game's own
## _exit_tree and every autoload's have had their say.
func _note_the_exit() -> void:
	var path: String = OS.get_environment(EXIT_NOTES_VARIABLE).path_join(
		"exit-%d.json" % OS.get_process_id()
	)
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return
	var state: String = JSON.stringify({ "restart": OS.is_restart_on_exit_set() })
	var _written: bool = file.store_string(state)
	file.close()


## A profiled run's totals, sent as the game quits.
##
## The engine sends its script profiler's totals only when the profiler is switched off, and at
## exit it is torn down without being switched off, so a scene that did its work in _ready and
## quit took its whole profile with it, last frame included.
##
## The totals go out on the debugger's own thread, which stops without emptying its queue, so the
## game waits until the debugger says it has read them. A fixed wait of 100 ms lost the totals of
## games quitting under load, whose debugger thread did not get its turn in time.
##
## On the root leaving rather than this node: the root leaves only as the game quits, and after
## every other node's _exit_tree, so what those do is counted. A project that sent this node away
## mid-run had the profiler switched off then, and its run answered as complete with none of the
## frames after it.
##
## The debugger reads in order, so its answer comes once it has read everything the game queued
## before the totals, and a debugger that has fallen behind answers late rather than not at all. A
## debugger gdharness gave this game, the keeper of a run the server started or an editor with the
## gdharness addon, is waited for until it answers. A fixed three seconds lost the totals of a run
## whose first frame named 1536 functions, on a loaded runner that read them slower than that. Any
## other debugger may never answer, and holds the exit for the short wait only.
##
## The debugger is asked once before the profiler goes off as well, so the totals go into an empty
## queue. They name each function no frame did, one message apiece, and with the names of a large
## first frame still queued for a debugger behind on its reading, they did not fit and the engine
## dropped them. One that does not answer that is not asked again, as it would not answer the
## second.
func _send_the_profile() -> void:
	if not (EngineDebugger.is_active() and EngineDebugger.is_profiling("servers")):
		return
	if not EngineDebugger.has_capture(PROFILE_CAPTURE):
		EngineDebugger.register_message_capture(PROFILE_CAPTURE, _on_debugger_message)
	var answers: bool = (
		_profiled_from_start or OS.get_environment(EDITOR_PID_VARIABLE).is_valid_int()
	)
	var waits: int = PROFILE_ANSWERED_MS if answers else PROFILE_CONFIRM_MS
	var drained: bool = _debugger_answered(waits)
	EngineDebugger.profiler_enable("servers", false)
	var confirmed: bool = drained and _debugger_answered(waits)
	EngineDebugger.unregister_message_capture(PROFILE_CAPTURE)
	if not confirmed:
		print(
			(
				(
					"[gdharness] the debugger did not confirm the profiler's totals within %d ms, "
					+ "so the profile may be the frames that arrived without them"
				)
				% waits
			)
		)


## Sends the debugger the message it answers once it has read everything sent before it, and waits
## up to [param waits] ms for the answer. It polls for it since the game's loop is over.
func _debugger_answered(waits: int) -> bool:
	_profile_received = false
	EngineDebugger.send_message(PROFILE_SENT, [])
	var deadline: int = Time.get_ticks_msec() + waits
	while not _profile_received and Time.get_ticks_msec() < deadline:
		for _poll: int in POLLS_PER_READ:
			EngineDebugger.line_poll()
		OS.delay_msec(5)
	return _profile_received


## The totals sent now, for a stop that is about to end the game without letting it quit: ended by
## its process, a game takes the totals with it, and every stopped profile came back as the frames
## summed. Nothing of the game's own runs, which quitting the tree would have done.
func _send_profile_now(_params: Dictionary) -> Dictionary:
	if not (EngineDebugger.is_active() and EngineDebugger.is_profiling("servers")):
		return { "sent": false }
	_send_the_profile()
	return { "sent": true, "confirmed": _profile_received }


## What the script profiler costs per call in this game, measured once each time it is switched on.
##
## The profiler times every call it counts, and that bookkeeping lands in the self time of the
## function called, so a function doing almost nothing, called six hundred thousand times, can read
## as a second of its own that is mostly the profiler's. So an empty function
## is called here [constant PROFILER_PROBE_CALLS] times while the profiler watches, under the load
## the game is under, and the server reads its row as the cost of one call.
func _calibrate_the_profiler() -> void:
	var profiling: bool = EngineDebugger.is_active() and EngineDebugger.is_profiling("servers")
	if not profiling:
		_profiler_calibrated = false
		return
	if _profiler_calibrated:
		return
	_profiler_calibrated = true
	for _call: int in PROFILER_PROBE_CALLS:
		_profiler_probe()


## Does nothing, so its time under the profiler is the profiler's own. Kept in step with
## `PROFILER_PROBE` in src/script-profile.ts.
func _profiler_probe() -> void:
	pass


func _on_debugger_message(message: String, _data: Array) -> bool:
	if PROFILE_CAPTURE + ":" + message == PROFILE_RECEIVED:
		_profile_received = true
		return true
	return false


## The engine's error reports, written to a file for the server, for a game the editor plays, and
## its prints as well from the line announcing the runtime on.
##
## Only for one the editor plays: a game the server starts itself has its stderr in the run's
## transcript already, and a game somebody runs from a terminal has it on the terminal. The
## editor's game prints to the editor's stderr, which nobody reads, and the editor's debug
## adapter relays what the game prints and not what it reports. Before the server starts, so
## a port that cannot be bound is reported there too, and whether or not the server comes up.
func _report_errors() -> void:
	if not OS.get_environment(EDITOR_PID_VARIABLE).is_valid_int():
		return
	var directory: String = _announcement_directory()
	var made: Error = DirAccess.make_dir_recursive_absolute(directory)
	if made != OK and made != ERR_ALREADY_EXISTS:
		return
	_errors = GdhErrorReport.new(directory.path_join(ERROR_REPORT_NAME % OS.get_process_id()))
	OS.add_logger(_errors)


## Hands the socket as much of what it is owed as it will take, and says whether it is still worth
## talking to. Reading comes first in the frame, so a client that asked and left is noticed here
## rather than blocking on a write that can never finish.
func _drain(client: StreamPeerTCP) -> bool:
	var owed: PackedByteArray = _outgoing.get(client, PackedByteArray())
	if owed.is_empty():
		return true
	var sent: Array = client.put_partial_data(owed)
	if sent[0] != OK:
		return false
	_outgoing[client] = owed.slice(GdhRead.as_int(sent[1]))
	return true


## Bytes arrive in whatever pieces the socket makes of them, so a request is only handled once
## its newline has arrived, and two that arrive together are handled one after the other.
func _receive(client: StreamPeerTCP, bytes: PackedByteArray) -> void:
	var buffered: PackedByteArray = _pending.get(client, PackedByteArray())
	buffered.append_array(bytes)
	var start: int = 0
	var newline: int = buffered.find(10, start)
	while newline != -1:
		var line: String = buffered.slice(start, newline).get_string_from_utf8().strip_edges()
		start = newline + 1
		newline = buffered.find(10, start)
		if not line.is_empty():
			# Through a Callable and not awaited: a request that waits on the game must not stop
			# the others being read, and the analyser would otherwise insist on the await.
			_handle_message.call(client, line)
	_pending[client] = buffered.slice(start)


func _start_server() -> void:
	# The command set includes call_method, set_property and input injection, none of it
	# authenticated, so a release export must not serve it.
	if not OS.is_debug_build():
		_enabled = false
		return

	# And a script run has nothing to serve. Autoloads come up for `godot -s` as well, so a test
	# tier or a batch tool binds a loopback port and writes an announcement under the project's
	# own path: a gate that starts sixteen engines at once announces sixteen games that are not
	# games, and a client asking the runtime anything while they run can be answered by whichever
	# of them replies first. Measured on two projects before it was written here.
	if (
		_script_run()
		and not GdhRead.as_bool(ProjectSettings.get_setting(SCRIPT_RUNS_SETTING, false))
	):
		_enabled = false
		return

	# Nor a scene the project says is not the game. A bench is handed to the engine as a scene, the
	# way a screen is, so it announced as the game for as long as it ran, and so did every worker
	# engine it started, all under the project's own path. One started to be profiled from its start
	# is served all the same, since only this addon hands the totals back as it quits.
	var prefixes: Variant = ProjectSettings.get_setting(QUIET_SCENES_SETTING, PackedStringArray())
	if not _profiled_from_start and not quiet_scene_in(OS.get_cmdline_args(), prefixes).is_empty():
		_enabled = false
		return

	# Nor an engine `gdharness spread` started, whatever folder its scene is in: its workers and the
	# engine gathering their outcomes play a bench rather than the game, several at once.
	if spread_engine(OS.get_cmdline_user_args()):
		_enabled = false
		return

	_server = TCPServer.new()
	# listen() defaults bind_address to "*", which exposes the game to the whole network.
	var bind_address: String = str(
		ProjectSettings.get_setting(BIND_ADDRESS_SETTING, DEFAULT_BIND_ADDRESS)
	)
	var wanted_port: int = GdhRead.as_int(ProjectSettings.get_setting(PORT_SETTING, 0))
	var error: Error = _server.listen(wanted_port, bind_address)
	if error != OK:
		# A warning, not an error: callers treat any ERROR line on stderr as a failed
		# operation, and a game without a runtime server is a handled condition.
		push_warning(
			(
				"[gdharness] runtime port %d is unavailable (%s), running without a server"
				% [wanted_port, error]
			)
		)
		_enabled = false
		return

	_port = _server.get_local_port()
	_announce(bind_address)
	var listening: String = (
		"[gdharness] runtime listening on %s:%d, announced at %s"
		% [bind_address, _port, _announcement]
	)
	# The line the server tells the two streams apart by: it takes the prints before it from the
	# debug adapter and everything from it on from the file, which has it first. After the
	# announcement, so a server reading the line finds the file beside it.
	if _errors != null:
		_errors.take_the_console(listening)
	else:
		print(listening)


## The scene [param given] names for the engine to run, as a `res://` path, when it lies under one
## of [param prefixes], and otherwise empty. The engine takes any bare argument ending in a scene's
## extension for the scene, relative to the project or absolute, so each is read as it would.
static func quiet_scene_in(given: PackedStringArray, prefixes: Variant) -> String:
	# A PackedStringArray as project.godot writes one, or an Array of strings as a hand might.
	var folders: PackedStringArray = []
	if prefixes is PackedStringArray:
		folders = prefixes
	elif prefixes is Array:
		var listed: Array = prefixes
		for prefix: Variant in listed:
			if prefix is String:
				var _kept: bool = folders.append(str(prefix))
	for argument: String in given:
		if (
			argument.begins_with("-")
			or not SCENE_EXTENSIONS.has(argument.get_extension().to_lower())
		):
			continue
		var scene: String = ProjectSettings.localize_path(argument)
		for folder: String in folders:
			if not folder.is_empty() and scene.begins_with(folder):
				return scene
	return ""


## Whether [param given], the engine's user arguments, are those `gdharness spread` hands its
## engines, which the tests addon's GdhShare reads.
static func spread_engine(given: PackedStringArray) -> bool:
	for argument: String in given:
		if argument.begins_with(SPREAD_ARGUMENTS):
			return true
	return false


## Whether the engine was told to run a script rather than the game.
func _script_run() -> bool:
	var given: PackedStringArray = OS.get_cmdline_args()
	for flag: String in SCRIPT_FLAGS:
		if given.has(flag):
			return true
	return false


## Where the announcement goes. The server derives the same path with the same precedence, so
## the two only meet if this stays in step with `runtimeDirectory` in src/runtime-client.ts.
func _announcement_directory() -> String:
	var explicit: String = OS.get_environment("GDHARNESS_RUNTIME_DIR")
	if not explicit.is_empty():
		return explicit
	var per_user: String = OS.get_environment("XDG_RUNTIME_DIR")
	var base: String = per_user if not per_user.is_empty() else OS.get_temp_dir()
	return base.path_join("gdharness")


func _announce(bind_address: String) -> void:
	var directory: String = _announcement_directory()
	var made: Error = DirAccess.make_dir_recursive_absolute(directory)
	if made != OK and made != ERR_ALREADY_EXISTS:
		push_warning(
			(
				"[gdharness] cannot create %s (%s); the server will not find this game"
				% [directory, made]
			)
		)
		return
	var path: String = directory.path_join("runtime-%d.json" % OS.get_process_id())
	# Written whole under a name no server reads and moved into place, so no look ever meets
	# the file empty: a server sweeping the directory between an open and a write took the
	# announcement for a dead game's leftover, and the directory is shared by every server on
	# the machine.
	var staged: String = path + ".tmp"
	var file: FileAccess = FileAccess.open(staged, FileAccess.WRITE)
	if file == null:
		push_warning(
			(
				"[gdharness] cannot write %s (%s); the server will not find this game"
				% [staged, FileAccess.get_open_error()]
			)
		)
		return
	var written: bool = file.store_string(JSON.stringify(_identity(bind_address)))
	file.close()
	if not written:
		push_warning("[gdharness] cannot write %s; the server will not find this game" % staged)
		_unstage(staged)
		return
	var moved: Error = DirAccess.rename_absolute(staged, path)
	if moved != OK:
		push_warning(
			(
				"[gdharness] cannot move %s to %s (%s); the server will not find this game"
				% [staged, path, moved]
			)
		)
		_unstage(staged)
		return
	_announcement = path


## Takes a staged announcement down after a write or a move that failed. The answer is taken
## rather than dropped, since these scripts compile under the game's own warning levels. A
## staged file that will not go either is nothing any server reads.
func _unstage(staged: String) -> void:
	var _removed: Error = DirAccess.remove_absolute(staged)


## What the announcement file and the welcome both carry: enough to pick this game out of
## several and to know whether the server speaks its protocol.
func _identity(bind_address: String) -> Dictionary:
	var identity: Dictionary = {
		"protocol": PROTOCOL,
		"pid": OS.get_process_id(),
		"port": _port,
		"address": bind_address,
		"project":
		{
			"name": str(ProjectSettings.get_setting("application/config/name", "")),
			"path": ProjectSettings.globalize_path("res://").rstrip("/"),
		},
		"godot": Engine.get_version_info().get("string", ""),
		# Where user:// is for this run, which only the engine can say: it follows the project's
		# name and settings and the environment the run was started in.
		"user_dir": OS.get_user_data_dir(),
		"addon_version": _loaded_version,
		"addon_digest": _loaded_digest,
	}
	var played_by: String = OS.get_environment(EDITOR_PID_VARIABLE)
	if played_by.is_valid_int():
		identity["editor_pid"] = played_by.to_int()
	return identity


static func _read_marker(path: String) -> String:
	if not FileAccess.file_exists(path):
		return ""
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if file == null:
		return ""
	var text: String = file.get_as_text().strip_edges()
	file.close()
	return text


func _send_welcome(client: StreamPeerTCP) -> void:
	var welcome: Dictionary = _identity(
		str(ProjectSettings.get_setting(BIND_ADDRESS_SETTING, DEFAULT_BIND_ADDRESS))
	)
	welcome["type"] = "welcome"
	welcome["commands"] = _command_names()
	_send_response(client, welcome)


func _handle_message(client: StreamPeerTCP, line: String) -> void:
	var json: JSON = JSON.new()
	if json.parse(line) != OK:
		_send_error(client, null, "Invalid JSON: " + json.get_error_message())
		return

	var message: Variant = json.get_data()
	if not message is Dictionary:
		_send_error(client, null, "A request must be an object")
		return

	var fields: Dictionary = message
	var request_id: Variant = fields.get("id", null)
	if request_id == null:
		_send_error(client, null, "A request must carry an id")
		return

	var command: String = str(fields.get("command", ""))
	var params: Variant = fields.get("params", {})
	if not params is Dictionary:
		_send_error(client, request_id, "params must be an object")
		return
	var arguments: Dictionary = params

	# A command that waits on the game (a frame, a signal, a condition) suspends here and answers
	# when it is done, while _process keeps serving the other clients in the meantime. A client
	# that hung up while its command waited is simply not written to.
	var result: Dictionary = await _execute_command(command, arguments)
	result["id"] = request_id
	if client.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_send_response(client, result)


func _execute_command(command: String, params: Dictionary) -> Dictionary:
	var handler: Callable = _handler(command)
	if not handler.is_valid():
		return {
			"type": "error",
			"message": "Unknown command: %s. Commands: %s" % [command, ", ".join(_command_names())],
		}
	# Only a waits module already loaded can have a trace running to record the call in.
	var waits: Object = _modules.get(WAITS)
	if waits != null:
		var _seen: Variant = waits.call(&"saw_call", command, params)
	var answer: Variant = await handler.call(params)
	return answer


func _ping(_params: Dictionary) -> Dictionary:
	return { "type": "pong", "timestamp": Time.get_unix_time_from_system() }


## The game asked to close, as a player's close asks it: answered at once and delivered once the
## answer has gone out. `acceptsQuit` says whether the tree quits on the request by itself. A game
## that turned that off decides for itself, and may ask the player first.
func _close_game(_params: Dictionary) -> Dictionary:
	_close_asked = true
	_close_frames = 0
	return { "type": "closing", "acceptsQuit": get_tree().auto_accept_quit }


## What a player's close does: the close request reaches every node, and then the root window says
## it was asked to close, which the tree answers by quitting when it accepts quits. So the game's
## own close runs, a crash guard's included, where a stop that ended the process ran none of it.
func _deliver_close() -> void:
	var root: Window = get_tree().root
	root.propagate_notification(NOTIFICATION_WM_CLOSE_REQUEST)
	root.close_requested.emit()


static func _is_empty(owed: Variant) -> bool:
	var bytes: PackedByteArray = owed
	return bytes.is_empty()


## One JSON object and a newline, queued for [method _drain] rather than written here.
##
## Raw bytes rather than put_utf8_string, which would prefix them with a length the other side is
## not expecting, and queued rather than put_data, which blocks the frame until the socket has
## taken the lot: see [member _outgoing].
func _send_response(client: StreamPeerTCP, data: Dictionary) -> void:
	var owed: PackedByteArray = _outgoing.get(client, PackedByteArray())
	# Keys left in the order they were put in: sorted, a map read came back in another order than
	# its keys() and the game iterate it in.
	owed.append_array((JSON.stringify(data, "", false) + "\n").to_utf8_buffer())
	_outgoing[client] = owed


## A request that could not be read far enough to find its id is answered with a null one.
func _send_error(client: StreamPeerTCP, request_id: Variant, message: String) -> void:
	_send_response(client, { "type": "error", "message": message, "id": request_id })


func _takes_the_close() -> bool:
	return not is_inside_tree() or get_tree().auto_accept_quit


func _cleanup() -> void:
	for client: StreamPeerTCP in _clients:
		client.disconnect_from_host()
	_clients.clear()
	_pending.clear()
	_outgoing.clear()

	if _server:
		_server.stop()
		_server = null

	# The announcement is what tells the server this game exists, so it goes before the
	# process does. A crash leaves it behind, and the server drops one whose process is gone.
	if not _announcement.is_empty():
		var removed: Error = DirAccess.remove_absolute(_announcement)
		if removed != OK:
			push_warning(
				(
					"[gdharness] cannot remove %s; the server will find a game that is gone"
					% _announcement
				)
			)
		_announcement = ""
