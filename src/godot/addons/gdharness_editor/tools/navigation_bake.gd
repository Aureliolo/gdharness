@tool
extends RefCounted
## Bakes what a NavigationRegion2D or NavigationRegion3D in a scene file navigates by, as the
## editor's Bake button does, and saves it where the region keeps it.
##
## The navigation servers read source geometry only off nodes inside the scene tree, which a scene
## opened for a tool is not: measured on 4.7.2, parsing outside it fails with "The root node needs
## to be inside the SceneTree." What goes into the tree is a copy made without scripts, so a
## headless engine runs none of the game's code for it, and taken out again in the same call. Its
## source group is renamed to one only the copy uses, since the editor's tree also holds the scene
## being edited, whose nodes would otherwise be read with it.

const GdhSceneFile = preload("../scene_file.gd")
const GdhSceneUids = preload("../scene_uids.gd")
## The names NavigationPolygon.SourceGeometryMode and NavigationMesh.SourceGeometryMode give each
## mode, which share their values.
const SOURCE_MODES: Array[String] = [
	"root_node_children", "groups_with_children", "groups_explicit",
]


## Bakes the region [param region] of [param scene], answering what it now holds or why not.
static func bake(scene: GdhSceneFile, region: Node) -> Dictionary:
	var at: String = scene.path_of(region)
	var flat: bool = region is NavigationRegion2D
	if not flat and not region is NavigationRegion3D:
		var regions: PackedStringArray = []
		for node: Node in _all_under(scene.root):
			if node is NavigationRegion2D or node is NavigationRegion3D:
				var _named: bool = regions.append(scene.path_of(node))
		return (
			scene
			. refuse(
				(
					"%s is a %s, not a NavigationRegion2D or a NavigationRegion3D. %s."
					% [
						at,
						region.get_class(),
						(
							"The scene has none, and scene_node add puts one in"
							if regions.is_empty()
							else "The scene's are at %s" % ", ".join(regions)
						),
					]
				)
			)
		)
	var property: String = "navigation_polygon" if flat else "navigation_mesh"
	var held: Resource = region.get(property)
	var made: bool = held == null
	if made:
		held = NavigationPolygon.new()
		if not flat:
			held = NavigationMesh.new()
	var file: String = held.resource_path.get_slice("::", 0)
	var embedded: bool = file.is_empty() or held.resource_path.contains("::")
	if embedded and not file.is_empty() and file != scene.path:
		return (
			scene
			. refuse(
				(
					(
						"The %s %s holds is built into %s, and a bake here cannot save that file. "
						+ "Bake the region there, or save the %s to a file of its own."
					)
					% [held.get_class(), at, file, held.get_class()]
				)
			)
		)

	scene.asked(region, [property])
	if made:
		region.set(property, held)
	var parsed: bool = _parse_and_bake(scene, at, held, flat)
	var polygons: int = _polygon_count(held)
	var answer: Dictionary = {
		"ok": true,
		"nodePath": at,
		"polygons": polygons,
		"vertices": _vertex_count(held),
	}
	if made:
		answer["made"] = (
			"%s held no %s, so one was made and built into the scene, with the defaults."
			% [at, property]
		)
	if polygons == 0:
		answer["note"] = _why_empty(held, flat, parsed)
	elif flat and not parsed:
		answer["note"] = _nothing_read(scene, held)
	if not flat and not Engine.is_editor_hint() and _reads_meshes(region, held):
		answer["meshesNote"] = (
			"The engine's warning that it had to parse RenderingServer meshes at runtime is about "
			+ "a game rebaking as it runs, where reading a mesh back from the GPU stalls a frame. "
			+ "A headless engine gives it for any bake read from MeshInstance3D nodes. This one "
			+ "ran once and is saved."
		)

	if not embedded:
		scene.close()
		var saving: Error = GdhSceneUids.save_keeping_uid(held, file)
		if saving != OK:
			return { "ok": false, "error": "Failed to save %s: %s" % [file, error_string(saving)] }
		if Engine.is_editor_hint():
			EditorInterface.get_resource_filesystem().update_file(file)
		answer["savedTo"] = file
		return answer

	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var kept: Resource = saved.get_node(at).get(property)
			var loaded: int = _polygon_count(kept) if kept != null else -1
			if loaded != polygons:
				return "%s would load holding %d polygons, not %d." % [at, loaded, polygons]
			return ""
	)
	if not written.is_empty():
		return written
	answer["savedTo"] = scene.path
	return answer


