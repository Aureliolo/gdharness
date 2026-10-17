@tool
extends RefCounted

## What a write made by a headless engine has to put back so the file holds what an editor would have
## written.
##
## The editor runs only tool scripts and gives every other script a placeholder that holds values and
## runs nothing. A headless engine runs them all, so loading a file runs each script's
## [code]_init[/code] and every setter of a stored property, and a tool setting one runs its setter.
## Whatever those change is saved with the write unless it is put back. Godot's own setters run in
## both, so a property a built-in setter derives (a Control's offsets from its size) is left alone
## unless a script that is not a tool is involved.

const PropertyValues = preload("property_values.gd")
const Read = preload("reading.gd")

const REMEDY: String = (
	"Open the project's editor (editor_launch with hidden: true) and ask again: the write then goes "
	+ "through it, and the editor runs no script that is not a tool."
)


## Every stored property of [param object] with its value, copied so a later change to an array or
## dictionary held there does not reach this record.
static func stored(object: Object) -> Dictionary:
	var values: Dictionary = {}
	for declared: Dictionary in object.get_property_list():
		if not (Read.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
			continue
		var name: String = str(declared.get("name", ""))
		if name.is_empty():
			continue
		var value: Variant = object.get(name)
		if value is Array:
			var items: Array = value
			value = items.duplicate(true)
		elif value is Dictionary:
			var entries_held: Dictionary = value
			value = entries_held.duplicate(true)
		values[name] = value
	return values


## Whether [param script] is a script an editor would not run.
static func untooled(script: Variant) -> bool:
	if not script is Script:
		return false
	var held: Script = script
	return not held.is_tool()


## Whether setting [param names] on [param object] can run a script an editor would not: one that is
## not a tool, declaring one of the names, taking every set through [code]_set[/code], or being the
## script set.
static func through_script(object: Object, names: Dictionary) -> bool:
	var script: Script = object.get_script()
	if script == null or script.is_tool():
		return false
	if names.has("script"):
		return true
	for method: Dictionary in script.get_script_method_list():
		if str(method.get("name", "")) == "_set":
			return true
	for declared: Dictionary in script.get_script_property_list():
		if names.has(str(declared.get("name", ""))):
			return true
	return false


## The stored properties of [param object] that are not in [param names] and no longer hold what
## [param before] recorded. One the object did not have before, which a script set on it declares,
## counts once it holds anything but its default; one it no longer has went with the old script.
static func differing(object: Object, before: Dictionary, names: Dictionary) -> Array[String]:
	var changed: Array[String] = []
	var now: Dictionary = stored(object)
	for key: Variant in now:
		var name: String = str(key)
		if names.has(name):
			continue
		var was: Variant = before[name] if before.has(name) else default_of(object, name)
		if not PropertyValues.same(now[name], was):
			changed.append(name)
	return changed


## The value [param object] holds for [param name] when nothing sets it: its script's default for a
## property the script declares, its class's otherwise.
static func default_of(object: Object, name: String) -> Variant:
	var script: Script = object.get_script()
	if script != null:
		for declared: Dictionary in script.get_script_property_list():
			if str(declared.get("name", "")) == name:
				var given: Variant = script.get_property_default_value(name)
				if given != null:
					return given
				return _initialised(script, name, Read.as_int(declared.get("type", TYPE_NIL)))
	return ClassDB.class_get_property_default_value(object.get_class(), name)


## What the declaration of [param name] in [param script] or a script it extends initialises it to,
## when that is a value written out, such as [code]PackedStringArray()[/code], or null. The engine
## reports a default only for an initializer it folded into a constant, and it folds no constructor
## call, so it gives none for such a property; the saver then writes it whatever it holds, and the
## line read as a change some script had made.
static func _initialised(script: Script, name: String, type: int) -> Variant:
	var declaration: RegEx = RegEx.create_from_string(
		"(?m)^[ \\t]*(?:@[^\\n]*?\\s)?var\\s+" + name + "\\b[^=\\n]*?=\\s*(.+?)\\s*:?[ \\t]*$"
	)
	var holder: Script = script
	while holder != null:
		var found: RegExMatch = declaration.search(holder.source_code)
		if found != null:
			var value: Variant = str_to_var(found.get_string(1))
			if value == null or type == TYPE_NIL or typeof(value) == type:
				return value
			return type_convert(value, type)
		holder = holder.get_base_script()
	return null


## Whether [param object] holds its default for [param name], so a file that newly writes it says
## nothing a script did: the saver writes a property whose default the engine cannot report whatever
## it holds, the editor's save as well.
static func at_default(object: Object, name: String) -> bool:
	return PropertyValues.same(object.get(name), default_of(object, name))


## The ids, in the file, of the embedded resources [param property] reaches into on [param object],
## such as the material of [code]material:albedo_color[/code], as a set.
static func reached(object: Object, property: String) -> Dictionary:
	var ids: Dictionary = {}
	var parts: PackedStringArray = property.split(":")
	var current: Variant = object
	for index: int in parts.size() - 1:
		if not current is Object:
			break
		var holder: Object = current
		current = holder.get(parts[index])
		if current is Resource:
			var resource: Resource = current
			var id: String = resource.get_scene_unique_id()
			if not id.is_empty():
				ids[id] = true
	return ids


## Whether [param object] holds, at any depth, an embedded resource with a script that is not a tool.
static func holds_scripted_embedded(object: Object, seen: Dictionary) -> bool:
	for value: Variant in stored(object).values():
		var items: Array = value if value is Array else [value]
		for item: Variant in items:
			if not item is Resource or seen.has(item):
				continue
			var resource: Resource = item
			if not resource.is_built_in():
				continue
			seen[resource] = true
			var script: Script = resource.get_script()
			if script != null and not script.is_tool():
				return true
			if holds_scripted_embedded(resource, seen):
				return true
	return false


## Puts the file at [param file_path] back as [param previous], or removes it when there was none,
## answering "" or a sentence saying that failed too.
static func put_back(file_path: String, previous: Variant) -> String:
	if previous is PackedByteArray:
		var bytes: PackedByteArray = previous
		var file: FileAccess = FileAccess.open(file_path, FileAccess.WRITE)
		if file == null or not file.store_buffer(bytes):
			return " Putting the file back as it was failed too."
		file.close()
		if ResourceLoader.has_cached(file_path):
			var _replaced: Resource = ResourceLoader.load(file_path, "", ResourceLoader.CACHE_MODE_REPLACE)
	elif DirAccess.remove_absolute(ProjectSettings.globalize_path(file_path)) != OK:
		return " Removing the file it wrote failed too."
	return ""


## Each section of a text scene or resource, by "resource" for the main one and "sub:<id>" for an
## embedded one, as {"head": its first line, "lines": the rest}.
static func sections(text: String) -> Dictionary:
	var found: Dictionary = {}
	var lines: PackedStringArray = []
	var key: String = ""
	var head: String = ""
	for line: String in text.split("\n"):
		if line.begins_with("["):
			if not key.is_empty():
				found[key] = {"head": head, "lines": lines}
			lines = []
			head = line
			key = _section_key(line)
			continue
		var _kept: bool = lines.append(line)
	if not key.is_empty():
		found[key] = {"head": head, "lines": lines}
	return found


static func _section_key(head: String) -> String:
	if head.begins_with("[resource]"):
		return "resource"
	if head.begins_with("[sub_resource"):
		var id: RegExMatch = RegEx.create_from_string('\\bid="([^"]+)"').search(head)
		return "sub:" + (id.get_string(1) if id != null else head)
	if head.begins_with("[ext_resource"):
		return "ext:" + head
	return ""


## Each property a section sets, by name, to the text of its value. A value running over several lines
## is kept whole.
static func entries_of(section: Dictionary) -> Dictionary:
	var lines: PackedStringArray = section.get("lines", PackedStringArray())
	return entries(lines)


static func entries(lines: PackedStringArray) -> Dictionary:
	var found: Dictionary = {}
	var key: String = ""
	var at_start: RegEx = RegEx.create_from_string("^([^\\s=][^=]*?) = (.*)$")
	for line: String in lines:
		var started: RegExMatch = at_start.search(line)
		if started != null:
			key = started.get_string(1)
			found[key] = started.get_string(2)
		elif not key.is_empty() and not line.is_empty():
			found[key] = str(found[key]) + "\n" + line
	return found


## Each property the main resource of [param after] sets differently from [param before], leaving
## out [param asked], as [name, whether before sets it, the text before gives it].
static func main_changes(before: String, after: String, asked: Dictionary) -> Array[Array]:
	var was: Dictionary = _main_entries(before)
	var now: Dictionary = _main_entries(after)
	var all: Dictionary = was.duplicate()
	all.merge(now)
	var changed: Array[Array] = []
	for key: Variant in all:
		var name: String = str(key)
		if asked.has(name) or was.get(name) == now.get(name):
			continue
		changed.append([name, was.has(name), str(was.get(name, ""))])
	return changed


static func _main_entries(text: String) -> Dictionary:
	var main: Dictionary = sections(text).get("resource", {})
	return entries_of(main)


## The ids of the embedded resources in [param text] that carry a script that is not a tool, as a set.
static func scripted_sections(text: String) -> Dictionary:
	var all: Dictionary = sections(text)
	var scripts: Dictionary = {}
	var ext: RegEx = RegEx.create_from_string('path="([^"]+)"[^\\]]*\\bid="([^"]+)"')
	for key: Variant in all:
		var name: String = str(key)
		if not name.begins_with("ext:") or not 'type="Script"' in name:
			continue
		var found: RegExMatch = ext.search(name)
		if found != null:
			scripts[found.get_string(2)] = found.get_string(1)
	var scripted: Dictionary = {}
	var uses: RegEx = RegEx.create_from_string('^ExtResource\\("([^"]+)"\\)$')
	for key: Variant in all:
		var name: String = str(key)
		var held: Dictionary = all[key]
		var set_there: Dictionary = entries_of(held)
		if not set_there.has("script"):
			continue
		var used: RegExMatch = uses.search(str(set_there["script"]))
		if used == null or not scripts.has(used.get_string(1)):
			continue
		var script: Script = ResourceLoader.load(str(scripts[used.get_string(1)])) as Script
		if script != null and not script.is_tool():
			scripted[name] = true
	return scripted


## Each property an embedded resource of [param after] sets differently from [param before], as
## [its id, name, whether before sets it, the text before gives it]. Only those with a script that
## is not a tool are compared, since only a script runs differently here, and those in
## [param reached_ids], which the tool changed, are left out.
static func embedded_changes(before: String, after: String, reached_ids: Dictionary) -> Array[Array]:
	var changed: Array[Array] = []
	if before.is_empty():
		return changed
	var old: Dictionary = sections(before)
	var new: Dictionary = sections(after)
	for key: Variant in scripted_sections(before):
		var section: String = str(key)
		var id: String = section.trim_prefix("sub:")
		if not section.begins_with("sub:") or reached_ids.has(id) or not new.has(section):
			continue
		var was_section: Dictionary = old[section]
		var now_section: Dictionary = new[section]
		var was: Dictionary = entries_of(was_section)
		var now: Dictionary = entries_of(now_section)
		var all: Dictionary = was.duplicate()
		all.merge(now)
		for entry: Variant in all:
			var name: String = str(entry)
			if was.get(name) != now.get(name):
				changed.append([id, name, was.has(name), str(was.get(name, ""))])
	return changed


## Compares the file just saved at [param path] with [param before], what it held, and puts back
## what a script that is not a tool changed in it: in its embedded resources, which [param values]
## reach, and in [param main], its main resource, unless that is null. [param asked] and
## [param reached_ids] are what the call changed. Saved again through [param resave], which answers
## an Error, and answers "" or why the file still does not hold what it should.
static func settle_saved(
	path: String,
	before: String,
	values: Array,
	main: Object,
	asked: Dictionary,
	reached_ids: Dictionary,
	resave: Callable
) -> String:
	for attempt: int in 2:
		var after: String = FileAccess.get_file_as_string(path)
		var by_id: Dictionary = embedded_in(values, {})
		var embedded: Array[Array] = []
		for found: Array in embedded_changes(before, after, reached_ids):
			var holder: Resource = by_id.get(found[0])
			if found[2] or holder == null or not at_default(holder, str(found[1])):
				embedded.append(found)
		var top: Array[Array] = []
		if main != null:
			for found: Array in main_changes(before, after, asked):
				if found[1] or not at_default(main, str(found[0])):
					top.append(found)
		if embedded.is_empty() and top.is_empty():
			return ""
		if attempt == 1:
			if not embedded.is_empty():
				return unasked("The embedded resource " + str(embedded[0][0]), str(embedded[0][1]))
			return unasked(path, str(top[0][0]))
		for found: Array in embedded:
			var id: String = found[0]
			var name: String = found[1]
			var was_set: bool = found[2]
			var held: String = found[3]
			var resource: Resource = by_id.get(id)
			var refused: String = "it was not found to be put back."
			if resource != null:
				refused = put_back_value(resource, name, was_set, held)
			if not refused.is_empty():
				return unasked("The embedded resource " + id, name, refused)
		for found: Array in top:
			var name: String = found[0]
			var was_set: bool = found[1]
			var held: String = found[2]
			var refused: String = put_back_value(main, name, was_set, held)
			if not refused.is_empty():
				return unasked(path, name, refused)
		var saving: Error = resave.call()
		if saving != OK:
			return "Failed to save %s again: %s." % [path, error_string(saving)]
	return ""


## Every embedded resource [param values] reach, at any depth, by its id in the file.
static func embedded_in(values: Array, found: Dictionary) -> Dictionary:
	for value: Variant in values:
		var items: Array = value if value is Array else [value]
		for item: Variant in items:
			if not item is Resource:
				continue
			var resource: Resource = item
			var id: String = resource.get_scene_unique_id()
			if not resource.is_built_in() or id.is_empty() or found.has(id):
				continue
			found[id] = resource
			var _deeper: Dictionary = embedded_in(stored(resource).values(), found)
	return found


## Sets [param name] on [param object] back to [param held], the text a file gave it, or to its
## default when the file set nothing ([param was_set] false), answering "" or why it cannot be.
## A value naming another resource is not read back from text here.
static func put_back_value(object: Object, name: String, was_set: bool, held: String) -> String:
	if not was_set:
		object.set(name, default_of(object, name))
		return ""
	if "Resource(" in held:
		return "its value there names another resource, which cannot be restored from the text here."
	object.set(name, str_to_var(held))
	return ""


## Why [param name] on [param what] cannot be saved as the file held it.
static func unasked(what: String, name: String, why: String = "") -> String:
	return (
		(
			(
				"%s.%s would be saved differently from what the file holds, and the call did not ask for "
				+ "it: its script ran when a headless engine loaded or set it, as it does in the game and not "
				+ "in an editor%s. "
			)
			% [what, name, "" if why.is_empty() else "; " + why.trim_suffix(".")]
		)
		+ REMEDY
	)
