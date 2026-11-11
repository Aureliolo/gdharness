extends RefCounted

const GdhDeclared = preload("declared_values.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhGdscriptAuthoring = preload("gdscript_authoring.gd")
const GdhRead = preload("reading.gd")
const GdhLog = preload("logger.gd")
const GdhProjectFile = preload("project_file.gd")
const GdhSerialisation = preload("serialisation.gd")
const GdhSettingReads = preload("setting_reads.gd")
const GdhShapes = preload("value_shapes.gd")
## The words GDScript reserves, which no script could reach an autoload by.
## The settings beside the autoloads whose file the engine loads at boot.
const BOOT_LOADED: Array[String] = [
	"internationalization/locale/translations",
	"application/boot_splash/image",
	"gui/theme/custom",
	"gui/theme/custom_font",
	"display/mouse_cursor/custom_image",
]
const GDSCRIPT_KEYWORDS: Array[String] = [
	"and",
	"as",
	"assert",
	"await",
	"break",
	"breakpoint",
	"class",
	"class_name",
	"const",
	"continue",
	"elif",
	"else",
	"enum",
	"extends",
	"false",
	"for",
	"func",
	"if",
	"in",
	"INF",
	"is",
	"match",
	"NAN",
	"namespace",
	"not",
	"null",
	"or",
	"pass",
	"PI",
	"preload",
	"return",
	"self",
	"signal",
	"static",
	"super",
	"TAU",
	"trait",
	"true",
	"var",
	"void",
	"when",
	"while",
	"yield",
]

var _log: GdhLog
var _values: GdhSerialisation = GdhSerialisation.new()


func _init(p_log: GdhLog) -> void:
	_log = p_log


# Get a project setting value, or every setting under a prefix.
func get_project_setting(params: Dictionary) -> Dictionary:
	var prefix: String = str(params.get("prefix", ""))
	if not prefix.is_empty():
		_log.info("Listing project settings under: " + prefix)
		return GdhSettingReads.under(prefix, _values)

	var setting_path: String = str(params.get("setting", ""))
	if setting_path.is_empty():
		return _log.failure("setting is required, or prefix to read every setting under one")

	_log.info("Getting project setting: " + setting_path)

	return GdhSettingReads.one(setting_path, _values)


# Set a project setting value
func set_project_setting(params: Dictionary) -> Dictionary:
	var setting_path: String = str(params.get("setting", ""))
	if setting_path.is_empty():
		return _log.failure("setting is required")
	var value: Variant = params.get("value")

	_log.info("Setting project setting: " + setting_path)

	var old_value: Variant = null
	var had_value: bool = ProjectSettings.has_setting(setting_path)
	var laid: Dictionary = GdhSettingReads.laid_over(
		setting_path, GdhSettingReads.override_files()
	)
	if had_value:
		old_value = (
			ProjectSettings.get_setting(setting_path) if laid.is_empty() else laid["project"]
		)
	# A setting the engine registers is there with its default whether or not project.godot sets it,
	# so has_setting alone called the description of a project that had never set one an old value.
	# Whether it is new is the file's to say: one at its default has a line only where the project
	# wrote it out on purpose.
	var default_value: Variant = ProjectSettings.property_get_revert(setting_path)
	var was_default: bool = had_value and default_value != null and old_value == default_value
	var in_file: bool = GdhProjectFile.sets(setting_path)

	var wanted: int = _wanted_type(setting_path, old_value if had_value else null)
	var fitted: Array = _fitted_value(setting_path, value, wanted)
	if fitted[0] and not had_value and wanted == TYPE_NIL:
		fitted[1] = _whole_if_whole(fitted[1])
	# A typed list or map is written back with its type, since a script reading the setting into a
	# typed variable fails on an untyped one: gdUnit4's session hooks failed every test run.
	if fitted[0] and had_value:
		fitted = _typed_like(old_value, fitted[1], setting_path)
	if not fitted[0]:
		return _log.failure(str(fitted[1]))
	var final_value: Variant = fitted[1]

	var answer: Dictionary = {
		"setting_path": setting_path,
		"old_value": _values.serialize_value(old_value) if had_value else null,
		"new_value": _values.serialize_value(final_value),
		"was_new": not in_file,
		"was_default": was_default,
		"saved": true,
	}
	if not laid.is_empty():
		_note_laid_over(answer, laid)
	# The same value in the same type is no change, and the file is left alone: a save rewrites it
	# whole. The type is compared as well, so an int setting the file holds as 50.0 is still put
	# right.
	if had_value and typeof(old_value) == typeof(final_value) and old_value == final_value:
		answer["saved"] = false
		answer["unchanged"] = true
		if was_default and not in_file:
			answer["note"] = (
				(
					"%s is already this setting's default, which project.godot holds no line for:"
					+ " the engine reads it wherever %s is asked for, so nothing was written."
				)
				% [JSON.stringify(_values.serialize_value(final_value)), setting_path]
			)
		return answer

	if not had_value:
		_note_near(answer, setting_path)
	_note_missing(answer, setting_path, final_value)
	ProjectSettings.set_setting(setting_path, final_value)
	var err: Error = GdhProjectFile.save([setting_path])
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))
	_note_overrides(answer, setting_path)
	return answer


