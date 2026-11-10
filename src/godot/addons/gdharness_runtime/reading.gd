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
## 2^63, the first float that is no 64-bit whole number.
const INT_LIMIT: float = 9_223_372_036_854_775_808.0
const INT_MAX: int = 9_223_372_036_854_775_807
const INT_MIN: int = -9_223_372_036_854_775_807 - 1
## The types holding their floats as the engine's real numbers, 32-bit unless it was built for 64.
const SHAPES_OF_REALS: Array[int] = [
	TYPE_VECTOR2,
	TYPE_VECTOR3,
	TYPE_VECTOR4,
	TYPE_RECT2,
	TYPE_PLANE,
	TYPE_QUATERNION,
	TYPE_AABB,
	TYPE_BASIS,
	TYPE_TRANSFORM2D,
	TYPE_TRANSFORM3D,
	TYPE_PROJECTION,
	TYPE_PACKED_VECTOR2_ARRAY,
	TYPE_PACKED_VECTOR3_ARRAY,
	TYPE_PACKED_VECTOR4_ARRAY,
]


## Text and numbers that are no whole number in 64 bits answer [param fallback] rather than a
## wrapped or cut-off value.
static func as_int(value: Variant, fallback: int = 0) -> int:
	if value is int:
		var already: int = value
		return already
	if value is float:
		var real: float = value
		if not is_finite(real) or real >= INT_LIMIT or real < -INT_LIMIT:
			return fallback
		return int(real)
	if value is bool:
		var flag: bool = value
		return 1 if flag else 0
	if value is String:
		var text: String = value
		return _int_in(text.strip_edges(), fallback)
	return fallback


## [param text] as a whole number, which may be written with an exponent or a fraction, or
## [param fallback] when it is none or does not fit in 64 bits.
static func _int_in(text: String, fallback: int) -> int:
	if text.is_valid_int():
		var whole: int = text.to_int()
		# to_int stops at the ends of the range, so an end that the text does not spell is an
		# overflow.
		if (whole == INT_MAX or whole == INT_MIN) and str(whole) != text.trim_prefix("+"):
			return fallback
		return whole
	if text.is_valid_float():
		return as_int(text.to_float(), fallback)
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
		var raw: String = value
		var text: String = raw.strip_edges()
		if text.is_valid_float():
			var read: float = text.to_float()
			return read if is_finite(read) else fallback
		return non_finite(text, fallback)
	if value is Dictionary:
		var tagged: Dictionary = value
		if str(tagged.get("_type", "")) == "float":
			var carried: Variant = tagged.get("value", "")
			if carried is float or carried is int:
				return as_float(carried)
			return non_finite(str(carried), fallback)
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


## Text answers true for "true" and false for "false" and the empty text, in any case, and a number
## in text is true unless it is zero. Any other text answers [param fallback], as does NaN.
static func as_bool(value: Variant, fallback: bool = false) -> bool:
	if value is bool:
		var already: bool = value
		return already
	if value is int:
		var whole: int = value
		return whole != 0
	if value is float:
		var real: float = value
		return fallback if is_nan(real) else real != 0.0
	if value is String:
		var raw: String = value
		var text: String = raw.strip_edges().to_lower()
		if text.is_empty() or text == "false":
			return false
		if text == "true":
			return true
		if text.is_valid_float():
			return text.to_float() != 0.0
		return fallback
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
## caller who read the root as Main in a tree wrote Main/Body and was told only that nothing is
## there.
static func from_the_root(said: String, node_path: String, root_name: String) -> String:
	var first: String = node_path.get_slice("/", 0)
	if first != root_name:
		return said
	var rest: String = node_path.substr(first.length() + 1)
	var how: String = 'Paths go from the root, %s, whose own path is "."' % root_name
	if not rest.is_empty():
		how += ', so this one is "%s"' % rest
	return "%s%s %s." % [said, "" if said.ends_with(".") else ".", how]


## [param said], the refusal for a path a scene does not have, with where the path leaves it: the
## last node of the path it has, [param reached] from the root, called [param root_name], when that
## is empty, the name below it that is missing, and [param children], the names that node has, as
## after a node was moved or renamed. Names up to [constant NAMED_CHILDREN] of them.
static func missing_below(
	said: String,
	root_name: String,
	reached: PackedStringArray,
	missing: String,
	children: PackedStringArray
) -> String:
	var named: PackedStringArray = []
	for child: String in children.slice(0, NAMED_CHILDREN):
		var _named: bool = named.append(_spelt(child))
	var shown: String = ", ".join(named)
	if children.size() > NAMED_CHILDREN:
		shown += " and %d more" % (children.size() - NAMED_CHILDREN)
	var walked: PackedStringArray = []
	for part: String in reached:
		var _walked: bool = walked.append(_spelt(part))
	return (
		"%s %s has no %s. %s."
		% [
			ended(said),
			"The root, %s," % _spelt(root_name) if reached.is_empty() else "/".join(walked),
			_spelt(missing),
			"Its children are " + shown if not children.is_empty() else "It has no children",
		]
	)


