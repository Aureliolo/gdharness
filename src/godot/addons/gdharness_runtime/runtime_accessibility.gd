extends RefCounted
## What the running game tells a screen reader: its accessibility tree, as the system's own screen
## reader interface reads it: UI Automation on Windows, AT-SPI on Linux and the AX API on macOS.
##
## The engine builds the tree only when something asks for it, and nothing on gdharness's desktop
## does, so a game's NOTIFICATION_ACCESSIBILITY_UPDATE never came and what its controls expose could
## not be checked. The engine offers no way to read the tree back, so the question is put the way a
## screen reader puts it: a client started by the game lands on the game's own desktop, its first
## question makes the engine build the tree, and what it reads is what a screen reader is told,
## names left empty included. The clients are in [code]runtime_readers.gd[/code].

const GdhRead = preload("reading.gd")
const GdhSays = preload("runtime_says.gd")
const GdhReaders = preload("runtime_readers.gd")
## How long the client keeps walking the tree for it to settle: the engine answers the first
## question with its windows alone and fills them in over the next frames.
const SETTLE_MS: int = 8000
## How long a window with nothing in it is walked before the client stops: a game building its tree
## fills the window within a few frames of being asked, and one building none never does.
const EMPTY_MS: int = 4000
## How long starting the client and loading its interface may take before the client is stopped.
## It waits on the machine alone: a warm start takes well under a second, and a cold one on a
## loaded runner took the whole of a single 23 s budget meant for the walk as well.
const START_MS: int = 45000
## How long the walks may take beyond [constant SETTLE_MS] a window once UI Automation is loaded,
## kept short since a walk that overruns is a window that does not answer.
const WALK_SLACK_MS: int = 7000
## How often the progress file is read while the client runs.
const LOOK_MS: int = 250
## Deep enough for any interface a game builds.
const MOST_LEVELS: int = 40
## Where an element holds its node's instance id between matching and placing, removed before the
## answer goes.
const NODE_ID: String = "_node_instance"

var _host: Node


func _init(host: Node) -> void:
	_host = host


## Why this game's tree cannot be read where it runs, or "" when it can.
static func _unreadable_here() -> String:
	if DisplayServer.get_name() == "headless":
		# Both needs at once: told only the window, a caller started a windowed run and was then
		# refused for the tree the engine had not been asked to build.
		var also: String = ""
		if _setting() != "always":
			also = (
				(
					' and engineArgs ["--accessibility", "always"], since this project\'s '
					+ "accessibility/general/accessibility_support is %s and the engine builds the "
					+ "tree only when asked"
				)
				% _setting()
			)
		return (
			(
				"A headless run has no window, so a screen reader is told nothing: start the "
				+ "run with headless: false%s."
			)
			% also
		)
	if GdhReaders.profile().is_empty():
		return (
			(
				"The tree is read through UI Automation on Windows, AT-SPI on Linux and the AX API "
				+ "on macOS, and this game runs on %s, which has none of them"
			)
			% OS.get_name()
		)
	return ""


## Waits out the client [param pid] walking [param windows] windows, a frame at a time rather than
## blocking: the client's questions are answered on the game's main thread, which a blocking wait
## would hold, and neither side would move. Two budgets, so a slow start is never charged to the
## walk: one for the client to begin and load its interface, and once it has, one for the walks.
## [param reader] is the system's [method GdhReaders.profile]. Answers why it was stopped, or ""
## once the walk is done.
func _walk_waited(
	pid: int, progress: String, windows: int, started_ms: int, reader: Dictionary
) -> String:
	var began_at: int = Time.get_ticks_msec()
	var deadline: int = _deadline(began_at, -1, windows)
	var walking: bool = false
	var looked_at: int = began_at
	var frames: int = 0
	while OS.is_process_running(pid):
		var now: int = Time.get_ticks_msec()
		# Read again at the deadline too, so an answer marked since the last look is taken rather
		# than stopped.
		if now - looked_at >= LOOK_MS or now > deadline:
			looked_at = now
			var marked: String = FileAccess.get_file_as_string(progress)
			if not walking and marked.contains("loaded "):
				walking = true
				deadline = _deadline(began_at, now, windows)
			# The answer is whole once it is marked, so the read is done whatever the client does
			# after it, and a client slow to exit costs the read nothing.
			if marked.contains("answered "):
				var _ended: Error = OS.kill(pid)
				return ""
		if now > deadline:
			var _killed: Error = OS.kill(pid)
			var reached: String = _reached(
				FileAccess.get_file_as_string(progress),
				started_ms,
				int(Time.get_unix_time_from_system() * 1000.0),
				reader
			)
			var _gone: Error = DirAccess.remove_absolute(progress)
			return _stopped(now - began_at, reached, frames, reader)
		await _host.get_tree().process_frame
		frames += 1
	return ""


