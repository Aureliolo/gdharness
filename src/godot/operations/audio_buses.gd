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
	# Sends are by name, so a second bus with one would leave every send to it meaning either.
	var existing: int = AudioServer.get_bus_index(bus_name)
	if existing != -1:
		return _log.failure("A bus named " + bus_name + " already exists, at index " + str(existing))

	# Right after the bus it sends to, because a bus can only send to one before it. The engine
	# inserts there and moves every later bus down one, so the new bus is at that index: taking the
	# last index named and rewired whichever bus had been last, and answered with it.
	var new_idx: int = parent_idx + 1
	AudioServer.add_bus(new_idx)
	AudioServer.set_bus_name(new_idx, bus_name)
	AudioServer.set_bus_send(new_idx, AudioServer.get_bus_name(parent_idx))

	var layout: String = _save_layout()
	if layout.is_empty():
		return {}
	# Every bus, because the ones after the new one have moved and a caller holding their old
	# indices would address the wrong bus next.
	var buses: Array[Dictionary] = []
	for i: int in range(AudioServer.bus_count):
		buses.append(_bus(i))
	return {"bus": _bus(new_idx), "buses": buses, "layout": layout}


func remove_audio_bus(params: Dictionary) -> Dictionary:
	var bus_name: String = str(params.get("bus_name", ""))
	if bus_name.is_empty():
		return _log.failure("bus_name is required")
	var index: int = AudioServer.get_bus_index(bus_name)
	if index == -1:
		var names: Array[String] = []
		for i: int in range(AudioServer.bus_count):
			names.append(AudioServer.get_bus_name(i))
		return _log.failure("No bus named %s. The buses are %s." % [bus_name, ", ".join(names)])
	if index == 0:
		return _log.failure("%s is the bus every other ends in, so it cannot be removed." % bus_name)

	# A bus sending to this one would be left sending to a name nothing has, which the engine reads
	# as Master; sent on to where this one went instead, the chain it was part of keeps its shape.
	var onward: String = AudioServer.get_bus_send(index)
	var resent: Array[String] = []
	for i: int in range(AudioServer.bus_count):
		if i != index and AudioServer.get_bus_send(i) == bus_name:
			AudioServer.set_bus_send(i, onward)
			resent.append(AudioServer.get_bus_name(i))
	AudioServer.remove_bus(index)

	var layout: String = _save_layout()
	if layout.is_empty():
		return {}
	var buses: Array[Dictionary] = []
	for i: int in range(AudioServer.bus_count):
		buses.append(_bus(i))
	var answer: Dictionary = {"removed": bus_name, "buses": buses, "layout": layout}
	if not resent.is_empty():
		answer["resent"] = {"buses": resent, "to": onward}
	return answer


func get_audio_buses(_params: Dictionary) -> Dictionary:
	var buses: Array[Dictionary] = []
	for i: int in range(AudioServer.bus_count):
		buses.append(_bus(i))
	var layout: String = _layout_path()
	var answer: Dictionary = {"bus_count": AudioServer.bus_count, "buses": buses, "layout": layout}
	# The setting names a path whether or not anything is there, and a project that never changed a
	# bus has no file: the path alone read as a layout the project keeps.
	if not FileAccess.file_exists(layout):
		answer["layout_on_disk"] = false
		answer["note"] = (
			(
				"Nothing is at %s, so these are the engine's default buses; the first change to a bus "
				+ "writes the layout there."
			)
			% layout
		)
	return answer


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

	# The slot holds this effect afterwards: the one there is replaced, and one past the last is
	# added. The engine's add inserts, so the effect in the slot was pushed along rather than
	# replaced, and a slot past the end was reached by padding the bus with Amplify effects nobody
	# asked for.
	var count: int = AudioServer.get_bus_effect_count(bus_idx)
	if effect_idx < 0 or effect_idx > count:
		return _log.failure(
			(
				"Bus "
				+ str(bus_idx)
				+ " has "
				+ str(count)
				+ (" effect" if count == 1 else " effects")
				+ ", so effect_index can be 0 to "
				+ str(count)
				+ ", where "
				+ str(count)
				+ " adds one after the last"
			)
		)
	var replaced: String = ""
	if effect_idx < count:
		replaced = AudioServer.get_bus_effect(bus_idx, effect_idx).get_class()
		AudioServer.remove_bus_effect(bus_idx, effect_idx)
	AudioServer.add_bus_effect(bus_idx, effect, effect_idx)
	AudioServer.set_bus_effect_enabled(bus_idx, effect_idx, enabled)

	var layout: String = _save_layout()
	if layout.is_empty():
		return {}
	var answer: Dictionary = {
		"bus": _bus(bus_idx), "effect_index": effect_idx, "effect_type": effect.get_class(), "layout": layout
	}
	if not replaced.is_empty():
		answer["replaced"] = replaced
	return answer


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