## [code][true, value][/code] with [param value] fitted to the type [param wanted], or
## [code][false, refusal][/code] for a value the setting cannot hold as given.
func _fitted_value(setting_path: String, value: Variant, wanted: int) -> Array:
	# A value of fields or a colour's html code is fitted as a property write fits it, so a value
	# one of them takes the other takes too. A number is left to the check below, which refuses one
	# the setting would cut where fitting it would cut it.
	var final_value: Variant = _values.deserialize_value(value)
	if final_value is Dictionary or (wanted == TYPE_COLOR and final_value is String):
		final_value = _values.fitted(value, wanted)
	# An enum setting takes the name the editor's menu shows, as a property write does.
	if wanted == TYPE_INT and final_value is String:
		var by_name: Array = _enum_named(setting_path, str(final_value))
		if by_name[0]:
			final_value = by_name[1]
		elif not str(by_name[1]).is_empty():
			return [false, by_name[1]]
	if wanted > TYPE_NIL and final_value != null and typeof(final_value) != wanted:
		if not _converts_faithfully(final_value, wanted):
			return [false, _cannot_hold(setting_path, wanted, final_value)]
		final_value = type_convert(final_value, wanted)
	# A tag that could not be built is still the dictionary it arrived as, and a setting nothing
	# declares took it as one: the file was given the tag key by key, beside an answer of success.
	if final_value is Dictionary:
		var held: Dictionary = final_value
		if held.has("_type"):
			return [false, _unbuilt(setting_path, held)]
	return [true, final_value]


## The enum value [param named] stands for in the setting's menu, as
## [method GdhDeclared.enum_by_name] answers it. [code][false, ""][/code] for a setting that is no
## enum.
func _enum_named(setting_path: String, named: String) -> Array:
	var declared: Dictionary = _declared(setting_path)
	if GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE)) != PROPERTY_HINT_ENUM:
		return [false, ""]
	return GdhDeclared.enum_by_name(ProjectSettings, declared, named, "ProjectSettings")


## [param value] as an int when it is a whole float. JSON carries every number as a float and a
## new setting has no declared type to fit one to, so a whole number was saved as 800.0 beside an
## answer saying 800.
static func _whole_if_whole(value: Variant) -> Variant:
	if not value is float:
		return value
	var number: float = value
	if number == floorf(number) and absf(number) < 9.0e15:
		return int(number)
	return value


## Notes in [param answer] the value a run reads from the override file [param laid] names.
func _note_laid_over(answer: Dictionary, laid: Dictionary) -> void:
	var read: Variant = _values.serialize_value(laid["value"])
	answer["overridden_in"] = { "file": laid["file"], "value": read }
	answer["overriddenNote"] = (
		(
			"A run on this machine still reads %s for it from %s, which a run lays over "
			+ "project.godot and the editor does not."
		)
		% [JSON.stringify(read), laid["file"]]
	)