## Why a client stopped after [param waited_ms] at the stage [param reached] was stopped. The
## frames the game ran meanwhile tell a machine too starved to run anything from a client stuck
## on its own while the game, at no higher a priority, kept running. [param reader] is the system's
## [method GdhReaders.profile], UI Automation's when empty.
static func _stopped(
	waited_ms: int, reached: String, frames: int, reader: Dictionary = {}
) -> String:
	return (
		(
			"%s had not read the tree after %d ms, so it was stopped: %s. The game "
			+ "ran %d frame%s in that time."
		)
		% [
			_first_upper(_system(reader)),
			waited_ms,
			reached,
			frames,
			"" if frames == 1 else "s",
		]
	)


## The interface [param reader] asks, UI Automation's when empty.
static func _system(reader: Dictionary) -> String:
	return str(reader.get("system", "UI Automation"))


## What starts [param reader]'s client, said as a sentence's subject, PowerShell when empty.
static func _starter(reader: Dictionary) -> String:
	return str(reader.get("starter", "PowerShell"))


static func _first_upper(words: String) -> String:
	return words.left(1).to_upper() + words.substr(1)


## Gives each of [param windows] the id in [param ids] at its place, -1 past their end, and matches
## its elements to the nodes [param made_by] says made them.
func _match_windows(
	windows: Array, ids: Array[int], made_by: Dictionary, placing: GdhPlacing
) -> void:
	for at: int in windows.size():
		var window: Dictionary = windows[at]
		window["window_id"] = ids[at] if at < ids.size() else -1
		_match(window, made_by, placing)


## Notes in [param result] what [param placing] could not place and what [param answer], the
## client's, could not read. [param reader] is the system's [method GdhReaders.profile].
static func _note_reading(
	result: Dictionary, placing: GdhPlacing, answer: Dictionary, reader: Dictionary
) -> void:
	if placing.tooltips > 0:
		result["tooltip_note"] = (
			(
				"tooltip is the node's tooltip_text, which the engine puts in the tree, and %s, "
				+ "as AccessKit fills it in, has no property that carries it (measured on 4.7.2 "
				+ "with UI Automation), so a screen reader is not told it. Say what a reader needs "
				+ "in accessibility_description."
			)
			% _system(reader)
		)
	if reader.get("element_ids", true) == false:
		result["node_note"] = (
			(
				"%s gives no element ids, so no element could be matched to the node that made "
				+ "it: part_of says which node is drawn around each element instead."
			)
			% _first_upper(_system(reader))
		)
	elif placing.asked > 0 and placing.placed == 0:
		# Nothing at all matched: the element ids are not the engine's element RIDs any more, which
		# an AccessKit that numbers its elements another way would do, and every node would read
		# null.
		result["node_note"] = (
			(
				"No element could be matched to the node that made it: %s's element ids did "
				+ "not carry the engine's element ids, so node and part_of are the windows' alone."
			)
			% _system(reader)
		)
	if answer.has("description_unread"):
		result["description_note"] = (
			"Descriptions could not be read, so none is shown: %s"
			% str(answer["description_unread"])
		)


## Whether a read of a tree the engine was not asked to build found only what the system draws
## round each window, such as its title bar, which no node made. [param unbuilt] is
## [method _tree_unbuilt]'s answer.
static func _only_the_frame(placing: GdhPlacing, reader: Dictionary, unbuilt: String) -> bool:
	return (
		not unbuilt.is_empty()
		and reader.get("element_ids", true) != false
		and placing.asked > 0
		and placing.placed == 0
	)


