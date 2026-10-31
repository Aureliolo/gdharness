@tool
extends Node
## The editor's view of the files on disk: scans, the reimports asked for, where each stands, and
## files moved under it.

const GdhRead = preload("../reading.gd")
const GdhSceneFile = preload("../scene_file.gd")

var _editor_plugin: EditorPlugin = null
## How many scans the editor has completed, counted off `sources_changed`, which it emits at the end
## of every scan once the reimport the scan found is done: the one moment a scan is over. Neither
## flag it offers says so. A threaded scan stops reporting itself when its thread finishes, and its
## import runs a frame or more later when the thread is joined; an editor in the background took
## long enough over that frame that a rescan answered before the import of 211 changed scenes began.
var _scans_completed: int = 0
## When the last scan completed, on the engine's clock, or -1 before the first. The editor writes
## the class cache a frame after it stops reporting a scan, measured on 4.7.2, so a game started
## in between reads a file being rewritten; how long ago the scan ended is what tells a caller
## whether that write can still be coming.
var _scan_finished_at_msec: int = -1
## How many reimports asked for through [method reimport_files] have finished. Counted here rather
## than off `resources_reimported`, which a scan's own import emits as well.
var _reimports_completed: int = 0


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	if not filesystem.sources_changed.is_connected(_scan_completed):
		var watched: int = filesystem.sources_changed.connect(_scan_completed)
		if watched != OK:
			push_error("gdharness could not watch for completed scans: %d" % watched)


func _scan_completed(_sources_exist: bool) -> void:
	_scans_completed += 1
	_scan_finished_at_msec = Time.get_ticks_msec()


## Rescan the project filesystem, and report whether a scan is still running.
##
## The editor rescans when its window regains focus, so a script written by anything other
## than the editor stays invisible until someone clicks on Godot. Until then its
## `class_name` is missing from the global class list and the language server reports every
## use of it as an unknown type, which is godotengine/godot#42786.
##
## Returns as soon as the scan is queued rather than awaiting it, because the tool executor
## takes a Dictionary and not a coroutine. Pass `statusOnly` to poll without starting
## another scan.
func rescan_filesystem(args: Dictionary) -> Dictionary:
	if not _editor_plugin:
		return { "ok": false, "error": "Editor plugin unavailable" }

	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	# Not over a scan or an import the editor is already running: a scan asked for then starts a
	# second reimport over the first, and the editor logs "Task 'reimport' already exists" and two
	# conditions from its progress dialog. Declined and said, so the caller waits and asks again.
	var busy: bool = filesystem.is_scanning() or filesystem.is_importing()
	var started: bool = false
	var completed_before: int = _scans_completed
	var uids: Dictionary = { "reread": [], "duplicated": [] }
	if not GdhRead.as_bool(args.get("statusOnly", false)) and not busy:
		uids = _reread_changed_uids(filesystem)
		# Files the caller has just written, moved or deleted, read again one by one. The scan finds
		# a script that appeared and leaves the global class of one that has gone in the editor's
		# list, which it then writes back into the class cache at a path that is not there. Reading
		# the gone path again is what drops it.
		var named: Variant = args.get("updateFiles", [])
		if named is Array:
			var paths: Array = named
			for path: Variant in paths:
				filesystem.update_file(str(path))
		filesystem.scan()
		# Whether the scan ran, read off the editor rather than assumed. `scan()` returns without
		# a word while the thread of the scan before is still to be joined, which is a frame or
		# more after that scan stops reporting itself, and that scan then signals as it is joined.
		# Taken as started, the answer came from a scan begun before the files were written:
		# downstream, a rescan after 698 files were rewritten answered finished in 1.5s and the
		# one changed file stayed on its old import. A threaded scan reports itself from inside
		# the call, and one run on this thread has finished and signalled before it returns.
		started = filesystem.is_scanning() or _scans_completed != completed_before

	# Importing is reported separately from scanning, and a class is not registered until
	# both are done, so a caller watching only one of them can look too early. The two counts are
	# what a caller waits on: the scan it asked for is over once the count has moved past the one
	# from before it was asked.
	return {
		"ok": true,
		"started": started,
		"scanning": filesystem.is_scanning(),
		"importing": filesystem.is_importing(),
		"scansCompletedBefore": completed_before,
		"scansCompleted": _scans_completed,
		"uidsReread": uids["reread"],
		"uidsDuplicatedOnDisk": uids["duplicated"],
	}


