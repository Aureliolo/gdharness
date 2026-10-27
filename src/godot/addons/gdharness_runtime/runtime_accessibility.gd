extends RefCounted

## What the running game tells a screen reader: its accessibility tree, as UI Automation reads it.
##
## The engine builds the tree only when something asks for it, and nothing on gdharness's desktop
## does, so a game's NOTIFICATION_ACCESSIBILITY_UPDATE never came and what its controls expose could
## not be checked. The engine offers no way to read the tree back, so the question is put the way a
## screen reader puts it: a UI Automation client started by the game lands on the game's own desktop,
## its first question makes the engine build the tree, and what it reads is what a screen reader is
## told, names left empty included.

const GdhRead = preload("reading.gd")
const GdhSays = preload("runtime_says.gd")

## How long the client keeps walking the tree for it to settle: the engine answers the first question
## with its windows alone and fills them in over the next frames.
const SETTLE_MS: int = 8000
## How long a window with nothing in it is walked before the client stops: a game building its tree
## fills the window within a few frames of being asked, and one building none never does.
const EMPTY_MS: int = 4000
## How long starting PowerShell and loading UI Automation may take before the client is stopped. It
## waits on the machine alone: a warm start takes under a second, and a cold one on a loaded Windows
## runner took the whole of a single 23 s budget meant for the walk as well.
const START_MS: int = 45000
## How long the walks may take beyond [constant SETTLE_MS] a window once UI Automation is loaded,
## kept short since a walk that overruns is a window that does not answer.
const WALK_SLACK_MS: int = 7000
## How often the progress file is read while the client runs.
const LOOK_MS: int = 250
## Deep enough for any interface a game builds, and inside the hundred levels ConvertTo-Json stops
## at, which are two to a level of the tree.
const MOST_LEVELS: int = 40
## Where an element holds its node's instance id between matching and placing, removed before the
## answer goes.
const NODE_ID: String = "_node_instance"

