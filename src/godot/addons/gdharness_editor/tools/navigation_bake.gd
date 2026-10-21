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

## The names NavigationPolygon.SourceGeometryMode and NavigationMesh.SourceGeometryMode give each
## mode, which share their values.
const SOURCE_MODES: Array[String] = ["root_node_children", "groups_with_children", "groups_explicit"]


## Bakes the region [param region] of [param scene], answering what it now holds or why not.
static func bake(scene: GdhSceneFile, region: Node) -> Dictionary:
	var at: String = scene.path_of(region)
	var flat: bool = region is NavigationRegion2D
	if not flat and not region is NavigationRegion3D:
		return scene.refuse(
			"%s is a %s, not a NavigationRegion2D or a NavigationRegion3D." % [at, region.get_class()]
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
		return scene.refuse(
			(
				(
					"The %s %s holds is built into %s, and a bake here cannot save that file. Bake the "
					+ "region there, or save the %s to a file of its own."
				)
				% [held.get_class(), at, file, held.get_class()]
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
			"%s held no %s, so one was made and built into the scene, with the defaults." % [at, property]
		)
	if polygons == 0:
		answer["note"] = _why_empty(held, flat, parsed)

	if not embedded:
		scene.close()
		var saving: Error = GdhSceneFile.save_keeping_uid(held, file)
		if saving != OK:
			return {"ok": false, "error": "Failed to save %s: %s" % [file, error_string(saving)]}
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
## into [param held], answering whether the copy gave any geometry.
static func _parse_and_bake(scene: GdhSceneFile, at: String, held: Resource, flat: bool) -> bool:
	var copy: Node = scene.root.duplicate(Node.DUPLICATE_GROUPS)
	var reading: Resource = held.duplicate()
	var group_property: String = "source_geometry_group_name" if flat else "geometry_source_group_name"
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
		found = geometry.has_data()
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
				+ "scene_node set, such as navigation_polygon/outlines [[[0, 0], [512, 0], [512, 512], "
				+ "[0, 512]]], then bake again."
			)
		return (
			(
				"Nothing was left to walk inside the outlines once the obstacles read from %s, and the "
				% _source_said(polygon.source_geometry_mode, polygon.source_geometry_group_name)
			)
			+ "agent_radius %s kept from their edges, were taken out." % polygon.agent_radius
		)
	var mesh: NavigationMesh = held
	if not parsed:
		return (
			(
				"No geometry was read from %s with geometry_parsed_geometry_type %s, so there was nothing to "
				% [
					_source_said(mesh.geometry_source_geometry_mode, mesh.geometry_source_group_name),
					["mesh_instances", "static_colliders", "both"][mesh.geometry_parsed_geometry_type],
				]
			)
			+ "bake: mesh_instances reads MeshInstance3D nodes, static_colliders the shapes of physics "
			+ "bodies on geometry_collision_mask, and both reads both."
		)
	return (
		"The geometry read gave no floor an agent of agent_height %s and agent_radius %s can stand on."
		% [mesh.agent_height, mesh.agent_radius]
	)


static func _source_said(mode: int, group: String) -> String:
	if mode == 0:
		return "the region's children (source mode root_node_children)"
	return "the nodes in the group %s (source mode %s)" % [group, SOURCE_MODES[mode]]