## Notes in [param answer] the settings named nearest a new one, which may be the one meant.
func _note_near(answer: Dictionary, setting_path: String) -> void:
	var near: PackedStringArray = _settings_near(setting_path)
	if near.is_empty():
		return
	answer["note"] = (
		(
			"No setting %s existed, so this wrote a new one, which the engine reads only where"
			+ " something asks for it by that name. The nearest %s %s."
		)
		% [setting_path, "setting is" if near.size() == 1 else "settings are", ", ".join(near)]
	)


## Adds [param said] to the note in [param answer], after any note already there.
static func _add_note(answer: Dictionary, said: String) -> void:
	answer["note"] = (str(answer["note"]) + " " if answer.has("note") else "") + said


## Notes in [param answer] the files [param final_value] names that are not there, and what makes
## each. The value is written as given, since a file can be made after the setting names it, as an
## import makes a translation.
func _note_missing(answer: Dictionary, setting_path: String, final_value: Variant) -> void:
	var translating: bool = setting_path == "internationalization/locale/translations"
	var missing: Array[String] = _missing_files(final_value)
	if not missing.is_empty():
		answer["missing_files"] = missing
		var one: bool = missing.size() == 1
		var said: String = "%s %s not exist" % [", ".join(missing), "does" if one else "do"]
		if _loaded_at_boot(setting_path):
			said += (
				", and the engine reports %s on every boot until %s"
				% ["it" if one else "them", "it does" if one else "they do"]
			)
		var made: Array[String] = _translations_made_by(missing)
		if not made.is_empty():
			said += (
				". project_import reimport makes the translation files from " + ", ".join(made)
			)
		var resources: Array[String] = []
		for path: String in missing:
			var kind: String = path.get_extension()
			if kind == "res" or (kind == "tres" and not translating):
				resources.append(path)
		if not resources.is_empty():
			said += ". resource_edit create makes " + ", ".join(resources)
		_add_note(answer, said + ".")
	if translating:
		var untranslated: String = text_translations_line(final_value)
		if not untranslated.is_empty():
			_add_note(
				answer,
				untranslated + ". resource_edit create writes a Translation to a .res path."
			)


## Notes in [param answer] the feature overrides of [param setting_path]. An override still
## replaces what was written wherever its feature is, and a write of the base value read as if it
## reached every build.
func _note_overrides(answer: Dictionary, setting_path: String) -> void:
	var overrides: Dictionary = GdhSettingReads.overrides_of(setting_path, _values)
	if overrides.is_empty():
		return
	answer["overrides"] = overrides
	var parts: Array[String] = []
	for feature: Variant in overrides:
		parts.append(
			(
				"one with the feature %s reads %s from %s.%s"
				% [feature, JSON.stringify(overrides[feature]), setting_path, feature]
			)
		)
	answer["overridesNote"] = (
		(
			"Not every build reads what was written: %s. Set or unset an override to change "
			+ "what its builds read."
		)
		% "; ".join(parts)
	)


## Whether the engine loads what [param setting_path] names as it boots, and so prints an error for
## a file that is not there. Measured on a headless boot: the icon, the bus layout and a setting
## only a tool reads print nothing.
static func _loaded_at_boot(setting_path: String) -> bool:
	return setting_path.begins_with("autoload/") or setting_path in BOOT_LOADED


## What the engine says of the .tres translations [param value] names, or "" for none. It loads
## the translations as the game starts, before it can read a text resource, so each .tres one is
## "No loader found" and the game runs untranslated, while the same translation as .res loads.
static func text_translations_line(value: Variant) -> String:
	var texts: Array[String] = []
	if value is PackedStringArray or value is Array:
		for item: Variant in value:
			if str(item).get_extension() == "tres":
				texts.append(str(item))
	if texts.is_empty():
		return ""
	return (
		(
			"The engine cannot load %s as the game starts: it reports \"No loader found\" for a"
			+ " .tres translation, and the game shows its keys. The same translation saved as"
			+ " .res loads, as does one imported from a .csv or .po"
		)
		% ", ".join(texts)
	)


