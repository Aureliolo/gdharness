extends SceneTree

## The shader tools hand back GLSL assembled from templates. A headless engine uses the dummy
## renderer and compiles no shaders at all, so this cannot ask the engine whether the source is
## valid; what it can do is catch the way an assembled template breaks, which is a fragment
## going missing: an unfilled placeholder, a lost declaration, an unclosed brace.

var failures: Array[String] = []


func _init() -> void:
	var tools = load("res://addons/godot_mcp_editor/tools/resource_tools.gd").new()

	for template in ["basic", "color_shift", "outline", "", "nonesuch"]:
		_check_written_shader(tools, template)

	for theme in ["medieval", "cyberpunk", "nature", "scifi", "horror", "cartoon", "nonesuch"]:
		for effect in ["glow", "hologram", "wind_sway", "torch_fire", "dissolve", "outline", "nonesuch"]:
			_check_theme_shader(tools, theme, effect)

	tools.free()

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _braces_balance(source: String) -> bool:
	var depth := 0
	for i in source.length():
		if source[i] == "{":
			depth += 1
		elif source[i] == "}":
			depth -= 1
			if depth < 0:
				return false
	return depth == 0


func _check_shape(label: String, source: String, expected_type: String) -> bool:
	if not source.begins_with("shader_type %s;" % expected_type):
		_fail("%s lost its shader_type line: %s" % [label, source.substr(0, 40)])
		return false
	if source.contains("%s") or source.contains("%d") or source.contains("%f"):
		_fail("%s left a format placeholder unfilled" % label)
		return false
	if not source.contains("void fragment()"):
		_fail("%s has no fragment function" % label)
		return false
	if not _braces_balance(source):
		_fail("%s has unbalanced braces" % label)
		return false
	return true


func _check_written_shader(tools: Object, template: String) -> void:
	var label := "create_shader(%s)" % ("<empty>" if template.is_empty() else template)
	var shader_path := "res://fixture_%s.gdshader" % ("default" if template.is_empty() else template)
	var result: Dictionary = tools.create_shader(
		{"shaderPath": shader_path, "shaderType": "canvas_item", "template": template}
	)
	if not result.get("ok", false):
		_fail("%s failed: %s" % [label, JSON.stringify(result)])
		return

	var file := FileAccess.open(shader_path, FileAccess.READ)
	if file == null:
		_fail("%s wrote nothing to %s" % [label, shader_path])
		return
	var source := file.get_as_text()
	file.close()

	if not _check_shape(label, source, "canvas_item"):
		return

	# Each template carries something only it declares, so a template falling through to the
	# empty one reads as success without this.
	match template:
		"basic":
			if not source.contains("COLOR = vec4(1.0);"):
				_fail("%s is not the basic template" % label)
		"color_shift":
			if not source.contains("uniform vec4 color_shift"):
				_fail("%s lost its color_shift uniform" % label)
		"outline":
			if not source.contains("uniform float outline_width"):
				_fail("%s lost its outline_width uniform" % label)
			if not source.contains("TEXTURE_PIXEL_SIZE"):
				_fail("%s lost its outline body" % label)


func _check_theme_shader(tools: Object, theme: String, effect: String) -> void:
	var label := "theme shader %s/%s" % [theme, effect]
	var source: String = tools._get_theme_shader_code(theme, effect)

	if not _check_shape(label, source, "spatial"):
		return
	if not source.contains("vec3 base_col ="):
		_fail("%s lost its base colour" % label)
		return
	if not source.contains("ALBEDO"):
		_fail("%s writes nothing to ALBEDO" % label)
		return

	match effect:
		"glow":
			if not source.contains("EMISSION = base_col * (0.5 + 0.5 * sin(TIME * 2.0));"):
				_fail("%s lost its glow body" % label)
		"hologram":
			if not source.contains("float scan =") or not source.contains("ALPHA = 0.65;"):
				_fail("%s lost its hologram body" % label)
		"wind_sway":
			if not source.contains("0.05 * sin(TIME + UV.x * 10.0)"):
				_fail("%s lost its wind_sway body" % label)
		"torch_fire":
			if not source.contains("float flicker =") or not source.contains("vec3(1.0, 0.5, 0.1)"):
				_fail("%s lost its torch_fire body" % label)
		"dissolve":
			if not source.contains("43758.5453") or not source.contains("ALPHA = step(cut, n);"):
				_fail("%s lost its dissolve body" % label)
		"outline":
			if not source.contains("step(0.85, e)"):
				_fail("%s lost its outline body" % label)
