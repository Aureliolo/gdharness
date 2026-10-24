extends RefCounted

## What crosses the wire between the game and the server, in both directions: Godot values
## as JSON-safe dictionaries, and JSON back into the values a property or parameter wants.
##
## The conversion itself is the shared one, so a value read off a running game is spelled exactly
## as the same value read off the editor or off a headless engine. What is here is the part that is
## only true of a running game: reaching a node by path, and fitting an argument to the type the
## method it is going to declares.

const GdhDeclared = preload("declared_values.gd")
const GdhRead = preload("reading.gd")
const GdhSerialisation = preload("serialisation.gd")
const GdhShapes = preload("value_shapes.gd")

## The engine singletons a call, a write or a read may name instead of a node: what the engine
## measures, and the engine settings that are the game's own. Not every singleton: OS runs programs
## and opens files, DisplayServer switches the keyboard's layout and Input moves the real pointer,
## and none of that is a game's to do to the machine it runs on.
const SINGLETONS: Array[String] = [
	"Engine",
	"Performance",
	"RenderingServer",
	"AudioServer",
	"PhysicsServer2D",
	"PhysicsServer3D",
	"NavigationServer2D",
	"NavigationServer3D",
	"Time",
	"TranslationServer",
]
## The most frames a press is held in one call, as many as a frames wait takes.
const MOST_HELD: int = 600

## Read by [method _key_names], once a game.
static var _named_keys: PackedStringArray = []

var _shared: GdhSerialisation = GdhSerialisation.new()


## Converts a Godot value into something JSON can carry.
func serialize(value: Variant) -> Variant:
	return _shared.serialize_value(value)


## Rebuilds a Godot value from the shape [method serialize] gave it.
func deserialize(value: Variant) -> Variant:
	return _shared.deserialize_value(value)


## The node [param path] names under [param root], or a refusal saying why there is not one.
##
## The other direction of what a node serialises as, and here for that reason: a node crosses the
## wire as its path, so a path crossing back is a node or it is nothing. One answer for every op,
## because each of them read a path for itself and they could disagree about what one means.
##
## A colon is the disagreement worth its own sentence. Godot reads everything after the first one
## as subnames and [method Node.get_node_or_null] drops them, so "/root/Main:_game:run" was quietly
## answered about "/root/Main", and an op that then said the path had no method `advance` was right
## about an object nobody had asked for. Colons reach through what a node holds, and the arguments
## that take them are the property and the method.
static func node_at(root: Node, path: String) -> Dictionary:
	if path.is_empty():
		return {"type": "error", "message": "Node path required"}

	if path.contains(":"):
		var shape: String = (
			'"%s" names a node and colons reach past one: "%s" is the node,'
			+ ' and "%s" goes in the property or the method'
		)
		return {
			"type": "error",
			"message": shape % [path, path.get_slice(":", 0), path.substr(path.find(":") + 1)],
		}

	var node: Node = root.get_node_or_null(path)
	if node == null:
		return {"type": "error", "message": _not_found(root, path)}
	return {"node": node}


## "Node not found" for [param path], with the deepest node of it the game has and the children that
## node has instead, as a scene's refusal names them: a mistyped step was otherwise found by reading
## the whole tree. A path written from the current scene rather than from the root, as a scene's
## tools take one, is given the path that reaches it.
static func _not_found(root: Node, path: String) -> String:
	var said: String = "Node not found: " + path
	var scene: Node = root.get_tree().current_scene if root.is_inside_tree() else null
	if not path.begins_with("/") and scene != null:
		var meant: Node = scene.get_node_or_null(path)
		if meant != null:
			return (
				"%s. Paths here go from the root, /root, not from the current scene, so this one is %s."
				% [said, str(meant.get_path())]
			)
	var parts: PackedStringArray = path.split("/", false)
	var at: Node = root
	var step: int = 0
	if path.begins_with("/"):
		if parts.is_empty() or parts[0] != str(root.name):
			return said
		step = 1
	while step < parts.size():
		var below: Node = at.get_node_or_null(NodePath(parts[step]))
		if below == null:
			break
		at = below
		step += 1
	if step >= parts.size():
		return said
	var names: PackedStringArray = []
	for child: Node in at.get_children():
		var _named: bool = names.append(str(child.name))
	return GdhRead.missing_below(said, "", PackedStringArray([str(at.get_path())]), parts[step], names)


