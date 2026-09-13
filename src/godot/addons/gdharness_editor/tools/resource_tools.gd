@tool
extends Node

## Resource files, shaders, tilesets and themes, written through the open editor.

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
		var project_abs: String = ProjectSettings.globalize_path("res://")
		if path.begins_with(project_abs):
			var rel: String = path.substr(project_abs.length())
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
		var json: JSON = JSON.new()
		if json.parse(raw) == OK and typeof(json.data) == TYPE_DICTIONARY:
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
	var loaded: Resource = ResourceLoader.load(theme_path, "Theme", ResourceLoader.CACHE_MODE_IGNORE)
	if loaded is Theme:
		return loaded
	return null


func _save_scene_root(root: Node, scene_path: String) -> Error:
	var packed: PackedScene = PackedScene.new()
	var pack_result: Error = packed.pack(root)
	if pack_result != OK:
		return pack_result
	return ResourceSaver.save(packed, scene_path)


func create_resource(args: Dictionary) -> Dictionary:
	var res_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	var resource_type: String = str(args.get("resourceType", "Resource"))
	if res_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}

	var instance: Variant = ClassDB.instantiate(resource_type)
	if instance == null or not (instance is Resource):
		return {"ok": false, "error": "Failed to instantiate resource type", "resourceType": resource_type}
	var resource: Resource = instance

	var script_path: String = str(args.get("script", ""))
	if script_path != "":
		var script_obj: Resource = load(_ensure_res_path(script_path))
		if script_obj:
			resource.set_script(script_obj)

	if args.has("properties"):
		_set_resource_properties(resource, args.get("properties"))

	var save_result: Error = ResourceSaver.save(resource, res_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save resource", "code": save_result}

	_refresh_filesystem()
	return {"ok": true, "resourcePath": res_path, "resourceType": args.get("resourceType")}


func modify_resource(args: Dictionary) -> Dictionary:
	var res_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if res_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}

	var resource: Resource = load(res_path)
	if resource == null:
		return {"ok": false, "error": "Resource not found", "resourcePath": res_path}

	_set_resource_properties(resource, args.get("properties", ""))
	var save_result: Error = ResourceSaver.save(resource, res_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save resource", "code": save_result}

	_refresh_filesystem()
	return {"ok": true, "resourcePath": res_path}


func create_shader(args: Dictionary) -> Dictionary:
	var shader_path: String = _ensure_res_path(str(args.get("shaderPath", "")))
	var shader_type: String = str(args.get("shaderType", "canvas_item"))
	if shader_path == "res://":
		return {"ok": false, "error": "shaderPath is required"}

	var code: String = str(args.get("code", ""))
	var template: String = str(args.get("template", ""))

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

	var file: FileAccess = FileAccess.open(shader_path, FileAccess.WRITE)
	if file == null:
		return {"ok": false, "error": "Failed to open shader file for writing", "shaderPath": shader_path}
	file.store_string(code)
	file.close()

	_refresh_filesystem()
	return {"ok": true, "shaderPath": shader_path, "shaderType": shader_type}


func create_tileset(args: Dictionary) -> Dictionary:
	var tileset_path: String = _ensure_res_path(str(args.get("tilesetPath", "")))
	if tileset_path == "res://":
		return {"ok": false, "error": "tilesetPath is required"}

	var tileset: TileSet = TileSet.new()
	var sources: Variant = args.get("sources", [])
	if typeof(sources) != TYPE_ARRAY:
		sources = []

	for entry: Variant in sources:
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var source: Dictionary = entry
		var atlas: TileSetAtlasSource = TileSetAtlasSource.new()
		var tex_path: String = _ensure_res_path(str(source.get("texture", "")))
		var tex: Texture2D = load(tex_path) as Texture2D
		if tex == null:
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

	var save_result: Error = ResourceSaver.save(tileset, tileset_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save TileSet", "code": save_result}

	_refresh_filesystem()
	return {"ok": true, "tilesetPath": tileset_path}


## The source ids a tile set holds, for saying what a cell could have named instead.
func _source_ids(tile_set: TileSet) -> PackedInt32Array:
	var ids: PackedInt32Array = PackedInt32Array()
	for index: int in tile_set.get_source_count():
		ids.append(tile_set.get_source_id(index))
	return ids


func set_tilemap_cells(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var node_path: String = str(args.get("tilemapNodePath", ""))
	if scene_path == "res://":
		return {"ok": false, "error": "scenePath is required"}

	var scene_res: PackedScene = load(scene_path) as PackedScene
	if scene_res == null:
		return {"ok": false, "error": "Scene not found", "scenePath": scene_path}

	var root: Node = scene_res.instantiate()
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

	var layer: int = int(args.get("layer", 0))
	var cells: Variant = args.get("cells", [])
	# Refused rather than skipped: placing nothing and answering success is indistinguishable
	# from placing everything, and the caller only finds out by opening the scene.
	if typeof(cells) != TYPE_ARRAY:
		root.queue_free()
		return {"ok": false, "error": "cells must be an array of cells to place"}

	var placed: Array = cells
	if placed.is_empty():
		root.queue_free()
		return {"ok": false, "error": "cells is empty, so there is nothing to place"}

	# set_cell stores a cell whatever source id it is given, and a tile set without that source
	# simply draws nothing, so the source is checked here: the alternative is a call that reports
	# placing tiles and a scene that shows none.
	var tile_set: TileSet = tilemap.tile_set
	if tile_set == null:
		root.queue_free()
		return {"ok": false, "error": "The TileMap has no TileSet, so no cell can name a source"}

	var written: int = 0
	for entry: Variant in placed:
		if typeof(entry) != TYPE_DICTIONARY:
			root.queue_free()
			return {
				"ok": false, "error": "every cell must be an object with coords, sourceId and atlasCoords"
			}
		var cell: Dictionary = entry
		var source_id: int = int(cell.get("sourceId", -1))
		if not tile_set.has_source(source_id):
			root.queue_free()
			return {
				"ok": false,
				"error": "The TileSet has no source %d; it has %s" % [source_id, _source_ids(tile_set)]
			}

		var coords: Dictionary = cell.get("coords", {})
		var atlas_coords: Dictionary = cell.get("atlasCoords", {})
		var at: Vector2i = Vector2i(int(coords.get("x", 0)), int(coords.get("y", 0)))
		tilemap.set_cell(
			layer,
			at,
			source_id,
			Vector2i(int(atlas_coords.get("x", 0)), int(atlas_coords.get("y", 0))),
			int(cell.get("alternativeTile", 0))
		)
		if tilemap.get_cell_source_id(layer, at) != -1:
			written += 1

	var save_result: Error = _save_scene_root(root, scene_path)
	root.queue_free()
	if save_result != OK:
		return {"ok": false, "error": "Failed to save scene", "code": save_result}

	_refresh_filesystem()
	return {"ok": true, "layer": layer, "placed": written, "requested": placed.size()}


func set_theme_color(args: Dictionary) -> Dictionary:
	var theme_path: String = _ensure_res_path(str(args.get("themePath", "")))
	if theme_path == "res://":
		return {"ok": false, "error": "themePath is required"}

	var color_name: String = str(args.get("colorName", ""))
	var control_type: String = str(args.get("controlType", ""))
	if color_name.is_empty() or control_type.is_empty():
		return {"ok": false, "error": "colorName and controlType are required"}

	var theme: Theme = _load_theme(theme_path)
	if theme == null:
		return {"ok": false, "error": "No Theme at %s. Create one there first." % theme_path}

	var c: Dictionary = args.get("color", {})
	var color: Color = Color(
		float(c.get("r", 1.0)), float(c.get("g", 1.0)), float(c.get("b", 1.0)), float(c.get("a", 1.0))
	)
	theme.set_color(color_name, control_type, color)

	var save_result: Error = ResourceSaver.save(theme, theme_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save theme", "code": save_result}

	_refresh_filesystem()

	var saved: Theme = _load_theme(theme_path)
	if saved == null or not saved.has_color(color_name, control_type):
		return {"ok": false, "error": "The theme saved without %s/%s" % [control_type, color_name]}

	var stored: Color = saved.get_color(color_name, control_type)
	return {
		"ok": true,
		"themePath": theme_path,
		"controlType": control_type,
		"colorName": color_name,
		"color": {"r": stored.r, "g": stored.g, "b": stored.b, "a": stored.a}
	}


func set_theme_font_size(args: Dictionary) -> Dictionary:
	var theme_path: String = _ensure_res_path(str(args.get("themePath", "")))
	if theme_path == "res://":
		return {"ok": false, "error": "themePath is required"}

	var font_size_name: String = str(args.get("fontSizeName", ""))
	var control_type: String = str(args.get("controlType", ""))
	if font_size_name.is_empty() or control_type.is_empty():
		return {"ok": false, "error": "fontSizeName and controlType are required"}

	var theme: Theme = _load_theme(theme_path)
	if theme == null:
		return {"ok": false, "error": "No Theme at %s. Create one there first." % theme_path}

	theme.set_font_size(font_size_name, control_type, int(args.get("size", 0)))

	var save_result: Error = ResourceSaver.save(theme, theme_path)
	if save_result != OK:
		return {"ok": false, "error": "Failed to save theme", "code": save_result}

	_refresh_filesystem()

	var saved: Theme = _load_theme(theme_path)
	if saved == null or not saved.has_font_size(font_size_name, control_type):
		return {"ok": false, "error": "The theme saved without %s/%s" % [control_type, font_size_name]}

	return {
		"ok": true,
		"themePath": theme_path,
		"controlType": control_type,
		"fontSizeName": font_size_name,
		"size": saved.get_font_size(font_size_name, control_type)
	}