## [method text_translations_line] for the project's own translations setting.
static func project_text_translations() -> String:
	return text_translations_line(
		ProjectSettings.get_setting("internationalization/locale/translations", [])
	)


## The res:// files [param value] names that are not on disk: a path, an autoload's starred path, or
## a list or dictionary of them.
static func _missing_files(value: Variant) -> Array[String]:
	var items: Array = []
	if value is String or value is StringName:
		items = [value]
	elif value is PackedStringArray:
		var strings: PackedStringArray = value
		items = Array(strings)
	elif value is Array:
		items = value
	elif value is Dictionary:
		var held: Dictionary = value
		items = held.values()
	var missing: Array[String] = []
	for item: Variant in items:
		if not (item is String or item is StringName):
			continue
		var path: String = str(item).trim_prefix("*")
		if not path.begins_with("res://"):
			continue
		if not FileAccess.file_exists(path) and not DirAccess.dir_exists_absolute(path):
			missing.append(path)
	return missing


## The CSV files an import makes the translations among [param missing] from: strings.en.translation
## from strings.csv beside it.
static func _translations_made_by(missing: Array[String]) -> Array[String]:
	var sources: Array[String] = []
	for path: String in missing:
		if path.get_extension() != "translation":
			continue
		var csv: String = path.get_basename().get_basename() + ".csv"
		if FileAccess.file_exists(csv) and not csv in sources:
			sources.append(csv)
	return sources


# Takes a setting's line out of project.godot, so the engine's default holds again, or nothing at
# all for one the engine does not declare: the way back from a set, which writes a misspelt name as
# given.
func unset_project_setting(params: Dictionary) -> Dictionary:
	var setting_path: String = str(params.get("setting", ""))
	if setting_path.is_empty():
		return _log.failure("setting is required")
	var default_value: Variant = ProjectSettings.property_get_revert(setting_path)
	var held: bool = ProjectSettings.has_setting(setting_path)
	var value: Variant = ProjectSettings.get_setting(setting_path) if held else null
	var laid: Dictionary = GdhSettingReads.laid_over(
		setting_path, GdhSettingReads.override_files()
	)
	if held and not laid.is_empty():
		value = laid["project"]
	var answer: Dictionary = {
		"setting_path": setting_path,
		"default_value": _values.serialize_value(default_value) if default_value != null else null,
	}
	# Read off the file rather than the value: a setting at its default usually has no line, as the
	# engine leaves it out, but a project can hold one written out on purpose.
	if not held or not GdhProjectFile.sets(setting_path):
		answer["removed"] = false
		answer["saved"] = false
		answer["note"] = (
			"project.godot does not set %s, so there was nothing to take out." % setting_path
		)
		var near: PackedStringArray = PackedStringArray() if held else _settings_near(setting_path)
		if not near.is_empty():
			answer["note"] += (
				" Nor does the engine declare it. The nearest %s %s."
				% ["setting is" if near.size() == 1 else "settings are", ", ".join(near)]
			)
		return _with_what_holds(answer, setting_path)
	answer["old_value"] = _values.serialize_value(value)
	# The default rather than null for a setting the engine declares: null takes the declaration
	# away as well, and a value at its default is left out of the file all the same.
	ProjectSettings.set_setting(setting_path, default_value)
	var err: Error = GdhProjectFile.save([setting_path])
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))
	answer["removed"] = true
	answer["saved"] = true
	return _with_what_holds(answer, setting_path)


