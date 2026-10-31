@tool
extends "animation_tools.gd"
## The tracks and keys of an animation, beside the players and libraries the script it extends
## edits, whose helpers it shares.

## The types whose values the editor blends between keys, so it makes a track on one continuous.
const BLENDED_TYPES: Array[int] = [
	TYPE_FLOAT,
	TYPE_VECTOR2,
	TYPE_RECT2,
	TYPE_VECTOR3,
	TYPE_TRANSFORM2D,
	TYPE_VECTOR4,
	TYPE_PLANE,
	TYPE_QUATERNION,
	TYPE_AABB,
	TYPE_BASIS,
	TYPE_TRANSFORM3D,
	TYPE_PROJECTION,
	TYPE_COLOR,
	TYPE_PACKED_FLOAT32_ARRAY,
	TYPE_PACKED_FLOAT64_ARRAY,
	TYPE_PACKED_VECTOR2_ARRAY,
	TYPE_PACKED_VECTOR3_ARRAY,
	TYPE_PACKED_COLOR_ARRAY,
	TYPE_PACKED_VECTOR4_ARRAY,
]


# =============================================================================
# add_animation_track, remove_animation_track
# =============================================================================
func add_animation_track(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var given_track: Variant = args.get("track", {})

	if scene_path.strip_edges() == "res://":
		return { "ok": false, "error": "Missing scenePath" }
	if animation_name.strip_edges().is_empty():
		return { "ok": false, "error": "Missing animationName" }
	var track: Dictionary = given_track if given_track is Dictionary else {}
	if track.is_empty():
		return { "ok": false, "error": "Missing track" }
	# The schema leaves keyframes out of what track requires, since remove_track finds a track
	# without them.
	if not track.has("keyframes"):
		return { "ok": false, "error": "Missing track.keyframes" }
	var keyed: Array = _keyframes(track)
	if not keyed[0]:
		return { "ok": false, "error": keyed[1] }

	# Asked of the player, which knows every library: looking only in the default one refused
	# "moves/walk" as missing.
	var opened: Array = _animation_at(scene_path, player_node_path, animation_name)
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var player: AnimationPlayer = opened[1]
	var anim: Animation = player.get_animation(StringName(animation_name))
	var homes: Array = _homes(
		scene, [[_library_of(player, animation_name), "animation library"], [anim, "animation"]]
	)
	if not homes[0]:
		return scene.refuse(str(homes[1]))

	var target_path: String = str(track.get("nodePath", ""))
	if target_path.is_empty():
		target_path = "."
	var target: Node = _animated(player, target_path)
	if target == null:
		return (
			scene
			. refuse(
				(
					(
						"No node at %s from the player's root node, %s, which is what the track "
						+ "path is read against."
					)
					% [target_path, str(player.root_node)]
				)
			)
		)
	var keyframes: Array = keyed[1]
	var replacing: bool = GdhRead.as_bool(args.get("replaceKeys", false))
	var built: Array = _add_track(player, anim, track, target_path, keyframes, replacing)
	if not str(built[1]).is_empty():
		return scene.refuse(str(built[1]))
	var track_idx: int = built[0]

	var at: String = scene.path_of(player)
	var keys: int = anim.track_get_key_count(track_idx)
	var check: Callable = func(saved: Node) -> String:
		var copy: AnimationPlayer = saved.get_node_or_null(at) as AnimationPlayer
		if copy == null or not copy.has_animation(StringName(animation_name)):
			return "%s would not be in the scene when it loads." % animation_name
		var loaded: Animation = copy.get_animation(StringName(animation_name))
		if loaded.get_track_count() <= track_idx or loaded.track_get_key_count(track_idx) != keys:
			return "the track would not be in %s when the scene loads." % animation_name
		return ""
	var answer: Dictionary = {
		"ok": true,
		"trackType": str(track.get("type", "")),
		"trackIndex": track_idx,
		"keys": keys,
		"keysAdded": keyframes.size(),
	}
	if anim.track_get_type(track_idx) == Animation.TYPE_VALUE:
		var mode: int = anim.value_track_get_update_mode(track_idx)
		answer["update"] = GdhAnimationReads.UPDATE_MODE_NAMES.get(mode, str(mode))
		var blended: int = anim.track_get_interpolation_type(track_idx)
		answer["interpolation"] = GdhAnimationReads.INTERPOLATION_NAMES.get(blended, str(blended))
		answer["loopWrap"] = anim.track_get_interpolation_loop_wrap(track_idx)
	if built[3]:
		answer["existingTrack"] = true
	var replaced: Array = built[5]
	if not replaced.is_empty():
		answer["keysReplaced"] = replaced
		answer["keysAdded"] = keyframes.size() - replaced.size()
	if built[2] != null:
		answer["methodFound"] = built[2]
		# Written all the same, as a missing method is: the method may be changed next.
		if built[2]:
			answer["argumentsFit"] = str(built[4]).is_empty()
	if not str(built[4]).is_empty():
		answer["misfit"] = built[4]
	# Only the keys this call wrote: a key left past the end by an earlier call was named again on
	# every later one, as though the key just written were past it.
	var written: PackedStringArray = []
	for keyframe: Dictionary in keyframes:
		var time: float = GdhRead.as_float(keyframe["time"])
		if time > anim.length + 0.0001:
			var _added: bool = written.append(
				"%s at %s s" % [str(anim.track_get_path(track_idx)), _seconds(time)]
			)
	var past: String = _past_sentence(anim, animation_name, written)
	if not past.is_empty():
		answer["pastLength"] = past
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)