## Why the windows hold nothing because the engine was not asked to build the tree, or "" when it
## was. The command line's --accessibility is consumed by the engine and not handed on, so only
## the setting and a screen reader can say the tree is built. Otherwise an empty window is most
## likely a game that builds none.
static func _tree_unbuilt(reader: Dictionary) -> String:
	var setting: String = _setting()
	# 1 is a screen reader running, 0 none and -1 a platform that cannot say.
	var read_aloud: bool = (
		setting == "auto" and DisplayServer.accessibility_screen_reader_active() == 1
	)
	if setting == "always" or read_aloud:
		return ""
	return (
		(
			"%s found nothing in the game's windows: the engine builds the "
			+ "tree a screen reader reads only with "
			+ "accessibility/general/accessibility_support at Always Active, or at "
			+ "Auto with a screen reader running when it starts, and this project's "
			+ "is %s. "
			+ 'Start the run with engineArgs ["--accessibility", "always"].'
		)
		% [_first_upper(_system(reader)), setting]
	)


## Why the client's [param text], parsed as [param read], is no answer, or "" when it is one. A
## client that did not run at all leaves nothing, so the message says what running it needs, and
## what the client printed on its error output, [param said], where it printed anything.
static func _unanswered(text: String, read: Variant, reader: Dictionary, said: String) -> String:
	var system: String = _first_upper(_system(reader))
	if not read is Dictionary:
		var printed: String = "" if said.is_empty() else " It printed: %s." % said
		return (
			"%s answered nothing readable: %s.%s Reading it needs %s."
			% [system, text.left(500), printed, reader["needs"]]
		)
	var answer: Dictionary = read
	if not answer.has("error"):
		return ""
	var needs: String = ""
	if answer.has("permission"):
		needs = ". It needs %s" % reader["needs"]
	return "%s could not read the game's windows: %s%s" % [system, str(answer["error"]), needs]


## The game's windows as a screen reader is told them, each a tree of elements.
func get_accessibility(params: Dictionary) -> Dictionary:
	var unread: String = _unreadable_here()
	if not unread.is_empty():
		return _refused(unread)
	var reader: Dictionary = GdhReaders.profile()
	var handles: Array[String] = []
	var ids: Array[int] = []
	for id: int in DisplayServer.get_window_list():
		var handle: int = DisplayServer.window_get_native_handle(DisplayServer.WINDOW_HANDLE, id)
		# Only UI Automation is asked by handle: AT-SPI and the AX API find the game's windows by
		# its process, and a window with no handle of its own is still one.
		if handle != 0 or OS.get_name() != "Windows":
			handles.append(str(handle))
			ids.append(id)

	var out: String = OS.get_temp_dir().path_join(
		"gdharness-accessibility-%d-%d.json" % [OS.get_process_id(), Time.get_ticks_usec()]
	)
	var progress: String = out + ".progress"
	var launched: Dictionary = await GdhReaders.new(_host).start(
		out, progress, handles, [SETTLE_MS, EMPTY_MS, MOST_LEVELS]
	)
	if launched.has("error"):
		return _refused(str(launched["error"]))
	var started_ms: int = launched["started_ms"]
	var pid: int = launched["pid"]
	var stopped: String = await _walk_waited(pid, progress, handles.size(), started_ms, reader)
	if not stopped.is_empty():
		return _refused(stopped)

	var text: String = FileAccess.get_file_as_string(out)
	var took: Dictionary = _took(
		FileAccess.get_file_as_string(progress),
		started_ms,
		int(Time.get_unix_time_from_system() * 1000.0)
	)
	var compile_ms: int = launched["compile_ms"]
	if not took.is_empty() and compile_ms > 0:
		took["compile"] = compile_ms
	# Not checked: a file that is not there was never written, which the answer below says.
	var _removed: Error = DirAccess.remove_absolute(out)
	var _progress_removed: Error = DirAccess.remove_absolute(progress)
	var printed: String = GdhReaders.error_output(out)
	var read: Variant = GdhRead.json_or_null(text)
	var unanswered: String = _unanswered(text, read, reader, printed)
	if not unanswered.is_empty():
		return _refused(unanswered)
	var answer: Dictionary = read

	var windows: Array = answer.get("windows", [])
	var made_by: Dictionary = {}
	_note_elements(_host.get_tree().root, made_by)
	var placing: GdhPlacing = GdhPlacing.new()
	var elements: int = 0
	var unnamed: int = 0
	_match_windows(windows, ids, made_by, placing)
	for at: int in windows.size():
		var window: Dictionary = windows[at]
		var window_id: int = window["window_id"]
		var holder: Window = _window_with(_host.get_tree().root, window_id)
		if holder != null:
			window["node"] = str(holder.get_path())
			_attribute(window, holder, placing, true)
		else:
			_unmark(window)
		elements += _count(window)
		unnamed += _unnamed_text(window)
	var result: Dictionary = { "windows": windows, "elements": elements }
	if not took.is_empty():
		result["tookMsBy"] = took
	_note_reading(result, placing, answer, reader)
	var unbuilt: String = _tree_unbuilt(reader)
	if elements <= windows.size() or _only_the_frame(placing, reader, unbuilt):
		if answer.has("reader_saw"):
			result["reader_saw"] = answer["reader_saw"]
		if not unbuilt.is_empty():
			return _refused(unbuilt)
		result["_note"] = (
			"The windows hold nothing a screen reader is told: Controls are in the tree, and "
			+ "Node2D and Node3D are not unless the game creates elements for them."
		)
	elif unnamed > 0:
		# Seen on a game naming its lines with accessibility_update_set_name: the text was there in
		# the game and empty to the screen reader.
		result["_note"] = (
			(
				"%d text element(s) on screen have no name, so a screen reader reads them as "
				+ "nothing. Static text is read from its value, "
				+ "DisplayServer.accessibility_update_set_value, and a name set on it is not read."
			)
			% unnamed
		)
	_narrow(result, params)
	return result