## How many process frames a whole press holds before its release, from `holdFrames`: one unless
## asked, as the halves of a press have always been a frame apart. Held inside the game because the
## time between a press, a wait and a release sent as three calls counts as held too: a 60-frame
## pour poured for nearly three seconds. A String saying why, where the hold cannot be.
static func held_for(params: Dictionary) -> Variant:
	if not params.has("holdFrames"):
		return 1
	if params.has("pressed"):
		return (
			"holdFrames holds a whole press and then lets go, and pressed asks for one half of one:"
			+ " give one or the other."
		)
	var frames: int = GdhRead.as_int(params["holdFrames"], 0)
	if frames < 1 or frames > MOST_HELD:
		return "holdFrames is %d, and it takes 1 to %d." % [frames, MOST_HELD]
	return frames


## What a press says it was held for: [param frames] for a whole one, nothing for one half.
static func held_answer(whole: bool, frames: int) -> Variant:
	if whole:
		return frames
	return null


## Waits out [param frames] process frames of [param tree], how long a whole press is held down,
## and answers how long that was by the clock and in physics ticks. A process frame is no set
## time: a headless game draws nothing and runs them as fast as it can, so thirty held a movement
## read in _physics_process for twelve ticks, a fifth of a second, where a caller counting sixty
## frames a second expected half of one.
static func hold(tree: SceneTree, frames: int) -> Dictionary:
	var began_usec: int = Time.get_ticks_usec()
	var began_tick: int = Engine.get_physics_frames()
	for _frame: int in frames:
		await tree.process_frame
	return {
		"seconds": snappedf((Time.get_ticks_usec() - began_usec) / 1000000.0, 0.001),
		"physics_frames": Engine.get_physics_frames() - began_tick,
	}


## The character a key produces, or nothing for a key that produces none.
##
## Godot's keycodes below [constant KEY_SPECIAL] are the Unicode code points of the keys that
## print something, so the mapping is the value itself. Letters are held as their capitals, which
## is the one place the shift a caller asked for changes the answer rather than the key: the small
## letter is 32 above its capital.
static func glyph_of(keycode: Key, shifted: bool) -> int:
	if keycode >= KEY_SPECIAL:
		return 0
	if keycode >= KEY_A and keycode <= KEY_Z and not shifted:
		return keycode + 32
	return keycode


## The refusal for [param name], which no key is called, with the key names nearest it. Read from the
## engine's own names, printable keys and the special ones above [constant KEY_SPECIAL], since the
## game takes any name OS.find_keycode_from_string does.
static func unknown_key(name: String) -> String:
	var close: PackedStringArray = GdhRead.nearest(name, _key_names())
	var said: String = "No key is called %s." % name
	if close.size() == 1:
		said += " The nearest key name is %s." % close[0]
	elif not close.is_empty():
		said += " The nearest key names are %s." % ", ".join(close)
	return (
		said
		+ ' A key is named as Godot names it, such as "Space", "Enter", "Escape", "A" or "F1",'
		+ " or given by its keycode."
	)


## Every key name the engine takes, read once a game. The engine spells a code it has no name for as
## the character it would be, and past the last code point that is an error it prints: 136 of them
## for the special range, two seconds of console on a fast machine, more than a call's whole wait on
## a loaded one, and each in the game's log as an error the game never made. So they are asked with
## the engine's error printing off, which no other line of the main thread runs beside.
static func _key_names() -> PackedStringArray:
	if not _named_keys.is_empty():
		return _named_keys
	var printing: bool = Engine.print_error_messages
	Engine.print_error_messages = false
	for code: int in range(32, 127) + range(KEY_SPECIAL + 1, KEY_SPECIAL + 0x100):
		var spelled: String = OS.get_keycode_string(code as Key)
		if not spelled.is_empty() and OS.find_keycode_from_string(spelled) == code:
			var _named: bool = _named_keys.append(spelled)
	Engine.print_error_messages = printing
	return _named_keys


