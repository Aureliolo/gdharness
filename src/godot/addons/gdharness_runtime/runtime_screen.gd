extends RefCounted

## Where a point in some viewport is on the game's own screen, for a click to be sent there and for
## an answer to say where something is drawn.


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
	var out: Array[Dictionary] = [{"viewport": viewport, "point": point, "through": null}]
	while true:
		var window: Window = viewport as Window
		if window != null and window.is_embedded() and window.get_parent() != null:
			point += Vector2(window.position)
			viewport = window.get_parent().get_viewport()
			out.append({"viewport": viewport, "point": point, "through": window})
			continue
		var shown_by: SubViewportContainer = viewport.get_parent() as SubViewportContainer
		if viewport is SubViewport and shown_by != null:
			var scaled: Vector2 = point * float(shown_by.stretch_shrink) if shown_by.stretch else point
			point = shown_by.get_global_transform_with_canvas() * scaled
			viewport = shown_by.get_viewport()
			out.append({"viewport": viewport, "point": point, "through": shown_by})
			continue
		break
	return out


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