## [param name] as a refusal writes it: bare, unless that would read as something else. A name with
## a comma, an edge space, a quote or a leading or trailing dot is quoted, so a list of names stays
## a list and a sentence's full stop is not taken for part of a name.
static func _spelt(name: String) -> String:
	var plain: bool = (
		not name.is_empty()
		and name == name.strip_edges()
		and not name.contains(",")
		and not name.contains('"')
		and not name.begins_with(".")
		and not name.ends_with(".")
	)
	return name if plain else '"%s"' % name.replace('"', '\\"')


## [param said] with a full stop at its end, so another sentence can follow it.
static func ended(said: String) -> String:
	return said if said.ends_with(".") else said + "."


## [param said], the refusal for a [param kind] the scene does not have at [param node_path], with
## what is there when the scene has a node there, [param found] its class, and [param holders], the
## paths of the nodes in the scene that are one, so the caller has the path to pass. Names up to
## [constant NAMED_CHILDREN] of them.
static func not_of_kind(
	said: String, node_path: String, found: String, kind: String, holders: PackedStringArray
) -> String:
	var told: String = said + ("" if said.ends_with(".") else ".")
	if not found.is_empty():
		told += (
			' The node at "%s" is %s, not %s.'
			% [node_path, with_article(found), with_article(kind)]
		)
	if holders.is_empty():
		return (
			told
			+ (
				" The scene holds no %s. scene_node add with nodeType %s puts one in it."
				% [kind, kind]
			)
		)
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
## refusal offers for one that is not there, as a typo usually is one of them. Names that add to the
## word come beyond the three, up to [constant NAMED_CHILDREN] in all. Names equally near keep the
## order given, so the pick does not depend on how many names there are.
static func nearest(word: String, names: PackedStringArray) -> PackedStringArray:
	var wanted: String = word.to_lower()
	var close: Array[String] = []
	var scores: Array[float] = []
	for name: String in names:
		var score: float = name.to_lower().similarity(wanted)
		if score >= 0.5:
			close.append(name)
			scores.append(score)
	var order: Array[int] = []
	for at: int in close.size():
		order.append(at)
	# The index breaks a tie, since the engine's sort keeps the given order only for a short list.
	order.sort_custom(
		func(
			a: int,
			b: int,
		) -> bool: return scores[a] > scores[b] or (scores[a] == scores[b] and a < b)
	)
	# Every name that only adds to the word stays, since cutting at three named three corners of
	# corner_radius and left out the fourth as if it were not there.
	var named: PackedStringArray = []
	for at: int in order:
		if (
			named.size() < 3
			or (named.size() < NAMED_CHILDREN and close[at].to_lower().begins_with(wanted))
		):
			var _added: bool = named.append(close[at])
	return named


## "is" and the one name of [param close], or "are" and all of them, to end a sentence that offers
## the names nearest a word.
static func are_named(close: PackedStringArray) -> String:
	return "%s %s" % ["is" if close.size() == 1 else "are", ", ".join(close)]


## [param said] with the sentence that offers [param close], the names it has nearest the one asked.
static func nearest_told(said: String, close: PackedStringArray) -> String:
	return "%s The nearest it has %s" % [ended(said), are_named(close)]


## [param said], the refusal for [param word], which is not among [param names], with those nearest
## it when any are, or else the first [constant NAMED_CHILDREN] of them, so the caller has a name to
## send instead.
static func offered(said: String, word: String, names: Array) -> String:
	var every: PackedStringArray = PackedStringArray(names)
	var close: PackedStringArray = nearest(word, every)
	if every.is_empty():
		return "%s It has none" % ended(said)
	if close.is_empty():
		var shown: String = ", ".join(every.slice(0, NAMED_CHILDREN))
		if every.size() > NAMED_CHILDREN:
			shown += " and %d more" % (every.size() - NAMED_CHILDREN)
		return "%s It has %s" % [ended(said), shown]
	return nearest_told(said, close)