## The refusal for [param action], which the input map lacks, with the nearest of the project's own
## actions, or else all of them. The engine's ui_ ones are in every project, and offered for any name
## they only buried the project's ("dance" is near ui_cancel), so they are offered for a ui_ name only.
static func no_action(action: String) -> String:
	var engine: PackedStringArray = []
	var own: PackedStringArray = []
	for named: StringName in InputMap.get_actions():
		if str(named).begins_with("ui_"):
			var _listed: bool = engine.append(str(named))
		else:
			var _owned: bool = own.append(str(named))
	own.sort()
	var said: String = "Action not found: %s" % action
	var close: PackedStringArray = GdhRead.nearest(action, engine if action.begins_with("ui_") else own)
	if not close.is_empty():
		return "%s; the nearest %s %s." % [said, "is" if close.size() == 1 else "are", ", ".join(close)]
	if own.is_empty():
		return "%s; the project defines no actions of its own, and the engine's are the ui_ ones." % said
	return "%s; the project's own actions are %s, beside the engine's ui_ ones." % [said, ", ".join(own)]


## The actions of the input map that [param event] stands for, as Input reads it for
## is_action_pressed: a key or a button bound to an action presses that action too, so a game
## counting the action counted the key, and the answer had said only that a key went in.
static func actions_of(event: InputEvent) -> Array[String]:
	var named: Array[String] = []
	# A motion matches every action on its axis, either way and at any distance, which would name
	# ui_left for a stick held right; Input presses only those its direction reaches past their
	# deadzone.
	var moved: bool = event is InputEventJoypadMotion
	for action: StringName in InputMap.get_actions():
		if event.is_action_pressed(action) if moved else InputMap.event_is_action(event, action):
			named.append(str(action))
	named.sort()
	return named


## The path of the Control holding the keyboard focus in [param host]'s viewport, or "" when none
## does. Read before an event goes in, since pressing a focused button can move the focus.
static func focus_path(host: Node) -> String:
	var holding: Control = host.get_viewport().gui_get_focus_owner()
	return "" if holding == null else str(holding.get_path())


## [param said] with [param focused], the Control that had the focus, under focused. A key, an action
## or a pad's event reaches that Control before the game's _unhandled_input: Space on a focused Button
## pressed it and the game's own handler counted the key as well, and a stick pushed down moved a
## focused list's selection and never reached the game, with nothing in the answer saying why.
##
## Where the focus is once the event has been handled goes under focused_after when it moved, null
## when nothing holds it then: ui_down on a focused button hands the focus to its neighbour, and an
## answer naming only the button that took the press read as the focus never having moved.
static func focus_noted(said: Dictionary, focused: String, host: Node) -> Dictionary:
	if not focused.is_empty():
		said["focused"] = focused
	var now: String = focus_path(host)
	if now.is_empty() and not focused.is_empty():
		said["focused_after"] = null
	elif now != focused:
		said["focused_after"] = now
	return said


## Presses the buttons under [param root] whose Shortcut [param action] matches, as the player's key
## bound to it would, and answers their paths under "shortcuts" and the one that took the press
## under "shortcut_pressed". A Viewport hands a shortcut only keys, joypad buttons and
## InputEventShortcut, so an action pressed on its own never reached a Button whose Shortcut holds
## that action, which is how a game gives a button a binding the player can change.
##
## A key goes to the shortcuts last in the tree first and stops at the first button that takes it,
## while an InputEventShortcut reaches only the buttons holding that one Shortcut. So each Shortcut
## is sent in that order, a frame apart, until a button is pressed; a button still decides by its
## disabled, its visibility and its shortcut context, as it does for the key.
static func press_shortcuts(root: Node, action: String) -> Dictionary:
	var pressing: InputEventAction = InputEventAction.new()
	pressing.action = action
	pressing.pressed = true
	var buttons: Array[BaseButton] = []
	for node: Node in root.find_children("*", "BaseButton", true, false):
		var button: BaseButton = node
		if button.shortcut != null and button.shortcut.matches_event(pressing):
			buttons.append(button)
	var paths: Array[String] = []
	for button: BaseButton in buttons:
		paths.append(str(button.get_path()))
	buttons.reverse()
	var taken: Array[String] = []
	var heard: Array[Callable] = []
	for button: BaseButton in buttons:
		var path: String = str(button.get_path())
		var hearing: Callable = func() -> void: taken.append(path)
		heard.append(hearing)
		var _listening: int = button.pressed.connect(hearing)
	var sent: Dictionary = {}
	for button: BaseButton in buttons:
		if not taken.is_empty():
			break
		if sent.has(button.shortcut):
			continue
		sent[button.shortcut] = true
		var through: InputEventShortcut = InputEventShortcut.new()
		through.shortcut = button.shortcut
		Input.parse_input_event(through)
		await root.get_tree().process_frame
	for at: int in buttons.size():
		if is_instance_valid(buttons[at]):
			buttons[at].pressed.disconnect(heard[at])
	var pressed: Variant = null
	if not taken.is_empty():
		pressed = taken[0]
	return {"shortcuts": paths, "shortcut_pressed": pressed}


