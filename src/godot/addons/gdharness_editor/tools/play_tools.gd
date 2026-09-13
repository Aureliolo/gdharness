@tool
extends Node

## Running the game from the editor, so the editor is the one debugging it.
##
## A game started as its own process is a game nothing is attached to: the editor's debug adapter
## has no session for it, so breakpoints, stepping and the stack are all unreachable. Asking the
## editor to play means the debugger it owns is holding the game, which is what makes the debug
## tools answer at all.

## What the display server calls itself when the engine was started with no display at all.
const HEADLESS_DISPLAY: String = "headless"

var _editor_plugin: EditorPlugin = null


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


func play_scene(args: Dictionary) -> Dictionary:
	var scene_path: String = str(args.get("scenePath", ""))

	if EditorInterface.is_playing_scene():
		EditorInterface.stop_playing_scene()

	if scene_path.is_empty():
		EditorInterface.play_main_scene()
	else:
		var full_path: String = scene_path if scene_path.begins_with("res://") else "res://" + scene_path
		if not ResourceLoader.exists(full_path, "PackedScene"):
			return {"ok": false, "error": "No scene at " + full_path}
		EditorInterface.play_custom_scene(full_path)

	return {
		"ok": true,
		"playing": EditorInterface.is_playing_scene(),
		"scenePath": EditorInterface.get_playing_scene()
	}


func stop_playing(_args: Dictionary) -> Dictionary:
	var was_playing: bool = EditorInterface.is_playing_scene()
	if was_playing:
		EditorInterface.stop_playing_scene()
	return {"ok": true, "wasPlaying": was_playing, "playing": EditorInterface.is_playing_scene()}


## Restarts the editor, which is how a replaced addon is picked up.
##
## An install writes the new files under a running editor, which goes on serving the code it read
## at startup: the version it reports and the tools it answers are the old ones until it comes
## back. Scenes are saved on the way out, because the alternative is throwing away somebody's
## unsaved work to pick up a version.
func restart_editor(_args: Dictionary) -> Dictionary:
	# Only an editor with a window, because only that one can come back as itself. The engine
	# hands back none of the arguments it consumed: OS.get_cmdline_args() in an editor started
	# with --headless --path <project> --lsp-port <n> answers with none of them, so a headless
	# editor restarted by anybody comes up as a project manager with no project, holding the
	# desktop of whoever was unlucky enough to be watching. A windowed editor was started with
	# none of that, so Godot's own restart brings back the same editor on the same project.
	#
	# Asked of the display server rather than of the window, because window_can_draw answers no
	# for a window that is merely minimised. An editor sitting in the taskbar was told it was
	# headless and refused to restart, which is exactly the editor somebody wants restarted after
	# an upgrade: nobody minimises a window they are watching.
	if DisplayServer.get_name() == HEADLESS_DISPLAY:
		return {
			"ok": false,
			"error":
			(
				"This editor is headless, and the engine does not hand back the arguments it was "
				+ "started with, so nothing can bring it back as the editor it is. Start it again "
				+ "yourself."
			)
		}

	if EditorInterface.is_playing_scene():
		EditorInterface.stop_playing_scene()

	EditorInterface.save_all_scenes()

	# Deferred so this answer is on its way out before the editor goes.
	EditorInterface.restart_editor.call_deferred(true)

	return {"ok": true, "restarting": true, "saved": true}


func playing_status(_args: Dictionary) -> Dictionary:
	var playing: bool = EditorInterface.is_playing_scene()
	return {
		"ok": true, "playing": playing, "scenePath": EditorInterface.get_playing_scene() if playing else ""
	}
