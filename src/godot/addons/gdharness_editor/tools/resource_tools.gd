@tool
extends Node

## Resource files, shaders, tilesets and themes, written through the open editor.

const GdhFileReads = preload("../file_reads.gd")
const GdhHeadlessCheck = preload("../headless_check.gd")
const GdhPropertyValues = preload("../property_values.gd")
const GdhRead = preload("../reading.gd")
const GdhSceneFile = preload("../scene_file.gd")

# The minimal shader of a type: its declaration and the one function the engine calls for it.
const SHADER_EMPTY: String = """shader_type %s;

void %s() {
}
"""
const SHADER_ENTRY: Dictionary[String, String] = {
	"canvas_item": "fragment", "spatial": "fragment", "particles": "process", "sky": "sky", "fog": "fog"
}

## How many cells a read of a tile map lists, enough for a level's worth and not a whole world's.
const CELLS_SHOWN: int = 1000

var _editor_plugin: EditorPlugin = null
var _properties: GdhPropertyValues = GdhPropertyValues.new()


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
		"%s already exists, and %s would replace everything in it. %s, or create the new one under another path."
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


## A pair of whole numbers given as {"x": 1, "y": 2} or [1, 2], as [true, Vector2i] or
## [false, why]. The server checks the arguments it is given but not what is inside them, and a
## pair given the other way went into a typed local and failed as "Invalid tool result".
func _xy(value: Variant, label: String) -> Array:
	var x: Variant = null
	var y: Variant = null
	if value is Dictionary:
		var fields: Dictionary = value
		x = fields.get("x")
		y = fields.get("y")
	elif value is Array:
		var pair: Array = value
		if pair.size() == 2:
			x = pair[0]
			y = pair[1]
	for number: Variant in [x, y]:
		if (
			not (number is float or number is int)
			or GdhRead.as_float(number) != floorf(GdhRead.as_float(number))
		):
			return [
				false,
				'%s must be two whole numbers, {"x": .., "y": ..}, not %s.' % [label, JSON.stringify(value)]
			]
	return [true, Vector2i(GdhRead.as_int(x), GdhRead.as_int(y))]


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