## Cuts [param result] to what [param params] asks for: the elements made by a node and its
## descendants, the elements saying some words, the fields named, and no more than a number of them.
## Each window keeps as its children only the outermost elements that match, with what they hold, so
## a question about one panel reads one panel.
static func _narrow(result: Dictionary, params: Dictionary) -> void:
	var under: String = str(params.get("node_path", "")).trim_suffix("/")
	var said: String = str(params.get("says", ""))
	var windows: Array = result.get("windows", [])
	if not under.is_empty() or not said.is_empty():
		var matched: int = 0
		for window: Variant in windows:
			if not window is Dictionary:
				continue
			var holder: Dictionary = window
			if _matches(holder, under, said):
				matched += 1
				continue
			var kept: Array = []
			_outermost(holder, under, said, kept)
			holder["children"] = kept
			matched += kept.size()
		result["matched"] = matched
	var fields: Array = params.get("properties", [])
	if not fields.is_empty():
		for window: Variant in windows:
			if window is Dictionary:
				var holder: Dictionary = window
				_keep_only(holder, fields)
	var limit: int = GdhRead.as_int(params.get("limit", 0), 0)
	if limit > 0:
		var left: Array[int] = [limit]
		var omitted: Array[int] = [0]
		for window: Variant in windows:
			if window is Dictionary:
				var holder: Dictionary = window
				_cut(holder, left, omitted)
		if omitted[0] > 0:
			result["omitted"] = omitted[0]
	var counted: int = 0
	for window: Variant in windows:
		if window is Dictionary:
			var holder: Dictionary = window
			counted += _count(holder)
	result["elements"] = counted


## Whether [param element] is made by the node at [param under] or one below it, and says
## [param said], each where asked: words as find matches them, in the element's name, value or
## value_text.
static func _matches(element: Dictionary, under: String, said: String) -> bool:
	if not under.is_empty():
		var path: String = str(element.get("node", element.get("part_of", "")))
		if path != under and not path.begins_with(under + "/"):
			return false
	if not said.is_empty():
		for field: String in ["name", "value", "value_text"]:
			if element.has(field) and GdhSays.matches(str(element[field]), said):
				return true
		return false
	return true


static func _outermost(element: Dictionary, under: String, said: String, kept: Array) -> void:
	var children: Array = element.get("children", [])
	for child: Variant in children:
		if not child is Dictionary:
			continue
		var inner: Dictionary = child
		if _matches(inner, under, said):
			kept.append(inner)
		else:
			_outermost(inner, under, said, kept)


## Leaves [param element] and everything under it only the [param fields] asked for, and the
## children that hold the rest of the tree.
static func _keep_only(element: Dictionary, fields: Array) -> void:
	for key: Variant in element.keys():
		if key != "children" and not fields.has(key):
			var _dropped: bool = element.erase(key)
	var children: Array = element.get("children", [])
	for child: Variant in children:
		if child is Dictionary:
			var inner: Dictionary = child
			_keep_only(inner, fields)