## The methods [param object] answers to, as the engine lists them: for a script itself, the static
## functions it declares before the methods every script has. The engine's list for a script holds
## only those, so a static function called on its class was read as taking nothing.
static func methods_of(object: Object) -> Array[Dictionary]:
	var listed: Array[Dictionary] = []
	if object is Script:
		var script: Script = object
		for entry: Dictionary in script.get_script_method_list():
			if GdhRead.as_int(entry.get("flags", 0)) & METHOD_FLAG_STATIC:
				listed.append(entry)
	listed.append_array(object.get_method_list())
	return listed


## What [param path] names: a node under [param root], as [method node_at] reads it, or an engine
## singleton by its name. Answers the object under "object", and under "node" the node that objects
## named in a value are found from, which for a singleton is [param root].
static func target_at(root: Node, path: String) -> Dictionary:
	if SINGLETONS.has(path):
		return {"object": Engine.get_singleton(path), "node": root}
	if not path.contains("/") and Engine.has_singleton(path):
		return {
			"type": "error",
			"message":
			(
				(
					"%s is an engine singleton, and the ones that can be reached are %s. The rest act"
					+ " on the machine rather than the game: OS runs programs, DisplayServer switches the"
					+ " keyboard's layout and Input moves the real pointer."
				)
				% [path, ", ".join(SINGLETONS)]
			),
		}
	var standing: Dictionary = node_at(root, path)
	if standing.has("message"):
		return standing
	return {"object": standing["node"], "node": standing["node"]}


## The script [param path] names for a call of one of its static functions, as [method target_at]
## answers a node, with [param root] as the node objects named in its arguments are found from: a
## script by its res:// path, or the global class of that name where no node is at [param path].
## Answers {} when it names a node or no class, and a message for a res:// path holding no script.
## A class no node carries could not be called at all, and each way of naming it read as a node or
## a method misspelt.
static func class_at(root: Node, path: String) -> Dictionary:
	var script_path: String = path
	if not path.begins_with("res://"):
		if not path.is_valid_ascii_identifier() or not node_at(root, path).has("message"):
			return {}
		script_path = ""
		for declared: Dictionary in ProjectSettings.get_global_class_list():
			if str(declared.get("class", "")) == path:
				script_path = str(declared.get("path", ""))
		if script_path.is_empty():
			return {}
	var loaded: Resource = load(script_path) if ResourceLoader.exists(script_path) else null
	if not loaded is Script:
		return {
			"type": "error",
			"message": "No script is at %s to call a static function of." % script_path,
		}
	return {"object": loaded, "node": root}


## Whether two values can be compared without the comparison itself failing.
static func comparable(one: Variant, other: Variant) -> bool:
	return GdhSerialisation.comparable(one, other)


## Whether a value can be handed to a parameter declared as [param type] without the call failing.
static func acceptable(value: Variant, type: int) -> bool:
	return GdhSerialisation.acceptable(value, type)


