class_name GdhShare
extends RefCounted
## Plays a bench's runs here, or this engine's share of them under `gdharness spread`, and hands
## back every run's outcome in run order.
##
## A bench whose run `i` depends on `i` alone (its seed worked out from the index, nothing carried
## from one run to the next) calls [method outcomes] for each arm with the number of runs and a
## callable playing run `i`. Run on its own, the scene plays every run here, as it always did. Under
## `gdharness spread`, each worker engine plays every Nth run from its own index and leaves what each
## run answered; then one more engine runs the scene to gather, and there [method outcomes] plays
## nothing and answers every run's outcome, read back as the type it went in as. The bench folds them
## in run order either way, so a spread table is the same table to the last digit, floats included.
##
## An outcome is a plain value: a number, a string, a vector, or an array or dictionary of them. An
## object cannot be handed from one engine to another, so one is refused with an error.

## What `gdharness spread` tells a worker: which of how many it is.
const SHARE: String = "--gdh-share="
## What it tells the engine gathering: how many workers left outcomes.
const GATHER: String = "--gdh-share-gather="
## Where the workers leave their outcomes, an absolute path, since each engine has its own `user://`.
const INTO: String = "--gdh-share-dir="
## What a worker prints as it goes, which `gdharness spread` reads to say how far each has got.
const PROGRESS: String = "gdharness share: %s %d of %d runs"

static var _learnt: bool = false
static var _index: int = -1
static var _workers: int = 0
static var _gathering: int = 0
static var _directory: String = ""
static var _arms: Dictionary[String, bool] = {}
static var _read: bool = false
static var _unread: String = ""
static var _found: Dictionary[String, Dictionary] = {}
static var _found_runs: Dictionary[String, int] = {}


## Whether this engine is one of the workers of a spread run, which prints no table.
static func working() -> bool:
	_learn()
	return _index >= 0


## Whether this engine is the one gathering a spread run's outcomes.
static func gathering() -> bool:
	_learn()
	return _gathering > 0


## The runs of [param runs] this engine plays: every one on its own, its share as a worker (every
## Nth from its own index, so each worker draws long runs and short ones alike), and none when it
## gathers.
static func dealt(runs: int) -> PackedInt32Array:
	_learn()
	var played: PackedInt32Array = []
	if gathering():
		return played
	var step: int = _workers if working() else 1
	for at: int in range(maxi(_index, 0), runs, step):
		var _added: bool = played.append(at)
	return played


## Every outcome of the arm [param arm]'s [param runs] runs, in run order: played here by
## [param play], which is called with a run's index, or gathered from the workers. A worker plays
## its share, leaves the outcomes for the engine gathering, and answers an empty array.
static func outcomes(arm: String, runs: int, play: Callable) -> Array:
	_learn()
	if _arms.has(arm):
		push_error("GdhShare: the arm %s was played twice in one run; give each arm its own name" % arm)
		return []
	_arms[arm] = true
	if gathering():
		return _gathered(arm, runs)

	var by_index: Dictionary[int, Variant] = {}
	var share: PackedInt32Array = dealt(runs)
	var every: int = maxi(ceili(share.size() / 10.0), 1)
	for at: int in range(share.size()):
		var run: int = share[at]
		var outcome: Variant = play.call(run)
		var wrong: String = _not_plain(outcome)
		if not wrong.is_empty():
			push_error(
				(
					"GdhShare: run %d of %s answered %s, which cannot be handed from one engine to another"
					% [run, arm, wrong]
				)
			)
		by_index[run] = outcome
		if working() and ((at + 1) % every == 0 or at + 1 == share.size()):
			print(PROGRESS % [arm, at + 1, share.size()])

	if working():
		_leave(arm, runs, by_index)
		return []
	var ordered: Array = []
	for run: int in range(runs):
		ordered.append(by_index[run])
	return ordered


## [param counted], each a dictionary of whole numbers, added up key by key; a key named in
## [param largest] keeps the largest instead. Adding and taking the largest come out the same in
## any order, which is what lets a bench fold its runs however it likes.
static func added(
	counted: Array, largest: PackedStringArray = PackedStringArray()
) -> Dictionary[String, int]:
	var total: Dictionary[String, int] = {}
	for outcome: Variant in counted:
		if not outcome is Dictionary:
			push_error("GdhShare.added: an outcome is %s, not a dictionary" % type_string(typeof(outcome)))
			continue
		var counts: Dictionary = outcome
		for key: Variant in counts:
			var named: String = str(key)
			var count: Variant = counts[key]
			if not count is int:
				push_error(
					"GdhShare.added: %s is %s, not a whole number" % [named, type_string(typeof(count))]
				)
				continue
			var now: int = count
			if not total.has(named):
				total[named] = now
			elif largest.has(named):
				total[named] = maxi(total[named], now)
			else:
				total[named] += now
	return total


## Leaves one arm's outcomes, then the line saying so, which `gdharness spread` checks the share
## against; the outcomes first, so a line is never there without them.
static func _leave(arm: String, runs: int, by_index: Dictionary[int, Variant]) -> void:
	var left: Dictionary = {"arm": arm, "runs": runs, "outcomes": by_index}
	if not _appended("worker-%d.bin" % _index, func(file: FileAccess) -> bool: return file.store_var(left)):
		return
	var said: String = JSON.stringify({"arm": arm, "runs": runs, "played": by_index.size()})
	var _noted: bool = _appended(
		"worker-%d.arms" % _index, func(file: FileAccess) -> bool: return file.store_line(said)
	)


