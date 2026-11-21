extends SceneTree
## The test runner's three walks of res://, run once each, and the operations' four listings of one
## folder, asked of the folder that lists but does not open. The user arguments are the runner's
## path, the operations' folder, that folder as res:// and as an absolute path.


func _init() -> void:
	var given: PackedStringArray = OS.get_cmdline_user_args()
	var runner: GDScript = load(given[0])
	var constants: Dictionary = runner.get_script_constant_map()
	var scripts: PackedStringArray = runner.call("scripts_in", PackedStringArray(["res://scripts"]))
	var none: Array[GDScript] = []
	var walk: GDScript = constants["GdhShutdownWalk"]
	var _held: Variant = walk.call("hold", none)
	var reached: GDScript = constants["GdhReached"]
	var files: PackedStringArray = reached.call("project_files")
	var operations: String = given[1]
	var shut: String = given[2]
	var file_walk: GDScript = load(operations.path_join("file_walk.gd"))
	var file_reads: GDScript = load(operations.path_join("file_reads.gd"))
	var export_presets: GDScript = load(operations.path_join("export_presets.gd"))
	var import_pipeline: GDScript = load(operations.path_join("import_pipeline.gd"))
	var listings: Dictionary = {
		"namesakes": file_walk.call("_namesakes", shut.path_join("one.gd")),
		"imported_from": file_reads.call("_imported_from", shut.path_join("one.png")),
		"installed": export_presets.call("_installed", given[3], "Linux"),
		"editor_cache": import_pipeline.call("_editor_cache_path"),
	}
	print(JSON.stringify({ "ok": true, "scripts": scripts, "files": files, "listings": listings }))
	quit(0)
