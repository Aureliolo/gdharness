@tool
extends EditorPlugin
## The editor half of gdharness: a client that holds a socket to the server and an executor
## that does what the server asks, with a label in the toolbar saying whether the two are
## connected.

const GdhBridgeClient = preload("bridge_client.gd")
const GdhToolExecutor = preload("tool_executor.gd")
const GdhReleaseExport = preload("release_export.gd")
## The tools answered while the editor scans or imports, because none of them saves a file: the
## ones a caller waits on a scan with, and the ones that only read or stop a played game.
const ANSWERED_WHILE_SCANNING: Array[String] = [
	"scan_status",
	"rescan_filesystem",
	"reimport_files",
	"playing_status",
	"stop_playing",
	"profile_read",
]
## The tools answered inside a task of the editor's progress dialog, because none of them writes
## anything the editor's task could be in the middle of.
const ANSWERED_DURING_A_TASK: Array[String] = [
	"scan_status",
	"playing_status",
	"stop_playing",
	"profile_read",
]

var _client: GdhBridgeClient
## The editor's progress dialog, which Godot keeps for the editor's whole life and exposes no other
## way. Looked for once, and again only if it has gone.
var _progress: Node = null
var _progress_sought: bool = false
var _tool_executor: GdhToolExecutor
var _status_label: Label
var _release_export: GdhReleaseExport


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
## Every call waits out a capture, which shows a scene for frames before it reads the view.
##
## A task in the editor's progress dialog runs frames of the editor from inside itself at every
## step, so a call handled then runs in the middle of that task. A save there asked for the script
## classes again while the editor was registering them, and the two registrations walked one list,
## which crashed the editor at its next scan.
func turned_away(tool_name: String) -> bool:
	if _tool_executor != null and _tool_executor.capturing():
		return true
	if not ANSWERED_DURING_A_TASK.has(tool_name) and _in_a_task():
		return true
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	return (
		not ANSWERED_WHILE_SCANNING.has(tool_name)
		and (filesystem.is_scanning() or filesystem.is_importing())
	)


## Whether the editor's progress dialog is showing, which it does for as long as a task is open.
func _in_a_task() -> bool:
	if _progress != null and not is_instance_valid(_progress):
		_progress = null
		_progress_sought = false
	if not _progress_sought:
		_progress_sought = true
		_progress = _found_progress(get_tree().root)
	return _progress is CanvasItem and (_progress as CanvasItem).visible


static func _found_progress(top: Node) -> Node:
	var pending: Array[Node] = [top]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		if node.is_class("ProgressDialog"):
			return node
		pending.append_array(node.get_children(true))
	return null


func _on_tool_requested(request_id: String, tool_name: String, args: Dictionary) -> void:
	if _tool_executor == null or _client == null:
		return

	# Turned away rather than held, so the server asks again: a call held here could run after the
	# server had given up on it.
	if turned_away(tool_name):
		_client.send_busy(request_id, tool_name)
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
