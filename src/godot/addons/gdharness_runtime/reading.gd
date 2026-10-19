extends RefCounted

# A value out of a dictionary that came from JSON, as the type the caller wants.
#
# This file is the one beside the operations, and `bun run sync:gd` copies it into each addon,
# because an addon is installed as a directory and cannot preload out of one. The runtime addon's
# copy ships inside exported games and the editor addon's does not, which is the other reason
# neither of them reaches into the other.
#
# `int(value)`, `float(value)` and `bool(value)` take a Variant, and a project holding
# `unsafe_call_argument` at error level will not compile a script that hands one over. These
# scripts are compiled under the target project's warning levels rather than under this package's,
# because `--path` makes that project the loaded one and the file's living in the npm cache
# changes nothing: one project turning that warning on lost every headless operation at once.
#
# The conversion itself is the same. What changes is that the type is established first, on a
# typed local, and the conversion happens from that. Here rather than at each of the thirty-one
# places that read a parameter, because thirty-one is how many chances there are to write the old
# form again, and the error does not appear until somebody sets the warning.
#
# `fallback` answers a value that is there and is null, which is a caller sending JSON null where a
# number was expected. Absent keys never reach here: the callers pass their own default to
# `Dictionary.get`, so what arrives is that default.

## How many of a node's children a refusal for a path missing below it names.
const NAMED_CHILDREN: int = 12


static func as_int(value: Variant, fallback: int = 0) -> int:
	if value is int:
		var already: int = value
		return already
	if value is float:
		var real: float = value
		return int(real)
	if value is bool:
		var flag: bool = value
		return 1 if flag else 0
	if value is String:
		var text: String = value
		return text.to_int()
	return fallback


static func as_float(value: Variant, fallback: float = 0.0) -> float:
	if value is float:
		var already: float = value
		return already
	if value is int:
		var whole: int = value
		return float(whole)
	if value is bool:
		var flag: bool = value
		return 1.0 if flag else 0.0
	if value is String:
		var text: String = value
		return text.to_float()
	if value is Dictionary:
		var tagged: Dictionary = value
		if str(tagged.get("_type", "")) == "float":
			return non_finite(str(tagged.get("value", "")), fallback)
	return fallback


## The float a non-finite tag names, "inf", "-inf" or "nan", or [param fallback] for anything else.
## JSON has no spelling for these, so the serialiser tags them rather than let them arrive as null.
static func non_finite(word: String, fallback: float = 0.0) -> float:
	match word:
		"inf":
			return INF
		"-inf":
			return -INF
		"nan":
			return NAN
	return fallback


static func as_bool(value: Variant, fallback: bool = false) -> bool:
	if value is bool:
		var already: bool = value
		return already
	if value is int:
		var whole: int = value
		return whole != 0
	if value is float:
		var real: float = value
		return not is_zero_approx(real)
	if value is String:
		var text: String = value
		return not text.is_empty()
	return fallback


## [param text] read as JSON, or null when it does not parse, without printing anything.
##
## [method JSON.parse_string] prints an engine error for text that does not parse, and that error
## lands in the log of whatever is running it. A caller sending the word "five" where a number was
## wanted was refused properly, and the game's own log then held an error it never made, so its
## verdict read `clean: false`. Text that is not JSON is an answer here, not a fault.
static func json_or_null(text: String) -> Variant:
	var json: JSON = JSON.new()
	if json.parse(text) != OK:
		return null
	return json.data


## [param said], the refusal for [param node_path] found nowhere in a scene whose root is called
## [param root_name], with how paths are read when the path starts with that name and the root has
## no child called that. Paths go from the root, so its own name there names a child of it, and a
## caller who read the root as Main in a tree wrote Main/Body and was told only that nothing is there.
static func from_the_root(said: String, node_path: String, root_name: String) -> String:
	var first: String = node_path.get_slice("/", 0)
	if root_name.is_empty() or first != root_name:
		return said
	var rest: String = node_path.substr(first.length() + 1)
	var how: String = 'Paths go from the root, %s, whose own path is "."' % root_name
	if not rest.is_empty():
		how += ', so this one is "%s"' % rest
	return "%s%s %s." % [said, "" if said.ends_with(".") else ".", how]


