@tool
class_name MCPResourceTools
extends Node

# Shader templates. Written as real multi-line source rather than escaped one-liners so that
# what ends up in the .gdshader can be read here. The %s is the shader type.
const SHADER_EMPTY: String = """shader_type %s;

void fragment() {
}
"""

const SHADER_BASIC: String = """shader_type %s;

void fragment() {
	COLOR = vec4(1.0);
}
"""

const SHADER_COLOR_SHIFT: String = """shader_type %s;

uniform vec4 color_shift : source_color = vec4(0.1, 0.0, 0.2, 0.0);

void fragment() {
	vec4 base = texture(TEXTURE, UV);
	COLOR = vec4(clamp(base.rgb + color_shift.rgb, 0.0, 1.0), base.a);
}
"""

const SHADER_OUTLINE: String = """shader_type %s;

uniform vec4 outline_color : source_color = vec4(0.0, 0.0, 0.0, 1.0);
uniform float outline_width : hint_range(0.0, 8.0) = 1.0;

void fragment() {
	vec2 px = TEXTURE_PIXEL_SIZE * outline_width;
	float a = texture(TEXTURE, UV).a;
	float edge = max(
		max(texture(TEXTURE, UV + vec2(px.x, 0.0)).a, texture(TEXTURE, UV - vec2(px.x, 0.0)).a),
		max(texture(TEXTURE, UV + vec2(0.0, px.y)).a, texture(TEXTURE, UV - vec2(0.0, px.y)).a)
	);
	vec4 base = texture(TEXTURE, UV);
	COLOR = mix(outline_color * edge, base, a);
}
"""

var _editor_plugin: EditorPlugin = null


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


func _ensure_res_path(path: String) -> String:
	if path.begins_with("res://"):
		return path
	if path.begins_with("/"):
		var project_abs := ProjectSettings.globalize_path("res://")
		if path.begins_with(project_abs):
			var rel := path.substr(project_abs.length())
			return "res://" + rel
	return "res://" + path


func _refresh_filesystem() -> void:
	if _editor_plugin:
		EditorInterface.get_resource_filesystem().scan()


func _parse_value(value: Variant) -> Variant:
	if typeof(value) == TYPE_DICTIONARY:
		var fields: Dictionary = value
		if fields.has("type") or fields.has("_type"):
			var t: Variant = fields.get("type", fields.get("_type", ""))
			match t:
				"Vector2":
					return Vector2(fields.get("x", 0), fields.get("y", 0))
				"Vector3":
					return Vector3(fields.get("x", 0), fields.get("y", 0), fields.get("z", 0))
				"Color":
					return Color(
						fields.get("r", 1), fields.get("g", 1), fields.get("b", 1), fields.get("a", 1)
					)
				"Vector2i":
					return Vector2i(fields.get("x", 0), fields.get("y", 0))
				"Vector3i":
					return Vector3i(fields.get("x", 0), fields.get("y", 0), fields.get("z", 0))
				"Rect2":
					return Rect2(
						fields.get("x", 0),
						fields.get("y", 0),
						fields.get("width", 0),
						fields.get("height", 0)
					)
				"NodePath":
					return NodePath(fields.get("path", ""))
	if typeof(value) == TYPE_ARRAY:
		var result: Array = []
		for item: Variant in value:
			result.append(_parse_value(item))
		return result
	return value


func _set_resource_properties(resource: Resource, properties: Variant) -> void:
	var props: Dictionary = _parse_properties_dict(properties)
	for key: Variant in props:
		var val: Variant = _parse_value(props[key])
		resource.set(key, val)


func _parse_properties_dict(raw: Variant) -> Dictionary:
	if typeof(raw) == TYPE_DICTIONARY:
		return raw
	if typeof(raw) == TYPE_STRING and raw != "":
		var json := JSON.new()
		if json.parse(raw) == OK and typeof(json.data) == TYPE_DICTIONARY:
			return json.data
	return {}


func _load_theme(theme_path: String) -> Theme:
	var loaded: Resource = load(theme_path)
	if loaded is Theme:
		return loaded
	return Theme.new()


func _save_scene_root(root: Node, scene_path: String) -> int:
	var packed := PackedScene.new()
	var pack_result := packed.pack(root)
	if pack_result != OK:
		return pack_result
	return ResourceSaver.save(packed, scene_path)


