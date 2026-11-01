extends RefCounted
## How long the game's last frames took, timed from the runtime's first frame. Apart from the
## queries that report it, because those are compiled after that frame and the frames before them
## count too.

## How many frames the frame time is the mean of: two seconds at sixty frames a second.
const FRAMES_TIMED: int = 120

## How long each of the last frames took, oldest first, in microseconds, as the game timed them.
var usec: PackedInt64Array = PackedInt64Array()
## How many physics steps ran in each of those frames, in the same order.
var physics: PackedInt64Array = PackedInt64Array()
var _last_frame_usec: int = 0
var _last_physics_frames: int = 0


## Called by the autoload once a frame, whatever else it does that frame, with the time it was
## called.
##
## The engine's own monitors do not follow the frame: TIME_PROCESS and the frame rate are set once a
## second, the first to the slowest process step of that second, so a game whose frames took 16.7ms
## read 45ms for a second at a time, and a change to the game showed only on the next second's
## worst frame. The time between two of these calls is the frame as it passed, physics and the wait
## for the display included.
##
## The physics steps are counted beside it because the engine steps physics from the wall clock and
## nothing else reports how many it took: a game drawing sixty frames a second whose brew advanced
## by physics steps moved a tenth as far as the frames promised, and every reading available said
## the game was running well.
func note_frame(now_usec: int) -> void:
	var stepped: int = Engine.get_physics_frames()
	if _last_frame_usec > 0:
		var _grew: bool = usec.push_back(now_usec - _last_frame_usec)
		var _counted: bool = physics.push_back(stepped - _last_physics_frames)
		if usec.size() > FRAMES_TIMED:
			usec.remove_at(0)
			physics.remove_at(0)
	_last_frame_usec = now_usec
	_last_physics_frames = stepped


## Leaves the frame in progress out of the timing, for one the runtime itself slowed. A module a
## command needs before its loading thread finished it is finished in the frame, which can take half
## a second. That is gdharness's and not the game's, and would stand as the slowest frame for two
## seconds of readings.
func skip_this_frame() -> void:
	_last_frame_usec = 0