## Keeps the first [param left] elements below [param element], depth first, and counts the ones
## cut into [param omitted]. One-element arrays, so the count carries across windows.
static func _cut(element: Dictionary, left: Array[int], omitted: Array[int]) -> void:
	var children: Array = element.get("children", [])
	var kept: Array = []
	for child: Variant in children:
		if not child is Dictionary:
			continue
		var inner: Dictionary = child
		if left[0] <= 0:
			omitted[0] += _count(inner)
			continue
		left[0] -= 1
		kept.append(inner)
		_cut(inner, left, omitted)
	element["children"] = kept


## The project's accessibility mode, as the command line's --accessibility names them.
static func _setting() -> String:
	match GdhRead.as_int(
		ProjectSettings.get_setting("accessibility/general/accessibility_support", 0), 0
	):
		1:
			return "always"
		2:
			return "disabled"
	return "auto"


static func _count(element: Dictionary) -> int:
	var total: int = 1
	var children: Array = element.get("children", [])
	for child: Variant in children:
		if child is Dictionary:
			var inner: Dictionary = child
			total += _count(inner)
	return total


## Every node's element by its id, for the walk's elements to be read back as the node that made
## them. Internal children too: a dialog's buttons are elements like any other.
static func _note_elements(node: Node, made_by: Dictionary) -> void:
	var element: RID = node.get_accessibility_element()
	if element.is_valid():
		made_by[element.get_id()] = node
	for child: Node in node.get_children(true):
		_note_elements(child, made_by)


static func _window_with(node: Node, window_id: int) -> Window:
	if node is Window:
		var window: Window = node
		if window.get_window_id() == window_id:
			return window
	for child: Node in node.get_children(true):
		var found: Window = _window_with(child, window_id)
		if found != null:
			return found
	return null


## Gives every element below [param element] whose id is a node's element that node, and notes
## which nodes UI Automation shows.
##
## UI Automation's runtime id for an element ends in the four halves of AccessKit's id for it, and
## Godot gives AccessKit the element's RID: measured on 4.7.2, /root/Main's element answered
## 114,1,0,0 with RID 114 << 32 | 1. Which pair holds it is not assumed, so both are tried.
static func _match(element: Dictionary, made_by: Dictionary, placing: GdhPlacing) -> void:
	var children: Array = element.get("children", [])
	for child: Variant in children:
		if not child is Dictionary:
			continue
		var inner: Dictionary = child
		var parts: Array = inner.get("element_id", [])
		var _dropped: bool = inner.erase("element_id")
		if parts.size() == 4:
			placing.asked += 1
			var node: Node = _made(parts, made_by)
			if node != null:
				placing.placed += 1
				placing.shown[node.get_instance_id()] = true
				inner["node"] = str(node.get_path())
				inner[NODE_ID] = node.get_instance_id()
				if node is Control:
					var control: Control = node
					if not control.tooltip_text.is_empty():
						inner["tooltip"] = control.tooltip_text
						placing.tooltips += 1
		_match(inner, made_by, placing)


## Gives every element below [param element] that is no node's own the node it is a part of.
##
## UI Automation's parent is not that node: AccessKit leaves every container out of the tree it
## gives UI Automation and hangs what the container held on the nearest element it keeps, and a
## Control, a RichTextLabel and each of its lines are containers. A RichTextLabel's text in a
## column of plain containers came out straight under the window. So the node is found where it
## must be: below the shown element's node, itself left out of the tree (a node that is shown would
## have the part under it), drawn around the part, and, for text, one that holds its words.
static func _attribute(
	element: Dictionary, holder: Node, placing: GdhPlacing, is_window: bool
) -> void:
	var children: Array = element.get("children", [])
	for child: Variant in children:
		if not child is Dictionary:
			continue
		var inner: Dictionary = child
		if inner.has(NODE_ID):
			var node: Node = instance_from_id(GdhRead.as_int(inner[NODE_ID], 0))
			var _dropped: bool = inner.erase(NODE_ID)
			_attribute(inner, node if node != null else holder, placing, false)
			continue
		var owners: Array[Node] = _owners_of(inner, holder, placing)
		if owners.size() == 1:
			inner["part_of"] = str(owners[0].get_path())
		else:
			inner["part_of"] = str(holder.get_path())
			var paths: Array[String] = []
			for owner: Node in owners:
				paths.append(str(owner.get_path()))
			inner["part_of_candidates"] = paths
		# The one text a window makes of itself, where it speaks what is announced: it is given no
		# bounds, where every text a node draws has them.
		var only_holder: bool = owners.size() == 1 and owners[0] == holder
		if is_window and inner.get("role") == "text" and not inner.has("bounds") and only_holder:
			inner["part"] = "announcement"
		_attribute(inner, owners[0] if owners.size() == 1 else holder, placing, false)


