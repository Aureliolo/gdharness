extends RefCounted

## Which control a click means when it names the control by the words on it rather than by path.

const Queries = preload("runtime_queries.gd")
const Read = preload("reading.gd")
const Values = preload("runtime_values.gd")
const Words = preload("runtime_words.gd")

## How many of the controls saying the same words a refusal names, with the index for each.
const LISTED_CANDIDATES: int = 10


## The control a click by [param wanted] words presses, found under [param root_path] in the tree
## [param root] heads, or the refusal saying why there is none or which of several:
## {"path", "found"} or {"type", "message"}.
##
## Matched the way a find matches `says`, against a control's own words, and only among controls
## the player can see. A match inside a button presses the button, because the label is what says
## the words and the button is what takes the click: aimed at the label, the pointer lands on the
## button and the answer would call the click a miss. Several matches are refused rather than
## guessed, each named with the [param which] that picks it, counting from 0.
static func control_saying(root: Node, root_path: String, wanted: String, which: Variant) -> Dictionary:
	var reached: Dictionary = Values.node_at(root, root_path)
	if reached.has("message"):
		return reached
	var targets: Array[Control] = []
	# The words of the control that matched, which a button pressed on a label's behalf has none of.
	var said: Array[String] = []
	var hidden: int = 0
	var pending: Array[Node] = [reached["node"]]
	while not pending.is_empty():
		var node: Node = pending.pop_front()
		if node is Control and Queries.says(node, wanted):
			if not Queries.shown(node):
				hidden += 1
			else:
				var matched: Control = node
				var target: Control = _pressed_through(matched)
				if not targets.has(target):
					targets.append(target)
					said.append(Words.said_by(node))
		var children: Array[Node] = node.get_children(true)
		for index: int in range(children.size() - 1, -1, -1):
			pending.push_front(children[index])

	var under: String = "" if root_path == "/root" else " under %s" % root_path
	if targets.is_empty():
		return {
			"type": "error",
			"message":
			(
				'no control on screen%s says "%s", so nothing was clicked%s'
				% [under, wanted, _hidden_note(hidden)]
			)
		}
	if which == null and targets.size() > 1:
		return {
			"type": "error",
			"message":
			(
				'%d controls on screen%s say "%s", so which to click is not clear; pass index, counting from 0: %s'
				% [targets.size(), under, wanted, _candidates(targets, said)]
			)
		}
	var index: int = 0 if which == null else Read.as_int(which, -1)
	if index < 0 or index >= targets.size():
		var plural: String = "" if targets.size() == 1 else "s"
		return {
			"type": "error",
			"message":
			(
				'index %s is not one of the %d control%s on screen%s saying "%s": %s'
				% [str(which), targets.size(), plural, under, wanted, _candidates(targets, said)]
			)
		}
	return {
		"path": str(targets[index].get_path()),
		"found": {"says": wanted, "index": index, "of": targets.size()},
	}


## What to add to a refusal that found nothing on screen, when words matched controls out of sight.
static func _hidden_note(hidden: int) -> String:
	if hidden == 0:
		return ""
	return "; %d hidden control%s" % [hidden, " says it" if hidden == 1 else "s say it"]


## [param control], or the button holding it when it is not one itself, which is what a click on
## its words means.
static func _pressed_through(control: Control) -> Control:
	var walk: Node = control
	while walk != null:
		if walk is BaseButton:
			var pressed: BaseButton = walk
			return pressed
		walk = walk.get_parent()
	return control


## The controls a click by words could mean, each with its index, its path and the words that
## matched, [param said] holding those in the same order.
static func _candidates(targets: Array[Control], said: Array[String]) -> String:
	var named: Array[String] = []
	for index: int in mini(targets.size(), LISTED_CANDIDATES):
		var words: String = said[index].replace("\n", " ")
		if words.length() > 60:
			words = words.substr(0, 57) + "..."
		named.append('%d %s ("%s")' % [index, targets[index].get_path(), words])
	if targets.size() > LISTED_CANDIDATES:
		named.append("and %d more" % (targets.size() - LISTED_CANDIDATES))
	return "; ".join(named)
