@tool
extends Node

## The editor's view of the files on disk: scans, the reimports asked for, and where each stands.

const Read = preload("../reading.gd")

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
		return {"ok": false, "error": "Editor plugin unavailable"}

	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	# Not over a scan or an import the editor is already running: a scan asked for then starts a
	# second reimport over the first, and the editor logs "Task 'reimport' already exists" and two
	# conditions from its progress dialog. Declined and said, so the caller waits and asks again.
	var busy: bool = filesystem.is_scanning() or filesystem.is_importing()
	var started: bool = false
	var completed_before: int = _scans_completed
	var uids: Dictionary = {"reread": [], "duplicated": []}
	if not Read.as_bool(args.get("statusOnly", false)) and not busy:
		uids = _reread_changed_uids(filesystem)
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
	return {"reread": reread, "duplicated": duplicated}


## Every `.uid` under [param directory], skipping what the editor skips: hidden directories, any
## holding a `.gdignore`, and any below the project's own that holds a `project.godot` of its own,
## which the editor passes over as another project. A nested project's UIDs are never in the editor's
## table, so without that last one its files would be read again on every rescan, and one holding a
## copy of an outer file's `.uid` named as a duplicate on disk.
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
		return {"ok": false, "error": "Editor plugin unavailable"}
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	return {
		"ok": true,
		"scanning": filesystem.is_scanning(),
		"importing": filesystem.is_importing(),
		"sinceScanFinishedMs":
		-1 if _scan_finished_at_msec < 0 else Time.get_ticks_msec() - _scan_finished_at_msec,
		"reimportsCompleted": _reimports_completed,
	}


## Reimport the files named under `paths`, whatever their state, the way the editor's Reimport
## button does, and report whether the reimport was started.
##
## Started on the next frame rather than run here: the editor imports on its main thread, and a
## reimport of a few hundred scenes outlasts the wait on any one command. The caller waits for
## `reimportsCompleted` in [method scan_status] to move past `reimportsCompletedBefore`. Declined
## while the editor scans or imports, since `reimport_files` refuses to run inside an import.
func reimport_files(args: Dictionary) -> Dictionary:
	if not _editor_plugin:
		return {"ok": false, "error": "Editor plugin unavailable"}
	var paths: Array[String] = []
	var given: Variant = args.get("paths", [])
	if given is Array:
		for path: Variant in given:
			paths.append(str(path))
	if paths.is_empty():
		return {"ok": false, "error": "reimport_files needs paths"}
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


func _reimport(paths: PackedStringArray) -> void:
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	# A scan can begin between the answer and this frame, and its import would refuse this one.
	while filesystem.is_scanning() or filesystem.is_importing():
		await get_tree().process_frame
	filesystem.reimport_files(paths)
	_reimports_completed += 1
