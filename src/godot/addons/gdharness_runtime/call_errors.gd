extends Logger
## What the engine reports on the main thread while one call runs, added for that call alone.
##
## A call the engine refuses, given too few arguments or one it will not convert, comes back from
## `callv` as null, which is also what a method that ran and returned nothing answers, and the
## engine's reason goes only to the game's output. Measured on 4.7.2: each refusal is one error from
## `callv` whose text begins with [constant REFUSED]. Anything else reported while the call runs is
## the method's own, raised on its way through.

const REFUSED: String = "Error calling method from 'callv': "
## The most errors an answer lists, and so the most a request's reads add to one.
const ERRORS_KEPT: int = 20

## Where the errors the reads of the request in progress make are gathered. See [method bind].
static var _bound: Collected = null

## The engine's reason for refusing the call, without [constant REFUSED], or "" when it ran.
var refused: String = ""
## The errors reported while it ran, a line each.
var raised: Array[String] = []
## The warnings reported while it ran, a line each.
var warned: Array[String] = []
## Where a script error first ended each function it ended, as "res://path:line" by function name.
## A function the VM ends at a script error gives back its return type's default, 0, "" or null,
## and its caller goes on with that as if it had been returned.
var ended_at: Dictionary = {}
## The engine file each entry of [member raised] was reported from, in the same order.
var raised_in: Array[String] = []
## The engine file the refusal in [member refused] was reported from.
var refused_in: String = ""


## Makes [param collector] the one reads add their errors to, and answers the one it replaced. A
## request opens one when it starts. Code that resumes after an await binds the request's again,
## since another request may have run in between.
static func bind(collector: Collected) -> Collected:
	var before: Collected = _bound
	_bound = collector
	return before


## The collector reads are adding to now, or null outside a request.
static func bound() -> Collected:
	return _bound


## Adds [param text], an error a read made, to the collector bound now.
static func note(text: String) -> void:
	if _bound != null:
		_bound.add(text)


## Puts what [param found] gathered in [param answer]. An answer that lists errors gets them after
## the ones it holds, cut to [constant ERRORS_KEPT] with the rest counted under errors_not_shown.
## A refusal reaches the caller as its message alone, so the errors go into the message.
static func attach(answer: Dictionary, found: Collected) -> void:
	if found.is_empty():
		return
	var lines: Array[String] = found.lines()
	if answer.has("message"):
		var shown: String = " | ".join(lines.slice(0, ERRORS_KEPT))
		if lines.size() > ERRORS_KEPT:
			shown += " | and %d more" % (lines.size() - ERRORS_KEPT)
		var refusal: String = str(answer["message"]).trim_suffix(".")
		answer["message"] = "%s. The engine reported: %s" % [refusal, shown]
		return
	var all: Array = answer.get("errors", [])
	all.append_array(lines)
	var hidden: int = answer.get("errors_not_shown", 0)
	hidden += maxi(all.size() - ERRORS_KEPT, 0)
	answer["errors"] = all.slice(0, ERRORS_KEPT)
	if hidden > 0:
		answer["errors_not_shown"] = hidden


## Every error the engine reported while the call ran, the refusal first, a line each.
func errors() -> Array[String]:
	var all: Array[String] = []
	if not refused.is_empty():
		all.append(REFUSED + refused)
	all.append_array(raised)
	return all


## Prints a line for each error reported, naming [param by] as what raised it. The server takes
## those errors out of the game's own when it reads the log, so a read the game never asked for
## does not make the run unclean.
func announce(by: String) -> void:
	if not refused.is_empty():
		print_mark(by, refused_in, REFUSED + refused)
	for index: int in raised.size():
		if not raised_in[index].is_empty():
			print_mark(by, raised_in[index], raised[index])


## Prints one line in the shape the server reads, with only the first line of [param text].
static func print_mark(by: String, file: String, text: String) -> void:
	print("gdharness: %s raised from %s: %s" % [by, file, text.split("\n")[0]])


func _log_message(_message: String, _error: bool) -> void:
	pass


# The engine's own signature for a Logger, eight parameters and not this project's to shape.
# gdstyle:ignore=quality/max-parameters
func _log_error(
	function: String,
	file: String,
	line: int,
	code: String,
	rationale: String,
	_editor_notify: bool,
	error_type: int,
	_script_backtraces: Array[ScriptBacktrace],
) -> void:
	# Another thread's report in the same moment is not the call's.
	if OS.get_thread_caller_id() != OS.get_main_thread_id():
		return
	var text: String = rationale if not rationale.is_empty() else code
	if function == "callv" and text.begins_with(REFUSED) and refused.is_empty():
		refused = text.trim_prefix(REFUSED)
		refused_in = file
		return
	if error_type == ERROR_TYPE_WARNING:
		warned.append(text)
	else:
		raised.append(text)
		raised_in.append(file)
	if error_type == ERROR_TYPE_SCRIPT and not ended_at.has(function):
		ended_at[function] = "%s:%d" % [file, line]


## The errors the reads of one request made, each distinct text once with how often it came.
class Collected:
	extends RefCounted
	var texts: Array[String] = []
	var counts: Dictionary[String, int] = {}

	func add(text: String) -> void:
		if not counts.has(text):
			texts.append(text)
		counts[text] = counts.get(text, 0) + 1

	func is_empty() -> bool:
		return texts.is_empty()

	## A line for each distinct text, with its count after it when it came more than once.
	func lines() -> Array[String]:
		var listed: Array[String] = []
		for text: String in texts:
			var times: int = counts[text]
			listed.append(text if times == 1 else "%s (x%d)" % [text, times])
		return listed