## Saves [param resource] to [param path] and reads the file back, answering "" when each of
## [param names] loads as [param resource] holds it, or why not. On a mismatch the file is put back
## as it was, [param previous], or removed when there was none.
##
## Read back because a property can be set and still not be saved: one without storage, a
## script variable that is not exported. Both were answered as changed.
func _save_checked(resource: Resource, path: String, names: Array, previous: Variant) -> String:
	var saving: Error = GdhSceneFile.save_keeping_uid(resource, path)
	if saving != OK:
		return "Failed to save %s: %s" % [path, error_string(saving)]
	var unkept: String = _unkept_headless(resource, path, names, previous)
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
			if not GdhPropertyValues.same(read, _properties.read_at(resource, property)):
				lost = (
					(
						"%s.%s would load from the file as %s: it is not a property the file keeps, so "
						+ "nothing was changed."
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
## or why that did not hold. See [GdhHeadlessCheck].
func _unkept_headless(resource: Resource, path: String, names: Array, previous: Variant) -> String:
	if Engine.is_editor_hint():
		return ""
	var script: Script = resource.get_script()
	var scripted: bool = script != null and not script.is_tool()
	if not path.ends_with(".tres"):
		if scripted or GdhHeadlessCheck.holds_scripted_embedded(resource, {}):
			return (
				(
					(
						"%s is a binary resource with a script that is not a tool, and what that script "
						+ "changed when a headless engine loaded it cannot be told apart from the file here. "
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
	var asked: Dictionary = {"script": true}
	var reached: Dictionary = {}
	for key: Variant in names:
		var property: String = str(key)
		asked[property] = true
		asked[property.get_slice(":", 0)] = true
		reached.merge(GdhHeadlessCheck.reached(resource, property))
	return GdhHeadlessCheck.settle_saved(
		path,
		before,
		GdhHeadlessCheck.stored(resource).values(),
		resource if scripted else null,
		asked,
		reached,
		func() -> Error: return GdhSceneFile.save_keeping_uid(resource, path)
	)


func create_resource(args: Dictionary) -> Dictionary:
	var res_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	var resource_type: String = str(args.get("resourceType", "Resource"))
	var asked_type: String = resource_type
	if res_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}
	var taken: String = _taken(res_path, "resource_edit op=create")
	if not taken.is_empty():
		return {"ok": false, "error": taken}

	var script_path: String = str(args.get("script", ""))
	var made: Dictionary = GdhSceneFile.made_as(
		resource_type, "" if script_path == "" else _ensure_res_path(script_path), "Resource", "resourceType"
	)
	if made.has("error"):
		return {"ok": false, "error": made["error"]}
	resource_type = str(made["type"])
	script_path = str(made["script"])
	if not ClassDB.class_exists(resource_type):
		return {
			"ok": false,
			"error":
			(
				"%s is neither an engine class nor a class_name a script in this project declares."
				% resource_type
			)
		}
	if not ClassDB.is_parent_class(resource_type, "Resource") or not ClassDB.can_instantiate(resource_type):
		return {"ok": false, "error": "%s is not a resource class that can be created." % resource_type}
	var resource: Resource = ClassDB.instantiate(resource_type)

	# A script that did not load was skipped, and a plain resource was saved in place of the custom
	# one asked for.
	if script_path != "":
		var script_file: String = _ensure_res_path(script_path)
		var script: Script = load(script_file) as Script
		if script == null:
			return {"ok": false, "error": "No script loads from " + script_file}
		var uncompiled: String = GdhSceneFile.uncompiled(script, script_file)
		if not uncompiled.is_empty():
			return {"ok": false, "error": uncompiled}
		var base: String = str(script.get_instance_base_type())
		if not ClassDB.is_parent_class(resource_type, base):
			return {
				"ok": false,
				"error": "%s extends %s, so it cannot be on a %s." % [script_file, base, resource_type]
			}
		resource.set_script(script)

	var properties: Dictionary = _parse_properties_dict(args.get("properties", {}))
	var refused: String = _properties.write_all(resource, properties)
	if not refused.is_empty():
		return {"ok": false, "error": refused}

	var folder: String = GdhSceneFile.make_folder_for(res_path)
	if not folder.is_empty():
		return {"ok": false, "error": folder}
	var failed: String = _save_checked(resource, res_path, properties.keys(), null)
	if not failed.is_empty():
		return {"ok": false, "error": failed}
	return {"ok": true, "resourcePath": res_path, "resourceType": asked_type}


func modify_resource(args: Dictionary) -> Dictionary:
	var res_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if res_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}
	if not FileAccess.file_exists(res_path):
		return {"ok": false, "error": "No resource at " + res_path}
	# The editor's copy of an imported file is rebuilt from the source on every import, and a save
	# to it fails; edited through the cache, the editor kept the changed copy after the refusal.
	if FileAccess.file_exists(res_path + ".import"):
		return {
			"ok": false,
			"error":
			(
				(
					"%s is imported, so what it holds comes from its source file and its import options. "
					+ "Change those with project_import op=set_options."
				)
				% res_path
			)
		}

	# Past the cache, so a refusal leaves the copy open scenes hold as it was.
	var resource: Resource = ResourceLoader.load(res_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if resource == null:
		return {"ok": false, "error": "%s did not load as a resource." % res_path}

	var properties: Dictionary = _parse_properties_dict(args.get("properties", ""))
	var refused: String = _properties.write_all(resource, properties)
	if not refused.is_empty():
		return {"ok": false, "error": refused}
	var previous: PackedByteArray = FileAccess.get_file_as_bytes(res_path)
	var failed: String = _save_checked(resource, res_path, properties.keys(), previous)
	if not failed.is_empty():
		return {"ok": false, "error": failed}
	return {"ok": true, "resourcePath": res_path}


## What a resource file holds, read as a headless engine reads it with no editor connected.
func read_resource(args: Dictionary) -> Dictionary:
	var res_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if res_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}
	# The server takes a resource kept inside a file apart, so the boundary judges the file alone.
	var inner: String = str(args.get("subResource", ""))
	if not inner.is_empty():
		res_path += "::" + inner
	return GdhFileReads.resource(res_path, GdhRead.as_bool(args.get("includeDefaults", false)))


func create_shader(args: Dictionary) -> Dictionary:
	var shader_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	var shader_type: String = str(args.get("shaderType", "canvas_item"))
	if shader_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}
	var taken: String = _taken(shader_path, "resource_edit op=create_shader", "Edit its text")
	if not taken.is_empty():
		return {"ok": false, "error": taken}

	var code: String = str(args.get("code", ""))
	if code == "":
		code = SHADER_EMPTY % [shader_type, SHADER_ENTRY.get(shader_type, "fragment")]

	var folder: String = GdhSceneFile.make_folder_for(shader_path)
	if not folder.is_empty():
		return {"ok": false, "error": folder}
	var file: FileAccess = FileAccess.open(shader_path, FileAccess.WRITE)
	if file == null:
		return {
			"ok": false,
			"error":
			"Could not open %s for writing: %s" % [shader_path, error_string(FileAccess.get_open_error())]
		}
	var written: bool = file.store_string(code)
	file.close()
	if not written:
		return {"ok": false, "error": "Failed to write the shader file " + shader_path}

	_written(shader_path)
	return {"ok": true, "shaderPath": shader_path, "shaderType": shader_type}


func create_tileset(args: Dictionary) -> Dictionary:
	var tileset_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if tileset_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}
	var taken: String = _taken(tileset_path, "resource_edit op=create_tileset")
	if not taken.is_empty():
		return {"ok": false, "error": taken}

	var given: Variant = args.get("sources", [])
	if not given is Array:
		return {"ok": false, "error": "sources must list at least one atlas"}
	var sources: Array = given
	if sources.is_empty():
		return {"ok": false, "error": "sources must list at least one atlas"}

	var tileset: TileSet = TileSet.new()
	var made: Array = []
	for index: int in sources.size():
		var built: Array = _atlas(sources[index], index)
		if not built[0]:
			return {"ok": false, "error": built[1]}
		var atlas: TileSetAtlasSource = built[1]
		# The first source sets the tile set's own tile size, which is what a TileMapLayer draws
		# cells at; left at its default of 16 it did not match the atlas.
		if index == 0:
			tileset.tile_size = atlas.texture_region_size
		var added: int = tileset.add_source(atlas)
		if added < 0:
			return {
				"ok": false,
				"error": "The TileSet did not take the atlas for %s" % atlas.texture.resource_path
			}
		made.append(
			{"sourceId": added, "texture": atlas.texture.resource_path, "tiles": atlas.get_tiles_count()}
		)

	var folder: String = GdhSceneFile.make_folder_for(tileset_path)
	if not folder.is_empty():
		return {"ok": false, "error": folder}
	var saving: Error = GdhSceneFile.save_keeping_uid(tileset, tileset_path)
	if saving != OK:
		return {"ok": false, "error": "Failed to save %s: %s" % [tileset_path, error_string(saving)]}

	_written(tileset_path)
	return {"ok": true, "tilesetPath": tileset_path, "sources": made}


## One atlas source from its description, with its tiles made, as [true, source] or [false, why].
##
## Tiles are made in every cell of the grid that has a pixel that is not transparent, which is
## what the editor offers to do when an atlas gets a texture. Without them the atlas held no tiles,
## and every cell painted from it drew nothing.
func _atlas(entry: Variant, index: int) -> Array:
	if not entry is Dictionary:
		return [false, "sources[%d] must be an object with texture and tileSize" % index]
	var source: Dictionary = entry
	var texture_path: String = str(source.get("texture", ""))
	if not texture_path.begins_with("res://") and not texture_path.begins_with("uid://"):
		texture_path = _ensure_res_path(texture_path)
	# Contained here as well as on the server: a relative path climbing out of the project became
	# res://../../ and was loaded.
	if texture_path.split("/").has(".."):
		return [false, "sources[%d].texture leaves the project: %s" % [index, texture_path]]
	if not ResourceLoader.exists(texture_path):
		# An image the engine has not imported loads as nothing, where "no texture" would send a caller
		# looking for a file that is there.
		if FileAccess.file_exists(texture_path) and not FileAccess.file_exists(texture_path + ".import"):
			return [
				false,
				(
					(
						"sources[%d].texture: %s has not been imported, so the engine has no texture for it "
						+ "yet. project_import reimport with resourcePath %s imports it."
					)
					% [index, texture_path, texture_path]
				)
			]
		return [false, "sources[%d].texture: no texture at %s" % [index, texture_path]]
	var texture: Texture2D = load(texture_path) as Texture2D
	if texture == null:
		return [false, "sources[%d].texture: %s is not a texture" % [index, texture_path]]

	var sized: Array = _xy(source.get("tileSize"), "sources[%d].tileSize" % index)
	if not sized[0]:
		return sized
	var tile_size: Vector2i = sized[1]
	if tile_size.x <= 0 or tile_size.y <= 0:
		return [false, "sources[%d].tileSize must be above zero on both sides" % index]

	var atlas: TileSetAtlasSource = TileSetAtlasSource.new()
	atlas.texture = texture
	atlas.texture_region_size = tile_size
	for field: String in ["separation", "offset"]:
		if not source.has(field):
			continue
		var pair: Array = _xy(source[field], "sources[%d].%s" % [index, field])
		if not pair[0]:
			return pair
		if field == "separation":
			atlas.separation = pair[1]
		else:
			atlas.margins = pair[1]

	var grid: Vector2i = atlas.get_atlas_grid_size()
	if grid.x <= 0 or grid.y <= 0:
		return [
			false,
			(
				"sources[%d]: a %s tile does not fit in %s, which is %s"
				% [index, tile_size, texture_path, texture.get_size()]
			)
		]
	var image: Image = texture.get_image()
	for y: int in grid.y:
		for x: int in grid.x:
			var cell: Vector2i = Vector2i(x, y)
			# Worked out here: the atlas answers a region only for a tile it already has.
			var region: Rect2i = Rect2i(
				atlas.margins + cell * (atlas.texture_region_size + atlas.separation),
				atlas.texture_region_size
			)
			if image != null and _blank(image, region):
				continue
			atlas.create_tile(cell)
	return [true, atlas]


func _blank(image: Image, region: Rect2i) -> bool:
	if image.is_compressed():
		return false
	return image.get_region(region).is_invisible()


## The source ids a tile set holds, for saying what a cell could have named instead.
func _source_ids(tile_set: TileSet) -> Array[int]:
	var ids: Array[int] = []
	for index: int in tile_set.get_source_count():
		ids.append(tile_set.get_source_id(index))
	return ids


func set_tilemap_cells(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	if scene_path == "res://":
		return {"ok": false, "error": "scenePath is required"}

	var cells: Variant = args.get("cells", [])
	# Refused rather than skipped: placing nothing and answering success is indistinguishable
	# from placing everything, and the caller only finds out by opening the scene.
	if typeof(cells) != TYPE_ARRAY:
		return {"ok": false, "error": "cells must be an array of cells to place"}
	var placed: Array = cells
	if placed.is_empty():
		return {"ok": false, "error": "cells is empty, so there is nothing to place"}

	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, true)
	if not refused.is_empty():
		return refused

	var layer: int = GdhRead.as_int(args.get("layer", 0))
	var found: Array = _tile_node(scene, node_path, layer)
	if found[0] == null:
		return scene.refuse(str(found[1]))
	var node: Node = found[0]
	var layered: TileMap = node as TileMap
	var single: TileMapLayer = node as TileMapLayer

	# set_cell stores a cell whatever it is given, and a cell naming no tile simply draws nothing, so
	# the source, the tile and its alternative are checked here: the alternative is a call that
	# reports placing tiles and a scene that shows none.
	var tile_set: TileSet = layered.tile_set if layered != null else single.tile_set

	scene.asked(node, ["layer_%d/tile_data" % layer if layered != null else "tile_map_data"])
	var wanted: Array = []
	for index: int in placed.size():
		var cell: Array = _cell(placed[index], index, tile_set)
		if not cell[0]:
			return scene.refuse(str(cell[1]))
		var at: Vector2i = cell[1]
		var source_id: int = cell[2]
		var atlas_coords: Vector2i = cell[3]
		var alternative: int = cell[4]
		if layered != null:
			layered.set_cell(layer, at, source_id, atlas_coords, alternative)
		else:
			single.set_cell(at, source_id, atlas_coords, alternative)
		wanted.append([at, source_id, atlas_coords, alternative])

	var at_path: String = scene.path_of(node)
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var copy: Node = saved.get_node_or_null(at_path)
			for entry: Array in wanted:
				var at: Vector2i = entry[0]
				var held: Array = _cell_at(copy, layer, at)
				if held != entry.slice(1):
					return "the cell at %s would load as %s, not %s." % [at, held, entry.slice(1)]
			return ""
	)
	if not written.is_empty():
		return written

	return {"ok": true, "layer": layer, "placed": wanted.size(), "requested": placed.size()}