## Adds [param track] to [param anim] of [param player], on the node at [param target_path] from the
## player's root, which the caller has found, with [param keyframes], as [index, why not,
## methodFound,
## existing, misfit, replaced]: methodFound is null for a property track, existing is whether the
## keys went into a track the animation already had for that path, misfit why a method key's
## arguments cannot reach the method, or "", and replaced each key [param replacing] let a keyframe
## take the place of, as its time and what it held.
##
## Into that track rather than a second one beside it, as the editor keys a property it already
## animates: two tracks for one path both play, the later overriding the earlier, and a key meant
## to extend the motion was split off where reading the animation showed two halves.
func _add_track(
	player: AnimationPlayer,
	anim: Animation,
	track: Dictionary,
	target_path: String,
	keyframes: Array,
	replacing: bool
) -> Array:
	var target: Node = _animated(player, target_path)
	var track_type: String = str(track.get("type", ""))
	var keys: Array = []
	var method_found: Variant = null
	var misfit: String = ""
	var kind: Animation.TrackType = Animation.TYPE_VALUE
	var path: NodePath = NodePath(target_path)
	var update: int = -1
	var interpolation: int = -1
	if track_type == "property":
		var prop_name: String = str(track.get("property", ""))
		if prop_name.is_empty():
			return _not_added("track.property is required for property track")
		# The server has refused any name but these.
		var named: Variant = GdhAnimationReads.UPDATE_MODE_NAMES.find_key(
			str(track.get("update", ""))
		)
		if named != null:
			update = GdhRead.as_int(named)
		var blended: Variant = GdhAnimationReads.INTERPOLATION_NAMES.find_key(
			str(track.get("interpolation", ""))
		)
		if blended != null:
			interpolation = GdhRead.as_int(blended)
		var values: Array = _key_values(target, prop_name, keyframes)
		if not values[0]:
			return _not_added(str(values[1]))
		keys = values[1]
		path = NodePath(target_path + ":" + prop_name)
	elif track_type == "method":
		var method_name: String = str(track.get("method", ""))
		if method_name.is_empty():
			return _not_added("track.method is required for method track")
		for index: int in keyframes.size():
			var keyframe: Dictionary = keyframes[index]
			var given: Variant = keyframe.get("args", [])
			if not given is Array:
				return _not_added("keyframes[%d].args must be a list." % index)
			var raw: Array = given
			var arguments: Array = _fitted(target, method_name, _parse_method_args(raw))
			keys.append({ "method": method_name, "args": arguments })
			if misfit.is_empty():
				misfit = _key_misfit(target, method_name, arguments, index)
		method_found = target.has_method(method_name)
		kind = Animation.TYPE_METHOD
		# A method key is called at its time and never blended, so neither has anything to set.
		for blending: String in ["interpolation", "loopWrap"]:
			if track.has(blending):
				return _not_added(
					"track.%s is for property tracks; a method key is not blended." % blending
				)
	else:
		return _not_added(
			(
				(
					"add_track makes property and method tracks, and track.type is %s; "
					+ "remove_track takes any."
				)
				% track_type
			)
		)

	var track_idx: int = anim.find_track(path, kind)
	var existing: bool = track_idx >= 0
	var replaced: Array[Dictionary] = []
	if existing:
		# Checked before any key goes in, since track_insert_key replaces a key at the same time
		# without a word, and a refusal partway would leave the editor's scene half changed.
		var values: GdhSerialisation = GdhSerialisation.new()
		for index: int in keyframes.size():
			var keyframe: Dictionary = keyframes[index]
			var time: float = GdhRead.as_float(keyframe["time"])
			var key: int = anim.track_find_key(track_idx, time, Animation.FIND_MODE_APPROX)
			if key < 0:
				continue
			if not replacing:
				return _not_added(
					(
						(
							"Track %d already animates %s and has a key at %s s, which "
							+ "keyframes[%d] would replace. Nothing was written; replaceKeys true "
							+ "replaces it."
						)
						% [track_idx, str(path), _seconds(time), index]
					)
				)
			# A method key's value is its call, {"method": ..., "args": [...]}. The time is as
			# asked: the key's own, read back from a scene's 32-bit times, puts 0.1 at
			# 0.100000001490116.
			(
				replaced
				. append(
					{
						"time": time,
						"was": values.serialize_value(anim.track_get_key_value(track_idx, key)),
					}
				)
			)
	else:
		track_idx = anim.add_track(kind)
		anim.track_set_path(track_idx, path)
		if kind == Animation.TYPE_VALUE:
			_as_the_editor_makes(anim, track_idx, player, target)
	if update >= 0:
		anim.value_track_set_update_mode(track_idx, update as Animation.UpdateMode)
	if interpolation >= 0:
		anim.track_set_interpolation_type(track_idx, interpolation as Animation.InterpolationType)
	if track.has("loopWrap"):
		anim.track_set_interpolation_loop_wrap(track_idx, GdhRead.as_bool(track["loopWrap"]))
	for index: int in keyframes.size():
		var keyframe: Dictionary = keyframes[index]
		if anim.track_insert_key(track_idx, GdhRead.as_float(keyframe["time"]), keys[index]) < 0:
			return _not_added("Keyframe %d could not be inserted." % index)
	return [track_idx, "", method_found, existing, misfit, replaced]


