@tool
extends EditorPlugin
## The editor half of gdharness: a client that holds a socket to the server and an executor
## that does what the server asks, with a label in the toolbar saying whether the two are
## connected.

const GdhBridgeClient = preload("bridge_client.gd")
const GdhToolExecutor = preload("tool_executor.gd")
const GdhReleaseExport = preload("release_export.gd")
const GdhSceneFile = preload("scene_file.gd")
const GdhRead = preload("reading.gd")
## The tools answered while the editor scans or imports, because none of them saves a file: the
## ones a caller waits on a scan with, and the ones that only read or stop a played game.
const ANSWERED_WHILE_SCANNING: Array[String] = [
	"scan_status",
	"rescan_filesystem",
	"reimport_files",
	"playing_status",
	"stop_playing",
	"profile_read",
	"error_breaks",
]
## The tools answered inside a task of the editor's progress dialog, because none of them writes
## anything the editor's task could be in the middle of.
const ANSWERED_DURING_A_TASK: Array[String] = [
	"scan_status",
	"playing_status",
	"stop_playing",
	"profile_read",
	"error_breaks",
]
## What an editor opened to quit once a process has gone carries after `--`, with that pid after it.
## Kept in step with `UNTIL_MARK` in src/launch.ts.
const UNTIL_MARK: String = "--gdharness-until="
## Where the holder of such an editor asks it to save and quit, a file named for its pid. Kept in
## step with `QUITS_FOLDER` in src/editor-open.ts.
const QUITS_FOLDER: String = "res://.godot/gdharness-editor-quits/"
## How often such an editor looks for the request, in seconds.
const QUIT_LOOK_S: float = 1.0
## The project setting holding the minutes a hidden editor waits with no call before it quits, 0
## for never. Kept in step with `IDLE_CLOSE_SETTING` in src/idle-close.ts.
const IDLE_SETTING: String = "gdharness/editor/idle_close_minutes"
## The minutes when the setting is absent. Kept in step with `IDLE_CLOSE_MINUTES` there.
const IDLE_MINUTES: float = 10.0
## Where it says, as it quits, how it was started and what it had open, for the next server whose
## call needs an editor to open it again. Kept in step with `IDLE_RECORD` in src/idle-close.ts.
const IDLE_RECORD: String = "res://.godot/gdharness-editor-idle.json"
## The most seconds between two looks at whether it has gone unused.
const IDLE_LOOK_S: float = 30.0

var _client: GdhBridgeClient
var _tool_executor: GdhToolExecutor
var _status_label: Label
var _release_export: GdhReleaseExport
var _quit_look: Timer
var _loaded_at: int = 0
var _idle_look: Timer
## Set once it has said it quits as unused, from when every call is answered as closing.
var _closing: bool = false


func _enter_tree() -> void:
	_release_export = GdhReleaseExport.new()
	add_export_plugin(_release_export)

	_client = GdhBridgeClient.new()
	_client.name = "GdharnessBridgeClient"
	add_child(_client)

	_tool_executor = GdhToolExecutor.new()
	_tool_executor.name = "GdharnessToolExecutor"
	add_child(_tool_executor)
	_tool_executor.set_editor_plugin(self)

	_listen(_client.connected, _on_connected)
	_listen(_client.disconnected, _on_disconnected)
	_listen(_client.tool_requested, _on_tool_requested)

	_setup_status_indicator()
	_client.connect_to_server()
	_look_for_a_quit_request()
	_look_for_idleness()


func _exit_tree() -> void:
	if _release_export:
		remove_export_plugin(_release_export)
		_release_export = null

	if _client:
		if _client.connected.is_connected(_on_connected):
			_client.connected.disconnect(_on_connected)
		if _client.disconnected.is_connected(_on_disconnected):
			_client.disconnected.disconnect(_on_disconnected)
		if _client.tool_requested.is_connected(_on_tool_requested):
			_client.tool_requested.disconnect(_on_tool_requested)
		_client.disconnect_from_server()
		_client.queue_free()
		_client = null

	if _tool_executor:
		_tool_executor.queue_free()
		_tool_executor = null

	if _status_label:
		remove_control_from_container(CONTAINER_TOOLBAR, _status_label)
		_status_label.queue_free()
		_status_label = null


