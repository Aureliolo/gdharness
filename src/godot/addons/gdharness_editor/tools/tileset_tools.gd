@tool
extends "resource_tools.gd"
## TileSets and the cells of tile maps, beside the resource files the script it extends writes,
## whose helpers it shares.

## How many cells a read of a tile map lists, enough for a level's worth and not a whole world's.
const CELLS_SHOWN: int = 1000


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
				(
					'%s must be two whole numbers, {"x": .., "y": ..}, not %s.'
					% [label, JSON.stringify(value)]
				),
			]
	return [true, Vector2i(GdhRead.as_int(x), GdhRead.as_int(y))]


func create_tileset(args: Dictionary) -> Dictionary:
	var tileset_path: String = _ensure_res_path(str(args.get("resourcePath", "")))
	if tileset_path == "res://":
		return { "ok": false, "error": "resourcePath is required" }
	# modify sets properties and builds no atlas, so the other path is the only way on offered.
	var taken: String = (
		""
		if not FileAccess.file_exists(tileset_path)
		else (
			(
				"%s already exists, and create_tileset builds a whole new TileSet, which would "
				+ "replace everything in it, the tiles a scene paints with among them. Give "
				+ "resourcePath a path nothing is at."
			)
			% tileset_path
		)
	)
	if not taken.is_empty():
		return { "ok": false, "error": taken }

	var given: Variant = args.get("sources", [])
	if not given is Array:
		return { "ok": false, "error": "sources must list at least one atlas" }
	var sources: Array = given
	if sources.is_empty():
		return { "ok": false, "error": "sources must list at least one atlas" }

	var tileset: TileSet = TileSet.new()
	var made: Array = []
	for index: int in sources.size():
		var built: Array = _atlas(sources[index], index)
		if not built[0]:
			return { "ok": false, "error": built[1] }
		var atlas: TileSetAtlasSource = built[1]
		# The first source sets the tile set's own tile size, which is what a TileMapLayer draws
		# cells at. Left at its default of 16 it did not match the atlas.
		if index == 0:
			tileset.tile_size = atlas.texture_region_size
		var added: int = tileset.add_source(atlas)
		if added < 0:
			return {
				"ok": false,
				"error": "The TileSet did not take the atlas for %s" % atlas.texture.resource_path,
			}
		var entry: Dictionary = {
			"sourceId": added,
			"texture": atlas.texture.resource_path,
			"tiles": atlas.get_tiles_count(),
		}
		var blank: Array = built[2]
		if not blank.is_empty():
			entry["leftBlank"] = blank
		var spare: String = built[3]
		if not spare.is_empty():
			entry["notInAnyTile"] = spare
		made.append(entry)

	var folder: String = GdhSceneFile.make_folder_for(tileset_path)
	if not folder.is_empty():
		return { "ok": false, "error": folder }
	var saving: Error = GdhSceneUids.save_keeping_uid(tileset, tileset_path)
	if saving != OK:
		return {
			"ok": false, "error": "Failed to save %s: %s" % [tileset_path, error_string(saving)],
		}

	_written(tileset_path)
	# The size cells are drawn at, which the file leaves out when it is the default 16 by 16.
	return {
		"ok": true,
		"tilesetPath": tileset_path,
		"tileSize": { "x": tileset.tile_size.x, "y": tileset.tile_size.y },
		"sources": made,
	}