## Whether [param given] would have to be cut to become a [param type]: a fraction made a whole
## number, or a number other than 0 or 1 made a truth.
##
## A number arrives from JSON as a float, so one is converted to what the slot holds, and the
## conversion truncates: 2.5 written into an int was stored as 2 and answered as written, and 0.2 on
## a bool became true. A number written as text counts as the number.
static func cuts(given: Variant, type: int) -> bool:
	if type != TYPE_INT and type != TYPE_BOOL:
		return false
	var number: Variant = given
	if given is String:
		var text: String = given
		number = GdhRead.json_or_null(text)
	if typeof(number) != TYPE_FLOAT and typeof(number) != TYPE_INT:
		return false
	var value: float = GdhRead.as_float(number)
	var whole: bool = value == floorf(value)
	if type == TYPE_INT:
		return not whole
	return not (whole and (value == 0.0 or value == 1.0))


## The slot [method cuts] speaks of, with its article, for a refusal to name: "an int" or "a bool".
static func cut_by(type: int) -> String:
	return "an int" if type == TYPE_INT else "a bool"


## Why [param given] may not be the whole number sent, or "": see [method GdhSerialisation.inexact].
static func inexact(given: Variant, type: int) -> String:
	return GdhSerialisation.inexact(given, type)


## What a refusal of [param value] where a [param type] goes ends with: see [method GdhShapes.remedy].
static func remedy(value: Variant, type: int) -> String:
	return GdhShapes.remedy(value, type)


## The declared type of one parameter of a method, or TYPE_NIL when the method or the parameter
## is not there, which reads as "no opinion".
func parameter_type(object: Object, method: String, index: int) -> int:
	for entry: Dictionary in methods_of(object):
		if entry.get("name", "") != method:
			continue
		var params: Array = entry.get("args", [])
		if index < 0 or index >= params.size():
			return TYPE_NIL
		var parameter: Dictionary = params[index]
		return GdhRead.as_int(parameter.get("type", TYPE_NIL), TYPE_NIL)
	return TYPE_NIL


## The values of the enum argument [param index] of [param method] declares, by name, as
## `{"enum": "Mood", "values": {...}}`, or {} when it declares none. The engine gives such an argument
## the type int and the enum's name, as res://main.gd.Mood or Node.ProcessMode.
func parameter_enum(object: Object, method: String, index: int) -> Dictionary:
	for entry: Dictionary in methods_of(object):
		if entry.get("name", "") != method:
			continue
		var params: Array = entry.get("args", [])
		if index < 0 or index >= params.size():
			return {}
		var parameter: Dictionary = params[index]
		if GdhRead.as_int(parameter.get("usage", 0)) & PROPERTY_USAGE_CLASS_IS_ENUM == 0:
			return {}
		var qualified: String = str(parameter.get("class_name", ""))
		var enum_name: String = qualified.get_slice(".", qualified.get_slice_count(".") - 1)
		var values: Dictionary = GdhDeclared.enum_declared_as(qualified)
		if values.is_empty():
			values = _enum_along(object if object is Script else object.get_script(), enum_name)
		if values.is_empty():
			return {}
		return {"enum": enum_name, "values": values}
	return {}


## The enum [param named] declared by [param script] or a script it extends, or {}. A script built in
## a scene or made at run time names its enums by an id nothing loads, gdscript://-92233….gd.Mood
## measured on 4.7.2, and a method of the object called declares its enums along this chain.
static func _enum_along(script: Variant, named: String) -> Dictionary:
	if not script is Script:
		return {}
	var current: Script = script
	while current != null:
		var found: Variant = current.get_script_constant_map().get(named)
		if found is Dictionary:
			var values: Dictionary = found
			return values
		current = current.get_base_script()
	return {}


## An empty list typed as what the packed array [param type] holds, for its elements to be fitted
## against one by one, or null for any other type.
static func packed_template(type: int) -> Variant:
	if not GdhSerialisation.LIST_TYPES.has(type):
		return null
	var element: int = GdhShapes.PACKED_ELEMENTS[type]
	return Array([], element, &"", null)


## The class a method declares for argument [param index], or "" when it names none: an untyped
## parameter, a Variant, or a type that is not an object.
func parameter_class(object: Object, method: String, index: int) -> String:
	for entry: Dictionary in methods_of(object):
		if entry.get("name", "") != method:
			continue
		var params: Array = entry.get("args", [])
		if index < 0 or index >= params.size():
			return ""
		var parameter: Dictionary = params[index]
		return str(parameter.get("class_name", ""))
	return ""