## Has the editor read again every file whose `.uid` names a UID the editor does not hold for it.
##
## The scan re-reads a file when the file changes and not when only the `.uid` beside it does, so a
## script copied with its `.uid` and then given a fresh one keeps the copied UID in the editor, and
## every headless engine reading the editor's cache warns of a duplicate. Measured on 4.7.2: a scan
## after the `.uid` was rewritten left both scripts on one UID in the cache. What the editor holds
## is read off its UID table, which maps each UID to one path, so a `.uid` whose UID is missing from
## the table or mapped to another file is one the editor has not taken in.
##
## Two files on disk naming one UID are left alone and named: reading them again cannot settle
## which of them owns it, and doing it on every scan would only move the UID between them.
func _reread_changed_uids(filesystem: EditorFileSystem) -> Dictionary:
	var sidecars: Array[String] = []
	_uid_files("res://", sidecars)
	var claimed: Dictionary = {}
	for sidecar: String in sidecars:
		var id: int = ResourceUID.text_to_id(FileAccess.get_file_as_string(sidecar).strip_edges())
		var path: String = sidecar.trim_suffix(".uid")
		if id == ResourceUID.INVALID_ID or not FileAccess.file_exists(path):
			continue
		var paths: Array = claimed.get_or_add(id, [])
		paths.append(path)
	var reread: Array[String] = []
	var duplicated: Array[Array] = []
	for id: int in claimed:
		var paths: Array = claimed[id]
		if paths.size() > 1:
			paths.sort()
			duplicated.append(paths)
			continue
		var path: String = str(paths[0])
		if ResourceUID.has_id(id) and ResourceUID.get_id_path(id) == path:
			continue
		filesystem.update_file(path)
		reread.append(path)
	reread.sort()
	duplicated.sort()
	return { "reread": reread, "duplicated": duplicated }


## Every `.uid` under [param directory], skipping what the editor skips: hidden directories, any
## holding a `.gdignore`, and any below the project's own that holds a `project.godot` of its own,
## which the editor passes over as another project. A nested project's UIDs are never in the
## editor's table, so without that last one its files would be read again on every rescan, and one
## holding a copy of an outer file's `.uid` named as a duplicate on disk.
func _uid_files(directory: String, found: Array[String]) -> void:
	var listing: DirAccess = DirAccess.open(directory)
	if listing == null or FileAccess.file_exists(directory.path_join(".gdignore")):
		return
	if directory != "res://" and FileAccess.file_exists(directory.path_join("project.godot")):
		return
	for child: String in listing.get_directories():
		if not child.begins_with("."):
			_uid_files(directory.path_join(child), found)
	for file: String in listing.get_files():
		if file.ends_with(".uid"):
			found.append(directory.path_join(file))


## Whether the editor is scanning, and how long ago its last scan finished, without asking for one.
##
## For a caller about to start a game: the editor rewrites the class cache a frame after a scan
## stops reporting, so a game booted during the scan or in that frame reads a file being rewritten.
## Apart from `rescan_filesystem` because asking must not start or count anything.
func scan_status(_args: Dictionary) -> Dictionary:
	if not _editor_plugin:
		return { "ok": false, "error": "Editor plugin unavailable" }
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	# The scenes open in tabs, the one shown and the ones holding unsaved edits: a scene edit on
	# disk meets what the editor holds of it, and nothing said which scenes those were. A tab of a
	# scene never saved has no path, and a new project's editor opens with an empty one, so it is
	# left out of the open; one with edits is kept among the unsaved, as the edits a close would
	# lose.
	var shown: Node = EditorInterface.get_edited_scene_root()
	var open: Array[String] = []
	open.assign(Array(EditorInterface.get_open_scenes()).filter(_has_path))
	var unsaved: Array[String] = []
	unsaved.assign(EditorInterface.get_unsaved_scenes())
	return {
		"ok": true,
		"openScenes": open,
		"editedScene": "" if shown == null else shown.scene_file_path,
		"unsavedScenes": unsaved,
		"scanning": filesystem.is_scanning(),
		"importing": filesystem.is_importing(),
		"pending": GdhSceneFile.scan_due,
		"sinceScanFinishedMs":
		-1 if _scan_finished_at_msec < 0 else Time.get_ticks_msec() - _scan_finished_at_msec,
		"reimportsCompleted": _reimports_completed,
	}


