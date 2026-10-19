@tool
extends RefCounted

## Where a property a tool writes lives: on the object given, on a resource built into it, or on an
## element of one of its lists that the write has to make first.

const GdhRead = preload("reading.gd")

const HEADINGS: int = PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP


## The entry [param target] declares for [param property], or {} when it declares none, headings
## left out.
static func declared_on(target: Object, property: String) -> Dictionary:
	for declared: Dictionary in target.get_property_list():
		if str(declared.get("name", "")) != property:
			continue
		if GdhRead.as_int(declared.get("usage", 0)) & HEADINGS:
			continue
		return declared
	return {}


## Where [param key] is written: as [holder, name, through], the object holding the property, its
## name there, and the resources passed on the way. A key that is none of [param target]'s own may
## start with the name of one holding a resource built into it, then a slash and a key of that
## resource: "sources/0/0:0/0/probability" is the probability of tile 0:0 in the atlas source a
## TileSet keeps as sources/0. A colon path cannot reach it, since the tile's own name holds colons.
## A resource kept in a file of its own is not reached, nor, given the file [param home] that
## [param target] is saved in, one built into another file, since writing it here would leave that
## file as it was.
static func holder_of(target: Object, key: String, home: String = "") -> Array:
	var through: Array[Resource] = []
	var holder: Object = target
	var name: String = key
	while declared_on(holder, name).is_empty():
		var reached: Resource = null
		var at: int = name.find("/")
		while at > 0:
			var held: Resource = built_in_at(holder, name.left(at), home)
			if held != null:
				reached = held
				break
			at = name.find("/", at + 1)
		if reached == null:
			break
		through.append(reached)
		holder = reached
		name = name.substr(at + 1)
	return [holder, name, through]


## The resource [param target] holds under [param property] when it is built into a file, or null;
## given [param home], only one built into that file or into none yet.
static func built_in_at(target: Object, property: String, home: String = "") -> Resource:
	var held: Resource = held_at(target, property)
	if held == null or not held.is_built_in():
		return null
	var file: String = held.resource_path.get_slice("::", 0)
	return held if home.is_empty() or file.is_empty() or file == home else null


## The file [param target] is saved in: its scene's for a node, as the nodes of an instance are
## saved in the scene holding it, and its own for a resource; "" when it has none yet.
static func home_of(target: Object) -> String:
	if target is Node:
		var top: Node = target
		while top.owner != null:
			top = top.owner
		return top.scene_file_path
	if target is Resource:
		var resource: Resource = target
		return resource.resource_path.get_slice("::", 0)
	return ""


## The resource [param target] holds under [param property], built in or kept in a file, or null.
static func held_at(target: Object, property: String) -> Resource:
	if declared_on(target, property).is_empty():
		return null
	var held: Variant = target.get(property)
	return held if held is Resource else null


## Makes the element of a list [param name] names on [param target] when it is the next one, as the
## inspector's Add Element does, and answers "" (also when [param name] is in no list), or why not,
## [param called] being what [param target] is called. The engine lists an element's properties
## only once the element exists, so a TileSet with no physics layer had no
## physics_layer_0/collision_layer to write. A list the engine declares as an array grows through
## the method named after its elements, add_physics_layer for physics_layer_, given the indices of
## the lists around it; a list counted by a property, as a tile's polygons are by polygons_count,
## grows by raising the count.
static func grow(target: Object, name: String, called: String) -> String:
	var steps: PackedStringArray = name.split("/")
	for depth: int in steps.size() - 1:
		var step: String = steps[depth]
		var cut: int = step.rfind("_")
		if cut < 1 or not step.substr(cut + 1).is_valid_int():
			continue
		var index: int = step.substr(cut + 1).to_int()
		var above: String = "/".join(steps.slice(0, depth))
		var under: String = above + "/" if not above.is_empty() else ""
		var prefix: String = under + step.left(cut + 1)
		var element: String = step.left(cut)
		var counted: String = under + element + "s_count"
		var count: int = -1
		var adding: Callable
		if not declared_on(target, counted).is_empty():
			count = GdhRead.as_int(target.get(counted))
			adding = func() -> void: target.set(counted, count + 1)
		elif _listed_array(target, prefix):
			count = _elements(target, prefix)
			var method: String = "add_" + element
			var outer: Array = []
			for enclosing: String in steps.slice(0, depth):
				var at: int = enclosing.rfind("_")
				if at > 0 and enclosing.substr(at + 1).is_valid_int():
					outer.append(enclosing.substr(at + 1).to_int())
			if target.has_method(method):
				adding = func() -> void: target.callv(method, outer)
		if count < 0 or index < count:
			continue
		var held: String = (
			"%s has %d %s%s"
			% [
				above if not above.is_empty() else called,
				count,
				element.replace("_", " "),
				"" if count == 1 else "s"
			]
		)
		if index > count:
			return (
				"%s, and a new one goes after the last, so %s%d cannot be written yet: write %s%d first."
				% [held, prefix, index, prefix, count]
			)
		if not adding.is_valid():
			return "%s, and nothing makes another, so %s cannot be written." % [held, name]
		adding.call()
		return ""
	return ""