## The node at [param node_path] cells are painted on, with a TileSet, as [node, why not].
## TileMapLayer is the node since 4.3, and TileMap the one it replaced, which keeps its layers.
func _tile_node(scene: GdhSceneFile, node_path: String, layer: int) -> Array:
	var node: Node = (
		scene.root if node_path == "." or node_path == "" else scene.root.get_node_or_null(node_path)
	)
	if node == null:
		return [null, "No node at %s in %s" % [node_path, scene.path]]
	var layered: TileMap = node as TileMap
	var single: TileMapLayer = node as TileMapLayer
	if layered == null and single == null:
		return [null, "%s is a %s, not a TileMapLayer or a TileMap" % [node_path, node.get_class()]]
	var foreign: String = scene.foreign(node)
	if not foreign.is_empty():
		return [null, foreign]
	if single != null and layer != 0:
		return [null, "%s is a TileMapLayer, which is one layer; layer applies to a TileMap" % node_path]
	if layered != null and (layer < 0 or layer >= layered.get_layers_count()):
		return [null, "%s has %d layers, and no layer %d" % [node_path, layered.get_layers_count(), layer]]
	var tile_set: TileSet = layered.tile_set if layered != null else single.tile_set
	if tile_set == null:
		return [null, "%s has no TileSet, so no cell can name a source" % node_path]
	return [node, ""]