## One atlas source from its description, with its tiles made, as [true, source, the grid cells left
## without a tile for being wholly transparent, a sentence on the pixels no tile covers or ""] or
## [false, why].
##
## Tiles are made in every cell of the grid that has a pixel that is not transparent, which is
## what the editor offers to do when an atlas gets a texture. Without them the atlas held no tiles,
## and every cell painted from it drew nothing. The cells passed over and the strip a tile size that
## does not divide the picture leaves are said, since a count alone left a caller to work out which.
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
		# An image the engine has not imported loads as nothing, where "no texture" would send a
		# caller looking for a file that is there.
		if (
			FileAccess.file_exists(texture_path)
			and not FileAccess.file_exists(texture_path + ".import")
		):
			return [
				false,
				(
					(
						"sources[%d].texture: %s has not been imported, so the engine has no "
						+ "texture for it yet. project_import reimport with resourcePath %s "
						+ "imports it."
					)
					% [index, texture_path, texture_path]
				),
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
			),
		]
	var image: Image = texture.get_image()
	var blank: Array = []
	for y: int in grid.y:
		for x: int in grid.x:
			var cell: Vector2i = Vector2i(x, y)
			# Worked out here: the atlas answers a region only for a tile it already has.
			var region: Rect2i = Rect2i(
				atlas.margins + cell * (atlas.texture_region_size + atlas.separation),
				atlas.texture_region_size
			)
			if image != null and _blank(image, region):
				blank.append({ "x": x, "y": y })
				continue
			atlas.create_tile(cell)
	var covered: Vector2i = (
		atlas.margins + grid * tile_size + (grid - Vector2i.ONE) * atlas.separation
	)
	var left: Vector2i = Vector2i(texture.get_size()) - covered
	var sides: PackedStringArray = []
	if left.x > 0:
		var _right: bool = sides.append("%d px on the right" % left.x)
	if left.y > 0:
		var _bottom: bool = sides.append("%d px at the bottom" % left.y)
	var spare: String = (
		""
		if sides.is_empty()
		else (
			"%s is %d by %d, so %s %s in no %d by %d tile."
			% [
				texture_path,
				texture.get_width(),
				texture.get_height(),
				" and ".join(sides),
				"is" if sides.size() == 1 else "are",
				tile_size.x,
				tile_size.y,
			]
		)
	)
	return [true, atlas, blank, spare]


func _blank(image: Image, region: Rect2i) -> bool:
	if image.is_compressed():
		return false
	return image.get_region(region).is_invisible()


## The sources a tile set holds, as "source 0", "sources 0, 2" or "no sources", for saying what a
## cell could have named instead.
func _sources_of(tile_set: TileSet) -> String:
	var ids: PackedStringArray = []
	for index: int in tile_set.get_source_count():
		var _listed: bool = ids.append(str(tile_set.get_source_id(index)))
	if ids.is_empty():
		return "no sources"
	return ("source " if ids.size() == 1 else "sources ") + ", ".join(ids)


