extends RefCounted

## The hover Godot gives the controls under the pointer, supplied in a native window the operating
## system has not said the pointer entered.
##
## With display/window/subwindows/embed_subwindows off, every window is a native one, and the engine
## hovers a control in one only once the window has had its mouse-enter: Viewport::_update_mouse_over
## asks the root which window the pointer is over, and only Window::_event_callback, called by the
## platform when the pointer crosses into the window, sets it. An injected event never crosses
## anything, and on gdharness's own desktop no pointer ever enters a window, so nothing was hovered.
## A BaseButton takes a mouse press only while hovered, so every click on a button in such a window
## was dropped while the press itself was routed to it. Reported from Tall Tales Inn, whose strip
## window holds its first-run question, and traced through Godot 4.7.2's source.
##
## What is supplied is what the engine does once the window has been entered: the control its own
## search finds under the point, MOUSE_ENTER and mouse_entered on it and on each holder the pointer
## passes to, MOUSE_ENTER_SELF on it, and the exits in the engine's order when the pointer moves on.
## The engine's own record of the hover is not reachable from a script, so
## Viewport.gui_get_hovered_control() still answers null there; [method hovered_in] answers for both.

## Per viewport, by instance id, the instance ids of the controls the supplied hover is on, outermost
## first, ending with the one under the pointer, as the engine keeps its own.
var _supplied: Dictionary[int, Array] = {}

## The windows whose mouse-enter and mouse-exit are listened for, and whether the platform has said
## the pointer is inside each: once it has, the engine hovers there by itself.
var _listened: Dictionary[int, bool] = {}
var _inside: Dictionary[int, bool] = {}

## Whether a script on a control declares `_has_point`, per script, since the search asks it of
## every control it passes.
var _shapes: Dictionary[Script, bool] = {}


## Whether the engine cannot hover anything in [param window]: a native window, with the root not
## embedding windows, that the platform has not said the pointer is in.
func cannot_hover(window: Window) -> bool:
	if window.is_embedded() or window.get_tree().root.gui_embed_subwindows:
		return false
	_listen(window)
	return not _inside.get(window.get_instance_id(), false)


## Hovers what is under [param point], in [param viewport]'s own coordinates, when the engine could
## not; answers whether it did. Where the engine hovers by itself, any hover supplied before is
## taken down first, so a control is never entered twice.
func follow(viewport: Viewport, point: Vector2) -> bool:
	var window: Window = viewport as Window
	if window == null:
		return false
	if not cannot_hover(window) or window.gui_get_hovered_control() != null:
		_drop(window, 0)
		return false
	_hover(window, point)
	return _supplied.has(window.get_instance_id())


## The control hovered in [param viewport], by the engine or by this.
func hovered_in(viewport: Viewport) -> Control:
	var own: Control = viewport.gui_get_hovered_control()
	if own != null:
		return own
	var held: Array = _supplied.get(viewport.get_instance_id(), [])
	if held.is_empty():
		return null
	var top: int = held.back()
	return instance_from_id(top) as Control


## Whether the hover in [param viewport] is one this supplied.
func supplied_in(viewport: Viewport) -> bool:
	return viewport.gui_get_hovered_control() == null and _supplied.has(viewport.get_instance_id())


func _listen(window: Window) -> void:
	var id: int = window.get_instance_id()
	if _listened.has(id):
		return
	_listened[id] = true
	var _entering: int = window.mouse_entered.connect(_entered.bind(window))
	var _leaving: int = window.mouse_exited.connect(_left.bind(window))


func _entered(window: Window) -> void:
	_inside[window.get_instance_id()] = true
	_drop(window, 0)


func _left(window: Window) -> void:
	_inside[window.get_instance_id()] = false


## Viewport::_update_mouse_over for [param point]: the control under it entered, from the outermost
## holder not already entered, and what is no longer under it left. Into what a SubViewportContainer
## under it shows as well, as the engine carries the pointer there.
func _hover(viewport: Viewport, point: Vector2) -> void:
	var over: Control = control_at(viewport, point)
	var id: int = viewport.get_instance_id()
	var held: Array = _supplied.get(id, [])
	var was: int = 0
	if not held.is_empty():
		was = held.back()
	var now: int = 0
	if over != null:
		now = over.get_instance_id()
	if now != was:
		var common: int = 0
		var entering: Array[int] = []
		var walk: CanvasItem = over
		while walk != null:
			var control: Control = walk as Control
			if control != null:
				var filter: Control.MouseFilter = control.get_mouse_filter_with_override()
				if filter != Control.MOUSE_FILTER_IGNORE:
					if held.has(control.get_instance_id()):
						common = control.get_instance_id()
						break
					entering.append(control.get_instance_id())
				if filter == Control.MOUSE_FILTER_STOP:
					break
			if walk.top_level:
				break
			walk = _parent_item(walk)
		_drop(viewport, common)
		if over != null:
			var kept: Array = _supplied.get(id, [])
			for index: int in range(entering.size() - 1, -1, -1):
				var control: Control = instance_from_id(entering[index]) as Control
				if control != null:
					kept.append(entering[index])
					control.notification(Control.NOTIFICATION_MOUSE_ENTER)
					control.mouse_entered.emit()
			_supplied[id] = kept
			over.notification(Control.NOTIFICATION_MOUSE_ENTER_SELF)
	var container: SubViewportContainer = over as SubViewportContainer
	if container == null:
		return
	var inside: Vector2 = container.get_global_transform_with_canvas().affine_inverse() * point
	if container.stretch:
		inside /= container.stretch_shrink
	for child: Node in container.get_children():
		var shown: SubViewport = child as SubViewport
		if shown != null and not shown.gui_disable_input:
			_hover(shown, shown.get_final_transform().affine_inverse() * inside)


