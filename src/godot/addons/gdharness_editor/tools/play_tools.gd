@tool
extends Node

## Running the game from the editor, so the editor is the one debugging it.
##
## A game started as its own process is a game nothing is attached to: the editor's debug adapter
## has no session for it, so breakpoints, stepping and the stack are all unreachable. Asking the
## editor to play means the debugger it owns is holding the game, which is what makes the debug
## tools answer at all.

## What the display server calls itself when the engine was started with no display at all.
const Read = preload("../reading.gd")

const HEADLESS_DISPLAY: String = "headless"
## Where Godot keeps the port its own debugger listens on for a game it is playing. One setting
## for every editor on the machine, and bound only while a game runs.
const DEBUGGER_SETTING: String = "network/debug/remote_port"
const LOOPBACK: String = "127.0.0.1"

var _editor_plugin: EditorPlugin = null

## Which play this is, counted up for every one the editor starts, whoever starts it. What a server
## writes about a play is kept on disk after it, and the editor saying it is playing does not say
## which play: a server picking a play back up read the console of an earlier one as this one's.
var _play: int = 0
var _was_playing: bool = false
## A play asked for here that the editor has not begun yet, as an editor still scanning answers.
## Counted when it was asked for, so its beginning later is not counted again as a play of its own.
var _awaited: bool = false


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


func _process(_delta: float) -> void:
	var playing: bool = EditorInterface.is_playing_scene()
	if playing and not _was_playing:
		if _awaited:
			_awaited = false
		else:
			_play += 1
	_was_playing = playing


func play_scene(args: Dictionary) -> Dictionary:
	var scene_path: String = str(args.get("scenePath", ""))

	var full_path: String = ""
	if scene_path.is_empty():
		# The editor puts up a dialog for a main scene that is not there and plays nothing, and the
		# play was answered as started.
		var main: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
		if main.is_empty():
			return {"ok": false, "error": "The project has no main scene to play."}
		if not ResourceLoader.exists(main, "PackedScene"):
			return {
				"ok": false,
				"error":
				(
					"The main scene, %s, is not there, so the editor would ask for another rather than play."
					% main
				)
			}
	else:
		full_path = scene_path if scene_path.begins_with("res://") else "res://" + scene_path
		if not ResourceLoader.exists(full_path, "PackedScene"):
			return {"ok": false, "error": "No scene at " + full_path}

	if EditorInterface.is_playing_scene():
		EditorInterface.stop_playing_scene()

	var debugger: int = _a_port_for_the_debugger()

	if full_path.is_empty():
		EditorInterface.play_main_scene()
	else:
		EditorInterface.play_custom_scene(full_path)

	_play += 1
	_was_playing = EditorInterface.is_playing_scene()
	_awaited = not _was_playing

	return {
		"ok": true,
		"playing": _was_playing,
		"scenePath": EditorInterface.get_playing_scene(),
		"debugPort": debugger,
		"play": _play,
		"editorPid": OS.get_process_id(),
	}


## Gives this editor's debugger a port of its own, and answers the one the game will be sent to.
##
## The editor binds this while a game runs, out of a setting shared by every editor on the
## machine, and Godot takes --lsp-port and --dap-port on its command line but nothing at all for
## this one. So two editors playing at once want the same number, and both ways that can go are
## wrong: a bind that fails leaves a game with no debugger behind it, which is every debug tool
## and the whole console gone, and a bind that succeeds anyway leaves two editors on one port with
## the games going to whichever one the operating system picks.
##
## Asked of the operating system each time rather than tested first, which is how the runtime
## addon takes its own port: a port that was free a moment ago is not a port that is still free,
## and nothing this can ask distinguishes the editor's own debugger from another editor's.
func _a_port_for_the_debugger() -> int:
	var settings: EditorSettings = EditorInterface.get_editor_settings()
	if settings == null or not settings.has_setting(DEBUGGER_SETTING):
		return 0
	var spare: int = _any_free_port()
	if spare > 0:
		settings.set_setting(DEBUGGER_SETTING, spare)
	return spare


## A port the operating system handed out, or 0 when it would not give one.
static func _any_free_port() -> int:
	var probe: TCPServer = TCPServer.new()
	if probe.listen(0, LOOPBACK) != OK:
		return 0
	var port: int = probe.get_local_port()
	probe.stop()
	return port


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

	var unsaved: Dictionary = _save_everything()
	if not unsaved.is_empty():
		return unsaved

	# Deferred so this answer is on its way out before the editor goes.
	EditorInterface.restart_editor.call_deferred(true)

	return {"ok": true, "restarting": true, "saved": true}


## Saves every open scene, answering a refusal naming what is still unsaved, or {}.
##
## Read back rather than assumed: save_all_scenes answers nothing and passes over a scene that has
## never been saved, which has no path to go to, so an untitled scene was lost with the editor while
## the answer said everything was saved.
static func _save_everything() -> Dictionary:
	if EditorInterface.is_playing_scene():
		EditorInterface.stop_playing_scene()
	EditorInterface.save_all_scenes()
	var left: PackedStringArray = EditorInterface.get_unsaved_scenes()
	if left.is_empty():
		return {}
	var named: Array[String] = []
	for scene: String in left:
		named.append(scene if not scene.is_empty() else "a scene that has never been saved")
	return {
		"ok": false,
		"error":
		(
			(
				"%s still %s unsaved changes after saving, and ending the editor would lose them. Save "
				+ "or close %s in the editor first."
			)
			% [
				", ".join(PackedStringArray(named)),
				"has" if named.size() == 1 else "have",
				"it" if named.size() == 1 else "them"
			]
		)
	}


## Ends this editor, having saved, so that whoever opened it can open it again.
##
## The editor's half of restarting one a server started. Godot's own restart cannot carry the ports
## such an editor was given, for the reason above: the engine consumes the arguments and hands none
## of them back. So the server starts it again itself, and this is the part only the editor can do.
##
## Saved first, exactly as the restart above saves. The editor is going either way, and unsaved
## scenes are not this tool's to lose.
func quit_editor(_args: Dictionary) -> Dictionary:
	var unsaved: Dictionary = _save_everything()
	if not unsaved.is_empty():
		return unsaved

	# Deferred so this answer is on its way out before the editor goes.
	_leave.call_deferred()

	return {"ok": true, "quitting": true, "saved": true}


## Asked of the tree the editor's own window is in, because this object is not in one.
static func _leave() -> void:
	var base: Control = EditorInterface.get_base_control()
	if base != null and base.get_tree() != null:
		base.get_tree().quit()


func playing_status(_args: Dictionary) -> Dictionary:
	var playing: bool = EditorInterface.is_playing_scene()
	# The debugger's port with it, read now rather than remembered: it is taken again before every
	# play, so the one from when this editor greeted the server is a number it has moved off.
	var settings: EditorSettings = EditorInterface.get_editor_settings()
	var debugger: int = (
		Read.as_int(settings.get_setting(DEBUGGER_SETTING))
		if settings != null and settings.has_setting(DEBUGGER_SETTING)
		else 0
	)
	return {
		"ok": true,
		"playing": playing,
		"scenePath": EditorInterface.get_playing_scene() if playing else "",
		"debugPort": debugger,
		"play": _play,
		"editorPid": OS.get_process_id(),
	}
