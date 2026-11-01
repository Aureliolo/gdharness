@tool
extends Node
## Resource files, shaders and themes, written through the open editor.

const GdhFileReads = preload("../file_reads.gd")
const GdhHeadlessCheck = preload("../headless_check.gd")
const GdhPropertyPaths = preload("../property_paths.gd")
const GdhPropertyValues = preload("../property_values.gd")
const GdhRead = preload("../reading.gd")
const GdhSame = preload("../same_values.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhSceneUids = preload("../scene_uids.gd")
const GdhSerialisation = preload("../serialisation.gd")
# The minimal shader of a type: its declaration and the one function the engine calls for it.
const SHADER_EMPTY: String = """shader_type %s;

void %s() {
}
"""
const SHADER_ENTRY: Dictionary[String, String] = {
	"canvas_item": "fragment",
	"spatial": "fragment",
	"particles": "process",
	"sky": "sky",
	"fog": "fog",
}

var _editor_plugin: EditorPlugin = null
var _properties: GdhPropertyValues = GdhPropertyValues.new()
var _values: GdhSerialisation = GdhSerialisation.new()


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


func _ensure_res_path(path: String) -> String:
	if path.begins_with("res://"):
		return path
	if path.begins_with("/"):
		var project_abs: String = ProjectSettings.globalize_path("res://")
		if path.begins_with(project_abs):
			var rel: String = path.substr(project_abs.length())
			return "res://" + rel
	return "res://" + path


## Brings the editor up to date with a resource file written under it. The cached copy is
## reloaded in place, since it is the one open scenes hold: left alone, the next edit made through
## it saved the old values over this one.
func _written(path: String) -> void:
	if ResourceLoader.has_cached(path):
		var _replaced: Resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)
	if _editor_plugin:
		GdhSceneFile.scan_later()


## Why a tool that creates [param path] must not write there, or "". Saving over a file that was
## there replaced it whole and answered as a new one.
func _taken(path: String, op: String, remedy: String = "Change it with op=modify") -> String:
	if not FileAccess.file_exists(path):
		return ""
	return (
		(
			"%s already exists, and %s would replace everything in it. %s, or create the new one "
			+ "under another path."
		)
		% [path, op, remedy]
	)


func _parse_properties_dict(raw: Variant) -> Dictionary:
	if typeof(raw) == TYPE_DICTIONARY:
		return raw
	if typeof(raw) == TYPE_STRING and raw != "":
		var text: String = raw
		var json: JSON = JSON.new()
		if json.parse(text) == OK and typeof(json.data) == TYPE_DICTIONARY:
			return json.data
	return {}


## The theme on disk at this path, or null when there is not one.
##
## Read past the cache, because the caller saves what it gets back and the cached copy is the
## one an earlier call already edited. A miss answers null rather than a blank Theme: writing
## one over a path holding something else, or holding nothing, is inventing a resource rather
## than editing one, and it reads as a success either way.
func _load_theme(theme_path: String) -> Theme:
	if not ResourceLoader.exists(theme_path, "Theme"):
		return null
	var loaded: Resource = ResourceLoader.load(
		theme_path, "Theme", ResourceLoader.CACHE_MODE_IGNORE
	)
	if loaded is Theme:
		return loaded
	return null


## Saves [param resource] to [param path] and reads the file back, answering "" when each of
## [param names] loads as [param resource] holds it, or why not. On a mismatch the file is put back
## as it was, [param previous], or removed when there was none.
##
## Read back because a property can be set and still not be saved: one without storage, a
## script variable that is not exported. Both were answered as changed.
func _save_checked(resource: Resource, path: String, names: Array, previous: Variant) -> String:
	var carried: Dictionary = GdhHeadlessCheck.embedded_in(
		GdhHeadlessCheck.stored(resource).values(), {}
	)
	var saving: Error = GdhSceneUids.save_keeping_uid(resource, path)
	if saving != OK:
		return "Failed to save %s: %s" % [path, error_string(saving)]
	var unkept: String = _unkept_headless(
		resource, path, names + _properties.moved_by_engine.keys(), previous, carried
	)
	if not unkept.is_empty():
		return "Nothing was written: " + unkept + GdhHeadlessCheck.put_back(path, previous)
	var loaded: Resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	var lost: String = ""
	if loaded == null:
		lost = "%s did not load back after it was saved." % path
	else:
		for key: Variant in names:
			var property: String = str(key)
			var read: Variant = _properties.read_at(loaded, property)
			if not GdhSame.same(read, _properties.read_at(resource, property)):
				lost = (
					(
						"%s.%s would load from the file as %s: it is not a property the file "
						+ "keeps, so nothing was changed."
					)
					% [path, property, _properties.shown(read)]
				)
				break
	if lost.is_empty():
		_written(path)
		return ""
	return lost + GdhHeadlessCheck.put_back(path, previous)