# An override has no default of its own: with it gone, a build with its feature reads the base
# setting, and default_value, null, said nothing of that.
func _with_what_holds(answer: Dictionary, setting_path: String) -> Dictionary:
	var base: String = GdhSettingReads.override_base(setting_path)
	if base.is_empty() or not ProjectSettings.has_setting(base):
		return answer
	answer["override_of"] = base
	answer["holds"] = _values.serialize_value(ProjectSettings.get_setting(base))
	var said: String = GdhSettingReads.overridden_by_none(setting_path, _values)
	answer["note"] = said if not answer.has("note") else "%s %s" % [answer["note"], said]
	return answer


# The settings in the same section as [param setting_path] named nearest it, for a new one that is
# likely a misspelt one: a setting nothing declares is written all the same, and is never read. None
# for an override of a setting the engine has, which its feature's builds read in the base's place.
static func _settings_near(setting_path: String) -> PackedStringArray:
	var base: String = GdhSettingReads.override_base(setting_path)
	if not base.is_empty() and ProjectSettings.has_setting(base):
		return PackedStringArray()
	var section: String = setting_path.get_slice("/", 0) + "/"
	var names: PackedStringArray = []
	for info: Dictionary in ProjectSettings.get_property_list():
		var name: String = str(info.get("name", ""))
		if name.begins_with(section) and name != setting_path:
			var _added: bool = names.append(name)
	return GdhRead.nearest(setting_path, names)


# The type a setting wants, or TYPE_NIL where the engine names none and there is nothing to go on.
#
# JSON carries one number type, so every number arrives as a float and an int setting was written
# to project.godot as "50.0". Every reader casts it back, so the tool, the editor and the running
# game all answer 50 afterwards and only the committed file says otherwise, where it reads as
# something having gone wrong.
#
# The engine's own property list is what is asked, rather than the value that is there: a setting
# already written as "50.0" reads back as a float, so the value on hand agrees with the mistake and
# no project that has made it once could be set right again. The property list still says int.
# A setting the engine does not declare has only its current value to go on, and a new one has
# neither, which is the caller's type to choose.
func _wanted_type(setting_path: String, current: Variant) -> int:
	var info: Dictionary = _declared(setting_path)
	if info.is_empty():
		return typeof(current)
	return GdhRead.as_int(info.get("type", TYPE_NIL), TYPE_NIL)


## How the engine declares [param setting_path], as get_property_list gives it, or {} for a setting
## it does not declare.
static func _declared(setting_path: String) -> Dictionary:
	for info: Dictionary in ProjectSettings.get_property_list():
		if str(info.get("name", "")) == setting_path:
			return info
	return {}


# What separates a narrowing from a guess: 50.0 through int and out again is 50.0, so it was an int
# all along, while 50.5 comes back as 50.0 and "loud" comes back as "0". Those are a caller meaning
# something the setting cannot hold, and are refused rather than written as whatever the cast
# happened to produce.
func _converts_faithfully(value: Variant, to: int) -> bool:
	return type_convert(type_convert(value, to), typeof(value)) == value


## [param given] typed as [param current] is, when that is a typed Dictionary or Array, as
## [ok, value], or [false, why] naming the type when a member does not fit it.
func _typed_like(current: Variant, given: Variant, setting_path: String) -> Array:
	if current is Dictionary and given is Dictionary:
		var held: Dictionary = current
		if not held.is_typed():
			return [true, given]
		var entries: Dictionary = given
		var key_type: int = held.get_typed_key_builtin()
		var value_type: int = held.get_typed_value_builtin()
		var typed: Dictionary = Dictionary(
			{},
			key_type,
			held.get_typed_key_class_name(),
			held.get_typed_key_script(),
			value_type,
			held.get_typed_value_class_name(),
			held.get_typed_value_script()
		)
		var name: String = "Dictionary[%s, %s]" % [
			_element_name(key_type, held.get_typed_key_class_name()),
			_element_name(value_type, held.get_typed_value_class_name()),
		]
		for key: Variant in entries:
			var fitted_key: Array = _fit_member(key, key_type)
			var fitted_value: Array = _fit_member(entries[key], value_type)
			if not fitted_key[0] or not fitted_value[0]:
				var misfit: Variant = key if not fitted_key[0] else entries[key]
				return [false, _misfit(setting_path, name, misfit)]
			typed[fitted_key[1]] = fitted_value[1]
		return [true, typed]
	if current is Array and given is Array:
		var held_list: Array = current
		if not held_list.is_typed():
			return [true, given]
		var element: int = held_list.get_typed_builtin()
		var list_name: String = (
			"Array[%s]" % _element_name(element, held_list.get_typed_class_name())
		)
		var typed_list: Array = Array(
			[], element, held_list.get_typed_class_name(), held_list.get_typed_script()
		)
		for item: Variant in given:
			var fitted_item: Array = _fit_member(item, element)
			if not fitted_item[0]:
				return [false, _misfit(setting_path, list_name, item)]
			typed_list.append(fitted_item[1])
		return [true, typed_list]
	return [true, given]


