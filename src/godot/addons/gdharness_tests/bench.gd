class_name GdhBench
extends RefCounted
## Work played a step a frame, for the script profiler. The engine sends the profiler what each
## frame called and holds names for only so many functions a frame, so work played inside one frame
## comes back with most of its functions unnamed. Spread over frames, every step is named.
##
##     func _ready() -> void:
##         var timed: Dictionary = await GdhBench.each_frame(get_tree(), 400, _run.advance)
##         print("bench: %d days, %.2f ms a day" % [timed["steps"], timed["ms_each"]])
##         get_tree().quit()


## Calls [param step] once a frame, up to [param most] times, and stops early when it returns false.
## Answers how many steps ran under "steps", and under "ms_each" the wall-clock milliseconds a step
## took on average, the step alone and not the frame around it.
static func each_frame(tree: SceneTree, most: int, step: Callable) -> Dictionary:
	var steps: int = 0
	var spent_usec: int = 0
	while steps < most:
		await tree.process_frame
		var began: int = Time.get_ticks_usec()
		var going: Variant = step.call()
		spent_usec += Time.get_ticks_usec() - began
		steps += 1
		if going is bool and going == false:
			break
	return { "steps": steps, "ms_each": spent_usec / 1000.0 / maxf(1.0, float(steps)) }