## [param said], the refusal for [param property], which [param target] does not declare, with the
## names it declares nearest it when any are, as a misspelt one is usually one of them, or else the
## variables its script declares. The engine's own are not listed when none is near, since an object
## has a hundred, while a script's are the few a caller most likely meant. An object with no script
## is told where they are listed instead, since the refusal alone left nothing to try.
static func near_property(said: String, target: Object, property: String) -> String:
	var headings: int = PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP
	var names: Array[String] = []
	var scripted: Array[String] = []
	for declared: Dictionary in target.get_property_list():
		var usage: int = as_int(declared.get("usage", 0))
		if usage & PROPERTY_USAGE_ARRAY:
			var listed: String = _list_called(target, declared, property)
			if not listed.is_empty():
				return "%s %s" % [ended(said), listed]
		if not usage & headings:
			names.append(str(declared.get("name", "")))
		if usage & PROPERTY_USAGE_SCRIPT_VARIABLE and not usage & headings:
			scripted.append(str(declared.get("name", "")))
	# A name that differs only by case is the likelier meaning, and the engine classes below the
	# node
	# that declare the lower-case one are not.
	var wanted: String = property.to_lower()
	for name: String in names:
		if name != property and name.to_lower() == wanted:
			return nearest_told(said, PackedStringArray([name]))
	var below: String = _declared_below(target.get_class(), property)
	if not below.is_empty():
		return "%s %s" % [ended(said), below]
	var close: PackedStringArray = nearest(property, PackedStringArray(names))
	if not close.is_empty():
		return nearest_told(said, close)
	# With a script that declares nothing readable, as one that does not compile, the name is
	# likelier the script's than the class's, so the class's list would point the wrong way.
	if scripted.is_empty() and target.get_script() != null:
		return said
	if scripted.is_empty():
		return (
			(
				"%s editor_classes info with className %s and includeInherited true lists the "
				+ "ones it has"
			)
			% [ended(said), target.get_class()]
		)
	scripted.sort()
	return "%s Its script declares %s" % [ended(said), ", ".join(PackedStringArray(scripted))]


## Which engine classes inheriting [param type] declare [param property], or empty when none does.
## A modulate on a plain Node was refused with the script's names, when the property was right and
## the class was not. Only the highest declaring classes are named, since every class under one has
## it too, and the editor's own classes are left out, as no scene or resource holds one.
static func _declared_below(type: String, property: String) -> String:
	var declaring: Array[String] = []
	for inheriting: String in ClassDB.get_inheriters_from_class(type):
		if inheriting.begins_with("Editor"):
			continue
		for declared: Dictionary in ClassDB.class_get_property_list(inheriting, true):
			if str(declared.get("name", "")) == property:
				declaring.append(inheriting)
				break
	var highest: Array[String] = []
	for one: String in declaring:
		var above: String = ClassDB.get_parent_class(one)
		while above != type and not declaring.has(above):
			above = ClassDB.get_parent_class(above)
		if above == type:
			highest.append(one)
	highest.sort()
	if highest.size() > 1:
		var named: String = ", ".join(PackedStringArray(highest.slice(0, 3)))
		if highest.size() > 3:
			named += " and %d more" % (highest.size() - 3)
		return "%s declare it" % named
	if highest.is_empty():
		return ""
	var declarer: String = highest[0]
	var made: Array[String] = []
	for child: String in ClassDB.get_inheriters_from_class(declarer):
		if ClassDB.get_parent_class(child) == declarer and ClassDB.can_instantiate(child):
			made.append(child)
	made.sort()
	if made.is_empty():
		return "%s declares it, and the classes under it have it too" % declarer
	return (
		"%s declares it, and the classes under it have it too, such as %s"
		% [declarer, " or ".join(PackedStringArray(made.slice(0, 2)))]
	)


## How [param target] keeps the list [param property] names, when that is the label of one of the
## engine's numbered lists, such as an OptionButton's Items. Empty when it is not. The engine has no
## property by that name, only a count and each entry's fields under a numbered prefix, so "items"
## was refused with nothing near it to offer.
static func _list_called(target: Object, count: Dictionary, property: String) -> String:
	var parts: PackedStringArray = str(count.get("class_name", "")).split(",")
	if parts.size() != 2 or _bare(parts[0]) != _bare(property):
		return ""
	var counted: String = str(count.get("name", ""))
	var first: String = parts[1] + "0/"
	var fields: PackedStringArray = _fields_at(target, first)
	if fields.is_empty() and ClassDB.can_instantiate(target.get_class()):
		var fresh: Object = ClassDB.instantiate(target.get_class())
		fresh.set(counted, 1)
		fields = _fields_at(fresh, first)
		if not fresh is RefCounted:
			fresh.free()
	var each: String = (
		"each one's fields" if fields.is_empty() else "each one's %s" % ", ".join(fields)
	)
	return (
		(
			"It keeps its %s as %s, how many there are, and %s under %s for the first, %s for the "
			+ "second and so on: give %s before the fields of the entries it makes"
		)
		% [parts[0].to_lower(), counted, each, first, parts[1] + "1/", counted]
	)


static func _fields_at(target: Object, prefix: String) -> PackedStringArray:
	var fields: PackedStringArray = PackedStringArray()
	for declared: Dictionary in target.get_property_list():
		var name: String = str(declared.get("name", ""))
		if name.begins_with(prefix):
			var _added: bool = fields.append(name.trim_prefix(prefix))
	return fields


