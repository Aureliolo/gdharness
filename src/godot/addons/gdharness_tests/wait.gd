class_name GdhWait
extends RefCounted
## Waits out what the game is doing by asking every frame whether it is done, never by a timer.
##
## A timer of an animation's length and a margin is a race the animation loses on a busy machine:
## the engine counts a tween's time in the frames' deltas, and a frame that waits on other engines
## arrives late, so the timer ends with the tween still running. Asking once a frame holds however
## slowly the frames come. The bound is on the clock only so that something that never ends fails
## the case by name instead of holding the run until its silence ends it.

## How long [method until] and [method still] wait by default, in milliseconds.
const MOST_MS: int = 30000

## Frames in a row with no tween running before [method still] counts the tree as still. A layout
## often starts its slide a frame after the change that asks for it, so the frame straight after
## had no tween yet and passed for still.
const QUIET_FRAMES: int = 3


## Whether [param done] answered true within [param most_ms], asked now and then once a frame.
static func until(tree: SceneTree, done: Callable, most_ms: int = MOST_MS) -> bool:
	var began: int = Time.get_ticks_msec()
	while not done.call():
		if Time.get_ticks_msec() - began > most_ms:
			return false
		await tree.process_frame
	return true


## Whether the tree ran no tween for [param quiet_frames] frames in a row within [param most_ms].
static func still(tree: SceneTree, quiet_frames: int = QUIET_FRAMES, most_ms: int = MOST_MS) -> bool:
	var began: int = Time.get_ticks_msec()
	var quiet: int = 0
	while quiet < quiet_frames:
		if Time.get_ticks_msec() - began > most_ms:
			return false
		await tree.process_frame
		quiet = quiet + 1 if not running(tree) else 0
	return true


## [param count] frames of the tree, waited one at a time.
static func frames(tree: SceneTree, count: int) -> void:
	for _frame: int in range(count):
		await tree.process_frame


## Whether any tween under [param tree] is running.
static func running(tree: SceneTree) -> bool:
	for tween: Tween in tree.get_processed_tweens():
		if tween.is_running():
			return true
	return false
