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
const MISSING_SHADER: String = "res://shi_missing.gdshader"
const REL_DIR: String = "res://shi_sub"
const REL_SHADER: String = "res://shi_sub/r.gdshader"
const REL_INCLUDE: String = "res://shi_sub/shi_rel.gdshaderinc"
const OTHER: String = "float other() { return 1.0; }\n"
const LIT: String = "float lit() { return 1.0; }\n"
const DOT_SHADER: String = "res://shi_dot.gdshader"
const DOT_INCLUDE: String = "res://shi_dot.gdshaderinc"
const UID_SHADER: String = "res://shi_uid.gdshader"
const UID_INCLUDE: String = "res://shi_uid.gdshaderinc"
const SELF_SHADER: String = "res://shi_self.gdshader"
const USER_SHADER: String = "res://shi_user.gdshader"
const USER_INCLUDE: String = "user://shi_user.gdshaderinc"
const DELETED_SHADER: String = "res://shi_deleted.gdshader"
const DELETED_INCLUDE: String = "res://shi_deleted.gdshaderinc"
const CALLS_LIT: String = "\nvoid fragment() {\n\tCOLOR = vec4(lit());\n}\n"


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

	# The held inner include carries an unsaved edit that adds the function, which the file lacks.
	# The read answers from the file and leaves the edit where it is.
	_write(INNER, OTHER)
	held_inner.code = LIT + "// unsaved\n"
	var unsaved_text: String = held_inner.code
	var lost: Array[Dictionary] = GdhFileReads.shader_errors(SHADER)
	var kept_after_unsaved: bool = (
		load(INNER) == held_inner
		and held_inner.resource_path == INNER
		and held_inner.code == unsaved_text
		and load(INCLUDE) == held_include
	)

	var spelled: Dictionary = _odd_spelling_findings()
	var by_uid: bool = _uid_include_compiles()
	var self_refusals: int = _refusals_reading_a_shader_that_includes_itself()
	var in_user: bool = _user_include_compiles()
	var deleted: Dictionary = _deleted_include_findings()

	# An include written relative to its shader, in a folder of its own, is judged the same way.
	var relative: Dictionary = _relative_include_findings()

	# An include that is not there is answered by the engine, as it is with nothing held.
	_write(
		MISSING_SHADER,
		"shader_type canvas_item;\n#include \"res://shi_gone.gdshaderinc\"\n\n%s" % body
	)
	var missing_include: Array[Dictionary] = GdhFileReads.shader_errors(MISSING_SHADER)

	var findings: Dictionary = {
		"ok": true,
		"missing_before": not before.is_empty(),
		"gained_compiles": gained.is_empty(),
		"held_copy_kept_after_gain": kept_after_gain,
		"lost_fails": not lost.is_empty(),
		"lost_names_the_function": str(lost).contains("lit"),
		"unsaved_edit_kept": kept_after_unsaved,
		"relative_gained_compiles": relative["gained"],
		"relative_lost_fails": relative["lost"],
		"relative_held_copy_kept": relative["kept"],
		"missing_include_answered_by_the_engine": str(missing_include).contains("Unknown char"),
		"odd_spelling_gained_compiles": spelled["gained"],
		"odd_spelling_held_copy_kept": spelled["kept"],
		"uid_include_gained_compiles": by_uid,
		"self_include_loads_nothing_as_an_include": self_refusals == 0,
		"user_include_gained_compiles": in_user,
		"deleted_include_fails": deleted["fails"],
		"deleted_held_copy_kept": deleted["kept"],
	}
	print(JSON.stringify(findings))
	for path: String in [
		SHADER,
		INCLUDE,
		INNER,
		MISSING_SHADER,
		REL_SHADER,
		REL_INCLUDE,
		DOT_SHADER,
		DOT_INCLUDE,
		UID_SHADER,
		UID_INCLUDE,
		SELF_SHADER,
		USER_SHADER,
		USER_INCLUDE,
		DELETED_SHADER,
	]:
		var _removed: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	var _dir_removed: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(REL_DIR))
	quit()


func _relative_include_findings() -> Dictionary:
	var _made: Error = DirAccess.make_dir_recursive_absolute(
		ProjectSettings.globalize_path(REL_DIR)
	)
	var body: String = "\nvoid fragment() {\n\tCOLOR = vec4(rel());\n}\n"
	_write(REL_SHADER, "shader_type canvas_item;\n#include \"shi_rel.gdshaderinc\"\n%s" % body)
	_write(REL_INCLUDE, OTHER)
	var _before: Array[Dictionary] = GdhFileReads.shader_errors(REL_SHADER)
	var held: ShaderInclude = load(REL_INCLUDE) as ShaderInclude
	_write(REL_INCLUDE, "float rel() { return 1.0; }\n")
	var gained: Array[Dictionary] = GdhFileReads.shader_errors(REL_SHADER)
	var kept: bool = load(REL_INCLUDE) == held and held.code == OTHER
	# The held copy now has the function, as one the editor loaded while the file had it, and the
	# file loses it.
	held.code = "float rel() { return 1.0; }\n"
	_write(REL_INCLUDE, OTHER)
	var lost: Array[Dictionary] = GdhFileReads.shader_errors(REL_SHADER)
	return {
		"gained": gained.is_empty(),
		"lost": not lost.is_empty() and str(lost).contains("rel"),
		"kept": kept,
	}