static func _bare(word: String) -> String:
	return word.to_lower().replace("_", "").replace(" ", "")


## The signals [param object] has that a caller can connect, its own class's first: its script's,
## as declared, then the engine's from the class down to Object. The engine lists its own from
## Object down, which puts a Button's pressed after thirty a Control has, and its script's ahead of
## those, so reversing the whole list put a game's own two signals after twenty-four of the
## engine's. The engine's names starting with an underscore are its own and left out, a script's
## not.
static func signals_of(object: Object) -> Array:
	var declared: Array = []
	var script: Script = object.get_script()
	if script != null:
		for entry: Dictionary in script.get_script_signal_list():
			var name: String = str(entry["name"])
			if not name in declared:
				declared.append(name)
	var names: Array = []
	for entry: Dictionary in object.get_signal_list():
		var name: String = str(entry["name"])
		if not name.begins_with("_") and not name in declared:
			names.push_front(name)
	return declared + names


## [param word] after the article it takes, "an AnimationTree" or "a Node2D".
static func with_article(word: String) -> String:
	return ("an " if word.left(1).to_upper() in ["A", "E", "I", "O", "U"] else "a ") + word


## [param value], which the engine holds as a 32-bit float, as the shortest decimal that is still
## that float. JSON carries a double, and the double a 32-bit 0.2 widens to is 0.200000002980232:
## the same number, but not the one written or the one the file shows, so a caller comparing what it
## set against what it read saw them differ. The shorter one, sent back, stores the same 32 bits. A
## plain float is left alone by the serialiser, since nothing says whether the engine holds it in
## 32 bits or 64.
static func single(value: float) -> float:
	if not is_finite(value) or value == 0.0:
		return value
	var held: float = PackedFloat32Array([value])[0]
	var magnitude: int = floori(log(absf(held)) / log(10.0))
	for digits: int in range(1, 9):
		var tried: float = _rounded_to(held, magnitude, digits)
		if PackedFloat32Array([tried])[0] == held:
			return tried
	# Nine digits always name a 32-bit float.
	return _rounded_to(held, magnitude, 9)


## [param value] to [param digits] significant digits, as the double nearest that decimal.
static func _rounded_to(value: float, magnitude: int, digits: int) -> float:
	var shift: int = digits - 1 - magnitude
	# Only the whole number of digits comes from this scale, which is a step off past 10^22 and so
	# decides nothing but which whole number is tried.
	var scale: float = pow(10.0, absi(shift))
	return _decimal(roundf(value * scale if shift >= 0 else value / scale), -shift)


## [param whole] times ten to the [param power], rounded once. The power of ten is not exact past
## 10^22 and a product or quotient with it lands a step off the nearest double, so it is carried as
## a high and a low double and the rounding happens last.
static func _decimal(whole: float, power: int) -> float:
	var ten: PackedFloat64Array = _ten_to(absi(power))
	var high: float = ten[0]
	var low: float = ten[1]
	if power >= 0:
		var product: PackedFloat64Array = _product(whole, high)
		return product[0] + (product[1] + whole * low)
	var quotient: float = whole / high
	var back: PackedFloat64Array = _product(quotient, high)
	return quotient + (((whole - back[0]) - back[1]) - quotient * low) / high


## Ten to the [param power] as {high, low}, which add up to it far past a double's precision.
static func _ten_to(power: int) -> PackedFloat64Array:
	var high: float = 1.0
	var low: float = 0.0
	for _step: int in power:
		var product: PackedFloat64Array = _product(high, 10.0)
		var tail: float = product[1] + low * 10.0
		var sum: float = product[0] + tail
		low = tail - (sum - product[0])
		high = sum
	return PackedFloat64Array([high, low])


## [param a] times [param b] as {product, error}, exactly: Dekker's product, which splits each
## factor
## in halves whose products are exact.
static func _product(a: float, b: float) -> PackedFloat64Array:
	var product: float = a * b
	var split_a: float = 134_217_729.0 * a
	var a_high: float = split_a - (split_a - a)
	var split_b: float = 134_217_729.0 * b
	var b_high: float = split_b - (split_b - b)
	var a_low: float = a - a_high
	var b_low: float = b - b_high
	var error: float = (
		((a_high * b_high - product) + a_high * b_low + a_low * b_high) + a_low * b_low
	)
	return PackedFloat64Array([product, error])


## Whether a value of [param type] holds its floats in 32 bits: a colour always, and the vectors and
## the shapes built of them unless the engine was built for 64.
static func holds_singles(type: int) -> bool:
	if type in [TYPE_COLOR, TYPE_PACKED_COLOR_ARRAY, TYPE_PACKED_FLOAT32_ARRAY]:
		return true
	return not OS.has_feature("double") and type in SHAPES_OF_REALS