## Outside the editor, puts back in the file just saved at [param path] what a script that is not a
## tool changed and the call did not ask for, [param names] being what it asked for, and answers ""
## or why that did not hold. [param carried] is what each embedded id named before the save. See
## [GdhHeadlessCheck].
func _unkept_headless(
	resource: Resource, path: String, names: Array, previous: Variant, carried: Dictionary
) -> String:
	if Engine.is_editor_hint():
		return ""
	var script: Script = resource.get_script()
	var scripted: bool = script != null and not script.is_tool()
	if not path.ends_with(".tres"):
		if scripted or GdhHeadlessCheck.holds_scripted_embedded(resource, {}):
			return (
				(
					(
						"%s is a binary resource with a script that is not a tool, and what that "
						+ "script changed when a headless engine loaded it cannot be told apart "
						+ "from the file here. "
					)
					% path
				)
				+ GdhHeadlessCheck.REMEDY
			)
		return ""
	var before: String = ""
	if previous is PackedByteArray:
		var bytes: PackedByteArray = previous
		before = bytes.get_string_from_utf8()
	var asked: Dictionary = { "script": true }
	var reached: Dictionary = {}
	for key: Variant in names:
		var property: String = str(key)
		asked[property] = true
		asked[property.get_slice(":", 0)] = true
		GdhHeadlessCheck.spare(reached, GdhHeadlessCheck.reached(resource, property))
	var just_saved: GdhHeadlessCheck.GdhSaved = GdhHeadlessCheck.GdhSaved.new(
		path, before, func() -> Error: return GdhSceneUids.save_keeping_uid(resource, path)
	)
	return GdhHeadlessCheck.settle_saved(
		just_saved,
		GdhHeadlessCheck.stored(resource).values(),
		resource if scripted else null,
		asked,
		reached,
		carried
	)


func create_resource(args: Dictionary) -> Dictionary:
	var res_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	var resource_type: String = str(args.get("resourceType", "Resource"))
	if res_path == "res://":
		return { "ok": false, "error": "resourcePath is required" }
	var taken: String = _taken(res_path, "resource_edit op=create")
	if not taken.is_empty():
		return { "ok": false, "error": taken }

	var script_path: String = str(args.get("script", ""))
	var made: Dictionary = GdhSceneFile.made_as(
		resource_type,
		"" if script_path == "" else _ensure_res_path(script_path),
		"Resource",
		"resourceType"
	)
	if made.has("error"):
		return { "ok": false, "error": made["error"] }
	resource_type = str(made["type"])
	script_path = str(made["script"])
	if not ClassDB.class_exists(resource_type):
		return {
			"ok": false,
			"error":
			(
				"%s is neither an engine class nor a class_name in the project's class list."
				% resource_type
			),
		}
	if (
		not ClassDB.is_parent_class(resource_type, "Resource")
		or not ClassDB.can_instantiate(resource_type)
	):
		return {
			"ok": false, "error": "%s is not a resource class that can be created." % resource_type,
		}
	var resource: Resource = ClassDB.instantiate(resource_type)

	# A script that did not load was skipped, and a plain resource was saved in place of the custom
	# one asked for.
	if script_path != "":
		var script_file: String = _ensure_res_path(script_path)
		var script: Script = load(script_file) as Script
		if script == null:
			return { "ok": false, "error": "No script loads from " + script_file }
		var uncompiled: String = GdhSceneFile.uncompiled(script, script_file)
		if not uncompiled.is_empty():
			return { "ok": false, "error": uncompiled }
		var base: String = str(script.get_instance_base_type())
		if not ClassDB.is_parent_class(resource_type, base):
			return {
				"ok": false,
				"error":
				"%s extends %s, so it cannot be on a %s." % [script_file, base, resource_type],
			}
		resource.set_script(script)

	var properties: Dictionary = _parse_properties_dict(args.get("properties", {}))
	var refused: String = _properties.write_all(resource, properties)
	if not refused.is_empty():
		return {
			"ok": false, "error": GdhHeadlessCheck.setter_ran(
				resource,
				_properties.unheld,
				refused,
			),
		}

	var folder: String = GdhSceneFile.make_folder_for(res_path)
	if not folder.is_empty():
		return { "ok": false, "error": folder }
	# As a read names it, the engine class under resourceType and the script's class beside it,
	# since a create given resourceType Resource and a script answered nothing of the class it had
	# made, and one given a class_name answered it where a read of the same file answers Resource.
	var answer: Dictionary = { "ok": true, "resourcePath": res_path, "resourceType": resource_type }
	var scripted: Variant = resource.get_script()
	if scripted is Script:
		var attached: Script = scripted
		answer["script"] = attached.resource_path
		if not attached.get_global_name().is_empty():
			answer["scriptClass"] = str(attached.get_global_name())
	_properties.note_write(answer)
	var failed: String = _save_checked(resource, res_path, properties.keys(), null)
	if not failed.is_empty():
		return { "ok": false, "error": failed }
	_note_put_back(answer, resource, res_path)
	if not properties.is_empty():
		answer["properties"] = _held(resource, properties.keys())
	return answer


