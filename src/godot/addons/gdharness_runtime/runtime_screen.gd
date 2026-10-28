extends RefCounted
## Where a point in some viewport is on the game's own screen, for a click to be sent there and for
## an answer to say where something is drawn.

const GdhHover = preload("runtime_hover.gd")


## The viewport a pointer at [param point], in [param viewport]'s own coordinates, arrives through,
## and where it is there: {"viewport", "point"}.
##
## A real pointer arrives at the outermost viewport showing this one and is handed down, so that is
## where a click is sent. An embedded [Window], a ConfirmationDialog for one, is drawn inside its
## parent under `gui_embed_subwindows`: pushing into its own viewport delivered nothing, measured,
## with the pointer reading as over no control at all. A [SubViewport] shown by a
## [SubViewportContainer] is drawn inside the container, scaled by its shrink when it stretches, and
## pushing into it read the point as the container's: the click on a dropdown inside one landed on
## nothing. Walked rather than stepped once, because a dialog can open a dialog and a container can
## sit inside another viewport. A SubViewport drawn some other way, onto a mesh for one, has no
## place on the screen to carry the point to, and the point stays in it.
static func reach(viewport: Viewport, point: Vector2) -> Dictionary:
	var out: Array[Dictionary] = steps_out(viewport, point)
	return out.back()


## Every viewport a pointer at [param point] in [param viewport] passes through on the way out to
## the one it arrives at, innermost first, as {"viewport", "point", "through"}: the point in that
## viewport's space, and the embedded [Window] or the [SubViewportContainer] in it that shows the
## step before, null for the first. What [method reach] answers is the last of them.
static func steps_out(viewport: Viewport, point: Vector2) -> Array[Dictionary]:
	var out: Array[Dictionary] = [{ "viewport": viewport, "point": point, "through": null }]
	while true:
		var window: Window = viewport as Window
		var host: Viewport = (
			embedder_of(window) if window != null and window.is_embedded() else null
		)
		if host != null:
			# A window's canvas is drawn into its embedder through its own final transform, which is
			# where a content scale goes: one at 4 drew a button at four times the point it was
			# clicked at, and the click missed it.
			point = Vector2(window.position) + window.get_final_transform() * point
			viewport = host
			out.append({ "viewport": viewport, "point": point, "through": window })
			continue
		var shown_by: SubViewportContainer = viewport.get_parent() as SubViewportContainer
		if viewport is SubViewport and shown_by != null:
			var scaled: Vector2 = (
				point * float(shown_by.stretch_shrink) if shown_by.stretch else point
			)
			point = shown_by.get_global_transform_with_canvas() * scaled
			viewport = shown_by.get_viewport()
			out.append({ "viewport": viewport, "point": point, "through": shown_by })
			continue
		break
	return out


## The viewport [param window] is embedded in and placed by, found as the engine finds it, which
## does not offer it to scripts: the nearest viewport above that embeds subwindows. That is not
## always its parent's: a window under a window that does not embed is embedded in the one above.
static func embedder_of(window: Window) -> Viewport:
	var above: Node = window.get_parent()
	# A viewport's get_viewport is itself, so a window's parent that is one is asked first.
	var viewport: Viewport = above.get_viewport() if above != null else null
	while viewport != null and not viewport.is_embedding_subwindows():
		above = viewport.get_parent()
		viewport = above.get_viewport() if above != null else null
	return viewport


## Where [param point], in [param viewport]'s own coordinates, is in the pixels of the window the
## game is shown in, which is what a mouse event names.
static func in_window(viewport: Viewport, point: Vector2) -> Vector2:
	var reached: Dictionary = reach(viewport, point)
	var outermost: Viewport = reached["viewport"]
	var there: Vector2 = reached["point"]
	return outermost.get_final_transform() * there


## [param rect], in [param viewport]'s own coordinates, in the window's pixels: the box its two
## corners make once carried there, which is the rect itself for anything not turned.
static func rect_in_window(viewport: Viewport, rect: Rect2) -> Rect2:
	var start: Vector2 = in_window(viewport, rect.position)
	var end: Vector2 = in_window(viewport, rect.end)
	return Rect2(start.min(end), (end - start).abs())


## Whether any of [param node] is drawn where the player can see it: inside its viewport, and inside
## every ScrollContainer between it and the viewport, each of which clips what it holds. A label
## placed past the window's edge was read out as written on the screen. Only a Control has a box to
## ask about, so anything else is in view.
static func in_view(node: Node) -> bool:
	var control: Control = node as Control
	return control == null or shown_part(control) != null


## The part of [param control] the player can see, in its viewport's canvas, or null when there is
## none: its drawn box cut to the viewport and to every ScrollContainer between, each cut taken from
## what the last one left. A control in view of an inner list and of the outer one can still sit
## where the two do not overlap.
static func shown_part(control: Control) -> Variant:
	var part: Rect2 = control.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, control.size)
	var clips: Array[Rect2] = [control.get_viewport().get_visible_rect()]
	var walking: Node = control.get_parent()
	while walking != null and not (walking is Viewport):
		var holder: ScrollContainer = walking as ScrollContainer
		if holder != null:
			clips.append(
				holder.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, holder.size)
			)
		walking = walking.get_parent()
	for clip: Rect2 in clips:
		if not part.intersects(clip, true):
			return null
		part = part.intersection(clip)
	return part