## Viewport::_drop_mouse_over: the hovered control left, then each holder down to and not including
## the one whose id is [param until], innermost first. What a SubViewportContainer left showed is
## left too.
func _drop(viewport: Viewport, until: int) -> void:
	var id: int = viewport.get_instance_id()
	var held: Array = _supplied.get(id, [])
	if held.is_empty():
		var _had: bool = _supplied.erase(id)
		return
	var top: int = held.back()
	var over: Control = instance_from_id(top) as Control
	var container: SubViewportContainer = over as SubViewportContainer
	if container != null:
		for child: Node in container.get_children():
			var shown: SubViewport = child as SubViewport
			if shown != null:
				_drop(shown, 0)
	if over != null and over.is_inside_tree():
		over.notification(Control.NOTIFICATION_MOUSE_EXIT_SELF)
	var stop: int = held.find(until) + 1 if until != 0 else 0
	for index: int in range(held.size() - 1, stop - 1, -1):
		var leaving: int = held[index]
		var control: Control = instance_from_id(leaving) as Control
		if control != null and control.is_inside_tree():
			control.notification(Control.NOTIFICATION_MOUSE_EXIT)
			control.mouse_exited.emit()
	var _sized: int = held.resize(stop)
	if held.is_empty():
		var _had: bool = _supplied.erase(id)
	else:
		_supplied[id] = held


## Viewport::gui_find_control: the control a pointer at [param point] in [param viewport] is over,
## searching the controls that hold no other control's place from the one drawn last.
##
## Where the engine asks a control's own has_point, a script's `_has_point` is asked and every other
## control is its rect: TextureButton's click mask, GraphEdit, GraphFrame and FoldableContainer
## answer it in C++ that a script cannot call, so for those this answers the rect they sit in.
func control_at(viewport: Viewport, point: Vector2) -> Control:
	var roots: Array[Control] = []
	_gather_roots(viewport, roots)
	roots.sort_custom(_drawn_before)
	for index: int in range(roots.size() - 1, -1, -1):
		var root: Control = roots[index]
		if not root.is_visible_in_tree():
			continue
		var holder: CanvasItem = _parent_item(root)
		var transform: Transform2D = (
			holder.get_global_transform_with_canvas() if holder != null else root.get_canvas_transform()
		)
		var found: Control = _at(root, point, transform)
		if found != null:
			return found
	return null


## The controls [param node] holds that the engine keeps as roots of [param node]'s viewport: drawn
## on their own, or with no control above them. Not into another viewport, a window or a
## SubViewport, whose controls are that one's.
static func _gather_roots(node: Node, roots: Array[Control]) -> void:
	for child: Node in node.get_children():
		if child is Viewport:
			continue
		var control: Control = child as Control
		if control != null and _is_root(control):
			roots.append(control)
		_gather_roots(child, roots)


static func _is_root(control: Control) -> bool:
	var walk: CanvasItem = control
	while not walk.top_level:
		var parent: CanvasItem = walk.get_parent() as CanvasItem
		if parent == null:
			return true
		if parent is Control:
			return false
		walk = parent
	return true


## Control::CComparator: by canvas layer, then in tree order.
static func _drawn_before(first: Control, second: Control) -> bool:
	var first_layer: int = _layer_of(first)
	var second_layer: int = _layer_of(second)
	if first_layer == second_layer:
		return second.is_greater_than(first)
	return first_layer < second_layer


static func _layer_of(item: CanvasItem) -> int:
	var layer: CanvasLayer = item.get_canvas_layer_node()
	return layer.layer if layer != null else 0


## CanvasItem::get_parent_item, which a script cannot call.
static func _parent_item(item: CanvasItem) -> CanvasItem:
	if item.top_level:
		return null
	return item.get_parent() as CanvasItem


## Viewport::_gui_find_control_at_pos.
func _at(item: CanvasItem, point: Vector2, holder: Transform2D) -> Control:
	if not item.visible:
		return null
	var matrix: Transform2D = holder * item.get_transform()
	if matrix.determinant() == 0.0:
		return null
	var control: Control = item as Control
	var local: Vector2 = matrix.affine_inverse() * point
	if control == null or not control.is_clipping_contents() or _has_point(control, local):
		for index: int in range(item.get_child_count() - 1, -1, -1):
			var child: CanvasItem = item.get_child(index) as CanvasItem
			if child == null or child.top_level:
				continue
			var found: Control = _at(child, point, matrix)
			if found != null:
				return found
	if control == null or control.get_mouse_filter_with_override() == Control.MOUSE_FILTER_IGNORE:
		return null
	if not _has_point(control, local):
		return null
	return control


func _has_point(control: Control, local: Vector2) -> bool:
	var attached: Variant = control.get_script()
	if attached is Script:
		var script: Script = attached
		if not _shapes.has(script):
			_shapes[script] = script.get_script_method_list().any(
				func(method: Dictionary) -> bool: return method["name"] == "_has_point"
			)
		if _shapes[script]:
			var inside: bool = control.call("_has_point", local)
			return inside
	return Rect2(Vector2.ZERO, control.size).has_point(local)
