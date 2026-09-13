extends SceneTree

## The global classes this engine process knows, which it read from the class cache at startup
## and from nothing else: the way to tell whether a rebuilt cache is one the engine accepts.


func _init() -> void:
	var known: Dictionary = {}
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		known[str(entry["class"])] = {"base": str(entry["base"]), "path": str(entry["path"])}
	print(JSON.stringify({"ok": true, "classes": known}))
	quit(0)
