extends RefCounted

## What the running game tells a screen reader: its accessibility tree, as UI Automation reads it.
##
## The engine builds the tree only when something asks for it, and nothing on gdharness's desktop
## does, so a game's NOTIFICATION_ACCESSIBILITY_UPDATE never came and what its controls expose could
## not be checked. The engine offers no way to read the tree back, so the question is put the way a
## screen reader puts it: a UI Automation client started by the game lands on the game's own desktop,
## its first question makes the engine build the tree, and what it reads is what a screen reader is
## told, names left empty included.

const Read = preload("reading.gd")

## How long the client keeps walking the tree for it to settle: the engine answers the first question
## with its windows alone and fills them in over the next frames.
const SETTLE_MS: int = 8000
## How long a window with nothing in it is walked before the client stops: a game building its tree
## fills the window within a few frames of being asked, and one building none never does.
const EMPTY_MS: int = 4000
## How long the client may take beyond that, starting PowerShell and loading UI Automation included,
## before it is stopped and the call answers that it did not finish.
const START_MS: int = 15000
## Deep enough for any interface a game builds, and inside the hundred levels ConvertTo-Json stops
## at, which are two to a level of the tree.
const MOST_LEVELS: int = 40

## The client, as PowerShell, with $Handles, $Out, $SettleMs, $EmptyMs and $MostLevels set before it. Each
## element answers what UI Automation names its role, its name, its value where it has one, its
## bounds in the window's pixels, and the actions a screen reader is offered on it.
const WALK: String = r"""
$ErrorActionPreference = 'Stop'
function Answer($value) {
  [System.IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject $value -Depth 100 -Compress))
}
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  function Patterned($element, $name) {
    $pattern = ("System.Windows.Automation.$($name)Pattern" -as [type])::Pattern
    $found = $null
    if ($element.TryGetCurrentPattern($pattern, [ref]$found)) { return $found }
    return $null
  }
  function Describe($element, $ox, $oy, $depth) {
    $c = $element.Current
    $role = $c.ControlType.ProgrammaticName -replace '^ControlType[.]', ''
    $role = ($role -creplace '(?<=[a-z])(?=[A-Z])', '_').ToLowerInvariant()
    $node = [ordered]@{ role = $role; name = $c.Name }
    if ($c.HelpText) { $node.description = $c.HelpText }
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
    $r = $root.Current.BoundingRectangle
    $deadline = [DateTime]::UtcNow.AddMilliseconds($SettleMs)
    $empty = [DateTime]::UtcNow.AddMilliseconds($EmptyMs)
    $tree = Describe $root $r.X $r.Y 0
    $last = Count $tree
    # Walked again until two walks in a row agree, since the first question is what makes the
    # engine build the tree, which arrives over the frames after it.
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 150
      $tree = Describe $root $r.X $r.Y 0
      $count = Count $tree
      if ($count -gt 1 -and $count -eq $last) { break }
      if ($count -eq 1 -and [DateTime]::UtcNow -gt $empty) { break }
      $last = $count
    }
    $windows += , $tree
  }
  Answer @{ windows = $windows }
} catch {
  Answer @{ error = "$_" }
}
"""

var _host: Node


func _init(host: Node) -> void:
	_host = host


## The game's windows as a screen reader is told them, each a tree of elements.
func get_accessibility(_params: Dictionary) -> Dictionary:
	if DisplayServer.get_name() == "headless":
		return _refused(
			(
				"A headless run has no window, so a screen reader is told nothing: start the run with"
				+ " headless: false."
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
	var script: String = (
		(
			"$Handles = @(%s)\n$Out = '%s'\n$SettleMs = %d\n$EmptyMs = %d\n$MostLevels = %d\n"
			% [", ".join(handles), out.replace("'", "''"), SETTLE_MS, EMPTY_MS, MOST_LEVELS]
		)
		+ WALK
	)
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
	var deadline: int = Time.get_ticks_msec() + SETTLE_MS + START_MS
	while OS.is_process_running(pid):
		if Time.get_ticks_msec() > deadline:
			var _killed: Error = OS.kill(pid)
			return _refused(
				"UI Automation had not read the tree after %d ms, so it was stopped" % (SETTLE_MS + START_MS)
			)
		await _host.get_tree().process_frame

	var text: String = FileAccess.get_file_as_string(out)
	# Not checked: a file that is not there was never written, which the answer below says.
	var _removed: Error = DirAccess.remove_absolute(out)
	var read: Variant = Read.json_or_null(text)
	if not read is Dictionary:
		return _refused("UI Automation answered nothing readable: %s" % text.left(500))
	var answer: Dictionary = read
	if answer.has("error"):
		return _refused("UI Automation could not read the game's windows: %s" % str(answer["error"]))

	var windows: Array = answer.get("windows", [])
	var elements: int = 0
	var unnamed: int = 0
	for at: int in windows.size():
		var window: Dictionary = windows[at]
		window["window_id"] = ids[at] if at < ids.size() else -1
		elements += _count(window)
		unnamed += _unnamed_text(window)
	var result: Dictionary = {"windows": windows, "elements": elements}
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
	return result


## The project's accessibility mode, as the command line's --accessibility names them.
static func _setting() -> String:
	match Read.as_int(ProjectSettings.get_setting("accessibility/general/accessibility_support", 0), 0):
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


## Text elements with bounds and no name. A window also holds a nameless text element with no bounds
## that no node of the game made, in every scene tried, which is left out.
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


static func _refused(message: String) -> Dictionary:
	return {"type": "error", "message": message}
