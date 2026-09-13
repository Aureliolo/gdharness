@tool
extends EditorPlugin

## The editor half of gdharness: a client that holds a socket to the server and an executor
## that does what the server asks, with a label in the toolbar saying whether the two are
## connected.

const BridgeClient = preload("bridge_client.gd")
const ToolExecutor = preload("tool_executor.gd")

var _client: BridgeClient
var _tool_executor: ToolExecutor
var _status_label: Label


func _enter_tree() -> void:
	_client = BridgeClient.new()
	_client.name = "GdharnessBridgeClient"
	add_child(_client)

	_tool_executor = ToolExecutor.new()
	_tool_executor.name = "GdharnessToolExecutor"
	add_child(_tool_executor)
	_tool_executor.set_editor_plugin(self)

	_client.connected.connect(_on_connected)
	_client.disconnected.connect(_on_disconnected)
	_client.tool_requested.connect(_on_tool_requested)

	_setup_status_indicator()
	_client.connect_to_server()


func _exit_tree() -> void:
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


func _on_tool_requested(request_id: String, tool_name: String, args: Dictionary) -> void:
	if _tool_executor == null or _client == null:
		return

	var result: Dictionary = _tool_executor.execute_tool(tool_name, args)
	var success: bool = result.get("ok", false)

	if success:
		var payload: Dictionary = result.duplicate(true)
		payload.erase("ok")
		_client.send_tool_result(request_id, true, payload, "")
	else:
		_client.send_tool_result(request_id, false, null, str(result.get("error", "Unknown error")))