## The nodes that may have made [param element], below [param holder]: the deepest ones drawn
## around it whose own elements are not shown, narrowed to those holding its words when that leaves
## any. [param holder] alone when none is drawn around it, or when it has no bounds to look by.
static func _owners_of(element: Dictionary, holder: Node, placing: GdhPlacing) -> Array[Node]:
	var bounds: Variant = element.get("bounds")
	if not bounds is Dictionary:
		return [holder]
	var box: Dictionary = bounds
	var drawn: Rect2 = Rect2(
		GdhRead.as_float(box.get("x", 0)),
		GdhRead.as_float(box.get("y", 0)),
		GdhRead.as_float(box.get("width", 0)),
		GdhRead.as_float(box.get("height", 0))
	)
	var found: Array[Node] = []
	_drawn_around(holder, drawn, placing, found)
	if found.is_empty():
		return [holder]
	# A RichTextLabel's line ends in a zero-width space its text does not have.
	var words: String = str(element.get("name", "")).replace(String.chr(0x200b), "").strip_edges()
	if found.size() > 1 and not words.is_empty():
		var saying: Array[Node] = []
		for node: Node in found:
			if _text_of(node).contains(words):
				saying.append(node)
		if not saying.is_empty():
			return saying
	return found


## Where a Control is drawn is read off its screen transform, which for a window that is not
## embedded is in that window's own pixels, as the bounds are.
static func _drawn_around(
	node: Node, drawn: Rect2, placing: GdhPlacing, found: Array[Node]
) -> void:
	for child: Node in node.get_children(true):
		# A node that is shown has its parts under it, and so do the nodes below it.
		if placing.shown.has(child.get_instance_id()):
			continue
		if child is CanvasItem:
			var item: CanvasItem = child
			if not item.is_visible_in_tree():
				continue
		var before: int = found.size()
		_drawn_around(child, drawn, placing, found)
		if found.size() > before or not child is Control:
			continue
		var control: Control = child
		var around: Rect2 = control.get_screen_transform() * Rect2(Vector2.ZERO, control.size)
		# Two pixels either way, for the rounding of bounds to whole pixels on both sides.
		if around.grow(2.0).encloses(drawn):
			found.append(control)


## Takes the instance ids [method _match] left out of a window no node holds.
static func _unmark(element: Dictionary) -> void:
	var _dropped: bool = element.erase(NODE_ID)
	var children: Array = element.get("children", [])
	for child: Variant in children:
		if child is Dictionary:
			var inner: Dictionary = child
			_unmark(inner)


static func _text_of(node: Node) -> String:
	if node is RichTextLabel:
		var rich: RichTextLabel = node
		return rich.get_parsed_text()
	if "text" in node:
		return str(node.get("text"))
	return ""


static func _made(parts: Array, made_by: Dictionary) -> Node:
	var halves: Array[int] = []
	for part: Variant in parts:
		halves.append(GdhRead.as_int(part, 0) & 0xffffffff)
	for at: int in [0, 2]:
		var id: int = (halves[at] << 32) | halves[at + 1]
		if made_by.has(id):
			return made_by[id]
	return null


## Text elements with bounds and no name. The window's announcement element has no bounds and is
## left out with them: it is empty until something is announced.
static func _unnamed_text(element: Dictionary) -> int:
	var total: int = 0
	if (
		element.get("role") == "text"
		and str(element.get("name", "")).is_empty()
		and element.has("bounds")
	):
		total += 1
	var children: Array = element.get("children", [])
	for child: Variant in children:
		if child is Dictionary:
			var inner: Dictionary = child
			total += _unnamed_text(inner)
	return total