## Sets the new property track [param index] up as the editor sets up a track it makes: as the
## RESET animation's track for the same path when there is one, and otherwise discrete unless the
## property's declared type is one the editor blends, so a bool or an int changes at its key rather
## than halfway to it.
static func _as_the_editor_makes(
	anim: Animation, index: int, player: AnimationPlayer, target: Node
) -> void:
	var path: NodePath = anim.track_get_path(index)
	var mode: Animation.UpdateMode = Animation.UPDATE_DISCRETE
	if player.has_animation(&"RESET") and player.get_animation(&"RESET") != anim:
		var reset: Animation = player.get_animation(&"RESET")
		for kind: Animation.TrackType in [Animation.TYPE_VALUE, Animation.TYPE_BEZIER]:
			var at: int = reset.find_track(path, kind)
			if at < 0:
				continue
			if kind == Animation.TYPE_VALUE:
				mode = reset.value_track_get_update_mode(at)
			anim.value_track_set_update_mode(index, mode)
			anim.track_set_interpolation_type(index, reset.track_get_interpolation_type(at))
			anim.track_set_interpolation_loop_wrap(
				index, reset.track_get_interpolation_loop_wrap(at)
			)
			return
	if BLENDED_TYPES.has(_declared_type(target, path)):
		mode = Animation.UPDATE_CONTINUOUS
	anim.value_track_set_update_mode(index, mode)


## The type the node or resource holding the last name of [param path] declares for it, read from
## [param target] as the editor reads it: a property of a property, as position:x, is no name the
## node declares, so it has none.
static func _declared_type(target: Node, path: NodePath) -> int:
	var reached: Array = target.get_node_and_resource(
		NodePath(".:" + str(path.get_concatenated_subnames()))
	)
	var leftover: NodePath = reached[2]
	var holder: Object = reached[1] if reached[1] != null else reached[0]
	if holder == null or leftover.get_subname_count() == 0:
		return TYPE_NIL
	var leaf: String = str(leftover.get_subname(leftover.get_subname_count() - 1))
	for declared: Dictionary in holder.get_property_list():
		if str(declared.get("name", "")) == leaf:
			return GdhRead.as_int(declared.get("type", TYPE_NIL))
	return TYPE_NIL


## What [method _add_track] answers when it added nothing, because of [param why].
static func _not_added(why: String) -> Array:
	return [-1, why, null, false, "", []]