## An include written with a ".." and a doubled slash is judged by its file, and the held copy stays
## the one the cache answers for its path.
func _odd_spelling_findings() -> Dictionary:
	var named: String = "res://operations/..//shi_dot.gdshaderinc"
	_write(DOT_SHADER, "shader_type canvas_item;\n#include \"%s\"\n%s" % [named, CALLS_LIT])
	_write(DOT_INCLUDE, OTHER)
	var _before: Array[Dictionary] = GdhFileReads.shader_errors(DOT_SHADER)
	var held: ShaderInclude = load(DOT_INCLUDE) as ShaderInclude
	_write(DOT_INCLUDE, LIT)
	var gained: Array[Dictionary] = GdhFileReads.shader_errors(DOT_SHADER)
	return {
		"gained": gained.is_empty(),
		"kept": load(DOT_INCLUDE) == held and held.resource_path == DOT_INCLUDE,
	}


## An include named by its uid is judged by its file too.
func _uid_include_compiles() -> bool:
	_write(UID_INCLUDE, OTHER)
	var id: int = ResourceUID.create_id()
	ResourceUID.add_id(id, UID_INCLUDE)
	var uid: String = ResourceUID.id_to_text(id)
	_write(UID_SHADER, "shader_type canvas_item;\n#include \"%s\"\n%s" % [uid, CALLS_LIT])
	var before: Array[Dictionary] = GdhFileReads.shader_errors(UID_SHADER)
	var _held: ShaderInclude = load(UID_INCLUDE) as ShaderInclude
	_write(UID_INCLUDE, LIT)
	var gained: Array[Dictionary] = GdhFileReads.shader_errors(UID_SHADER)
	ResourceUID.remove_id(id)
	return not before.is_empty() and gained.is_empty()


## An include written as a user:// path is judged by its file too.
func _user_include_compiles() -> bool:
	_write(USER_INCLUDE, OTHER)
	_write(USER_SHADER, "shader_type canvas_item;\n#include \"%s\"\n%s" % [USER_INCLUDE, CALLS_LIT])
	var before: Array[Dictionary] = GdhFileReads.shader_errors(USER_SHADER)
	var _held: ShaderInclude = load(USER_INCLUDE) as ShaderInclude
	_write(USER_INCLUDE, LIT)
	var gained: Array[Dictionary] = GdhFileReads.shader_errors(USER_SHADER)
	return not before.is_empty() and gained.is_empty()


## An include deleted on disk fails the read while a copy of it is still held, and the held copy
## stays the one the cache answers for its path.
func _deleted_include_findings() -> Dictionary:
	_write(DELETED_INCLUDE, LIT)
	_write(
		DELETED_SHADER,
		"shader_type canvas_item;\n#include \"%s\"\n%s" % [DELETED_INCLUDE, CALLS_LIT],
	)
	var before: Array[Dictionary] = GdhFileReads.shader_errors(DELETED_SHADER)
	var held: ShaderInclude = load(DELETED_INCLUDE) as ShaderInclude
	var _removed: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(DELETED_INCLUDE))
	var gone: Array[Dictionary] = GdhFileReads.shader_errors(DELETED_SHADER)
	return {
		"fails": before.is_empty() and not gone.is_empty(),
		"kept": ResourceLoader.get_cached_ref(DELETED_INCLUDE) == held,
	}


## How many loads the read of a cached shader that includes itself refused.
func _refusals_reading_a_shader_that_includes_itself() -> int:
	_write(SELF_SHADER, "shader_type canvas_item;\n#include \"%s\"\n" % SELF_SHADER)
	var _held: Shader = load(SELF_SHADER) as Shader
	var refusals: Refusals = Refusals.new()
	OS.add_logger(refusals)
	var _errors: Array[Dictionary] = GdhFileReads.shader_errors(SELF_SHADER)
	OS.remove_logger(refusals)
	return refusals.count


func _write(path: String, text: String) -> void:
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	var _stored: bool = file.store_string(text)
	file.close()


## Counts the engine's refusals to load a resource, which a read must not provoke.
class Refusals:
	extends Logger

	var count: int = 0

	func _log_message(_message: String, _error: bool) -> void:
		pass

	# The engine's own signature for a Logger, eight parameters and not this project's to shape.
	# gdstyle:ignore=quality/max-parameters
	func _log_error(
		_function: String,
		_file: String,
		_line: int,
		code: String,
		rationale: String,
		_editor_notify: bool,
		_error_type: int,
		_script_backtraces: Array[ScriptBacktrace],
	) -> void:
		var said: String = code + " " + rationale
		if said.contains("No loader found") or said.contains("Error loading resource"):
			count += 1
