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
const CROWD: String = "res://behind_crowd"
const CROWD_SIZE: int = 40
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
	_spelled_listing_each_directory_once()
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


## Every path of a check is spelled from one listing of each directory it passes through. Listed per
## path, a check of a project's 416 classes held an editor's main thread for close to a minute.
func _spelled_listing_each_directory_once() -> void:
	Checked.done(
		DirAccess.make_dir_absolute(ProjectSettings.globalize_path(CROWD)),
		"making " + CROWD,
	)
	var paths: Array[String] = []
	for index: int in CROWD_SIZE:
		paths.append(CROWD.path_join("filler_%d.gd" % index))
		_write(paths[index], GOOD)
	var listings: Dictionary = {}
	for path: String in paths:
		var spelled: String = GdhClassTools._spelled_as_on_disk(path, listings)
		if spelled != path:
			_fail("a path spelled as on disk is answered as given: %s for %s" % [spelled, path])
	var other_case: String = "res://Behind_Crowd/FILLER_7.gd"
	var mixed: String = GdhClassTools._spelled_as_on_disk(other_case, listings)
	if mixed != CROWD.path_join("filler_7.gd"):
		_fail("a path in another case is answered as the files spell it: %s" % mixed)
	if listings.keys() != ["res://", CROWD]:
		_fail("each directory is listed once for the whole check: %s" % [listings.keys()])
	for path: String in paths:
		var _removed: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	var _gone: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(CROWD))


func _write(path: String, source: String) -> void:
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	Checked.worked(file.store_string(source), "writing " + path)
	file.close()


func _fail(message: String) -> void:
	failures.append(message)