## What the slot [param named] on [param holder] declares it holds, as `{"type": int, "class":
## String, "script": Script or null, "declared": Dictionary}`: a property's declaration, or the
## element type of a typed list or the value type of a typed map. TYPE_NIL when nothing is declared,
## which is also what a property declared as Variant or left untyped reads as: either way it takes
## anything. declared is the property's entry in the property list, which carries its enum or
## range, and empty for anything that is not a property.
##
## Asked rather than read off the value in the slot, because an object slot can be empty: a
## property typed `Gear` holding null reads as TYPE_NIL, and anything written into it passed the
## check and was then dropped by the engine, which answered with the slot still null.
##
## The script only for a typed container, the one place the engine hands it over. A property typed
## as a script class with no `class_name` is declared under the engine class the script extends,
## measured on 4.7.2: `var quarrel: Walker` with Walker a preloaded Node3D script lists as Node3D.
static func slot_declared(holder: Variant, named: String) -> Dictionary:
	# A component holds one kind of value and no other: a vector's axis is a number, its integer
	# form's an integer, a rectangle's size a vector of the same form.
	if named in GdhSerialisation.components_of(holder):
		var component: Variant = holder[named]
		return {"type": typeof(component), "class": "", "script": null, "declared": {}}
	if holder is Array:
		var items: Array = holder
		if items.is_typed():
			return {
				"type": items.get_typed_builtin(),
				"class": _typed_class(items.get_typed_script(), items.get_typed_class_name()),
				"script": _script_or_null(items.get_typed_script()),
				"declared": {},
			}
	elif holder is Dictionary:
		var map: Dictionary = holder
		if map.is_typed_value():
			return {
				"type": map.get_typed_value_builtin(),
				"class": _typed_class(map.get_typed_value_script(), map.get_typed_value_class_name()),
				"script": _script_or_null(map.get_typed_value_script()),
				"declared": {},
			}
	elif holder is Object:
		var object: Object = holder
		for entry: Dictionary in object.get_property_list():
			if str(entry.get("name", "")) == named:
				return {
					"type": GdhRead.as_int(entry.get("type", TYPE_NIL), TYPE_NIL),
					"class": str(entry.get("class_name", "")),
					"script": null,
					"declared": entry,
				}
	return {"type": TYPE_NIL, "class": "", "script": null, "declared": {}}


static func _script_or_null(typed: Variant) -> Script:
	return typed if typed is Script else null


## The class a typed container names: its script's global name where it has one, since the engine
## class of a script class is only what the script extends.
static func _typed_class(script: Variant, engine_class: StringName) -> String:
	if script is Script:
		var typed: Script = script
		if not typed.get_global_name().is_empty():
			return str(typed.get_global_name())
	return str(engine_class)


## Whether [param object] is a [param declared]: an engine class, or a script class by its global
## name anywhere along the script's inheritance.
##
## Against [param declared_script] itself when there is one. A script with no global name is named by
## the engine class it extends, so an object of that class with another script, or none, passes the
## name, and a typed list built with it drops the element: measured on 4.7.2, an Array[Walker] given
## a plain Node3D comes out empty, the engine's errors going to the game's output alone.
static func is_a(object: Object, declared: String, declared_script: Script = null) -> bool:
	if declared_script != null:
		var own: Variant = object.get_script()
		while own is Script:
			if own == declared_script:
				return true
			var along: Script = own
			own = along.get_base_script()
		return false
	if object.is_class(declared):
		return true
	var script: Variant = object.get_script()
	while script is Script:
		var current: Script = script
		if current.get_global_name() == StringName(declared):
			return true
		script = current.get_base_script()
	return false


## What became of [param node] once an input it was given has run: still in the tree, taken out of
## it, or freed. Untyped, because a freed reference handed to a typed parameter is itself the engine
## error this is here to avoid.
static func afterwards(node: Variant) -> String:
	if not is_instance_valid(node):
		return "freed"
	if not node is Node:
		return "removed"
	var placed: Node = node
	return "in_tree" if placed.is_inside_tree() else "removed"


