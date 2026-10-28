extends SceneTree
## The editor addon's scripts_behind: a held copy compiled from a text the file no longer has is
## named, and one held unchanged, one never loaded, and the first once reloaded are not.
##
## A rescan reloads a named class ahead of a script that fails against it, so a check answering
## every script it is asked about would reload the project, and one answering none would leave the
## failing script blamed on the classes it names.

const Checked = preload("checked.gd")
const GdhClassTools = preload("res://addons/gdharness_editor/tools/class_tools.gd")
const HELD: String = "res://behind_held.gd"
const SAME: String = "res://behind_same.gd"
const NEVER: String = "res://behind_never.gd"
const GOOD: String = "extends RefCounted\n\nconst REFUSED: int = 1\n"

var failures: Array[String] = []


func _initialize() -> void:
	for path: String in [HELD, SAME, NEVER]:
		_write(path, GOOD)
	# Held for the length of the fixture, which is what keeps each in the cache the check reads.
	var _held: GDScript = load(HELD)
	var _same: GDScript = load(SAME)
	_write(HELD, GOOD + "\n\nstatic func who_of() -> int:\n\treturn 0\n")
	var tools: GdhClassTools = GdhClassTools.new()

	var asked: Dictionary = { "scriptPaths": [HELD, SAME, NEVER] }
	var before: Dictionary = tools.scripts_behind(asked)
	if before.get("behind") != [HELD] or before.get("unsavedInEditor") != []:
		_fail("only the copy compiled from an older text is behind: %s" % JSON.stringify(before))
	var mended: Dictionary = tools.reload_script({ "scriptPath": HELD })
	if mended.get("failed") != OK:
		_fail("the held copy reloads: %s" % JSON.stringify(mended))
	var after: Dictionary = tools.scripts_behind(asked)
	if after.get("behind") != []:
		_fail("and is not behind once reloaded: %s" % JSON.stringify(after))
	if ResourceLoader.has_cached(NEVER):
		_fail("asking loaded a script that was never loaded")

	tools.free()
	for path: String in [HELD, SAME, NEVER]:
		var _removed: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _write(path: String, source: String) -> void:
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	Checked.worked(file.store_string(source), "writing " + path)
	file.close()


func _fail(message: String) -> void:
	failures.append(message)
