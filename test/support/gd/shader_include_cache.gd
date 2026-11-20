extends SceneTree
## Whether a shader's compile is judged against its includes as the files are now, while the
## include the engine already holds in its cache is left as it is.
##
## The editor holds an include it loaded earlier, and an edit it has not saved lives only in that
## object. The read must see the file, and must not take the held copy away or reload it.

const GdhFileReads = preload("res://operations/file_reads.gd")
const SHADER: String = "res://shi_a.gdshader"
const INCLUDE: String = "res://shi_inc.gdshaderinc"
const INNER: String = "res://shi_inner.gdshaderinc"
const OTHER: String = "float other() { return 1.0; }\n"
const LIT: String = "float lit() { return 1.0; }\n"


func _initialize() -> void:
	var body: String = "void fragment() {\n\tCOLOR = vec4(lit());\n}\n"
	_write(SHADER, "shader_type canvas_item;\n#include \"%s\"\n\n%s" % [INCLUDE, body])
	_write(INCLUDE, "#include \"%s\"\n" % INNER)
	_write(INNER, OTHER)

	# The engine holds both includes, compiled while neither had the function.
	var before: Array[Dictionary] = GdhFileReads.shader_errors(SHADER)
	var held_include: ShaderInclude = load(INCLUDE) as ShaderInclude
	var held_inner: ShaderInclude = load(INNER) as ShaderInclude

	# The inner file gains the function on disk, which the held copies do not know.
	_write(INNER, LIT)
	var gained: Array[Dictionary] = GdhFileReads.shader_errors(SHADER)
	var kept_after_gain: bool = (
		load(INNER) == held_inner and held_inner.resource_path == INNER and held_inner.code == OTHER
	)

	# The held include carries an edit nobody has saved. The read answers from the file and leaves
	# the edit where it is.
	_write(INNER, OTHER)
	held_include.code = "#include \"%s\"\n// unsaved\n" % INNER
	var unsaved_text: String = held_include.code
	var lost: Array[Dictionary] = GdhFileReads.shader_errors(SHADER)
	var kept_after_unsaved: bool = (
		load(INCLUDE) == held_include
		and held_include.resource_path == INCLUDE
		and held_include.code == unsaved_text
	)

	var findings: Dictionary = {
		"ok": true,
		"missing_before": not before.is_empty(),
		"gained_compiles": gained.is_empty(),
		"held_copy_kept_after_gain": kept_after_gain,
		"lost_fails": not lost.is_empty(),
		"lost_names_the_function": str(lost).contains("lit"),
		"unsaved_edit_kept": kept_after_unsaved,
	}
	print(JSON.stringify(findings))
	for path: String in [SHADER, INCLUDE, INNER]:
		var _removed: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	quit()


func _write(path: String, text: String) -> void:
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	var _stored: bool = file.store_string(text)
	file.close()