## Reads the source geometry for [param held] off a copy of the region at [param at] and bakes it
## into [param held], answering whether the copy gave any geometry: in 2D, any obstacle.
static func _parse_and_bake(scene: GdhSceneFile, at: String, held: Resource, flat: bool) -> bool:
	var copy: Node = scene.root.duplicate(Node.DUPLICATE_GROUPS)
	var reading: Resource = held.duplicate()
	var group_property: String = (
		"source_geometry_group_name" if flat else "geometry_source_group_name"
	)
	var group: String = str(held.get(group_property))
	var own_group: String = "_gdh_bake_%d" % copy.get_instance_id()
	reading.set(group_property, own_group)
	for node: Node in _all_under(copy):
		if node.is_in_group(group):
			node.add_to_group(own_group)
	var tree: SceneTree = Engine.get_main_loop() as SceneTree
	tree.root.add_child(copy)
	var region: Node = copy.get_node(at)
	var found: bool = false
	if flat:
		var outline: NavigationPolygon = reading
		var geometry: NavigationMeshSourceGeometryData2D = NavigationMeshSourceGeometryData2D.new()
		NavigationServer2D.parse_source_geometry_data(outline, geometry, region)
		# has_data() counts only traversable outlines, so a bake carving every obstacle it read
		# would still say it read nothing.
		found = (
			not geometry.get_obstruction_outlines().is_empty()
			or not geometry.get_projected_obstructions().is_empty()
		)
		var polygon: NavigationPolygon = held
		NavigationServer2D.bake_from_source_geometry_data(polygon, geometry)
	else:
		var shape: NavigationMesh = reading
		var geometry: NavigationMeshSourceGeometryData3D = NavigationMeshSourceGeometryData3D.new()
		NavigationServer3D.parse_source_geometry_data(shape, geometry, region)
		found = geometry.has_data()
		var mesh: NavigationMesh = held
		NavigationServer3D.bake_from_source_geometry_data(mesh, geometry)
	tree.root.remove_child(copy)
	copy.free()
	return found


## Whether a bake of [param held] for [param region] reads the mesh of any node, which only a
## NavigationMesh reading mesh instances does.
static func _reads_meshes(region: Node, held: Resource) -> bool:
	var mesh: NavigationMesh = held
	if mesh.geometry_parsed_geometry_type == NavigationMesh.PARSED_GEOMETRY_STATIC_COLLIDERS:
		return false
	var read: Array[Node] = []
	match mesh.geometry_source_geometry_mode:
		NavigationMesh.SOURCE_GEOMETRY_ROOT_NODE_CHILDREN:
			read = _all_under(region)
		NavigationMesh.SOURCE_GEOMETRY_GROUPS_WITH_CHILDREN:
			for node: Node in _all_under(region.owner if region.owner != null else region):
				if node.is_in_group(mesh.geometry_source_group_name):
					read.append_array(_all_under(node))
		_:
			for node: Node in _all_under(region.owner if region.owner != null else region):
				if node.is_in_group(mesh.geometry_source_group_name):
					read.append(node)
	return read.any(
		func(node: Node) -> bool:
			return node is MeshInstance3D or node is MultiMeshInstance3D or node is GridMap
	)


static func _all_under(top: Node) -> Array[Node]:
	var nodes: Array[Node] = [top]
	for child: Node in top.get_children():
		nodes.append_array(_all_under(child))
	return nodes


static func _polygon_count(held: Resource) -> int:
	if held is NavigationPolygon:
		var polygon: NavigationPolygon = held
		return polygon.get_polygon_count()
	var mesh: NavigationMesh = held
	return mesh.get_polygon_count()


