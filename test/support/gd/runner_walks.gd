extends SceneTree
## The test runner's three walks of res://, run once each. The runner's path arrives as the first
## user argument.


func _init() -> void:
	var runner: GDScript = load(OS.get_cmdline_user_args()[0])
	var constants: Dictionary = runner.get_script_constant_map()
	var scripts: PackedStringArray = runner.call("scripts_in", PackedStringArray(["res://scripts"]))
	var none: Array[GDScript] = []
	var walk: GDScript = constants["GdhShutdownWalk"]
	var _held: Variant = walk.call("hold", none)
	var reached: GDScript = constants["GdhReached"]
	var files: PackedStringArray = reached.call("project_files")
	print(JSON.stringify({ "ok": true, "scripts": scripts, "files": files }))
	quit(0)