## When a client started at [param began_at] is stopped, in ticks: [constant START_MS] after it
## began while UI Automation is loading ([param loaded_at] -1), and once it was seen loaded at
## [param loaded_at], [constant SETTLE_MS] for each of [param windows] and [constant WALK_SLACK_MS]
## after that.
static func _deadline(began_at: int, loaded_at: int, windows: int) -> int:
	if loaded_at < 0:
		return began_at + START_MS
	return loaded_at + SETTLE_MS * maxi(1, windows) + WALK_SLACK_MS


## The stages [param progress] marks, each with the Unix time in ms it was reached, as an array of
## [stage, ms] in order.
static func _marks(progress: String) -> Array:
	var marks: Array = []
	for line: String in progress.split("\n", false):
		var words: PackedStringArray = line.strip_edges().split(" ", false)
		if words.size() >= 2 and words[words.size() - 1].is_valid_int():
			var stage: String = " ".join(words.slice(0, words.size() - 1))
			marks.append([stage, words[words.size() - 1].to_int()])
	return marks


## How far a client started at [param started_ms] and stopped at [param stopped_ms] got by the marks
## in [param progress], said for a caller whose read it stopped: the time went to starting
## the client, loading its interface, setting up the rest of the client, the walks, after the last
## walk, or writing the answer, and which tells a loaded machine from a window that never answers.
## [param reader] is the system's [method GdhReaders.profile], PowerShell's UI Automation client
## when empty.
static func _reached(
	progress: String, started_ms: int, stopped_ms: int, reader: Dictionary = {}
) -> String:
	var who: String = _starter(reader)
	var system: String = _system(reader)
	var marks: Array = _marks(progress)
	var at: Dictionary = {}
	var walks: int = 0
	var last: String = ""
	var last_at: int = 0
	for mark: Array in marks:
		var stage: String = mark[0]
		if stage.begins_with("walked "):
			walks += 1
			last = stage.trim_prefix("walked ")
			last_at = mark[1]
		elif not at.has(stage):
			at[stage] = mark[1]
	if not at.has("began"):
		return "%s had not begun the client" % who
	var began: int = at["began"] - started_ms
	if not at.has("loaded") and not at.has("assemblies"):
		return "%s began the client after %d ms and was still loading %s" % [who, began, system]
	if not at.has("loaded"):
		return (
			(
				"%s began the client after %d ms and loaded %s's assemblies in "
				+ "%d ms, and was still setting up the description reader and the JSON serialiser"
			)
			% [who, began, system, at["assemblies"] - at["began"]]
		)
	var loaded: int = at["loaded"] - at["began"]
	if walks == 0:
		return (
			(
				"%s began the client after %d ms and loaded %s in %d ms, and the"
				+ " first walk of the windows had not ended"
			)
			% [who, began, system, loaded]
		)
	var walked: String = (
		(
			"%s began the client after %d ms and loaded %s in %d ms, and the "
			+ "windows were walked %d time%s, the last finding %s element%s and ending %d ms "
			+ "before the client was stopped"
		)
		% [
			who,
			began,
			system,
			loaded,
			walks,
			"" if walks == 1 else "s",
			last,
			"" if last == "1" else "s",
			stopped_ms - last_at,
		]
	)
	if not at.has("answering"):
		return walked
	var answering: int = stopped_ms - at["answering"]
	return walked + ", which had been writing the answer for %d ms" % answering


## Where the time of a client started at [param started_ms] and done at [param done_ms] went, by
## the marks in [param progress]: starting PowerShell, loading UI Automation, and walking the
## windows. Empty when the client marked nothing.
static func _took(progress: String, started_ms: int, done_ms: int) -> Dictionary:
	var at: Dictionary = {}
	for mark: Array in _marks(progress):
		var stage: String = mark[0]
		if not at.has(stage):
			at[stage] = mark[1]
	if not at.has("began") or not at.has("loaded"):
		return {}
	return {
		"start": at["began"] - started_ms,
		"load": at["loaded"] - at["began"],
		"walk": done_ms - at["loaded"],
	}


static func _refused(message: String) -> Dictionary:
	return { "type": "error", "message": message }


## Counts kept while the elements are placed, and the nodes whose own elements UI Automation shows,
## by instance id.
class GdhPlacing:
	extends RefCounted
	var asked: int = 0
	var placed: int = 0
	var tooltips: int = 0
	var shown: Dictionary = {}