## What [param object] is, by its script class where it has one, and by its script's file where
## that has no global name, since the engine class alone is what a refusal about the script has
## just said it matched.
static func class_of(object: Object) -> String:
	var script: Variant = object.get_script()
	if script is Script:
		var current: Script = script
		if not current.get_global_name().is_empty():
			return str(current.get_global_name())
		return "%s with the script %s" % [object.get_class(), script_named(current)]
	return object.get_class()


## How a refusal names [param script]: its global name, or its file. A class declared inside another
## script has neither, measured on 4.7.2, so it is called an inner class and no more.
static func script_named(script: Script) -> String:
	if not script.get_global_name().is_empty():
		return str(script.get_global_name())
	if not script.resource_path.is_empty():
		return script.resource_path
	return "an inner class"


## A value from the wire fitted to the type a property or parameter declares.
func fitted(value: Variant, type: int) -> Variant:
	return _shared.fitted(value, type)


## An empty list or map typed the way argument [param index] of [param method] declares, or null
## when that argument is not a typed container. What [method typed_like] builds against.
func parameter_container(object: Object, method: String, index: int) -> Variant:
	for entry: Dictionary in methods_of(object):
		if entry.get("name", "") != method:
			continue
		var params: Array = entry.get("args", [])
		if index < 0 or index >= params.size():
			return null
		var parameter: Dictionary = params[index]
		var hint: int = GdhRead.as_int(parameter.get("hint", 0), 0)
		var named: String = str(parameter.get("hint_string", ""))
		if hint == PROPERTY_HINT_ARRAY_TYPE:
			var element: Dictionary = _element_type(named)
			if element.is_empty():
				return null
			var builtin: int = element["builtin"]
			var engine_class: StringName = element["class"]
			return Array([], builtin, engine_class, element["script"])
		if hint == PROPERTY_HINT_DICTIONARY_TYPE and named.contains(";"):
			var key: Dictionary = _element_type(named.get_slice(";", 0))
			var entry_type: Dictionary = _element_type(named.get_slice(";", 1))
			if key.is_empty() or entry_type.is_empty():
				return null
			var key_builtin: int = key["builtin"]
			var key_class: StringName = key["class"]
			var value_builtin: int = entry_type["builtin"]
			var value_class: StringName = entry_type["class"]
			return Dictionary(
				{}, key_builtin, key_class, key["script"], value_builtin, value_class, entry_type["script"]
			)
		return null
	return null


## The type a container hint names, as `{"builtin", "class", "script"}`, or {} for a name this
## cannot resolve. A built-in type by its name, an engine class, or a script class by its global
## name, which a typed container holds as the class it extends and the script itself.
static func _element_type(named: String) -> Dictionary:
	for type: int in TYPE_MAX:
		if type != TYPE_OBJECT and type_string(type) == named:
			return {"builtin": type, "class": &"", "script": null}
	if ClassDB.class_exists(named):
		return {"builtin": TYPE_OBJECT, "class": StringName(named), "script": null}
	for global: Dictionary in ProjectSettings.get_global_class_list():
		if str(global.get("class", "")) == named:
			var script: Script = load(str(global.get("path", "")))
			if script == null:
				return {}
			return {"builtin": TYPE_OBJECT, "class": script.get_instance_base_type(), "script": script}
	return {}