## Looks for its holder's request once a second, in an editor opened to quit once a process has
## gone. Godot cannot watch that process itself, since `OS.is_process_running` answers false for any
## pid it did not start, so a gdharness holder outside the editor watches it and writes the request.
func _look_for_a_quit_request() -> void:
	var held: bool = false
	for arg: String in OS.get_cmdline_user_args():
		held = held or arg.begins_with(UNTIL_MARK)
	if not held:
		return
	_loaded_at = int(Time.get_unix_time_from_system())
	_quit_look = Timer.new()
	_quit_look.wait_time = QUIT_LOOK_S
	_quit_look.autostart = true
	_listen(_quit_look.timeout, _on_quit_look)
	add_child(_quit_look)


## Saves and quits on a request written since this addon loaded, as quit_editor does. One older
## than that was written for an earlier process with this pid. Not while the editor scans, imports
## or runs a task, which every save waits out.
func _on_quit_look() -> void:
	var request: String = ProjectSettings.globalize_path(QUITS_FOLDER + str(OS.get_process_id()))
	if not FileAccess.file_exists(request) or FileAccess.get_modified_time(request) < _loaded_at:
		return
	if turned_away("quit_editor"):
		return
	_quit_look.stop()
	var answer: Dictionary = await _tool_executor.execute_tool("quit_editor", {})
	if answer.get("ok", false) != true:
		push_warning(
			"gdharness: the process holding this editor has gone, and it stays open: %s"
			% str(answer.get("error", ""))
		)


## Looks now and then at whether a hidden editor has gone unused, so one nobody calls frees its
## memory. Nobody can be working in a hidden editor, and a visible one is left to whoever sees it.
func _look_for_idleness() -> void:
	var seconds: float = _idle_seconds()
	if not GdhBridgeClient.is_hidden() or seconds <= 0.0:
		return
	_idle_look = Timer.new()
	_idle_look.wait_time = clampf(seconds / 4.0, 1.0, IDLE_LOOK_S)
	_idle_look.autostart = true
	_listen(_idle_look.timeout, _on_idle_look)
	add_child(_idle_look)


## The seconds of [constant IDLE_SETTING], or of [constant IDLE_MINUTES] when it holds no number.
func _idle_seconds() -> float:
	var minutes: Variant = ProjectSettings.get_setting(IDLE_SETTING, IDLE_MINUTES)
	if minutes is int or minutes is float:
		return GdhRead.as_float(minutes) * 60.0
	return IDLE_MINUTES * 60.0


## Quits once no server has called for the setting's minutes, as quit_editor does, after writing
## [constant IDLE_RECORD]. Not while a scene holds unsaved changes, a game plays, or the editor
## scans, imports or runs a task.
func _on_idle_look() -> void:
	var seconds: float = _idle_seconds()
	if _closing or _client == null or seconds <= 0.0:
		return
	if Time.get_unix_time_from_system() - _client.last_heard < seconds:
		return
	if (
		EditorInterface.is_playing_scene()
		or not EditorInterface.get_unsaved_scenes().is_empty()
		or turned_away("quit_editor")
	):
		return
	var record: Dictionary = {
		"pid": OS.get_process_id(),
		"closedAt": Time.get_datetime_string_from_system(true) + "Z",
		"idleMinutes": seconds / 60.0,
		"arguments": Array(OS.get_cmdline_args()) + ["--"] + Array(OS.get_cmdline_user_args()),
		"scenes": Array(EditorInterface.get_open_scenes()),
	}
	var file: FileAccess = FileAccess.open(IDLE_RECORD, FileAccess.WRITE)
	if file == null:
		push_warning(
			(
				"gdharness: this hidden editor went unused and stays open, since %s could not be "
				+ "written: %s"
			)
			% [IDLE_RECORD, error_string(FileAccess.get_open_error())]
		)
		return
	if not file.store_string(JSON.stringify(record)):
		push_warning(
			"gdharness: this hidden editor went unused and stays open, since %s was not written"
			% IDLE_RECORD
		)
		file.close()
		return
	file.close()
	_closing = true
	_idle_look.stop()
	var answer: Dictionary = await _tool_executor.execute_tool("quit_editor", {})
	if answer.get("ok", false) != true:
		_closing = false
		var removed: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(IDLE_RECORD))
		if removed != OK:
			push_error("gdharness: could not remove %s: %s" % [IDLE_RECORD, error_string(removed)])
		_idle_look.start()
		push_warning(
			"gdharness: this hidden editor went unused and stays open: %s"
			% str(answer.get("error", ""))
		)