## Whether [param target] declares a list whose elements' properties start with [param prefix],
## as TileSet declares physics_layers for physics_layer_0/collision_layer.
static func _listed_array(target: Object, prefix: String) -> bool:
	for declared: Dictionary in target.get_property_list():
		var usage: int = GdhRead.as_int(declared.get("usage", 0))
		if usage & PROPERTY_USAGE_ARRAY and str(declared.get("class_name", "")) == prefix:
			return true
	return false


## How many elements of the list whose properties start with [param prefix] [param target] holds.
static func _elements(target: Object, prefix: String) -> int:
	var count: int = 0
	for declared: Dictionary in target.get_property_list():
		var name: String = str(declared.get("name", ""))
		if not name.begins_with(prefix):
			continue
		var index: String = name.substr(prefix.length()).get_slice("/", 0)
		if index.is_valid_int():
			count = maxi(count, index.to_int() + 1)
	return count


## What [param target] is called in a refusal: the class_name its script declares, or else its
## engine class. A resource made as a project class is a Resource to the engine, and "Resource.kind"
## named a property no Resource has.
static func class_called(target: Object) -> String:
	var attached: Variant = target.get_script()
	if attached is Script:
		var script: Script = attached
		if not str(script.get_global_name()).is_empty():
			return str(script.get_global_name())
	return target.get_class()


## The refusal for [param name], which [param target] does not declare, when it runs through a
## resource saved in a file other than [param home], the one [param target] is saved in; or "". The
## write belongs in that file, since this one would be saved and that one left as it was: through a
## TileMapLayer's tile_set kept in a file of its own, or through the mesh of an instance's editable
## child, which is built into the scene the instance comes from.
static func held_elsewhere(target: Object, name: String, home: String) -> String:
	var at: int = name.find("/")
	while at > 0:
		var head: String = name.left(at)
		var rest: String = name.substr(at + 1)
		var held: Resource = held_at(target, head)
		var file: String = "" if held == null else held.resource_path.get_slice("::", 0)
		if held != null and not held.is_built_in():
			return (
				"%s.%s is %s, a file of its own, so %s is written there, with resource_edit modify on %s."
				% [class_called(target), head, file, rest, file]
			)
		if held != null and not file.is_empty() and not home.is_empty() and file != home:
			return _built_in_elsewhere(target, head, rest, held, file)
		at = name.find("/", at + 1)
	return ""


## The refusal for writing [param rest] into [param held], which [param target] holds under
## [param head] and which is built into [param file], the scene an instance in this one comes from.
static func _built_in_elsewhere(
	target: Object, head: String, rest: String, held: Resource, file: String
) -> String:
	var node: String = ""
	if target is Node:
		var placed: Node = target
		var from: Node = placed
		while from != null and from.scene_file_path != file:
			from = from.owner
		if from != null:
			node = " on %s" % from.get_path_to(placed)
	var text: String = (
		(
			"%s.%s is built into %s, so %s is written there, with scene_node set%s in %s, which changes "
			+ "it wherever that scene is used. To change it here alone, give %s a %s of its own: a "
			+ 'value with "_type" set to its class and its properties beside it.'
		)
		% [class_called(target), head, file, rest, node, file, head, held.get_class()]
	)
	if target is GeometryInstance3D and (held is Material or rest.contains("material")):
		text += " A material for this instance alone goes in material_override."
	return text
