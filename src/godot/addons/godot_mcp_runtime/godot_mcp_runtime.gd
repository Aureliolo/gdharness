@tool
extends EditorPlugin

## Registers the runtime autoload, which is the whole of what the game side of gdharness needs
## from the editor: with the plugin enabled, every run of the project carries the server that
## the runtime tools talk to.

const AUTOLOAD_NAME: String = "MCPRuntime"
const AUTOLOAD_PATH: String = "res://addons/godot_mcp_runtime/mcp_runtime_autoload.gd"


func _enter_tree() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)


func _exit_tree() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