## [param arguments] as [param method] on [param target] takes them: a whole number read as a
## float, as JSON gives every number, is an int unless the parameter is a float, so a key calling
## step(by: int) with 3 is saved as 3 rather than 3.0.
static func _fitted(target: Node, method: String, arguments: Array) -> Array:
	var parameters: Array = []
	for info: Dictionary in target.get_method_list():
		if str(info.get("name", "")) == method:
			parameters = info.get("args", [])
			break
	var fitted: Array = []
	for at: int in arguments.size():
		var value: Variant = arguments[at]
		var declared: int = TYPE_NIL
		if at < parameters.size():
			var parameter: Dictionary = parameters[at]
			declared = GdhRead.as_int(parameter.get("type", TYPE_NIL))
		if value is float and declared != TYPE_FLOAT:
			var number: float = value
			if (is_finite(number)
					and number == floorf(number)
					and absf(number) < 9_007_199_254_740_992.0):
				value = int(number)
		fitted.append(value)
	return fitted


## Why the key [param index], calling [param method] on [param target] with [param arguments],
## fails each time it plays, or "" when it can be called or the method is not there to judge. Only
## what fails every time is named, as scene_signal judges a connection: too few or too many
## arguments, and an object where the method takes a value or the reverse.
static func _key_misfit(target: Node, method: String, arguments: Array, index: int) -> String:
	var taken: Dictionary = {}
	for info: Dictionary in target.get_method_list():
		if str(info.get("name", "")) == method:
			taken = info
			break
	if taken.is_empty() or GdhRead.as_int(taken.get("flags", 0)) & METHOD_FLAG_VARARG:
		return ""
	var parameters: Array = taken.get("args", [])
	var defaults: Array = taken.get("default_args", [])
	var needed: int = parameters.size() - defaults.size()
	var fails: String = ", so the call fails each time the key plays."
	var passed: String = (
		"no arguments"
		if arguments.is_empty()
		else ("1 argument" if arguments.size() == 1 else "%d arguments" % arguments.size())
	)
	if arguments.size() < needed:
		return (
			"keyframes[%d] calls %s with %s, and it needs %d%s"
			% [index, method, passed, needed, fails]
		)
	if arguments.size() > parameters.size():
		var most: String = "none" if parameters.is_empty() else "at most %d" % parameters.size()
		return (
			"keyframes[%d] calls %s with %s, and it takes %s%s"
			% [index, method, passed, most, fails]
		)
	for at: int in arguments.size():
		var parameter: Dictionary = parameters[at]
		var taken_type: int = GdhRead.as_int(parameter.get("type", TYPE_NIL))
		var given_type: int = typeof(arguments[at])
		if taken_type == TYPE_NIL or given_type == TYPE_NIL:
			continue
		if (given_type == TYPE_OBJECT) != (taken_type == TYPE_OBJECT):
			return (
				"keyframes[%d] passes argument %d as %s, and %s takes %s as %s%s"
				% [
					index,
					at + 1,
					type_string(given_type),
					method,
					str(parameter.get("name", "")),
					type_string(taken_type),
					fails,
				]
			)
	return ""