## One cell from its description, checked against [param tile_set], as
## [true, coords, source id, atlas coords, alternative] or [false, why].
func _cell(entry: Variant, index: int, tile_set: TileSet) -> Array:
	if not entry is Dictionary:
		return [false, "cells[%d] must be an object with coords, sourceId and atlasCoords" % index]
	var cell: Dictionary = entry
	for field: String in ["coords", "sourceId", "atlasCoords"]:
		if not cell.has(field):
			return [false, "cells[%d] has no %s" % [index, field]]
	var at: Array = _xy(cell["coords"], "cells[%d].coords" % index)
	if not at[0]:
		return at
	var atlas_at: Array = _xy(cell["atlasCoords"], "cells[%d].atlasCoords" % index)
	if not atlas_at[0]:
		return atlas_at
	var source_id: int = GdhRead.as_int(cell["sourceId"], -1)
	if not tile_set.has_source(source_id):
		return [false, "The TileSet has no source %d; it has %s" % [source_id, _source_ids(tile_set)]]
	var source: TileSetSource = tile_set.get_source(source_id)
	var atlas_coords: Vector2i = atlas_at[1]
	var alternative: int = GdhRead.as_int(cell.get("alternativeTile", 0))
	if not source.has_tile(atlas_coords):
		return [
			false,
			(
				"cells[%d]: source %d has no tile at %s; it has %s. Nothing was placed."
				% [index, source_id, atlas_coords, _tiles_of(source)]
			)
		]
	if not source.has_alternative_tile(atlas_coords, alternative):
		return [
			false,
			"The tile at %s in source %d has no alternative %d" % [atlas_coords, source_id, alternative]
		]
	return [true, at[1], source_id, atlas_coords, alternative]


