extends RefCounted

const Log = preload("logger.gd")

# The base class each category name stands for.
const CATEGORY_BASES = {
	"node": "Node",
	"node2d": "Node2D",
	"node3d": "Node3D",
	"control": "Control",
	"resource": "Resource",
	"physics": "PhysicsBody3D",
	"physics2d": "PhysicsBody2D",
	"audio": "AudioStream",
	"visual": "VisualInstance3D",
	"animation": "AnimationMixer",
}

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# Query available classes from ClassDB with optional filtering
func query_classes(params) -> Dictionary:
	var filter = params.get("filter", "")
	var category = params.get("category", "")
	var instantiable_only = params.get("instantiable_only", false)

	_log.info(
		(
			"Querying ClassDB classes (filter: '"
			+ filter
			+ "', category: '"
			+ category
			+ "', instantiable_only: "
			+ str(instantiable_only)
			+ ")"
		)
	)

	var base_class = ""
	if not category.is_empty():
		base_class = CATEGORY_BASES.get(category.to_lower(), "")
		if base_class.is_empty():
			return _log.failure("Unknown category: " + category + ". Valid: " + str(CATEGORY_BASES.keys()))

	var all_classes = ClassDB.get_class_list()
	all_classes.sort()

	var filtered_classes = []

	for class_name_str in all_classes:
		# Apply instantiable filter
		if instantiable_only and not ClassDB.can_instantiate(class_name_str):
			continue

		# Apply name filter (case-insensitive substring match)
		if not filter.is_empty() and not class_name_str.to_lower().contains(filter.to_lower()):
			continue

		# Apply category filter
		if not base_class.is_empty():
			if not ClassDB.is_parent_class(class_name_str, base_class) and class_name_str != base_class:
				continue

		filtered_classes.append(class_name_str)

	_log.info(
		"Found " + str(filtered_classes.size()) + " classes (out of " + str(all_classes.size()) + " total)"
	)

	return {
		"total_classes": all_classes.size(),
		"filtered_count": filtered_classes.size(),
		"filter": filter,
		"category": category,
		"instantiable_only": instantiable_only,
		"classes": filtered_classes
	}


# Query detailed info about a specific class from ClassDB
func query_class_info(params) -> Dictionary:
	var class_name_str = params.class_name
	var include_inherited = params.get("include_inherited", false)

	_log.info(
		"Querying class info for: " + class_name_str + " (include_inherited: " + str(include_inherited) + ")"
	)

	if not ClassDB.class_exists(class_name_str):
		return _log.failure("Class not found: " + class_name_str)

	var methods = _methods_of(class_name_str, include_inherited)
	var properties = _properties_of(class_name_str, include_inherited)
	var signals = _signals_of(class_name_str, include_inherited)

	# Get enums
	var enums = {}
	for e in ClassDB.class_get_enum_list(class_name_str, !include_inherited):
		var enum_values = {}
		for c in ClassDB.class_get_enum_constants(class_name_str, e, !include_inherited):
			enum_values[c] = ClassDB.class_get_integer_constant(class_name_str, c)
		enums[e] = enum_values

	_log.info(
		(
			"Class info retrieved: "
			+ str(methods.size())
			+ " methods, "
			+ str(properties.size())
			+ " properties, "
			+ str(signals.size())
			+ " signals"
		)
	)

	return {
		"class_name": class_name_str,
		"parent_class": ClassDB.get_parent_class(class_name_str),
		"can_instantiate": ClassDB.can_instantiate(class_name_str),
		"include_inherited": include_inherited,
		"methods_count": methods.size(),
		"methods": methods,
		"properties_count": properties.size(),
		"properties": properties,
		"signals_count": signals.size(),
		"signals": signals,
		"enums": enums
	}


# Inspect class inheritance hierarchy
func inspect_inheritance(params) -> Dictionary:
	var class_name_str = params.class_name

	_log.info("Inspecting inheritance for: " + class_name_str)

	if not ClassDB.class_exists(class_name_str):
		return _log.failure("Class not found: " + class_name_str)

	# Build ancestor chain
	var ancestors = []
	var current = class_name_str
	while not current.is_empty():
		var parent = ClassDB.get_parent_class(current)
		if parent.is_empty():
			break
		ancestors.append(parent)
		current = parent

	var all_classes = ClassDB.get_class_list()

	# Get direct subclasses
	var direct_children = []
	for c in all_classes:
		if ClassDB.get_parent_class(c) == class_name_str:
			direct_children.append(c)
	direct_children.sort()

	# Get all descendants (recursive)
	var all_descendants = []
	for c in all_classes:
		if c != class_name_str and ClassDB.is_parent_class(c, class_name_str):
			all_descendants.append(c)
	all_descendants.sort()

	_log.info(
		(
			"Inheritance: "
			+ str(ancestors.size())
			+ " ancestors, "
			+ str(direct_children.size())
			+ " direct children, "
			+ str(all_descendants.size())
			+ " total descendants"
		)
	)

	return {
		"class_name": class_name_str,
		"parent_class": ClassDB.get_parent_class(class_name_str),
		"ancestors": ancestors,
		"direct_children_count": direct_children.size(),
		"direct_children": direct_children,
		"all_descendants_count": all_descendants.size(),
		"all_descendants": all_descendants,
		"can_instantiate": ClassDB.can_instantiate(class_name_str)
	}


func _methods_of(class_name_str: String, include_inherited: bool) -> Array:
	var methods = []

	for m in ClassDB.class_get_method_list(class_name_str, !include_inherited):
		var args = []
		for a in m.get("args", []):
			args.append(
				{
					"name": a.get("name", ""),
					"type": a.get("type", 0),
					"class_name": a.get("class_name", ""),
					"hint_string": a.get("hint_string", "")
				}
			)
		methods.append(
			{
				"name": m.get("name", ""),
				"args": args,
				"return":
				{
					"type": m.get("return", {}).get("type", 0),
					"class_name": m.get("return", {}).get("class_name", "")
				},
				"flags": m.get("flags", 0),
				"default_args": m.get("default_args", [])
			}
		)

	return methods


func _properties_of(class_name_str: String, include_inherited: bool) -> Array:
	var properties = []

	for p in ClassDB.class_get_property_list(class_name_str, !include_inherited):
		# A category, group or subgroup is an editor heading rather than a property.
		var usage = p.get("usage", 0)
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP or usage & PROPERTY_USAGE_SUBGROUP:
			continue
		properties.append(
			{
				"name": p.get("name", ""),
				"type": p.get("type", 0),
				"class_name": p.get("class_name", ""),
				"hint": p.get("hint", 0),
				"hint_string": p.get("hint_string", ""),
				"usage": usage
			}
		)

	return properties


func _signals_of(class_name_str: String, include_inherited: bool) -> Array:
	var signals = []

	for s in ClassDB.class_get_signal_list(class_name_str, !include_inherited):
		var sig_args = []
		for a in s.get("args", []):
			sig_args.append(
				{"name": a.get("name", ""), "type": a.get("type", 0), "class_name": a.get("class_name", "")}
			)
		signals.append({"name": s.get("name", ""), "args": sig_args})

	return signals