## [param value] as a member of the built-in [param type], as [ok, value]. An object type takes no
## value from the wire, since nothing names which object.
func _fit_member(value: Variant, type: int) -> Array:
	if type == TYPE_NIL or typeof(value) == type:
		return [true, value]
	if type == TYPE_OBJECT or not GdhSerialisation.acceptable(value, type):
		return [false, null]
	if not _converts_faithfully(value, type):
		return [false, null]
	return [true, type_convert(value, type)]


static func _element_name(type: int, class_named: StringName) -> String:
	if not class_named.is_empty():
		return str(class_named)
	return "Variant" if type == TYPE_NIL else type_string(type)


static func _misfit(setting_path: String, typed_name: String, value: Variant) -> String:
	return (
		"%s holds a %s, and %s does not fit it, so nothing was written."
		% [setting_path, typed_name, JSON.stringify(_shown(value))]
	)


static func _shown(value: Variant) -> Variant:
	return str(value) if value is Object else value


# Why [param value] cannot be written to a setting declared as [param wanted], in the words the
# editor's property writes use for the same two cases. One sentence for both read "without losing
# something" about a word given for a number, where nothing would be lost: it cannot become one.
static func _cannot_hold(setting_path: String, wanted: int, value: Variant) -> String:
	var numbers: Array[int] = [TYPE_INT, TYPE_FLOAT]
	var declared: String = "%s is declared as %s" % [setting_path, type_string(wanted)]
	var cost: String = " Setting it would save a different value than the one asked for."
	if wanted == TYPE_INT and typeof(value) == TYPE_FLOAT:
		return (
			"%s, which holds whole numbers, and %s would be cut to fit.%s"
			% [declared, str(value), cost]
		)
	if wanted in numbers and typeof(value) in numbers:
		return "%s, and %s is not the same number as one.%s" % [declared, str(value), cost]
	var given: String = type_string(typeof(value))
	var remedy: String = GdhShapes.remedy(value, wanted)
	return "%s, and %s (%s) cannot become one.%s" % [declared, JSON.stringify(value), given, remedy]


## Why [param tagged], a value whose tag could not be built, was not written to
## [param setting_path], and how a value of that tag is written.
static func _unbuilt(setting_path: String, tagged: Dictionary) -> String:
	var tag: String = str(tagged["_type"])
	var refused: String = (
		"The value for %s is tagged %s and could not be read as one, so nothing was written."
		% [setting_path, JSON.stringify(tag)]
	)
	var shapes: Array = GdhShapes.REQUIRED.get(tag, [])
	if shapes.is_empty():
		return refused + " A setting cannot hold a %s written as a tag." % tag
	var keys: Array = shapes[0]
	var parts: Array[String] = ['"_type": "%s"' % tag]
	for key: Variant in keys:
		parts.append(
			'"%s": %s' % [key, "[...]" if tag.begins_with("Packed") and key == "value" else "..."]
		)
	return refused + " One is written as {%s}." % ", ".join(parts)