## Takes out the track [code]track[/code] names by its type, nodePath and property as read answers
## them, so a track read back can be passed as it stands. Its keyframes are not looked at. Every
## track of that shape goes, since the editor can make two for one path and both play. A method
## track given a method loses only the keys calling it, since add_track puts every method called on
## one node in one track. The track goes once no key is left.
func remove_animation_track(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var given_track: Variant = args.get("track", {})
	if scene_path.strip_edges() == "res://":
		return { "ok": false, "error": "Missing scenePath" }
	if animation_name.strip_edges().is_empty():
		return { "ok": false, "error": "Missing animationName" }
	var track: Dictionary = given_track if given_track is Dictionary else {}
	if track.is_empty():
		return { "ok": false, "error": "Missing track" }
	var track_type: String = str(track.get("type", ""))
	if not track_type in GdhAnimationReads.TRACK_TYPE_NAMES.values():
		return { "ok": false, "error": "Unsupported track.type: " + track_type }
	var node_path: String = str(track.get("nodePath", ""))
	var property: String = str(track.get("property", ""))
	var shape: Array = [track_type, node_path, property]
	var method: String = str(track.get("method", "")) if track_type == "method" else ""
	var read_times: Variant = _times_of(args.get("times"))
	if read_times is String:
		return { "ok": false, "error": read_times }
	var times: Array = read_times

	var found: Array = _animation_at(scene_path, player_node_path, animation_name)
	if found[1] == null:
		return found[2]
	var scene: GdhSceneFile = found[0]
	var player: AnimationPlayer = found[1]
	var anim: Animation = player.get_animation(StringName(animation_name))
	var homes: Array = _homes(
		scene, [[_library_of(player, animation_name), "animation library"], [anim, "animation"]]
	)
	if not homes[0]:
		return scene.refuse(str(homes[1]))
	var matching: Array[int] = []
	var held: PackedStringArray = []
	for index: int in anim.get_track_count():
		var of: Array = _track_shape(anim, index)
		if of == shape:
			matching.append(index)
		var _listed: bool = held.append("%s (%s)" % [str(anim.track_get_path(index)), of[0]])
	if matching.is_empty():
		var said: String = (
			"%s has no %s track on %s"
			% [
				animation_name,
				track_type,
				node_path if property.is_empty() else "%s:%s" % [node_path, property],
			]
		)
		if held.is_empty():
			return scene.refuse("%s; it has no tracks." % said)
		return scene.refuse("%s; its tracks are %s." % [said, ", ".join(held)])
	var calling: Array = _keys_calling(anim, matching, method)
	if calling.is_empty():
		return scene.refuse(
			(
				"%s's method track on %s has no key calling %s; its keys call %s."
				% [animation_name, node_path, method, ", ".join(_methods_called(anim, matching))]
			)
		)
	if not times.is_empty():
		var timed: Array = _keys_at(anim, calling, times)
		if timed[1] != "":
			var on: String = node_path if property.is_empty() else "%s:%s" % [node_path, property]
			return scene.refuse(
				"%s's %s track on %s %s" % [animation_name, track_type, on, timed[1]]
			)
		calling = timed[0]
	var keys: int = 0
	var tracks_removed: int = 0
	calling.reverse()
	for pair: Array in calling:
		var index: int = pair[0]
		if pair[1] < 0:
			keys += anim.track_get_key_count(index)
			anim.remove_track(index)
			tracks_removed += 1
			continue
		var key: int = pair[1]
		anim.track_remove_key(index, key)
		keys += 1
		if anim.track_get_key_count(index) == 0:
			anim.remove_track(index)
			tracks_removed += 1

	var at: String = scene.path_of(player)
	var left: int = anim.get_track_count()
	var keys_left: int = _key_total(anim)
	var check: Callable = func(saved: Node) -> String:
		var copy: AnimationPlayer = saved.get_node_or_null(at) as AnimationPlayer
		if copy == null or not copy.has_animation(StringName(animation_name)):
			return "%s would not be in the scene when it loads." % animation_name
		var loaded: Animation = copy.get_animation(StringName(animation_name))
		if loaded.get_track_count() != left or _key_total(loaded) != keys_left:
			return "the track would still be in %s when the scene loads." % animation_name
		return ""
	var removed: Dictionary = { "type": track_type, "nodePath": node_path }
	if not property.is_empty():
		removed["property"] = property
	if not method.is_empty():
		removed["method"] = method
	var answer: Dictionary = {
		"ok": true,
		"animationName": animation_name,
		"removed": removed,
		"tracksRemoved": tracks_removed,
		"keysRemoved": keys,
		"tracks": left,
	}
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)


## What of the tracks [param matching] of [param anim] goes, in track order, as [[track, key]]: key
## -1 for a whole track, or with [param method] given each key that calls it, by its index.
static func _keys_calling(anim: Animation, matching: Array[int], method: String) -> Array:
	var calling: Array = []
	for index: int in matching:
		if method.is_empty():
			calling.append([index, -1])
			continue
		for key: int in anim.track_get_key_count(index):
			if str(anim.method_track_get_name(index, key)) == method:
				calling.append([index, key])
	return calling


## The key times [param given] names, as floats, empty when it is null, or the String refusing it.
static func _times_of(given: Variant) -> Variant:
	var times: Array = []
	if given == null:
		return times
	if not given is Array:
		return "times is a list of the key times to remove, in seconds"
	var listed: Array = given
	if listed.is_empty():
		return "times is a list of the key times to remove, in seconds"
	for time: Variant in listed:
		if not (time is float or time is int):
			return "times holds %s, which is not a number of seconds" % str(time)
		times.append(GdhRead.as_float(time))
	return times