## The atlas coordinates [param source] has tiles at, the first twelve and how many more, or that it
## has none: a refusal naming the one missing sent a caller guessing which of the others exist.
static func _tiles_of(source: TileSetSource) -> String:
	var count: int = source.get_tiles_count()
	if count == 0:
		return "no tiles"
	var named: Array[String] = []
	for index: int in mini(count, 12):
		named.append(str(source.get_tile_id(index)))
	var more: String = "" if count <= 12 else " and %d more" % (count - 12)
	return "tiles at " + ", ".join(PackedStringArray(named)) + more


## The cells a TileMapLayer or a TileMap holds, as {"cellCount", "cells"} in the form
## set_tilemap_cells takes, or {} for any other node. The scene keeps them as packed bytes, which a
## read answered with and nobody could read: a probe counted three cells by decoding the base64 by
## hand. At most CELLS_SHOWN are listed, the count saying how many there are.
static func cells_of(node: Node) -> Dictionary:
	var listed: Array[Dictionary] = []
	var count: int = 0
	var single: TileMapLayer = node as TileMapLayer
	var layered: TileMap = node as TileMap
	if single != null:
		var used: Array[Vector2i] = single.get_used_cells()
		count = used.size()
		for at: Vector2i in used.slice(0, CELLS_SHOWN):
			listed.append(
				_cell_entry(
					at,
					single.get_cell_source_id(at),
					single.get_cell_atlas_coords(at),
					single.get_cell_alternative_tile(at)
				)
			)
	elif layered != null:
		for layer: int in layered.get_layers_count():
			var used: Array[Vector2i] = layered.get_used_cells(layer)
			count += used.size()
			for at: Vector2i in used:
				if listed.size() >= CELLS_SHOWN:
					break
				var entry: Dictionary = _cell_entry(
					at,
					layered.get_cell_source_id(layer, at),
					layered.get_cell_atlas_coords(layer, at),
					layered.get_cell_alternative_tile(layer, at)
				)
				entry["layer"] = layer
				listed.append(entry)
	else:
		return {}
	var answer: Dictionary = {"cellCount": count, "cells": listed}
	if count > listed.size():
		answer["cellsNote"] = "The first %d of %d cells are listed." % [listed.size(), count]
	return answer


