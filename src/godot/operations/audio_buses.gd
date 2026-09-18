extends RefCounted

# The bus layout is a project resource the engine loads at startup and this process holds in
# memory, so every change is written back to that file or it is gone with the process.

const Read = preload("reading.gd")
const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


func create_audio_bus(params: Dictionary) -> Dictionary:
	var bus_name: String = str(params.get("bus_name", ""))
	if bus_name.is_empty():
		return _log.failure("bus_name is required")
	var parent_idx: int = Read.as_int(params.get("parent_bus_index", 0))
	if parent_idx < 0 or parent_idx >= AudioServer.bus_count:
		return _log.failure("No bus at index " + str(parent_idx))

	AudioServer.add_bus(parent_idx + 1)
	var new_idx: int = AudioServer.bus_count - 1
	AudioServer.set_bus_name(new_idx, bus_name)
	if parent_idx > 0:
		AudioServer.set_bus_send(new_idx, AudioServer.get_bus_name(parent_idx))

	var layout: String = _save_layout()
	if layout.is_empty():
		return {}
	return {"bus": _bus(new_idx), "layout": layout}


func get_audio_buses(_params: Dictionary) -> Dictionary:
	var buses: Array[Dictionary] = []
	for i: int in range(AudioServer.bus_count):
		buses.append(_bus(i))
	return {"bus_count": AudioServer.bus_count, "buses": buses, "layout": _layout_path()}


func set_audio_bus_effect(params: Dictionary) -> Dictionary:
	var bus_idx: int = Read.as_int(params.get("bus_index", 0))
	var effect_idx: int = Read.as_int(params.get("effect_index", 0))
	var effect_type: String = str(params.get("effect_type", ""))
	var enabled: bool = Read.as_bool(params.get("enabled", true), true)
	if bus_idx < 0 or bus_idx >= AudioServer.bus_count:
		return _log.failure("No bus at index " + str(bus_idx))

	var effect: AudioEffect = _effect_named(effect_type)
	if effect == null:
		return _log.failure("Unknown effect type: " + effect_type)

	# The slot has to exist before an effect can be placed at that index.
	while AudioServer.get_bus_effect_count(bus_idx) <= effect_idx:
		AudioServer.add_bus_effect(bus_idx, AudioEffectAmplify.new())

	AudioServer.add_bus_effect(bus_idx, effect, effect_idx)
	AudioServer.set_bus_effect_enabled(bus_idx, effect_idx, enabled)

	var layout: String = _save_layout()
	if layout.is_empty():
		return {}
	return {"bus": _bus(bus_idx), "effect_index": effect_idx, "effect_type": effect_type, "layout": layout}


func set_audio_bus_volume(params: Dictionary) -> Dictionary:
	var bus_idx: int = Read.as_int(params.get("bus_index", 0))
	var volume_db: float = Read.as_float(params.get("volume_db", 0.0))
	if bus_idx < 0 or bus_idx >= AudioServer.bus_count:
		return _log.failure("No bus at index " + str(bus_idx))

	AudioServer.set_bus_volume_db(bus_idx, volume_db)

	var layout: String = _save_layout()
	if layout.is_empty():
		return {}
	return {"bus": _bus(bus_idx), "layout": layout}


func _bus(index: int) -> Dictionary:
	var effects: Array[Dictionary] = []
	for e: int in range(AudioServer.get_bus_effect_count(index)):
		var effect: Dictionary = {
			"index": e,
			"type": AudioServer.get_bus_effect(index, e).get_class(),
			"enabled": AudioServer.is_bus_effect_enabled(index, e),
		}
		effects.append(effect)
	return {
		"index": index,
		"name": AudioServer.get_bus_name(index),
		"volume_db": AudioServer.get_bus_volume_db(index),
		"mute": AudioServer.is_bus_mute(index),
		"solo": AudioServer.is_bus_solo(index),
		"send": AudioServer.get_bus_send(index),
		"effects": effects,
	}


func _layout_path() -> String:
	return str(ProjectSettings.get_setting("audio/buses/default_bus_layout", "res://default_bus_layout.tres"))


# The path the layout was written to, or empty with the reason on stderr.
func _save_layout() -> String:
	var path: String = _layout_path()
	var err: Error = ResourceSaver.save(AudioServer.generate_bus_layout(), path)
	if err != OK:
		_log.error("Failed to save the bus layout to " + path + ": " + error_string(err))
		return ""
	return path


# Any effect class the engine has, by its class name or the part after "AudioEffect".
func _effect_named(effect_type: String) -> AudioEffect:
	var cls: String = effect_type if effect_type.begins_with("AudioEffect") else "AudioEffect" + effect_type
	if not ClassDB.class_exists(cls) or not ClassDB.is_parent_class(cls, "AudioEffect"):
		return null
	if not ClassDB.can_instantiate(cls):
		return null
	var instance: Variant = ClassDB.instantiate(cls)
	if instance is AudioEffect:
		return instance
	return null
