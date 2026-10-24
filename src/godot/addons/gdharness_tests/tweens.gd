class_name GdhTweens
extends RefCounted
## Moves the tree's animations on by a time the case chooses, rather than waiting for them.
##
## A case that waits a real timer of an animation's length races the animation: the tree runs its
## timers before its tweens, so on a busy machine the timer fires ahead of the last step and the
## case reads a fade short of its end. Stepping the tweens reads the slide or the fade exactly
## where the case asks.

## A frame at sixty a second.
const FRAME: float = 1.0 / 60.0


## Steps every tween the tree is processing by [param seconds], as frames that long would.
static func step(tree: SceneTree, seconds: float) -> void:
	for running: Tween in tree.get_processed_tweens():
		var _stepped: bool = running.custom_step(seconds)


## [method step] [param seconds] and one frame more, for a case about what an animation leaves once
## it is over: a step that ends exactly where the last tweener does leaves a callback after it
## waiting for time it has not been given.
static func past(tree: SceneTree, seconds: float) -> void:
	step(tree, seconds + FRAME)