static func _cell_entry(at: Vector2i, source_id: int, atlas: Vector2i, alternative: int) -> Dictionary:
	return {
		"coords": {"x": at.x, "y": at.y},
		"sourceId": source_id,
		"atlasCoords": {"x": atlas.x, "y": atlas.y},
		"alternativeTile": alternative,
	}


func _cell_at(node: Node, layer: int, at: Vector2i) -> Array:
	var layered: TileMap = node as TileMap
	if layered != null:
		return [
			layered.get_cell_source_id(layer, at),
			layered.get_cell_atlas_coords(layer, at),
			layered.get_cell_alternative_tile(layer, at)
		]
	var single: TileMapLayer = node as TileMapLayer
	if single != null:
		return [
			single.get_cell_source_id(at),
			single.get_cell_atlas_coords(at),
			single.get_cell_alternative_tile(at)
		]
	return []


## Saves [param theme] over [param theme_path] with [param item] changed, answering "" or why not.
func _save_theme(theme: Theme, theme_path: String, item: String) -> String:
	var previous: PackedByteArray = FileAccess.get_file_as_bytes(theme_path)
	var saving: Error = GdhSceneFile.save_keeping_uid(theme, theme_path)
	if saving != OK:
		return "Failed to save %s: %s" % [theme_path, error_string(saving)]
	var unkept: String = _unkept_headless(theme, theme_path, [item], previous)
	if not unkept.is_empty():
		return "Nothing was written: " + unkept + GdhHeadlessCheck.put_back(theme_path, previous)
	_written(theme_path)
	return ""