# A failed connect is a mistake in this plugin rather than anything the editor did, so it goes to
# the error stream instead of being dropped: a project holding return_value_discarded at error level
# refuses to compile a script that throws the answer away.
func _listen(source: Signal, handler: Callable) -> void:
	# int rather than Error: Signal.connect answers with a plain int, where Object.connect answers
	# with the enum, and a project holding int_as_enum_without_cast at error level refuses the
	# assignment that conflates them.
	var joined: int = source.connect(handler)
	if joined != OK:
		push_error("gdharness: could not listen to " + source.get_name())


func _setup_status_indicator() -> void:
	_status_label = Label.new()
	_status_label.text = "gdharness: connecting"
	_status_label.add_theme_color_override("font_color", Color.YELLOW)
	_status_label.add_theme_font_size_override("font_size", 12)
	add_control_to_container(CONTAINER_TOOLBAR, _status_label)


func _on_connected() -> void:
	if _status_label:
		_status_label.text = "gdharness: connected"
		_status_label.add_theme_color_override("font_color", Color.GREEN)


func _on_disconnected() -> void:
	if _status_label:
		_status_label.text = "gdharness: disconnected"
		_status_label.add_theme_color_override("font_color", Color.RED)


## Whether [param tool_name] waits for the editor to finish scanning or importing. A save during a
## scan updates the file list the scan's thread is writing out (see SceneFile.scan_later), and an
## import can run frames of the editor from inside itself, the one handling this call among them.
## Every call waits out a capture or a save that holds a scene in front for frames.
##
## A task in the editor's progress dialog runs frames of the editor from inside itself at every
## step, so a call handled then runs in the middle of that task. A save there asked for the script
## classes again while the editor was registering them, and the two registrations walked one list,
## which crashed the editor at its next scan.
func turned_away(tool_name: String) -> bool:
	if _tool_executor != null and not _tool_executor.showing().is_empty():
		return true
	if not ANSWERED_DURING_A_TASK.has(tool_name) and GdhSceneFile.in_a_task():
		return true
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	return (
		not ANSWERED_WHILE_SCANNING.has(tool_name)
		and (GdhSceneFile.scan_unfinished(filesystem) or filesystem.is_importing())
	)


## What the editor is doing that turns calls away, and a mark that changes as it gets on with it,
## as [what, mark]. The server keeps asking while the mark changes: registering forty classes in a
## hidden editor took over thirty seconds, every one of them a step.
func busy_with() -> Array[String]:
	if _tool_executor != null and not _tool_executor.showing().is_empty():
		return [_tool_executor.showing(), ""]
	var labels: Array[String] = GdhSceneFile.task_labels()
	if not labels.is_empty():
		return ["running its task \"%s\"" % labels[0].trim_suffix("..."), "\n".join(labels)]
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	if filesystem.is_importing():
		return ["importing its files", ""]
	return ["scanning its files", str(filesystem.get_scanning_progress())]


func _on_tool_requested(request_id: String, tool_name: String, args: Dictionary) -> void:
	if _tool_executor == null or _client == null:
		return

	if _closing:
		_client.send_closing(request_id, tool_name)
		return

	# Turned away rather than held, so the server asks again: a call held here could run after the
	# server had given up on it.
	if turned_away(tool_name):
		var busy: Array[String] = busy_with()
		_client.send_busy(request_id, tool_name, busy[0], busy[1])
		return

	var result: Dictionary = await _tool_executor.execute_tool(tool_name, args)
	var success: bool = result.get("ok", false)

	if success:
		var payload: Dictionary = result.duplicate(true)
		if not payload.erase("ok"):
			push_error("gdharness: a tool answered ok without an ok field to remove")
		_client.send_tool_result(request_id, true, payload, "")
	else:
		_client.send_tool_result(request_id, false, null, str(result.get("error", "Unknown error")))