## [param given] rebuilt as the typed list or map [param like] is, as `{"value": ...}`, or
## `{"message": ...}` naming the element that cannot become what the container holds.
##
## A typed container refuses a plain one, and the engine says nothing about it: an Array[int]
## property written with the list JSON carries kept what it held, and the answer showed the write
## as done. Each element is fitted the way a single value is, and an object element is named by
## its path through [param resolve], which is called with the path, the class declared and the
## script declared, and answers the way an object argument does. Anything that is not a typed
## container comes back as it was given.
##
## The container built is counted against what went into it. The engine drops an element it will
## not take and says so only in the game's output, so a list that came out shorter is refused here
## rather than written, which would empty the game's own.
func typed_like(given: Variant, like: Variant, resolve: Callable) -> Dictionary:
	if like is Array and given is Array:
		var template: Array = like
		if not template.is_typed():
			return {"value": given}
		var items: Array = given
		var built: Array = []
		for index: int in items.size():
			var element: Dictionary = _element(
				items[index],
				template.get_typed_builtin(),
				_typed_class(template.get_typed_script(), template.get_typed_class_name()),
				_script_or_null(template.get_typed_script()),
				resolve
			)
			if element.has("message"):
				return {"message": "element %d %s" % [index, element["message"]]}
			built.append(element["value"])
		var typed: Array = Array(
			built, template.get_typed_builtin(), template.get_typed_class_name(), template.get_typed_script()
		)
		if typed.size() != built.size():
			return {"message": "the engine would not take its elements as what the list holds."}
		return {"value": typed}
	if like is Dictionary and given is Dictionary:
		var map_like: Dictionary = like
		if not map_like.is_typed():
			return {"value": given}
		var entries: Dictionary = given
		var rebuilt: Dictionary = {}
		for key: Variant in entries:
			var key_fitted: Dictionary = _element(
				key,
				map_like.get_typed_key_builtin(),
				_typed_class(map_like.get_typed_key_script(), map_like.get_typed_key_class_name()),
				_script_or_null(map_like.get_typed_key_script()),
				resolve
			)
			if key_fitted.has("message"):
				return {"message": "key %s %s" % [str(key), key_fitted["message"]]}
			var value_fitted: Dictionary = _element(
				entries[key],
				map_like.get_typed_value_builtin(),
				_typed_class(map_like.get_typed_value_script(), map_like.get_typed_value_class_name()),
				_script_or_null(map_like.get_typed_value_script()),
				resolve
			)
			if value_fitted.has("message"):
				return {"message": "the value under %s %s" % [str(key), value_fitted["message"]]}
			rebuilt[key_fitted["value"]] = value_fitted["value"]
		var typed_map: Dictionary = Dictionary(
			rebuilt,
			map_like.get_typed_key_builtin(),
			map_like.get_typed_key_class_name(),
			map_like.get_typed_key_script(),
			map_like.get_typed_value_builtin(),
			map_like.get_typed_value_class_name(),
			map_like.get_typed_value_script()
		)
		if typed_map.size() != rebuilt.size():
			return {"message": "the engine would not take its entries as what the map holds."}
		return {"value": typed_map}
	return {"value": given}


## One element fitted to a container's element type, as `{"value"}` or `{"message"}` saying what it
## was and what goes there. The message is the part after "element N", whole sentences, since it
## can end with how a value of that type is sent.
##
## An object element given as a record goes to [param resolve] as a path would, which says how an
## object is named, rather than being refused as a map that cannot become the class.
func _element(item: Variant, builtin: int, declared: String, script: Script, resolve: Callable) -> Dictionary:
	if builtin == TYPE_NIL:
		return {"value": item}
	if builtin == TYPE_OBJECT and (item is String or item is Dictionary):
		var named: Dictionary = resolve.call(item, declared, script)
		if named.has("message"):
			return {"message": str(named["message"]) + "."}
		return {"value": named["object"]}
	# Fitted alone, 4.5 into an Array[int] went in as 4, as a single value is refused for.
	if cuts(item, builtin):
		return {
			"message":
			(
				"is %s, which %s cannot hold without changing it."
				% [JSON.stringify(serialize(item), "", false), cut_by(builtin)]
			)
		}
	var rounded: String = inexact(item, builtin)
	if not rounded.is_empty():
		return {"message": "is too large to be sure of: %s." % rounded}
	var fitted_item: Variant = fitted(item, builtin)
	if not acceptable(fitted_item, builtin):
		# The value as it was sent rather than its engine type: JSON numbers arrive as floats, so a 7
		# the caller wrote was named "float".
		var wanted: String = type_string(builtin)
		if builtin == TYPE_OBJECT:
			wanted = declared if script == null else script_named(script)
		var sent: String = JSON.stringify(serialize(item), "", false)
		return {"message": "is %s, which cannot become %s.%s" % [sent, wanted, remedy(item, builtin)]}
	return {"value": fitted_item}