func create_resource(args: Dictionary) -> Dictionary:
	var res_path := _ensure_res_path(str(args.get("resourcePath", "")))
	var resource_type := str(args.get("resourceType", "Resource"))
	if res_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}

	var instance: Variant = ClassDB.instantiate(resource_type)
	if instance == null or not (instance is Resource):
		return {"ok": false, "error": "Failed to instantiate resource type", "resourceType": resource_type}
	var resource: Resource = instance

	var script_path := str(args.get("script", ""))
	if script_path != "":
		var script_obj: Resource = load(_ensure_res_path(script_path))
		if script_obj:
			resource.set_script(script_obj)

	if args.has("properties"):
		_set_resource_properties(resource, args.get("properties"))

	var save_result := ResourceSaver.save(resource, res_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save resource", "code": save_result}

	_refresh_filesystem()
	return {"ok": true, "resourcePath": res_path, "resourceType": args.get("resourceType")}


func modify_resource(args: Dictionary) -> Dictionary:
	var res_path := _ensure_res_path(str(args.get("resourcePath", "")))
	if res_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}

	var resource: Resource = load(res_path)
	if resource == null:
		return {"ok": false, "error": "Resource not found", "resourcePath": res_path}

	_set_resource_properties(resource, args.get("properties", ""))
	var save_result := ResourceSaver.save(resource, res_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save resource", "code": save_result}

	_refresh_filesystem()
	return {"ok": true, "resourcePath": res_path}


func create_shader(args: Dictionary) -> Dictionary:
	var shader_path := _ensure_res_path(str(args.get("shaderPath", "")))
	var shader_type := str(args.get("shaderType", "canvas_item"))
	if shader_path == "res://":
		return {"ok": false, "error": "shaderPath is required"}

	var code := str(args.get("code", ""))
	var template := str(args.get("template", ""))

	if code == "":
		match template:
			"basic":
				code = SHADER_BASIC % shader_type
			"color_shift":
				code = SHADER_COLOR_SHIFT % shader_type
			"outline":
				code = SHADER_OUTLINE % shader_type
			_:
				code = SHADER_EMPTY % shader_type

	var file := FileAccess.open(shader_path, FileAccess.WRITE)
	if file == null:
		return {"ok": false, "error": "Failed to open shader file for writing", "shaderPath": shader_path}
	file.store_string(code)
	file.close()

	_refresh_filesystem()
	return {"ok": true, "shaderPath": shader_path, "shaderType": shader_type}


func create_tileset(args: Dictionary) -> Dictionary:
	var tileset_path := _ensure_res_path(str(args.get("tilesetPath", "")))
	if tileset_path == "res://":
		return {"ok": false, "error": "tilesetPath is required"}

	var tileset := TileSet.new()
	var sources: Variant = args.get("sources", [])
	if typeof(sources) != TYPE_ARRAY:
		sources = []

	for source: Variant in sources:
		if typeof(source) != TYPE_DICTIONARY:
			continue
		var atlas := TileSetAtlasSource.new()
		var tex_path := _ensure_res_path(str(source.get("texture", "")))
		var tex: Resource = load(tex_path)
		if not tex is Texture2D:
			continue
		atlas.texture = tex

		var tile_size: Dictionary = source.get("tileSize", {})
		atlas.texture_region_size = Vector2i(int(tile_size.get("x", 0)), int(tile_size.get("y", 0)))

		if source.has("separation"):
			var sep: Dictionary = source.get("separation", {})
			atlas.separation = Vector2i(int(sep.get("x", 0)), int(sep.get("y", 0)))

		if source.has("offset"):
			var off: Dictionary = source.get("offset", {})
			atlas.margins = Vector2i(int(off.get("x", 0)), int(off.get("y", 0)))

		tileset.add_source(atlas)

	var save_result := ResourceSaver.save(tileset, tileset_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save TileSet", "code": save_result}

	_refresh_filesystem()
	return {"ok": true, "tilesetPath": tileset_path}


func set_tilemap_cells(args: Dictionary) -> Dictionary:
	var scene_path := _ensure_res_path(str(args.get("scenePath", "")))
	var node_path := str(args.get("tilemapNodePath", ""))
	if scene_path == "res://":
		return {"ok": false, "error": "scenePath is required"}

	var scene_res: Resource = load(scene_path)
	if not scene_res is PackedScene:
		return {"ok": false, "error": "Scene not found", "scenePath": scene_path}

	var root: Node = (scene_res as PackedScene).instantiate()
	if root == null:
		return {"ok": false, "error": "Failed to instantiate scene"}

	var tilemap: TileMap = null
	if node_path == "." or node_path == "":
		tilemap = root as TileMap
	else:
		tilemap = root.get_node_or_null(node_path) as TileMap

	if tilemap == null:
		root.queue_free()
		return {"ok": false, "error": "TileMap node not found", "tilemapNodePath": node_path}

	var layer := int(args.get("layer", 0))
	var cells: Variant = args.get("cells", [])
	if typeof(cells) != TYPE_ARRAY:
		cells = []

	for cell: Variant in cells:
		if typeof(cell) != TYPE_DICTIONARY:
			continue
		var coords: Dictionary = cell.get("coords", {})
		var atlas_coords: Dictionary = cell.get("atlasCoords", {})
		tilemap.set_cell(
			layer,
			Vector2i(int(coords.get("x", 0)), int(coords.get("y", 0))),
			int(cell.get("sourceId", -1)),
			Vector2i(int(atlas_coords.get("x", 0)), int(atlas_coords.get("y", 0))),
			int(cell.get("alternativeTile", 0))
		)

	var save_result := _save_scene_root(root, scene_path)
	root.queue_free()
	if save_result != OK:
		return {"ok": false, "error": "Failed to save scene", "code": save_result}

	_refresh_filesystem()
	return {"ok": true, "cellCount": cells.size()}


func set_theme_color(args: Dictionary) -> Dictionary:
	var theme_path := _ensure_res_path(str(args.get("themePath", "")))
	if theme_path == "res://":
		return {"ok": false, "error": "themePath is required"}

	var theme := _load_theme(theme_path)
	var c: Dictionary = args.get("color", {})
	var color := Color(
		float(c.get("r", 1.0)), float(c.get("g", 1.0)), float(c.get("b", 1.0)), float(c.get("a", 1.0))
	)
	theme.set_color(str(args.get("colorName", "")), str(args.get("controlType", "")), color)

	var save_result := ResourceSaver.save(theme, theme_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save theme", "code": save_result}

	_refresh_filesystem()
	return {"ok": true}


func set_theme_font_size(args: Dictionary) -> Dictionary:
	var theme_path := _ensure_res_path(str(args.get("themePath", "")))
	if theme_path == "res://":
		return {"ok": false, "error": "themePath is required"}

	var theme := _load_theme(theme_path)
	theme.set_font_size(
		str(args.get("fontSizeName", "")), str(args.get("controlType", "")), int(args.get("size", 0))
	)

	var save_result := ResourceSaver.save(theme, theme_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save theme", "code": save_result}

	_refresh_filesystem()
	return {"ok": true}
