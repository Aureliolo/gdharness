extends RefCounted

const Log = preload("logger.gd")
const SceneNodes = preload("scene_nodes.gd")

var _log: Log
var _scene: SceneNodes


func _init(p_log: Log) -> void:
	_log = p_log
	_scene = SceneNodes.new(p_log)


func create_audio_stream_player(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_name = params.get("nodeName", "AudioStreamPlayer")
	var player_type = params.get("playerType", "AudioStreamPlayer")
	var audio_path = params.get("audioPath", "")

	var opened = _open_at(scene_path, params.get("parentPath", "root"), "Parent")
	if opened.is_empty():
		return {}

	var player = _player_of_type(player_type)
	player.bus = params.get("bus", "Master")
	player.autoplay = params.get("autoplay", false)

	if audio_path != "" and ResourceLoader.exists("res://" + audio_path):
		player.stream = load("res://" + audio_path)

	_attach(opened, player, node_name)
	_commit(opened[0], scene_path)

	return {"success": true, "node_name": node_name, "player_type": player_type}


func create_http_request(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_name = params.get("nodeName", "HTTPRequest")
	var timeout = float(params.get("timeout", 10.0))

	var opened = _open_at(scene_path, params.get("parentPath", "root"), "Parent")
	if opened.is_empty():
		return {}

	var http := HTTPRequest.new()
	http.timeout = timeout

	_attach(opened, http, node_name)
	_commit(opened[0], scene_path)

	return {"success": true, "node_name": node_name, "timeout": timeout}


func create_multiplayer_spawner(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_name = params.get("nodeName", "MultiplayerSpawner")
	var spawn_path = params.get("spawnPath", "")

	var opened = _open_at(scene_path, params.get("parentPath", "root"), "Parent")
	if opened.is_empty():
		return {}

	var spawner := MultiplayerSpawner.new()
	if spawn_path != "":
		spawner.spawn_path = NodePath(spawn_path)

	_attach(opened, spawner, node_name)
	_commit(opened[0], scene_path)

	return {"success": true, "node_name": node_name}


func create_multiplayer_synchronizer(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_name = params.get("nodeName", "MultiplayerSynchronizer")
	var root_path = params.get("rootPath", "")

	var opened = _open_at(scene_path, params.get("parentPath", "root"), "Parent")
	if opened.is_empty():
		return {}

	var synchronizer := MultiplayerSynchronizer.new()
	if root_path != "":
		synchronizer.root_path = NodePath(root_path)
	synchronizer.replication_interval = float(params.get("replicationInterval", 0.0))

	_attach(opened, synchronizer, node_name)
	_commit(opened[0], scene_path)

	return {"success": true, "node_name": node_name}


func create_raycast(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_name = params.get("nodeName", "RayCast")
	var is_3d = params.get("is3D", false)
	var target_pos = params.get("targetPosition", {"x": 0, "y": 100, "z": 0})

	var opened = _open_at(scene_path, params.get("parentPath", "root"), "Parent")
	if opened.is_empty():
		return {}

	var raycast = null
	if is_3d:
		raycast = RayCast3D.new()
		raycast.target_position = Vector3(
			float(target_pos.x), float(target_pos.y), float(target_pos.get("z", 0))
		)
	else:
		raycast = RayCast2D.new()
		raycast.target_position = Vector2(float(target_pos.x), float(target_pos.y))

	raycast.collision_mask = int(params.get("collisionMask", 1))
	raycast.enabled = true

	_attach(opened, raycast, node_name)
	_commit(opened[0], scene_path)

	return {"success": true, "node_name": node_name, "is_3d": is_3d}


func set_collision_layer_mask(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var collision_layer = int(params.get("collisionLayer", 1))
	var collision_mask = int(params.get("collisionMask", 1))

	var opened = _open_at(scene_path, params.get("nodePath", ""), "Node")
	if opened.is_empty():
		return {}

	var node = opened[1]
	node.collision_layer = collision_layer
	node.collision_mask = collision_mask

	_commit(opened[0], scene_path)

	return {"success": true, "collision_layer": collision_layer, "collision_mask": collision_mask}


func create_world_environment(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_name = params.get("nodeName", "WorldEnvironment")
	var env_path = params.get("environmentPath", "")

	var opened = _open_at(scene_path, params.get("parentPath", "root"), "Parent")
	if opened.is_empty():
		return {}

	var world_env := WorldEnvironment.new()
	if env_path != "" and ResourceLoader.exists("res://" + env_path):
		world_env.environment = load("res://" + env_path)
	else:
		world_env.environment = Environment.new()

	_attach(opened, world_env, node_name)
	_commit(opened[0], scene_path)

	return {"success": true, "node_name": node_name}


func create_light(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_name = params.get("nodeName", "Light")
	var light_type = params.get("lightType", "DirectionalLight3D")
	var color = params.get("color", {"r": 1.0, "g": 1.0, "b": 1.0})
	var energy = float(params.get("energy", 1.0))
	var shadow_enabled = params.get("shadowEnabled", false)

	var opened = _open_at(scene_path, params.get("parentPath", "root"), "Parent")
	if opened.is_empty():
		return {}

	var light = _light_of_type(light_type)

	# Light2D and Light3D spell the same three settings differently.
	if light is Light3D:
		light.light_color = Color(float(color.r), float(color.g), float(color.b))
		light.light_energy = energy
		light.shadow_enabled = shadow_enabled
	elif light is Light2D:
		light.color = Color(float(color.r), float(color.g), float(color.b))
		light.energy = energy
		light.shadow_enabled = shadow_enabled

	_attach(opened, light, node_name)
	_commit(opened[0], scene_path)

	return {"success": true, "node_name": node_name, "light_type": light_type}


func create_camera(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_name = params.get("nodeName", "Camera")
	var is_3d = params.get("is3D", false)
	var zoom = params.get("zoom", {"x": 1, "y": 1})

	var opened = _open_at(scene_path, params.get("parentPath", "root"), "Parent")
	if opened.is_empty():
		return {}

	var camera = null
	if is_3d:
		camera = Camera3D.new()
		camera.fov = float(params.get("fov", 75.0))
		camera.current = params.get("current", false)
	else:
		camera = Camera2D.new()
		camera.zoom = Vector2(float(zoom.x), float(zoom.y))

	_attach(opened, camera, node_name)
	_commit(opened[0], scene_path)

	return {"success": true, "node_name": node_name, "is_3d": is_3d}


func set_animation_tree_parameter(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var parameter_path = params.get("parameterPath", "")
	var value = params.get("value", null)

	var anim_tree_path = params.get("animTreePath", "")
	var opened = _open_at(scene_path, anim_tree_path, "AnimationTree")
	if opened.is_empty():
		return {}

	if not opened[1] is AnimationTree:
		opened[0].queue_free()
		return _log.failure("AnimationTree not found: " + anim_tree_path)

	opened[1].set(parameter_path, value)
	_commit(opened[0], scene_path)

	return {"success": true, "parameter": parameter_path, "value": value}


func apply_theme_to_node(params: Dictionary) -> Dictionary:
	var scene_path = "res://" + params.get("scenePath", "")
	var node_path = params.get("nodePath", "")
	var theme_path = "res://" + params.get("themePath", "")

	var opened = _open_at(scene_path, node_path, "Node")
	if opened.is_empty():
		return {}

	if not opened[1] is Control:
		opened[0].queue_free()
		return _log.failure("Node is not a Control")

	if not ResourceLoader.exists(theme_path):
		opened[0].queue_free()
		return _log.failure("Theme not found: " + theme_path)

	opened[1].theme = load(theme_path)
	_commit(opened[0], scene_path)

	return {"success": true, "node": node_path, "theme": theme_path}


# The scene root and the node inside it a builder works on, or nothing when either could not
# be resolved. `label` is what the node is to the caller, so the failure names what it wanted.
func _open_at(scene_path: String, node_path: String, label: String) -> Array:
	var scene = load(scene_path)
	if scene == null:
		_log.error("Failed to load scene: " + scene_path)
		return []

	var scene_root: Node = scene.instantiate()
	var node := _scene.node_at_path(scene_root, node_path)
	if node == null:
		scene_root.queue_free()
		_log.error(label + " not found: " + node_path)
		return []

	return [scene_root, node]


# Ownership is what makes a node part of the packed scene rather than a runtime child.
func _attach(opened: Array, node: Node, node_name: String) -> void:
	node.name = node_name
	opened[1].add_child(node)
	node.owner = opened[0]


func _commit(scene_root: Node, scene_path: String) -> void:
	var packed = PackedScene.new()
	packed.pack(scene_root)
	ResourceSaver.save(packed, scene_path)
	scene_root.queue_free()


# Untyped on the way out: the three players share the settings below but not a base class
# that declares them, so a Node return type would refuse every assignment.
func _player_of_type(player_type: String) -> Variant:
	match player_type:
		"AudioStreamPlayer2D":
			return AudioStreamPlayer2D.new()
		"AudioStreamPlayer3D":
			return AudioStreamPlayer3D.new()
	return AudioStreamPlayer.new()


func _light_of_type(light_type: String) -> Variant:
	match light_type:
		"OmniLight3D":
			return OmniLight3D.new()
		"SpotLight3D":
			return SpotLight3D.new()
		"DirectionalLight2D":
			return DirectionalLight2D.new()
		"PointLight2D":
			return PointLight2D.new()
	return DirectionalLight3D.new()