# Add an autoload singleton
func add_autoload(params: Dictionary) -> Dictionary:
	var name: String = str(params.get("name", ""))
	var path: String = str(params.get("path", ""))
	var global: bool = GdhRead.as_bool(params.get("global", true), true)

	# There is no disabled autoload in Godot 4: every entry in the list is loaded under the root at
	# every start. An entry without its asterisk is one whose name is not global, and it still runs.
	if not GdhRead.as_bool(params.get("enabled", true), true):
		return (
			_log
			. failure(
				(
					"An autoload cannot be added disabled: Godot loads every autoload in the list "
					+ "at every start. global: false keeps its name out of the global scope and "
					+ "still loads it. remove_autoload is what stops it loading"
				)
			)
		)

	var clash: String = _autoload_name_refusal(name)
	if not clash.is_empty():
		return _log.failure(clash)

	if not path.begins_with("res://"):
		path = "res://" + path

	_log.info("Adding autoload: " + name + " -> " + path)

	if not FileAccess.file_exists(path):
		return _log.failure(
			GdhFileWalk.new().with_nearest_files("Autoload file does not exist: " + path, path)
		)
	var unloadable: String = _not_an_autoload(path)
	if not unloadable.is_empty():
		return _log.failure(unloadable)

	# Through ProjectSettings so the file is saved the way the editor saves it, which includes
	# putting Godot's header back and dropping any comment somebody wrote into the file by hand.
	var setting: String = "autoload/" + name
	var was_updated: bool = ProjectSettings.has_setting(setting)

	# An asterisk in front of the path makes the autoload's name a global variable, the editor's
	# "Global Variable" column. Without it the node still comes up under the root. Only the name
	# stops resolving.
	var entry: String = ("*" if global else "") + path
	if was_updated and str(ProjectSettings.get_setting(setting)) == entry:
		return {
			"name": name,
			"path": path,
			"enabled": true,
			"global": global,
			"action": "unchanged",
			"saved": false,
		}
	# The editor's Add replaces an entry of the same name too. Said here, since the replaced script
	# is no longer loaded and nothing else in the answer names it.
	var held: String = str(ProjectSettings.get_setting(setting)) if was_updated else ""
	ProjectSettings.set_setting(setting, entry)
	var err: Error = GdhProjectFile.save([setting])
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	var answer: Dictionary = {
		"name": name,
		"path": path,
		"enabled": true,
		"global": global,
		"action": "updated" if was_updated else "added",
		"saved": true,
	}
	if was_updated:
		answer["old_path"] = held.trim_prefix("*")
	return answer


## Why the file at [param path] cannot be an autoload, or empty when it can, as the editor's
## Autoload
## tab judges it: a scene, or a script whose instances are nodes. Written anyway, a script extending
## RefCounted saved fine and every start of the game then failed to instantiate it. A script that
## does not compile is let through, since it may be one being written, and its errors are its own.
static func _not_an_autoload(path: String) -> String:
	var refused: String = "%s is %s, and an autoload is a scene or a script extending Node"
	if not ResourceLoader.exists(path):
		return (refused + ". Nothing was written.") % [path, "a file Godot does not load"]
	var loaded: Resource = load(path)
	if loaded is PackedScene:
		return ""
	if not loaded is Script:
		var kind: String = "nothing Godot could load"
		if loaded != null:
			kind = "a " + loaded.get_class()
		return (refused + ". Nothing was written.") % [path, kind]
	var script: Script = loaded
	if not script.can_instantiate():
		return ""
	var base: StringName = script.get_instance_base_type()
	if ClassDB.is_parent_class(base, "Node"):
		return ""
	return (
		(
			"%s extends %s, which is not a Node, and Godot instantiates an autoload under the root "
			+ "as a node, so every start of the game would fail to load it. Nothing was written."
		)
		% [path, base]
	)