func set_theme_color(args: Dictionary) -> Dictionary:
	var theme_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if theme_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}

	var color_name: String = str(args.get("colorName", ""))
	var control_type: String = str(args.get("controlType", ""))
	if color_name.is_empty() or control_type.is_empty():
		return {"ok": false, "error": "colorName and controlType are required"}

	var theme: Theme = _load_theme(theme_path)
	if theme == null:
		return {"ok": false, "error": "No Theme at %s. Create one there first." % theme_path}

	var c: Dictionary = args.get("color", {})
	var color: Color = Color(
		GdhRead.as_float(c.get("r", 1.0), 1.0),
		GdhRead.as_float(c.get("g", 1.0), 1.0),
		GdhRead.as_float(c.get("b", 1.0), 1.0),
		GdhRead.as_float(c.get("a", 1.0), 1.0)
	)
	theme.set_color(color_name, control_type, color)

	var unsaved: String = _save_theme(theme, theme_path, "%s/colors/%s" % [control_type, color_name])
	if not unsaved.is_empty():
		return {"ok": false, "error": unsaved}

	var saved: Theme = _load_theme(theme_path)
	if saved == null or not saved.has_color(color_name, control_type):
		return {"ok": false, "error": "The theme saved without %s/%s" % [control_type, color_name]}

	var stored: Color = saved.get_color(color_name, control_type)
	return _noting_variation(
		{
			"ok": true,
			"themePath": theme_path,
			"controlType": control_type,
			"colorName": color_name,
			"color": {"r": stored.r, "g": stored.g, "b": stored.b, "a": stored.a}
		}
	)


func set_theme_font_size(args: Dictionary) -> Dictionary:
	var theme_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if theme_path == "res://":
		return {"ok": false, "error": "resourcePath is required"}

	var font_size_name: String = str(args.get("fontSizeName", ""))
	var control_type: String = str(args.get("controlType", ""))
	if font_size_name.is_empty() or control_type.is_empty():
		return {"ok": false, "error": "fontSizeName and controlType are required"}

	var theme: Theme = _load_theme(theme_path)
	if theme == null:
		return {"ok": false, "error": "No Theme at %s. Create one there first." % theme_path}

	# Godot reads a size of 0 or less as unset and answers the theme's default, so -3 would be read
	# back as 16.
	var pixels: float = GdhRead.as_float(args.get("size"), 0.0)
	if not is_finite(pixels) or pixels < 1 or pixels != floorf(pixels):
		var shown: String = str(int(pixels)) if pixels == floorf(pixels) else str(pixels)
		return {
			"ok": false,
			"error":
			(
				(
					"size must be a whole number of pixels, 1 or more, not %s: Godot reads 0 or less as no size "
					% shown
				)
				+ "and uses the theme's default instead."
			)
		}
	theme.set_font_size(font_size_name, control_type, int(pixels))

	var unsaved: String = _save_theme(theme, theme_path, "%s/font_sizes/%s" % [control_type, font_size_name])
	if not unsaved.is_empty():
		return {"ok": false, "error": unsaved}

	var saved: Theme = _load_theme(theme_path)
	if saved == null or not saved.has_font_size(font_size_name, control_type):
		return {"ok": false, "error": "The theme saved without %s/%s" % [control_type, font_size_name]}

	return _noting_variation(
		{
			"ok": true,
			"themePath": theme_path,
			"controlType": control_type,
			"fontSizeName": font_size_name,
			"size": saved.get_font_size(font_size_name, control_type)
		}
	)


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
			"%s is not a Control or Window class, so this is a type variation: it styles only a control "
			+ "whose theme_type_variation is %s."
		)
		% [type, type]
	)
	return answer
