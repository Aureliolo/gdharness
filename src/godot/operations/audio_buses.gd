extends RefCounted

const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


func create_audio_bus(params: Dictionary) -> Dictionary:
	var bus_name = params.get("busName", "NewBus")
	var parent_idx = int(params.get("parentBusIndex", 0))

	AudioServer.add_bus(parent_idx + 1)
	var new_idx = AudioServer.bus_count - 1
	AudioServer.set_bus_name(new_idx, bus_name)

	if parent_idx > 0:
		AudioServer.set_bus_send(new_idx, AudioServer.get_bus_name(parent_idx))

	# The layout is a project resource, so the bus only survives the run if it is saved.
	var save_path = "res://default_bus_layout.tres"
	var err = ResourceSaver.save(AudioServer.generate_bus_layout(), save_path)

	return {
		"success": err == OK,
		"bus_index": new_idx,
		"bus_name": bus_name,
		"layout_saved": save_path if err == OK else "failed"
	}


func get_audio_buses(_params: Dictionary) -> Dictionary:
	var buses = []
	for i in range(AudioServer.bus_count):
		buses.append(
			{
				"index": i,
				"name": AudioServer.get_bus_name(i),
				"volume_db": AudioServer.get_bus_volume_db(i),
				"mute": AudioServer.is_bus_mute(i),
				"solo": AudioServer.is_bus_solo(i),
				"effect_count": AudioServer.get_bus_effect_count(i),
				"send": AudioServer.get_bus_send(i)
			}
		)

	return {"success": true, "bus_count": AudioServer.bus_count, "buses": buses}


func set_audio_bus_effect(params: Dictionary) -> Dictionary:
	var bus_idx = int(params.get("busIndex", 0))
	var effect_idx = int(params.get("effectIndex", 0))
	var effect_type = params.get("effectType", "Reverb")
	var enabled = params.get("enabled", true)

	var effect = _effect_named(effect_type)
	if effect == null:
		return _log.failure("Unknown effect type: " + effect_type)

	# Ensure enough effect slots
	while AudioServer.get_bus_effect_count(bus_idx) <= effect_idx:
		AudioServer.add_bus_effect(bus_idx, AudioEffectAmplify.new())

	AudioServer.add_bus_effect(bus_idx, effect, effect_idx)
	AudioServer.set_bus_effect_enabled(bus_idx, effect_idx, enabled)

	return {"success": true, "bus_index": bus_idx, "effect_index": effect_idx, "effect_type": effect_type}


func set_audio_bus_volume(params: Dictionary) -> Dictionary:
	var bus_idx = int(params.get("busIndex", 0))
	var volume_db = float(params.get("volumeDb", 0.0))

	AudioServer.set_bus_volume_db(bus_idx, volume_db)

	return {"success": true, "bus_index": bus_idx, "volume_db": volume_db}


func _effect_named(effect_type: String) -> AudioEffect:
	match effect_type:
		"Reverb":
			return AudioEffectReverb.new()
		"Delay":
			return AudioEffectDelay.new()
		"Chorus":
			return AudioEffectChorus.new()
		"Amplify":
			return AudioEffectAmplify.new()
		"Compressor":
			return AudioEffectCompressor.new()
		"Limiter":
			return AudioEffectLimiter.new()
		"EQ":
			return AudioEffectEQ.new()
		"LowPassFilter":
			return AudioEffectLowPassFilter.new()
		"HighPassFilter":
			return AudioEffectHighPassFilter.new()
		"Distortion":
			return AudioEffectDistortion.new()
	return null