## The client, as PowerShell, with $Handles, $Out, $Progress, $SettleMs, $EmptyMs and $MostLevels
## set before it. Each element answers what UI Automation names its role, its name, its value where it
## has one, its bounds in the window's pixels, and the actions a screen reader is offered on it. Each
## stage it reaches is marked in $Progress as it is reached, with the time, so a client stopped at the
## deadline still says how far it got.
const WALK: String = r"""
$ErrorActionPreference = 'Stop'
function Answer($value) {
  [System.IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject $value -Depth 100 -Compress))
}
function Mark($stage) {
  [System.IO.File]::AppendAllText($Progress, "$stage $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())`n")
}
try {
  Mark 'began'
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Mark 'loaded'
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  function Patterned($element, $name) {
    $pattern = ("System.Windows.Automation.$($name)Pattern" -as [type])::Pattern
    $found = $null
    if ($element.TryGetCurrentPattern($pattern, [ref]$found)) { return $found }
    return $null
  }
  # FullDescription is where the description is put, and the managed client refuses every property
  # newer than itself, so it is asked through the core call the client makes for the rest.
  $script:unread = $null
  try {
    $client = [System.Windows.Automation.AutomationElement]
    $core = $client.Assembly.GetType('MS.Internal.Automation.UiaCoreApi')
    $ask = $core.GetMethod('UiaGetPropertyValue', [System.Reflection.BindingFlags]'NonPublic,Public,Static')
    $nodeField = $client.GetField('_hnode', [System.Reflection.BindingFlags]'NonPublic,Instance')
    if ($null -eq $ask -or $null -eq $nodeField) {
      $script:unread = 'this Windows has no UiaGetPropertyValue to ask it through'
    }
  } catch {
    $script:unread = "$_"
  }
  function FullDescription($element) {
    if ($null -ne $script:unread) { return '' }
    try {
      $asked = @($nodeField.GetValue($element), [int]30159, $null)
      $null = $ask.Invoke($null, $asked)
      if ($asked[2] -is [string]) { return $asked[2] }
    } catch {
      $script:unread = "$_"
    }
    return ''
  }
  function Describe($element, $ox, $oy, $depth) {
    $c = $element.Current
    $role = $c.ControlType.ProgrammaticName -replace '^ControlType[.]', ''
    $role = ($role -creplace '(?<=[a-z])(?=[A-Z])', '_').ToLowerInvariant()
    $node = [ordered]@{ role = $role; name = $c.Name }
    $description = FullDescription $element
    if ($description) { $node.description = $description }
    if ($c.HelpText) { $node.placeholder = $c.HelpText }
    # The element's own id, the last four parts of its runtime id, which the game reads back as the
    # node that made it.
    $runtime = $element.GetRuntimeId()
    if ($null -ne $runtime -and $runtime.Length -ge 4) {
      $node.element_id = @($runtime[-4], $runtime[-3], $runtime[-2], $runtime[-1])
    }
    $r = $c.BoundingRectangle
    if (-not $r.IsEmpty) {
      $node.bounds = [ordered]@{ x = [int]($r.X - $ox); y = [int]($r.Y - $oy) }
      $node.bounds.width = [int]$r.Width
      $node.bounds.height = [int]$r.Height
    }
    $actions = @()
    if (Patterned $element 'Invoke') { $actions += 'click' }
    $p = Patterned $element 'Toggle'
    if ($p) { $actions += 'toggle'; $node.toggled = "$($p.Current.ToggleState)".ToLowerInvariant() }
    $p = Patterned $element 'ExpandCollapse'
    if ($p) {
      $actions += 'expand_collapse'
      $node.expanded = "$($p.Current.ExpandCollapseState)".ToLowerInvariant()
    }
    $p = Patterned $element 'SelectionItem'
    if ($p) { $actions += 'select'; $node.selected = $p.Current.IsSelected }
    $p = Patterned $element 'Value'
    if ($p) {
      $node.value = $p.Current.Value
      if (-not $p.Current.IsReadOnly) { $actions += 'set_value' }
    }
    $p = Patterned $element 'RangeValue'
    if ($p) {
      # A reader speaks the Value pattern's words, such as "75%" for a slider whose game sets them,
      # and the number would otherwise replace them.
      if ($node.Contains('value') -and "$($node.value)") { $node.value_text = $node.value }
      $node.value = $p.Current.Value
      $node.range = @($p.Current.Minimum, $p.Current.Maximum)
      if (-not $p.Current.IsReadOnly) { $actions += 'set_value' }
    }
    if (Patterned $element 'ScrollItem') { $actions += 'scroll_into_view' }
    if ($c.IsKeyboardFocusable) { $actions += 'focus' }
    $node.actions = $actions
    if ($c.HasKeyboardFocus) { $node.focused = $true }
    if (-not $c.IsEnabled) { $node.disabled = $true }
    if ($c.IsOffscreen) { $node.offscreen = $true }
    $children = @()
    if ($depth -lt $MostLevels) {
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child) {
        $children += , (Describe $child $ox $oy ($depth + 1))
        $child = $walker.GetNextSibling($child)
      }
    }
    $node.children = $children
    return $node
  }
  function Count($node) {
    $n = 1
    foreach ($child in $node.children) { $n += Count $child }
    return $n
  }
  $windows = @()
  foreach ($handle in $Handles) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$handle)
    $deadline = [DateTime]::UtcNow.AddMilliseconds($SettleMs)
    $empty = [DateTime]::UtcNow.AddMilliseconds($EmptyMs)
    # The window's corner is read on every walk: before the engine builds its tree the window is
    # its frame, and after it the client area inside it, so a corner read once placed everything
    # by the frame's.
    $r = $root.Current.BoundingRectangle
    $tree = Describe $root $r.X $r.Y 0
    $last = Count $tree
    Mark "walked $last"
    # Walked again until two walks in a row agree, since the first question is what makes the
    # engine build the tree, which arrives over the frames after it.
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 150
      $r = $root.Current.BoundingRectangle
      $tree = Describe $root $r.X $r.Y 0
      $count = Count $tree
      Mark "walked $count"
      if ($count -gt 1 -and $count -eq $last) { break }
      if ($count -eq 1 -and [DateTime]::UtcNow -gt $empty) { break }
      $last = $count
    }
    $windows += , $tree
  }
  $answer = @{ windows = $windows }
  if ($null -ne $script:unread) { $answer.description_unread = $script:unread }
  Answer $answer
} catch {
  Answer @{ error = "$_" }
}
"""

var _host: Node


func _init(host: Node) -> void:
	_host = host


