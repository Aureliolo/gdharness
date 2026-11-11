@tool
extends RefCounted
## What an unset takes a property back to, and whether the file holds a line for it to drop, as the
## inspector's revert arrow drops one.
##
## A write of the default leaves a line out only where the saver compares with a default. It has
## none for a shader parameter, so the material given whole wrote the shader's default back in as a
## stored value, and a later change to the shader no longer reached it.

const GdhDeclared = preload("declared_values.gd")
const GdhHeadlessCheck = preload("headless_check.gd")
const GdhPropertyPaths = preload("property_paths.gd")
const GdhPropertyValues = preload("property_values.gd")


## The paths [param args] gives under unset.
static func asked(args: Dictionary) -> Array[String]:
	var paths: Array[String] = []
	var given: Variant = args.get("unset")
	if given is Array:
		var listed: Array = given
		for path: Variant in listed:
			if not paths.has(str(path)):
				paths.append(str(path))
	return paths


## Where [param path] is held on [param target], as [holder, name], or [null, why it cannot be
## unset]. [param given] is what the same call sets.
static func place_of(target: Object, path: String, given: Dictionary) -> Array:
	if given.has(path):
		return [null, "%s is in both properties and unset." % path]
	if ":" in path:
		var whole: String = path.get_slice(":", 0)
		return [
			null,
			(
				"%s is a component of %s, which the file holds in one line, so it is unset whole: "
				+ "unset %s."
			)
			% [path, whole, whole],
		]
	var home: String = GdhPropertyPaths.home_of(target)
	var place: Array = GdhPropertyPaths.holder_of(target, path, home)
	var holder: Object = place[0]
	var name: String = place[1]
	if name.begins_with("metadata/"):
		return [null, 'A metadata entry is taken off with properties {"%s": null}.' % path]
	if not GdhPropertyPaths.declared_on(holder, name).is_empty():
		return [holder, name]
	var elsewhere: String = GdhPropertyPaths.held_elsewhere(holder, name, home)
	if not elsewhere.is_empty():
		return [null, elsewhere]
	if holder is ShaderMaterial and name.begins_with("shader_parameter/"):
		return [null, GdhDeclared.no_uniform(holder as ShaderMaterial, name)]
	return [null, GdhPropertyValues.no_property(holder, name)]


## What [param name] on [param resource] holds once no line sets it: its script's or class's
## default, or for a shader parameter nothing, which the material reads as the shader's default.
static func resource_default(resource: Object, name: String) -> Variant:
	if resource is ShaderMaterial and name.begins_with("shader_parameter/"):
		return null
	return GdhHeadlessCheck.default_of(resource, name)


## The lines [param text], a text scene or resource, holds for [param resource], by name.
## [param main] is the file's own resource, or null for a scene.
static func lines_for(text: String, resource: Resource, main: Resource) -> Dictionary:
	var key: String = "resource" if resource == main else "sub:" + resource.resource_scene_unique_id
	var section: Dictionary = GdhHeadlessCheck.sections(text).get(key, {})
	return GdhHeadlessCheck.entries_of(section)


## Whether [param name] has a line of its own in [param resource]'s part of the file at
## [param file_path]. A binary file is not read, and holds a line for every value away from its
## default.
static func resource_stores(
	file_path: String, resource: Resource, main: Resource, name: String
) -> bool:
	if not (file_path.ends_with(".tscn") or file_path.ends_with(".tres")):
		return not GdhHeadlessCheck.at_default(resource, name)
	var text: String = FileAccess.get_file_as_string(file_path)
	return lines_for(text, resource, main).has(name)


## The names [param resource] has a line for in the file at [param file_path], sorted.
static func resource_lines(file_path: String, resource: Resource, main: Resource) -> Array:
	if not (file_path.ends_with(".tscn") or file_path.ends_with(".tres")):
		return []
	var names: Array = lines_for(FileAccess.get_file_as_string(file_path), resource, main).keys()
	names.sort()
	return names


## The refusal for unsetting [param path], [param name] being its last step, which no line of the
## file sets, naming the lines it does hold beside it in [param stored].
static func not_stored(path: String, name: String, file_path: String, stored: Array) -> String:
	var said: String = "%s holds no line for %s, so there is nothing to unset." % [file_path, path]
	var prefix: String = path.left(path.length() - name.length())
	var kept: Array = stored.filter(func(held: Variant) -> bool: return str(held) != "script")
	if kept.is_empty():
		return said + " It sets nothing there."
	var named: Array = kept.map(func(held: Variant) -> String: return prefix + str(held))
	return said + " It sets %s." % ", ".join(named)
