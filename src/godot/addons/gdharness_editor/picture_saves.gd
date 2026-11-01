extends RefCounted

# How a captured picture is sized and saved, for the game's captures and the editor's alike.
#
# This file is the one beside the operations, and `bun run sync:gd` copies it into each addon,
# because an addon is installed as a directory and cannot preload out of one.

## Measured on a downstream game's 1280x720 frame: its interface text and pixel art read as they do
## in the PNG, at a fifth of the PNG's size.
const JPEG_QUALITY: float = 0.8


## The size a capture drawn at [param drawn] is scaled to, from the width and height asked for, 0
## being not asked. One side alone keeps the picture's proportions, since that is what asking for a
## smaller picture means: it was ignored unless both came, so the full-size picture was sent back.
static func scaled_to(drawn: Vector2i, width: int, height: int) -> Vector2i:
	if width > 0 and height > 0:
		return Vector2i(width, height)
	if width > 0 and drawn.x > 0:
		return Vector2i(width, maxi(1, roundi(float(drawn.y) * width / drawn.x)))
	if height > 0 and drawn.y > 0:
		return Vector2i(maxi(1, roundi(float(drawn.x) * height / drawn.y)), height)
	return drawn


## [param image] saved as a PNG at [param png_path], and as a JPEG beside it, which the server sends
## instead when it is the smaller: a rendered frame is several times smaller as one, and every
## picture sent stays in the caller's session. Not for a picture with transparency, which a JPEG
## would flatten.
static func saved(image: Image, png_path: String) -> Dictionary:
	var save_error: Error = image.save_png(png_path)
	if save_error != OK:
		return {
			"type": "error",
			"message": "Failed to save screenshot as PNG: " + str(save_error),
		}
	var answer: Dictionary = {
		"type": "screenshot_file",
		"format": "png",
		"width": image.get_width(),
		"height": image.get_height(),
		"path": png_path,
	}
	if image.detect_alpha() == Image.ALPHA_NONE:
		var jpeg_path: String = png_path.get_basename() + ".jpg"
		if image.save_jpg(jpeg_path, JPEG_QUALITY) == OK:
			answer["jpegPath"] = jpeg_path
	return answer