## The game's windows as a screen reader is told them, each a tree of elements.
func get_accessibility(params: Dictionary) -> Dictionary:
	if DisplayServer.get_name() == "headless":
		# Both needs at once: told only the window, a caller started a windowed run and was then
		# refused for the tree the engine had not been asked to build.
		var also: String = ""
		if _setting() != "always":
			also = (
				(
					' and engineArgs ["--accessibility", "always"], since this project\'s'
					+ " accessibility/general/accessibility_support is %s and the engine builds the tree"
					+ " only when asked"
				)
				% _setting()
			)
		return _refused(
			(
				(
					"A headless run has no window, so a screen reader is told nothing: start the run with"
					+ " headless: false%s."
				)
				% also
			)
		)
	if OS.get_name() != "Windows":
		return _refused(
			(
				(
					"The tree is read through UI Automation, the interface a Windows screen reader uses, and this"
					+ " game runs on %s, whose screen readers ask it through another"
				)
				% OS.get_name()
			)
		)
	var handles: Array[String] = []
	var ids: Array[int] = []
	for id: int in DisplayServer.get_window_list():
		var handle: int = DisplayServer.window_get_native_handle(DisplayServer.WINDOW_HANDLE, id)
		if handle != 0:
			handles.append(str(handle))
			ids.append(id)

	var out: String = OS.get_temp_dir().path_join(
		"gdharness-accessibility-%d-%d.json" % [OS.get_process_id(), Time.get_ticks_usec()]
	)
	var progress: String = out + ".progress"
	var script: String = (
		(
			"$Handles = @(%s)\n$Out = '%s'\n$Progress = '%s'\n$SettleMs = %d\n$EmptyMs = %d\n$MostLevels = %d\n"
			% [
				", ".join(handles),
				out.replace("'", "''"),
				progress.replace("'", "''"),
				SETTLE_MS,
				EMPTY_MS,
				MOST_LEVELS,
			]
		)
		+ WALK
	)
	var started_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
	# The system's own PowerShell by its path, so a powershell.exe earlier on PATH is not what runs.
	var shell: String = OS.get_environment("SystemRoot").path_join(
		"System32/WindowsPowerShell/v1.0/powershell.exe"
	)
	var pid: int = (
		OS
		. create_process(
			shell,
			[
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Marshalls.raw_to_base64(script.to_utf16_buffer()),
			]
		)
	)
	if pid <= 0:
		return _refused("PowerShell could not be started from %s to read the tree" % shell)
	# Waited out a frame at a time rather than blocking: the client's questions are answered on the
	# game's main thread, which a blocking wait would hold, and neither side would move.
	# Two budgets, so a slow start is never charged to the walk: one for PowerShell to begin and load
	# UI Automation, and once it has, one for the walks.
	var began_at: int = Time.get_ticks_msec()
	var deadline: int = _deadline(began_at, -1, handles.size())
	var walking: bool = false
	var looked_at: int = began_at
	while OS.is_process_running(pid):
		var now: int = Time.get_ticks_msec()
		if not walking and now - looked_at >= LOOK_MS:
			looked_at = now
			if FileAccess.get_file_as_string(progress).contains("loaded "):
				walking = true
				deadline = _deadline(began_at, now, handles.size())
		if now > deadline:
			var _killed: Error = OS.kill(pid)
			var reached: String = _reached(FileAccess.get_file_as_string(progress), started_ms)
			var _gone: Error = DirAccess.remove_absolute(progress)
			return _refused(
				(
					"UI Automation had not read the tree after %d ms, so it was stopped: %s"
					% [now - began_at, reached]
				)
			)
		await _host.get_tree().process_frame

	var text: String = FileAccess.get_file_as_string(out)
	var took: Dictionary = _took(
		FileAccess.get_file_as_string(progress), started_ms, int(Time.get_unix_time_from_system() * 1000.0)
	)
	# Not checked: a file that is not there was never written, which the answer below says.
	var _removed: Error = DirAccess.remove_absolute(out)
	var _progress_removed: Error = DirAccess.remove_absolute(progress)
	var read: Variant = GdhRead.json_or_null(text)
	if not read is Dictionary:
		return _refused("UI Automation answered nothing readable: %s" % text.left(500))
	var answer: Dictionary = read
	if answer.has("error"):
		return _refused("UI Automation could not read the game's windows: %s" % str(answer["error"]))

	var windows: Array = answer.get("windows", [])
	var made_by: Dictionary = {}
	_note_elements(_host.get_tree().root, made_by)
	var placing: GdhPlacing = GdhPlacing.new()
	var elements: int = 0
	var unnamed: int = 0
	for at: int in windows.size():
		var window: Dictionary = windows[at]
		var window_id: int = ids[at] if at < ids.size() else -1
		window["window_id"] = window_id
		_match(window, made_by, placing)
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
	var result: Dictionary = {"windows": windows, "elements": elements}
	if not took.is_empty():
		result["tookMsBy"] = took
	if placing.tooltips > 0:
		result["tooltip_note"] = (
			"tooltip is the node's tooltip_text, which the engine puts in the tree, and UI Automation, as"
			+ " AccessKit fills it in, has no property that carries it (measured on 4.7.2), so a screen"
			+ " reader on Windows is not told it. Say what a reader needs in accessibility_description."
		)
	if placing.asked > 0 and placing.placed == 0:
		# Nothing at all matched: the element ids are not the engine's element RIDs any more, which
		# an AccessKit that numbers its elements another way would do, and every node would read null.
		result["node_note"] = (
			"No element could be matched to the node that made it: UI Automation's runtime ids did not"
			+ " carry the engine's element ids, so node and part_of are the windows' alone."
		)
	if answer.has("description_unread"):
		result["description_note"] = (
			"Descriptions could not be read, so none is shown: %s" % str(answer["description_unread"])
		)
	if elements <= windows.size():
		var setting: String = _setting()
		# The command line's --accessibility is consumed by the engine and not handed on, so only
		# the setting and a screen reader can say the tree is built; otherwise an empty window is
		# most likely a game that builds none.
		# 1 is a screen reader running, 0 none and -1 a platform that cannot say.
		var read_aloud: bool = setting == "auto" and DisplayServer.accessibility_screen_reader_active() == 1
		if setting != "always" and not read_aloud:
			return _refused(
				(
					(
						"UI Automation found nothing in the game's windows: the engine builds the tree a screen"
						+ " reader reads only with accessibility/general/accessibility_support at Always Active,"
						+ " or at Auto with a screen reader running when it starts, and this project's is %s."
						+ ' Start the run with engineArgs ["--accessibility", "always"].'
					)
					% setting
				)
			)
		result["_note"] = (
			"The windows hold nothing a screen reader is told: Controls are in the tree, and Node2D and"
			+ " Node3D are not unless the game creates elements for them."
		)
	elif unnamed > 0:
		# Seen on a game naming its lines with accessibility_update_set_name: the text was there in
		# the game and empty to the screen reader.
		result["_note"] = (
			(
				"%d text element(s) on screen have no name, so a screen reader reads them as nothing. Static"
				+ " text is read from its value, DisplayServer.accessibility_update_set_value, and a name"
				+ " set on it is not read."
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
	match GdhRead.as_int(ProjectSettings.get_setting("accessibility/general/accessibility_support", 0), 0):
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
## have the part under it), drawn around the part, and, for text, holding its words.
static func _attribute(element: Dictionary, holder: Node, placing: GdhPlacing, is_window: bool) -> void:
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
static func _drawn_around(node: Node, drawn: Rect2, placing: GdhPlacing, found: Array[Node]) -> void:
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
		halves.append(GdhRead.as_int(part, 0) & 0xFFFFFFFF)
	for at: int in [0, 2]:
		var id: int = (halves[at] << 32) | halves[at + 1]
		if made_by.has(id):
			return made_by[id]
	return null


## Counts kept while the elements are placed, and the nodes whose own elements UI Automation shows,
## by instance id.
class GdhPlacing:
	extends RefCounted
	var asked: int = 0
	var placed: int = 0
	var tooltips: int = 0
	var shown: Dictionary = {}


## Text elements with bounds and no name. The window's announcement element has no bounds and is
## left out with them: it is empty until something is announced.
static func _unnamed_text(element: Dictionary) -> int:
	var total: int = 0
	if element.get("role") == "text" and str(element.get("name", "")).is_empty() and element.has("bounds"):
		total += 1
	var children: Array = element.get("children", [])
	for child: Variant in children:
		if child is Dictionary:
			var inner: Dictionary = child
			total += _unnamed_text(inner)
	return total


## When a client started at [param began_at] is stopped, in ticks: [constant START_MS] after it began
## while UI Automation is loading ([param loaded_at] -1), and once it was seen loaded at
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


## How far a client started at [param started_ms] got by the marks in [param progress], said for a
## caller whose read it stopped: the time went to starting PowerShell, loading UI Automation, or the
## walks, and which tells a loaded machine from a window that never answers.
static func _reached(progress: String, started_ms: int) -> String:
	var marks: Array = _marks(progress)
	var at: Dictionary = {}
	var walks: int = 0
	var last: String = ""
	for mark: Array in marks:
		var stage: String = mark[0]
		if stage.begins_with("walked "):
			walks += 1
			last = stage.trim_prefix("walked ")
		elif not at.has(stage):
			at[stage] = mark[1]
	if not at.has("began"):
		return "PowerShell had not begun the client"
	var began: int = at["began"] - started_ms
	if not at.has("loaded"):
		return "PowerShell began the client after %d ms and was still loading UI Automation" % began
	var loaded: int = at["loaded"] - at["began"]
	if walks == 0:
		return (
			(
				"PowerShell began the client after %d ms and loaded UI Automation in %d ms, and the"
				+ " first walk of the windows had not ended"
			)
			% [began, loaded]
		)
	return (
		(
			"PowerShell began the client after %d ms and loaded UI Automation in %d ms, and the windows"
			+ " were walked %d time%s, the last finding %s element%s"
		)
		% [began, loaded, walks, "" if walks == 1 else "s", last, "" if last == "1" else "s"]
	)


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
	return {"type": "error", "message": message}
