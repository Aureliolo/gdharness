extends SceneTree

## The editor addon's reload_script on a script held by a live instance: a reload that does not
## compile leaves the copy usable, and says so, and a path spelled in another case reloads the copy
## held under the spelling on disk.
##
## A failed compile leaves a script unusable while its member lists read as before: an instance it
## already made loses its methods. So what is checked is the instance, not the lists, before and
## after the refused reload, beside a reload that compiles so a copy that never reloads fails too.

const Checked = preload("checked.gd")
const ClassTools = preload("res://addons/gdharness_editor/tools/class_tools.gd")
const TOWER: String = "res://reload_tower.gd"
const GOOD: String = "extends Node\n\n\nfunc ring() -> int:\n\treturn 1\n"

var failures: Array[String] = []


func _initialize() -> void:
	_write(GOOD)
	var script: GDScript = load(TOWER)
	var held: Node = script.new()
	var tools: ClassTools = ClassTools.new()

	_write(GOOD + "\n\nfunc broken( -> int:\n\treturn 1\n")
	var refused: Dictionary = tools.reload_script({"scriptPath": "res://Reload_Tower.gd"})
	if refused.get("script") != TOWER:
		_fail("a path in another case is reloaded under the spelling on disk: %s" % JSON.stringify(refused))
	if refused.get("failed") != ERR_PARSE_ERROR or refused.get("restored") != true:
		_fail("a reload that does not compile is refused and the copy put back: %s" % JSON.stringify(refused))
	# Asked of the script before the instance is called, because has_method still answers yes on a
	# copy the failed compile broke, and the call is then an error that stops this fixture.
	if not script.can_instantiate():
		_fail("and the copy is usable, which a failed compile leaves it not")
	elif held.call("ring") != 1:
		_fail("and the instance made before it still has its methods")

	_write(GOOD + "\n\nfunc chime() -> int:\n\treturn 2\n")
	var mended: Dictionary = tools.reload_script({"scriptPath": TOWER})
	var methods: Array = mended.get("methods", [])
	if mended.get("failed") != OK or not methods.has("chime") or mended.has("restored"):
		_fail("a reload that compiles is taken: %s" % JSON.stringify(mended))
	if not script.can_instantiate():
		_fail("and the copy it compiled is usable")
	elif held.call("chime") != 2:
		_fail("and the same instance has the new method")

	held.free()
	tools.free()
	# Not checked: gone either way by the time the fixture tears itself down.
	var _removed: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(TOWER))
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _write(source: String) -> void:
	var file: FileAccess = FileAccess.open(TOWER, FileAccess.WRITE)
	Checked.worked(file.store_string(source), "writing the tower script")
	file.close()


func _fail(message: String) -> void:
	failures.append(message)