func set_tilemap_cells(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	if scene_path == "res://":
		return { "ok": false, "error": "scenePath is required" }

	var cells: Variant = args.get("cells", [])
	# Refused rather than skipped: placing nothing and answering success is indistinguishable
	# from placing everything, and the caller only finds out by opening the scene.
	if typeof(cells) != TYPE_ARRAY:
		return { "ok": false, "error": "cells must be an array of cells to place" }
	var placed: Array = cells
	if placed.is_empty():
		return { "ok": false, "error": "cells is empty, so there is nothing to place" }

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

	# set_cell stores a cell whatever it is given, and a cell naming no tile simply draws nothing,
	# so the source, the tile and its alternative are checked here: the alternative is a call that
	# reports placing tiles and a scene that shows none.
	var tile_set: TileSet = layered.tile_set if layered != null else single.tile_set

	scene.asked(node, ["layer_%d/tile_data" % layer if layered != null else "tile_map_data"])
	# Every cell is checked before any is placed, and every one refused is named: stopping at the
	# first left a caller fixing one cell a call.
	var checked: Array = []
	var refusals: PackedStringArray = []
	for index: int in placed.size():
		var cell: Array = _cell(placed[index], index, tile_set)
		if not cell[0]:
			var _named: bool = refusals.append(str(cell[1]))
		checked.append(cell)
	if not refusals.is_empty():
		return scene.refuse("%s. Nothing was placed." % "; ".join(refusals))
	var wanted: Array = []
	var erased: int = 0
	for cell: Array in checked:
		var at: Vector2i = cell[1]
		var source_id: int = cell[2]
		var atlas_coords: Vector2i = cell[3]
		var alternative: int = cell[4]
		if layered != null:
			layered.set_cell(layer, at, source_id, atlas_coords, alternative)
		else:
			single.set_cell(at, source_id, atlas_coords, alternative)
		wanted.append([at, source_id, atlas_coords, alternative])
		if source_id == -1:
			erased += 1
	# An erased cell leaves the layer's data at its next update, which a layer outside the tree
	# never has, so the pack wrote it as a cell naming no tile, where the editor's save leaves it
	# out.
	if layered != null:
		layered.update_internals()
	else:
		single.update_internals()

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

	return {
		"ok": true,
		"layer": layer,
		"placed": wanted.size() - erased,
		"erased": erased,
		"requested": placed.size(),
	}


## The node at [param node_path] cells are painted on, with a TileSet, as [node, why not].
## TileMapLayer is the node since 4.3, and TileMap the one it replaced, which keeps its layers.
func _tile_node(scene: GdhSceneFile, node_path: String, layer: int) -> Array:
	var node: Node = (
		scene.root
		if node_path == "." or node_path == ""
		else scene.root.get_node_or_null(node_path)
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
		return [
			null,
			"%s is a TileMapLayer, which is one layer; layer applies to a TileMap" % node_path,
		]
	if layered != null and (layer < 0 or layer >= layered.get_layers_count()):
		return [
			null,
			"%s has %d layers, and no layer %d" % [node_path, layered.get_layers_count(), layer],
		]
	var tile_set: TileSet = layered.tile_set if layered != null else single.tile_set
	if tile_set == null:
		return [
			null,
			(
				(
					"%s has no TileSet, so no cell can name a source. scene_node set with "
					+ 'properties {"tile_set": "res://..."} on %s gives it one, a TileSet file '
					+ "such as resource_edit create_tileset makes."
				)
				% [node_path, node_path]
			),
		]
	return [node, ""]


## One cell from its description, checked against [param tile_set], as
## [true, coords, source id, atlas coords, alternative] or [false, why]. A source of -1 erases the
## cell, as set_cell takes it, and needs no atlasCoords.
func _cell(entry: Variant, index: int, tile_set: TileSet) -> Array:
	if not entry is Dictionary:
		return [false, "cells[%d] must be an object with coords, sourceId and atlasCoords" % index]
	var cell: Dictionary = entry
	for field: String in ["coords", "sourceId"]:
		if not cell.has(field):
			return [false, "cells[%d] has no %s" % [index, field]]
	var at: Array = _xy(cell["coords"], "cells[%d].coords" % index)
	if not at[0]:
		return at
	var coords: Vector2i = at[1]
	var named: String = "cells[%d] at (%d, %d)" % [index, coords.x, coords.y]
	var source_id: int = GdhRead.as_int(cell["sourceId"], -2)
	if source_id == -1:
		return [true, coords, -1, Vector2i(-1, -1), -1]
	if not cell.has("atlasCoords"):
		return [
			false,
			"%s has no atlasCoords, which every cell but an erased one (sourceId -1) needs" % named,
		]
	var atlas_at: Array = _xy(cell["atlasCoords"], "cells[%d].atlasCoords" % index)
	if not atlas_at[0]:
		return atlas_at
	if not tile_set.has_source(source_id):
		return [
			false,
			(
				"%s names source %d, and the TileSet has %s; sourceId -1 erases a cell"
				% [named, source_id, _sources_of(tile_set)]
			),
		]
	var source: TileSetSource = tile_set.get_source(source_id)
	var atlas_coords: Vector2i = atlas_at[1]
	var alternative: int = GdhRead.as_int(cell.get("alternativeTile", 0))
	if not source.has_tile(atlas_coords):
		return [
			false,
			(
				"%s: source %d has no tile at %s; it has %s"
				% [named, source_id, atlas_coords, _tiles_of(source)]
			),
		]
	if not source.has_alternative_tile(atlas_coords, alternative):
		return [
			false,
			(
				"%s: the tile at %s in source %d has no alternative %d"
				% [named, atlas_coords, source_id, alternative]
			),
		]
	return [true, coords, source_id, atlas_coords, alternative]


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
	var answer: Dictionary = { "cellCount": count, "cells": listed }
	if count > listed.size():
		answer["cellsNote"] = "The first %d of %d cells are listed." % [listed.size(), count]
	return answer


static func _cell_entry(
	at: Vector2i, source_id: int, atlas: Vector2i, alternative: int
) -> Dictionary:
	return {
		"coords": { "x": at.x, "y": at.y },
		"sourceId": source_id,
		"atlasCoords": { "x": atlas.x, "y": atlas.y },
		"alternativeTile": alternative,
	}


func _cell_at(node: Node, layer: int, at: Vector2i) -> Array:
	var layered: TileMap = node as TileMap
	if layered != null:
		return [
			layered.get_cell_source_id(layer, at),
			layered.get_cell_atlas_coords(layer, at),
			layered.get_cell_alternative_tile(layer, at),
		]
	var single: TileMapLayer = node as TileMapLayer
	if single != null:
		return [
			single.get_cell_source_id(at),
			single.get_cell_atlas_coords(at),
			single.get_cell_alternative_tile(at),
		]
	return []
