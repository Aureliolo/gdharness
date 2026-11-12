extends SceneTree
## The res:// files the test runner's loader lists as the engine's own. The runner's path arrives
## as the first user argument.


func _init() -> void:
	var runner: GDScript = load(OS.get_cmdline_user_args()[0])
	var reached: GDScript = runner.get_script_constant_map()["GdhReached"]
	var files: PackedStringArray = reached.call("project_files")
	print(JSON.stringify({ "ok": true, "files": files }))
	quit(0)