## Appends to [param name] in the share directory with [param write], answering whether it did.
static func _appended(name: String, write: Callable) -> bool:
	var path: String = _directory.path_join(name)
	var file: FileAccess = FileAccess.open(
		path, FileAccess.READ_WRITE if FileAccess.file_exists(path) else FileAccess.WRITE
	)
	if file == null:
		push_error("GdhShare: cannot write %s: %s" % [path, error_string(FileAccess.get_open_error())])
		return false
	file.seek_end()
	var wrote: bool = write.call(file)
	file.close()
	if not wrote:
		push_error("GdhShare: cannot write %s" % path)
	return wrote


static func _gathered(arm: String, runs: int) -> Array:
	_read_workers()
	if not _unread.is_empty():
		push_error(_unread)
		return []
	if not _found.has(arm):
		push_error(
			(
				(
					"GdhShare: no worker played the arm %s, so this run went another way than theirs; "
					+ "which arms a bench plays must depend on its command line alone"
				)
				% arm
			)
		)
		return []
	if _found_runs[arm] != runs:
		push_error(
			(
				"GdhShare: the workers played %d runs of %s, and this run asks for %d"
				% [_found_runs[arm], arm, runs]
			)
		)
		return []
	var held: Dictionary = _found[arm]
	var ordered: Array = []
	for run: int in range(runs):
		if not held.has(run):
			push_error("GdhShare: no worker played run %d of %s" % [run, arm])
			return []
		ordered.append(held[run])
	var said: String = JSON.stringify({"arm": arm, "runs": runs, "played": runs})
	var _noted: bool = _appended(
		"gathered.arms", func(file: FileAccess) -> bool: return file.store_line(said)
	)
	return ordered


static func _read_workers() -> void:
	if _read:
		return
	_read = true
	for worker: int in range(_gathering):
		var path: String = _directory.path_join("worker-%d.bin" % worker)
		var file: FileAccess = FileAccess.open(path, FileAccess.READ)
		if file == null:
			_unread = "GdhShare: cannot read %s: %s" % [path, error_string(FileAccess.get_open_error())]
			return
		while file.get_position() < file.get_length():
			_unread = _took(file.get_var(), path)
			if not _unread.is_empty():
				file.close()
				return
		file.close()


## Adds one arm a worker left to what has been found, answering why it cannot, or empty.
static func _took(left: Variant, path: String) -> String:
	if not left is Dictionary:
		return "GdhShare: %s holds something other than a worker's outcomes" % path
	var record: Dictionary = left
	var arm_said: Variant = record.get("arm")
	var runs_said: Variant = record.get("runs")
	var outcomes_said: Variant = record.get("outcomes")
	if not (arm_said is String and runs_said is int and outcomes_said is Dictionary):
		return "GdhShare: %s holds something other than a worker's outcomes" % path
	var arm: String = arm_said
	var runs: int = runs_said
	var played: Dictionary = outcomes_said
	if _found_runs.has(arm) and _found_runs[arm] != runs:
		return (
			"GdhShare: the workers disagree on how many runs %s has: %d and %d"
			% [arm, _found_runs[arm], runs]
		)
	_found_runs[arm] = runs
	var held: Dictionary = _found.get_or_add(arm, {})
	for run: Variant in played:
		if held.has(run):
			return "GdhShare: run %s of %s was played by two workers" % [str(run), arm]
		held[run] = played[run]
	return ""


static func _learn() -> void:
	if _learnt:
		return
	_learnt = true
	for given: String in OS.get_cmdline_user_args():
		if given.begins_with(SHARE):
			var halves: PackedStringArray = given.trim_prefix(SHARE).split("/")
			if halves.size() == 2 and halves[0].is_valid_int() and halves[1].is_valid_int():
				_index = halves[0].to_int()
				_workers = halves[1].to_int()
			if _index < 0 or _index >= _workers:
				push_error("GdhShare: %s names no worker; it takes <index>/<workers>" % given)
				_index = -1
		elif given.begins_with(GATHER):
			_gathering = given.trim_prefix(GATHER).to_int()
		elif given.begins_with(INTO):
			_directory = given.trim_prefix(INTO)
	if (_index >= 0 or _gathering > 0) and _directory.is_empty():
		push_error("GdhShare: a spread engine was given no %s<directory> to share outcomes in" % INTO)


## What in [param value] cannot be written by one engine and read by another, or empty.
static func _not_plain(value: Variant) -> String:
	match typeof(value):
		TYPE_OBJECT:
			return "an object"
		TYPE_CALLABLE:
			return "a callable"
		TYPE_SIGNAL:
			return "a signal"
		TYPE_RID:
			return "a resource id"
		TYPE_ARRAY:
			var items: Array = value
			for item: Variant in items:
				var wrong: String = _not_plain(item)
				if not wrong.is_empty():
					return wrong
		TYPE_DICTIONARY:
			var pairs: Dictionary = value
			for key: Variant in pairs:
				var wrong: String = _not_plain(key) + _not_plain(pairs[key])
				if not wrong.is_empty():
					return wrong
	return ""