## Why [param name] cannot name an autoload, or empty when it can. The editor's Autoload tab refuses
## the same names, and a global constant's too, which no script can list: an autoload named after
## an engine class or a built-in type takes that name in every script, so an autoload called Input
## made every Input.is_action_pressed call the autoload.
static func _autoload_name_refusal(name: String) -> String:
	var reason: String = ""
	var declaring: String = str(GdhGdscriptAuthoring.declared_classes().get(name, ""))
	if not name.is_valid_unicode_identifier():
		reason = "it is not an identifier, which a script could name"
	elif name in GDSCRIPT_KEYWORDS:
		reason = "it is a GDScript keyword"
	elif ClassDB.class_exists(name):
		reason = (
			"it is the engine class %s, and every script naming %s would reach the autoload instead"
			% [name, name]
		)
	elif not declaring.is_empty():
		reason = "%s declares it as its class_name" % declaring
	else:
		for type: int in TYPE_MAX:
			if type_string(type) == name:
				reason = "it is the built-in type %s" % name
	if reason.is_empty():
		return ""
	return (
		(
			"%s cannot name an autoload: %s. Nothing was written. The editor's Autoload tab "
			+ "refuses it too."
		)
		% [JSON.stringify(name), reason]
	)


# Remove an autoload singleton
func remove_autoload(params: Dictionary) -> Dictionary:
	var name: String = str(params.get("name", ""))

	_log.info("Removing autoload: " + name)

	var setting: String = "autoload/" + name
	if not ProjectSettings.has_setting(setting):
		return _log.failure("Autoload not found: " + name)

	var old_value: String = str(ProjectSettings.get_setting(setting))
	ProjectSettings.set_setting(setting, null)
	var err: Error = GdhProjectFile.save([setting])
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {
		"name": name, "removed": true, "old_path": old_value.trim_prefix("*"), "saved": true,
	}


# List all autoload singletons
func list_autoloads(_params: Dictionary) -> Dictionary:
	_log.info("Listing autoloads")

	var autoloads: Array[Dictionary] = []

	for property: Dictionary in ProjectSettings.get_property_list():
		var setting: String = str(property.get("name", ""))
		if not setting.begins_with("autoload/"):
			continue
		var value: String = str(ProjectSettings.get_setting(setting))
		var path: String = value.trim_prefix("*")

		# Enabled whatever the asterisk says, because every autoload listed is loaded. The asterisk
		# is whether its name is a global variable.
		var autoload_info: Dictionary = {
			"name": setting.trim_prefix("autoload/"),
			"path": path,
			"enabled": true,
			"global": value.begins_with("*"),
			"file_exists": FileAccess.file_exists(path),
		}
		autoloads.append(autoload_info)

	return { "autoloads": autoloads, "count": autoloads.size() }


# Set the main scene
func set_main_scene(params: Dictionary) -> Dictionary:
	var scene_path: String = str(params.get("scene_path", ""))

	if not scene_path.begins_with("res://"):
		scene_path = "res://" + scene_path

	_log.info("Setting main scene: " + scene_path)

	if not FileAccess.file_exists(scene_path):
		return _log.failure(
			GdhFileWalk.new().with_nearest_files(
				"Scene file does not exist: " + scene_path, scene_path
			)
		)

	# The engine starts the game by instancing the main scene, so a script or any other resource set
	# there was saved and answered as set, and the game then would not start.
	if not ResourceLoader.exists(scene_path, "PackedScene"):
		var loaded: Resource = ResourceLoader.load(scene_path, "", ResourceLoader.CACHE_MODE_IGNORE)
		var kind: String = loaded.get_class() if loaded != null else ""
		var said: String = (
			"%s is %s, not a scene, and the main scene has to be one"
			% [scene_path, "a " + kind if not kind.is_empty() else "no resource the engine loads"]
		)
		return _log.failure(
			GdhFileWalk.new().with_nearest_files(said, scene_path.get_basename() + ".tscn")
		)

	var old_main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))

	ProjectSettings.set_setting("application/run/main_scene", scene_path)
	var err: Error = GdhProjectFile.save(["application/run/main_scene"])

	if err != OK:
		return _log.failure("Failed to save project settings: " + str(err))

	return { "old_main_scene": old_main_scene, "new_main_scene": scene_path, "saved": true }