## Whether [param centre] is somewhere a click can reach it: inside the viewport, and inside every
## ScrollContainer between the control and the root, each of which clips what it holds.
static func in_sight(control: Control, viewport: Viewport, centre: Vector2) -> bool:
	return viewport.get_visible_rect().has_point(centre) and clipped_by(control, centre) == null


## The ScrollContainer between [param control] and its viewport that clips [param centre] away from
## it, or null when none does. Not past the viewport: one holding a dialog is in another space.
static func clipped_by(control: Control, centre: Vector2) -> ScrollContainer:
	var walking: Node = control.get_parent()
	while walking != null and not (walking is Viewport):
		var holder: ScrollContainer = walking as ScrollContainer
		# Carried into the same space the centre is in, which is the canvas rather than the
		# container's own: the two are only the same while nothing above it is transformed.
		if holder != null:
			var seen: Rect2 = (
				holder.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, holder.size)
			)
			if not seen.has_point(centre):
				return holder
		walking = walking.get_parent()
	return null


## Scrolls whatever is holding [param control] until it is on screen, and answers whether the view
## moved.
##
## Innermost container first and outwards, a frame apart. A container moves what it holds on the
## next layout pass rather than inside the call, and the next one out works out where the control is
## from where it is drawn, so asked in the same frame it scrolled to where the control had been.
## Moved means a scroll value changed: a container asked to show what it already shows moves
## nothing, and answering true for it said the view had moved when it had not. Only the containers
## in the control's own viewport: one holding a dialog scrolls the page behind it, not the dialog.
static func scroll_into_view(control: Control, tree: SceneTree) -> bool:
	var moved: bool = false
	var walking: Variant = control.get_parent()
	while walking != null and not (walking is Viewport):
		var step: Node = walking
		var holder: ScrollContainer = step as ScrollContainer
		if holder != null:
			var before: Vector2i = Vector2i(holder.scroll_horizontal, holder.scroll_vertical)
			holder.ensure_control_visible(control)
			if Vector2i(holder.scroll_horizontal, holder.scroll_vertical) != before:
				moved = true
				await tree.process_frame
				# A panel that rebuilds itself can go in the frame this waited.
				if not is_instance_valid(control) or not is_instance_valid(holder):
					return moved
		walking = step.get_parent()
	return moved


## Whether a pointer on its way out through [param out], the steps [method steps_out] answers, gets
## past the interface in every viewport, as {"landed", "hovered"}: the path of the control that took
## it, or of the one under it that let it by, or null. [param hover] answers what is hovered.
##
## In the viewport the node is drawn in, a control under the pointer takes it unless it and every
## control holding it let the pointer pass. In each viewport outside that one, the pointer has to be
## over what shows the one inside: the SubViewportContainer, with nothing drawn over it, or inside
## the embedded window. Read in the first viewport alone, a click beside a container that is smaller
## than what it shows, or under a panel drawn over the container, answered landed.
static func through_the_interface(out: Array[Dictionary], hover: GdhHover) -> Dictionary:
	var first_under: Variant = null
	for step: Dictionary in out:
		var viewport: Viewport = step["viewport"]
		var through: Variant = step["through"]
		var hovered: Control = hover.hovered_in(viewport)
		if through is Window:
			var window: Window = through
			var point: Vector2 = step["point"]
			if not Rect2(window.position, window.size).has_point(point):
				return { "landed": false, "hovered": _path_or_null(hovered) }
			continue
		if through is SubViewportContainer:
			if hovered != through:
				return { "landed": false, "hovered": _path_or_null(hovered) }
			continue
		if hovered != null and not _passes_on(hovered):
			return { "landed": false, "hovered": str(hovered.get_path()) }
		if hovered != null and first_under == null:
			first_under = str(hovered.get_path())
	return { "landed": true, "hovered": first_under }


## Whether a pointer over [param control] goes on past the interface: a control that lets it pass
## hands it to the one holding it, and one that stops it takes it, up to a control drawn on its own
## or something that is not a control. Measured on 4.7.2: a HUD over the room letting the pointer
## pass answered not landed while the game's own input took the press. A script on a control that
## lets it pass can still take the event for itself, which nothing outside it can see.
static func _passes_on(control: Control) -> bool:
	var walk: Node = control
	while walk is Control:
		var at: Control = walk
		if at.get_mouse_filter_with_override() == Control.MOUSE_FILTER_STOP:
			return false
		if at.top_level:
			break
		walk = at.get_parent()
	return true


static func _path_or_null(node: Node) -> Variant:
	if node == null:
		return null
	return str(node.get_path())