func _has_path(path: String) -> bool:
	return path != ""


## Reimport the files named under `paths`, whatever their state, the way the editor's Reimport
## button does, and report whether the reimport was started.
##
## Started on the next frame rather than run here: the editor imports on its main thread, and a
## reimport of a few hundred scenes outlasts the wait on any one command. The caller waits for
## `reimportsCompleted` in [method scan_status] to move past `reimportsCompletedBefore`. Declined
## while the editor scans or imports, since `reimport_files` refuses to run inside an import.
func reimport_files(args: Dictionary) -> Dictionary:
	if not _editor_plugin:
		return { "ok": false, "error": "Editor plugin unavailable" }
	var paths: Array[String] = []
	var given: Variant = args.get("paths", [])
	if given is Array:
		for path: Variant in given:
			paths.append(str(path))
	if paths.is_empty():
		return { "ok": false, "error": "reimport_files needs paths" }
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	var busy: bool = filesystem.is_scanning() or filesystem.is_importing()
	if not busy:
		_reimport.call_deferred(PackedStringArray(paths))
	return {
		"ok": true,
		"started": not busy,
		"scanning": filesystem.is_scanning(),
		"importing": filesystem.is_importing(),
		"reimportsCompletedBefore": _reimports_completed,
	}


## Brings the editor up to files moved under it, the way its FileSystem dock brings itself up after
## a move of its own: each cached resource and each open scene named for where it now is, so what
## holds them saves the new path, the editor's file list told of both ends, and each open scene that
## moved or that the move rewrote read again from the file. A scene with unsaved edits is left as it
## is and named, since reading it again would discard them; its root names the new path either way.
##
## A moved tab is read again even when its text did not change: the editor keeps each tab's path
## twice, on the root and in its own list, and a script can set only the first. The second is what
## [method EditorInterface.get_open_scenes] answers, and reading the scene again is what writes it.
func files_moved(args: Dictionary) -> Dictionary:
	var renames: Dictionary[String, String] = {}
	var given: Variant = args.get("moved", [])
	if given is Array:
		var pairs: Array = given
		for pair: Variant in pairs:
			if pair is Dictionary:
				var named: Dictionary = pair
				renames[str(named.get("from", ""))] = str(named.get("to", ""))
	for from: String in renames:
		if ResourceLoader.has_cached(from):
			var held: Resource = ResourceLoader.get_cached_ref(from)
			if held != null:
				held.take_over_path(renames[from])
	var dirty: Array[String] = []
	for path: String in EditorInterface.get_unsaved_scenes():
		dirty.append(renames.get(path, path))
	var retargeted: Array[String] = []
	var reread: Array[String] = []
	for root: Node in EditorInterface.get_open_scene_roots():
		var path: String = root.scene_file_path
		if renames.has(path):
			root.scene_file_path = renames[path]
			retargeted.append(path)
			reread.append(renames[path])
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	for from: String in renames:
		filesystem.update_file(from)
		filesystem.update_file(renames[from])
	var open: Array[String] = []
	for root: Node in EditorInterface.get_open_scene_roots():
		open.append(root.scene_file_path)
	var changed: Variant = args.get("changed", [])
	if changed is Array:
		var paths: Array = changed
		for path: Variant in paths:
			if open.has(str(path)) and not reread.has(str(path)):
				reread.append(str(path))
	var reloaded: Array[String] = []
	var unsaved: Array[String] = []
	for scene: String in reread:
		if dirty.has(scene):
			unsaved.append(scene)
		else:
			EditorInterface.reload_scene_from_path(scene)
			reloaded.append(scene)
	reloaded.sort()
	unsaved.sort()
	return {
		"ok": true,
		"retargetedTabs": retargeted,
		"reloadedScenes": reloaded,
		"unsavedScenes": unsaved,
	}


func _reimport(paths: PackedStringArray) -> void:
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	# A scan can begin between the answer and this frame, and its import would refuse this one.
	while filesystem.is_scanning() or filesystem.is_importing():
		await get_tree().process_frame
	filesystem.reimport_files(paths)
	_reimports_completed += 1