static func _vertex_count(held: Resource) -> int:
	if held is NavigationPolygon:
		var polygon: NavigationPolygon = held
		return polygon.vertices.size()
	var mesh: NavigationMesh = held
	return mesh.vertices.size()


## Why a bake of [param held] gave no polygons, from whether any source geometry was read.
static func _why_empty(held: Resource, flat: bool, parsed: bool) -> String:
	if flat:
		var polygon: NavigationPolygon = held
		if polygon.get_outline_count() == 0:
			return (
				"The NavigationPolygon has no outlines, and a 2D bake fills only the area its "
				+ "outlines enclose, less what the obstacles inside take. Give it outlines with "
				+ "scene_node set, such as navigation_polygon/outlines [[[0, 0], [512, 0], [512, "
				+ "512], [0, 512]]], then bake again."
			)
		return (
			(
				(
					"Nothing was left to walk inside the outlines once the obstacles read from %s, "
					+ "and the "
				)
				% _source_said(polygon.source_geometry_mode, polygon.source_geometry_group_name)
			)
			+ "agent_radius %s kept from their edges, were taken out." % polygon.agent_radius
		)
	var mesh: NavigationMesh = held
	if not parsed:
		return (
			(
				(
					"No geometry was read from %s with geometry_parsed_geometry_type %s, so there "
					+ "was nothing to "
				)
				% [
					_source_said(
						mesh.geometry_source_geometry_mode, mesh.geometry_source_group_name
					),
					["mesh_instances", "static_colliders", "both"][
						mesh.geometry_parsed_geometry_type
					],
				]
			)
			+ "bake: mesh_instances reads MeshInstance3D nodes, static_colliders the shapes of "
			+ "physics bodies on geometry_collision_mask, and both reads both."
		)
	return (
		(
			"The geometry read gave no floor an agent of agent_height %s and agent_radius %s can "
			+ "stand on."
		)
		% [mesh.agent_height, mesh.agent_radius]
	)


## Why a 2D bake of [param held] left the whole outline walkable: no obstacle was read, and which
## nodes of [param scene] that give obstacles are under no region. A tile layer beside the region
## rather than under it is the usual cause, and the bake alone does not show it.
static func _nothing_read(scene: GdhSceneFile, held: Resource) -> String:
	var polygon: NavigationPolygon = held
	var said: String = (
		(
			"No obstacle was read from %s, so all the outlines enclose is walkable, less the "
			+ "agent_radius %s kept from their edges."
		)
		% [
			_source_said(polygon.source_geometry_mode, polygon.source_geometry_group_name),
			polygon.agent_radius,
		]
	)
	var outside: PackedStringArray = []
	for node: Node in _all_under(scene.root):
		var gives: bool = (
			node is TileMapLayer
			or node is StaticBody2D
			or node is MeshInstance2D
			or node is Polygon2D
			or node is NavigationObstacle2D
		)
		if gives and not _in_a_region(node):
			var _named: bool = outside.append("%s (a %s)" % [scene.path_of(node), node.get_class()])
	if outside.is_empty():
		return said
	return (
		(
			"%s %s %s outside what was read. The bake reads a node elsewhere once it is in the "
			+ "group %s and source_geometry_mode is groups_with_children, or once it is moved "
			+ "under the region."
		)
		% [
			said,
			", ".join(outside),
			"is" if outside.size() == 1 else "are",
			polygon.source_geometry_group_name,
		]
	)


## Whether [param node] is under a 2D region, this one or another, whose obstacle it then is.
static func _in_a_region(node: Node) -> bool:
	var above: Node = node.get_parent()
	while above != null:
		if above is NavigationRegion2D:
			return true
		above = above.get_parent()
	return false


static func _source_said(mode: int, group: String) -> String:
	if mode == 0:
		return "the region's children (source mode root_node_children)"
	return "the nodes in the group %s (source mode %s)" % [group, SOURCE_MODES[mode]]