## [param said], the refusal for a path a scene does not have, with where the path leaves it: the
## last node of the path it has, [param reached] from the root, called [param root_name], when that
## is empty; the name below it that is missing; and [param children], the names that node has, as
## after a node was moved or renamed. Names up to [constant NAMED_CHILDREN] of them.
static func missing_below(
	said: String, root_name: String, reached: PackedStringArray, missing: String, children: PackedStringArray
) -> String:
	var shown: String = ", ".join(children.slice(0, NAMED_CHILDREN))
	if children.size() > NAMED_CHILDREN:
		shown += " and %d more" % (children.size() - NAMED_CHILDREN)
	return (
		"%s%s %s has no %s; %s."
		% [
			said,
			"" if said.ends_with(".") else ".",
			"The root, %s," % root_name if reached.is_empty() else "/".join(reached),
			missing,
			"its children are " + shown if not children.is_empty() else "it has no children",
		]
	)


## [param said], the refusal for a [param kind] the scene does not have at [param node_path], with
## what is there when the scene has a node there, [param found] its class, and [param holders], the
## paths of the nodes in the scene that are one, so the caller has the path to pass. Names up to
## [constant NAMED_CHILDREN] of them.
static func not_of_kind(
	said: String, node_path: String, found: String, kind: String, holders: PackedStringArray
) -> String:
	var told: String = said + ("" if said.ends_with(".") else ".")
	if not found.is_empty():
		told += ' The node at "%s" is %s, not %s.' % [node_path, with_article(found), with_article(kind)]
	if holders.is_empty():
		return told + " The scene holds no %s." % kind
	var quoted: PackedStringArray = []
	for holder: String in holders.slice(0, NAMED_CHILDREN):
		var _quoted: bool = quoted.append('"%s"' % holder)
	var shown: String = ", ".join(quoted)
	if holders.size() > NAMED_CHILDREN:
		shown += " and %d more" % (holders.size() - NAMED_CHILDREN)
	if holders.size() == 1:
		return told + " The scene's %s is at %s." % [kind, shown]
	return told + " The scene's %ss are at %s." % [kind, shown]


## Up to three of [param names] closest to [param word], closest first, ignoring case: the names a
## refusal offers for one that is not there, as a typo usually is one of them.
static func nearest(word: String, names: PackedStringArray) -> PackedStringArray:
	var wanted: String = word.to_lower()
	var close: Array[String] = []
	for name: String in names:
		if name.to_lower().similarity(wanted) >= 0.5:
			close.append(name)
	close.sort_custom(
		func(a: String, b: String) -> bool:
			return a.to_lower().similarity(wanted) > b.to_lower().similarity(wanted)
	)
	return PackedStringArray(close.slice(0, 3))


## [param said], the refusal for [param word], which is not among [param names], with those nearest
## it when any are, or else every one of them, so the caller has a name to send instead.
static func offered(said: String, word: String, names: Array) -> String:
	var every: PackedStringArray = PackedStringArray(names)
	var close: PackedStringArray = nearest(word, every)
	if close.is_empty():
		return "%s; it has %s" % [said, ", ".join(every)]
	return "%s; the nearest it has %s %s" % [said, "is" if close.size() == 1 else "are", ", ".join(close)]


## The signals [param object] has that a caller can connect, its own class's first: the engine
## lists them from Object down, which puts a Button's pressed after thirty a Control has, and names
## starting with an underscore are the engine's own.
static func signals_of(object: Object) -> Array:
	var names: Array = []
	for entry: Dictionary in object.get_signal_list():
		var name: String = str(entry["name"])
		if not name.begins_with("_"):
			names.push_front(name)
	return names


## [param word] after the article it takes, "an AnimationTree" or "a Node2D".
static func with_article(word: String) -> String:
	return ("an " if word.left(1).to_upper() in ["A", "E", "I", "O", "U"] else "a ") + word