## Of the keys [param calling] names, as [method _keys_calling] answers them, the ones at
## [param times], as [[[track, key]...], ""], or with the second the words refusing a time none is
## at. Removing a key took removing its whole track, so moving one key in time rewrote every other.
static func _keys_at(anim: Animation, calling: Array, times: Array) -> Array:
	var at: Array = []
	var held: PackedStringArray = []
	var missed: Array = times.duplicate()
	for pair: Array in calling:
		var index: int = pair[0]
		for key: int in anim.track_get_key_count(index):
			if pair[1] >= 0 and key != pair[1]:
				continue
			var time: float = anim.track_get_key_time(index, key)
			var _listed: bool = held.append(str(GdhAnimationReads.held_seconds(time)))
			for given: float in times:
				if GdhAnimationReads.same_time(time, given):
					at.append([index, key])
					missed.erase(given)
					break
	if missed.is_empty():
		return [at, ""]
	var named: PackedStringArray = []
	for given: float in missed:
		var _named: bool = named.append(str(given))
	return [
		at,
		(
			"has no key at %s s; its keys are at %s s. Nothing was removed."
			% [", ".join(named), ", ".join(held)]
		),
	]


## The methods the keys of the tracks [param matching] call, each once.
static func _methods_called(anim: Animation, matching: Array[int]) -> PackedStringArray:
	var called: PackedStringArray = []
	for index: int in matching:
		for key: int in anim.track_get_key_count(index):
			var method: String = str(anim.method_track_get_name(index, key))
			if not called.has(method):
				var _added: bool = called.append(method)
	return called


static func _key_total(anim: Animation) -> int:
	var total: int = 0
	for track: int in anim.get_track_count():
		total += anim.track_get_key_count(track)
	return total


## Track [param index] of [param anim] as [type, nodePath, property], named as read names them.
static func _track_shape(anim: Animation, index: int) -> Array:
	var path: NodePath = anim.track_get_path(index)
	return [
		GdhAnimationReads.TRACK_TYPE_NAMES.get(
			anim.track_get_type(index), str(anim.track_get_type(index))
		),
		str(path.get_concatenated_names()),
		str(path.get_concatenated_subnames()),
	]


## The keyframes of [param track], as [true, list] or [false, why]. Each needs its own time: one
## that was not a dictionary was skipped, and one without a time went in at 0, where the next such
## key replaced it, and the answer said nothing of either.
func _keyframes(track: Dictionary) -> Array:
	var given: Variant = track.get("keyframes", [])
	if not given is Array:
		return [false, "track.keyframes must be a list."]
	var keyframes: Array = given
	var times: Dictionary = {}
	for index: int in keyframes.size():
		if not keyframes[index] is Dictionary:
			return [false, "keyframes[%d] is not an object with a time." % index]
		var keyframe: Dictionary = keyframes[index]
		var time: Variant = keyframe.get("time")
		if not (time is float or time is int):
			return [false, "keyframes[%d] has no time." % index]
		var seconds: float = GdhRead.as_float(time)
		if times.has(seconds):
			return [
				false,
				"keyframes[%d] and [%d] are both at %s seconds." % [times[seconds], index, seconds],
			]
		times[seconds] = index
	return [true, keyframes]


## Each keyframe's value read as the property [param prop_name] on [param target] takes it, as
## [true, values] or [false, why]. Read without the property, a string "10" keyed on Label.text
## was stored as the number 10, and a Vector2 given as [1, 2] as a list.
func _key_values(target: Node, prop_name: String, keyframes: Array) -> Array:
	var base: String = prop_name.get_slice(":", 0)
	var declared: Dictionary = _properties.declaration(target, base)
	if declared.is_empty():
		return [false, GdhPropertyValues.no_property(target, base)]
	var values: Array = []
	for index: int in keyframes.size():
		var keyframe: Dictionary = keyframes[index]
		var raw: Variant = keyframe.get("value")
		if base != prop_name:
			# A subname such as position:x keys one component, which is a number.
			var component: Variant = _properties.parse(raw, TYPE_FLOAT)
			if not component is float:
				return [
					false, "keyframes[%d].value keys %s, which is a number." % [index, prop_name],
				]
			values.append(component)
			continue
		var value: Array = _properties.value_for(target, declared, raw)
		if not value[0]:
			return [false, "keyframes[%d]: %s" % [index, value[1]]]
		values.append(value[1])
	return [true, values]