func modify_resource(args: Dictionary) -> Dictionary:
	var res_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if res_path == "res://":
		return { "ok": false, "error": "resourcePath is required" }
	if not FileAccess.file_exists(res_path):
		return { "ok": false, "error": "No resource at %s. op=create makes one there." % res_path }
	# The editor's copy of an imported file is rebuilt from the source on every import, and a save
	# to it fails. Edited through the cache, the editor kept the changed copy after the refusal.
	if FileAccess.file_exists(res_path + ".import"):
		return {
			"ok": false,
			"error":
			(
				(
					"%s is imported, so what it holds comes from its source file and its import "
					+ "options. Change those with project_import op=set_options."
				)
				% res_path
			),
		}

	# Past the cache, so a refusal leaves the copy open scenes hold as it was.
	var resource: Resource = ResourceLoader.load(res_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if resource == null:
		return { "ok": false, "error": "%s did not load as a resource." % res_path }
	# A scene's own properties are its packed bundle, so a property named for a scene is one of its
	# nodes', and "PackedScene has no property" left the caller looking for the tool that sets it.
	if resource is PackedScene:
		return {
			"ok": false,
			"error":
			(
				(
					"%s is a scene: scene_node set changes one node's properties, the root's at "
					+ "nodePath \".\"."
				)
				% res_path
			),
		}

	var properties: Dictionary = _parse_properties_dict(args.get("properties", ""))
	var refused: String = _properties.write_all(resource, properties)
	if refused.is_empty():
		refused = _holding_itself(resource, res_path, properties.keys())
	else:
		refused = GdhHeadlessCheck.setter_ran(resource, _properties.unheld, refused)
	if not refused.is_empty():
		return { "ok": false, "error": refused }
	var answer: Dictionary = { "ok": true, "resourcePath": res_path }
	_properties.note_write(answer)
	var previous: PackedByteArray = FileAccess.get_file_as_bytes(res_path)
	var failed: String = _save_checked(resource, res_path, properties.keys(), previous)
	if not failed.is_empty():
		return { "ok": false, "error": failed }
	_note_put_back(answer, resource, res_path)
	answer["properties"] = _held(resource, properties.keys())
	return answer


## Moves to setByScript each property alsoChanged in [param answer] gave a value [param resource] no
## longer holds once saved at [param path]: the save put it back as its script's doing.
func _note_put_back(answer: Dictionary, resource: Resource, path: String) -> void:
	var noted: Dictionary = answer.get("alsoChanged", {})
	var restored: Array = []
	for key: Variant in noted:
		var now: Variant = _values.serialize_value(_properties.read_at(resource, str(key)))
		var entry: Dictionary = noted[key]
		if JSON.stringify(now) != JSON.stringify(entry.get("now")):
			restored.append(key)
	GdhHeadlessCheck.move_script_set(answer, restored, path)


## Why [param resource], saved at [param path], cannot hold what [param names] were given, or "": a
## resource cannot hold the file it is saved as. Godot saves the reference as null with only a
## warning in its log, and the read back after the save reported the property as one the file does
## not keep.
func _holding_itself(resource: Resource, path: String, names: Array) -> String:
	for key: Variant in names:
		var property: String = str(key)
		for held: Resource in GdhHeadlessCheck.resources_in(
			_properties.read_at(resource, property)
		):
			if held == resource or held.resource_path == path:
				return (
					(
						"%s.%s would hold %s itself, and a resource cannot hold the file it is "
						+ "saved as: Godot saves the reference as null. Nothing was written."
					)
					% [GdhPropertyPaths.class_called(resource), property, path]
				)
	return ""


## What [param resource] holds at each property or path in [param asked], once the save has been
## checked against it: a write saying only that it was written left the caller a second call to
## learn what the engine kept.
func _held(resource: Resource, asked: Array) -> Dictionary:
	var held: Dictionary = {}
	for key: Variant in asked:
		held[str(key)] = _values.serialize_value(_properties.read_at(resource, str(key)))
	return held


## What a resource file holds, read as a headless engine reads it with no editor connected.
func read_resource(args: Dictionary) -> Dictionary:
	var res_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if res_path == "res://":
		return { "ok": false, "error": "resourcePath is required" }
	# The server takes a resource kept inside a file apart, so the boundary judges the file alone.
	var inner: String = str(args.get("subResource", ""))
	if not inner.is_empty():
		res_path += "::" + inner
	return GdhFileReads.resource(res_path, GdhRead.as_bool(args.get("includeDefaults", false)))


func create_shader(args: Dictionary) -> Dictionary:
	var shader_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	var shader_type: String = str(args.get("shaderType", "canvas_item"))
	if shader_path == "res://":
		return { "ok": false, "error": "resourcePath is required" }
	var taken: String = _taken(shader_path, "resource_edit op=create_shader", "Edit its text")
	if not taken.is_empty():
		return { "ok": false, "error": taken }

	var code: String = str(args.get("code", ""))
	if code == "":
		code = SHADER_EMPTY % [shader_type, SHADER_ENTRY.get(shader_type, "fragment")]

	var folder: String = GdhSceneFile.make_folder_for(shader_path)
	if not folder.is_empty():
		return { "ok": false, "error": folder }
	var file: FileAccess = FileAccess.open(shader_path, FileAccess.WRITE)
	if file == null:
		return {
			"ok": false,
			"error":
			(
				"Could not open %s for writing: %s"
				% [shader_path, error_string(FileAccess.get_open_error())]
			),
		}
	var written: bool = file.store_string(code)
	file.close()
	if not written:
		return { "ok": false, "error": "Failed to write the shader file " + shader_path }

	_written(shader_path)
	var answer: Dictionary = { "ok": true, "shaderPath": shader_path, "shaderType": shader_type }
	var errors: Array[Dictionary] = _shader_errors(shader_path)
	answer["compiles"] = errors.is_empty()
	if not errors.is_empty():
		answer["compileErrors"] = errors
	return answer


## The errors the engine raises compiling the shader at [param path], as {line, message} in order.
## A shader is compiled once something reads what it declares, and a create answering only the path
## left a missing semicolon to show up wherever the shader was first drawn with.
func _shader_errors(path: String) -> Array[Dictionary]:
	var caught: GdhShaderErrors = GdhShaderErrors.new()
	OS.add_logger(caught)
	var shader: Shader = (
		ResourceLoader.load(path, "Shader", ResourceLoader.CACHE_MODE_IGNORE) as Shader
	)
	if shader != null:
		var _uniforms: Array = shader.get_shader_uniform_list()
	OS.remove_logger(caught)
	return caught.raised


## Saves [param theme] over [param theme_path] with [param items] changed, answering "" or why not.
func _save_theme(theme: Theme, theme_path: String, items: Array) -> String:
	var previous: PackedByteArray = FileAccess.get_file_as_bytes(theme_path)
	var carried: Dictionary = GdhHeadlessCheck.embedded_in(
		GdhHeadlessCheck.stored(theme).values(), {}
	)
	var saving: Error = GdhSceneUids.save_keeping_uid(theme, theme_path)
	if saving != OK:
		return "Failed to save %s: %s" % [theme_path, error_string(saving)]
	var unkept: String = _unkept_headless(theme, theme_path, items, previous, carried)
	if not unkept.is_empty():
		return "Nothing was written: " + unkept + GdhHeadlessCheck.put_back(theme_path, previous)
	_written(theme_path)
	return ""


func set_theme_color(args: Dictionary) -> Dictionary:
	var theme_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if theme_path == "res://":
		return { "ok": false, "error": "resourcePath is required" }

	var color_name: String = str(args.get("colorName", ""))
	var control_type: String = str(args.get("controlType", ""))
	if color_name.is_empty() or control_type.is_empty():
		return { "ok": false, "error": "colorName and controlType are required" }

	var theme: Theme = _load_theme(theme_path)
	if theme == null:
		return { "ok": false, "error": "No Theme at %s. Create one there first." % theme_path }

	# Read as a property write reads a colour, html code included, so a value scene_node takes for a
	# Button's modulate is taken for its theme colour too; "#ff8000" was refused here alone.
	var parsed: Array = _properties.colour_from(args.get("color", {}), "color")
	if not parsed[0]:
		return { "ok": false, "error": parsed[1] }
	var color: Color = parsed[1]
	theme.set_color(color_name, control_type, color)

	var unsaved: String = _save_theme(
		theme, theme_path, ["%s/colors/%s" % [control_type, color_name]]
	)
	if not unsaved.is_empty():
		return { "ok": false, "error": unsaved }

	var saved: Theme = _load_theme(theme_path)
	if saved == null or not saved.has_color(color_name, control_type):
		return {
			"ok": false,
			"error": "The theme saved without %s/%s" % [control_type, color_name],
		}

	var stored: Color = saved.get_color(color_name, control_type)
	return _noting_variation(
		{
			"ok": true,
			"resourcePath": theme_path,
			"controlType": control_type,
			"colorName": color_name,
			"color": { "r": stored.r, "g": stored.g, "b": stored.b, "a": stored.a },
		}
	)


func set_theme_font_size(args: Dictionary) -> Dictionary:
	var theme_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if theme_path == "res://":
		return { "ok": false, "error": "resourcePath is required" }

	var font_size_name: String = str(args.get("fontSizeName", ""))
	var control_type: String = str(args.get("controlType", ""))
	if font_size_name.is_empty() or control_type.is_empty():
		return { "ok": false, "error": "fontSizeName and controlType are required" }

	var theme: Theme = _load_theme(theme_path)
	if theme == null:
		return { "ok": false, "error": "No Theme at %s. Create one there first." % theme_path }

	# Godot reads a size of 0 or less as unset and answers the theme's default, so -3 would be read
	# back as 16.
	var pixels: float = GdhRead.as_float(args.get("size"), 0.0)
	if not is_finite(pixels) or pixels != floorf(pixels):
		return {
			"ok": false,
			"error": "size is a whole number of pixels, and %s is not one." % str(pixels),
		}
	if pixels < 1:
		return {
			"ok": false,
			"error":
			(
				(
					"size must be 1 or more, not %d: the theme would hold it, and Godot reads a "
					+ "size of 0 or less as unset and draws the default size instead."
				)
				% int(pixels)
			),
		}
	theme.set_font_size(font_size_name, control_type, int(pixels))

	var unsaved: String = _save_theme(
		theme, theme_path, ["%s/font_sizes/%s" % [control_type, font_size_name]]
	)
	if not unsaved.is_empty():
		return { "ok": false, "error": unsaved }

	var saved: Theme = _load_theme(theme_path)
	if saved == null or not saved.has_font_size(font_size_name, control_type):
		return {
			"ok": false, "error": "The theme saved without %s/%s" % [control_type, font_size_name],
		}

	return _noting_variation(
		{
			"ok": true,
			"resourcePath": theme_path,
			"controlType": control_type,
			"fontSizeName": font_size_name,
			"size": saved.get_font_size(font_size_name, control_type),
		}
	)


## Takes one item, such as `"colors/font_color"`, or with none every item of a theme type, out of a
## Theme: a type is any name, so a misspelt one is written as given, and this is the way back.
func remove_theme_item(args: Dictionary) -> Dictionary:
	var theme_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	var control_type: String = str(args.get("controlType", ""))
	var theme: Theme = _load_theme(theme_path)
	if theme == null:
		return { "ok": false, "error": "No Theme at %s." % theme_path }
	if not theme.get_type_list().has(control_type):
		var types: PackedStringArray = theme.get_type_list()
		var said: String = "%s holds no type %s" % [theme_path, control_type]
		return { "ok": false, "error": GdhRead.offered(said, control_type, Array(types)) }
	var kinds: Array[String] = ["colors", "constants", "fonts", "font_sizes", "icons", "styles"]
	var item: String = str(args.get("item", ""))
	var removed: Array[String] = []
	var held: Array[String] = []
	for kind: int in kinds.size():
		for called: String in theme.get_theme_item_list(kind as Theme.DataType, control_type):
			var entry: String = "%s/%s" % [kinds[kind], called]
			held.append(entry)
			if item.is_empty() or item == entry:
				removed.append("%s/%s" % [control_type, entry])
				theme.clear_theme_item(kind as Theme.DataType, called, control_type)
	var base: String = theme.get_type_variation_base(control_type)
	if item.is_empty():
		# A variation's base is stored apart from its items and would outlive them in the file.
		if not base.is_empty():
			removed.append("%s/base_type" % control_type)
		theme.remove_type(control_type)
	elif removed.is_empty() and held.is_empty():
		var only: String = (
			"%s holds no items, only the type it varies, %s. "
			+ "Without item, remove_theme_item takes it out."
		)
		return { "ok": false, "error": only % [control_type, base] }
	elif removed.is_empty():
		return {
			"ok": false,
			"error": GdhRead.offered("%s has no item %s" % [control_type, item], item, held),
		}
	var unsaved: String = _save_theme(theme, theme_path, removed)
	if not unsaved.is_empty():
		return { "ok": false, "error": unsaved }
	return {
		"ok": true,
		"resourcePath": theme_path,
		"controlType": control_type,
		"removed": removed,
	}


## [param answer] with a note when its controlType names no class a theme styles. Any name is a
## theme type, so one that is no class is a type variation, which styles only a control whose
## theme_type_variation names it, and a misspelt "Buton" would otherwise read as Button set.
func _noting_variation(answer: Dictionary) -> Dictionary:
	var type: String = str(answer.get("controlType", ""))
	if (
		ClassDB.class_exists(type)
		and (ClassDB.is_parent_class(type, "Control") or ClassDB.is_parent_class(type, "Window"))
	):
		return answer
	answer["note"] = (
		(
			"%s is not a Control or Window class, so this is a type variation: it styles only a "
			+ "control whose theme_type_variation is %s."
		)
		% [type, type]
	)
	# A variation is any name, so a misspelt class is written all the same, and the classes nearest
	# it are what tells a caller which one was meant.
	var themed: PackedStringArray = []
	for known: String in ClassDB.get_class_list():
		if ClassDB.is_parent_class(known, "Control") or ClassDB.is_parent_class(known, "Window"):
			var _added: bool = themed.append(known)
	var close: PackedStringArray = GdhRead.nearest(type, themed)
	if not close.is_empty():
		answer["note"] += (
			(
				" If a class was meant, the nearest %s %s, and remove_theme_item with controlType "
				+ "%s takes this out."
			)
			% ["is" if close.size() == 1 else "are", ", ".join(close), type]
		)
	return answer


## Every shader error the engine raises while it is attached, in order.
class GdhShaderErrors:
	extends Logger

	var raised: Array[Dictionary] = []

	func _log_message(_message: String, _error: bool) -> void:
		pass

	# The engine's own signature for a Logger, eight parameters and not this project's to shape.
	# gdstyle:ignore=quality/max-parameters
	func _log_error(
		_function: String,
		_file: String,
		line: int,
		code: String,
		rationale: String,
		_editor_notify: bool,
		error_type: int,
		_script_backtraces: Array[ScriptBacktrace],
	) -> void:
		if error_type == Logger.ERROR_TYPE_SHADER:
			raised.append({ "line": line, "message": code if rationale.is_empty() else rationale })
