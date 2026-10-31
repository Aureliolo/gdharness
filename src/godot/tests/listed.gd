extends SceneTree
## gdUnit4's command-line runner over the suites a file lists, in the file's order. One `-a` a suite
## outgrows the command line once a game has a few hundred suites (Windows stops at 32767
## characters), so the suites come from the file named after `--` with [constant LISTED], and the
## cases to leave out from the one named with [constant SKIPPING]. Every other argument is gdUnit4's
## own, as `GdUnitCmdTool.gd` takes them.
##
## Started from outside the project, `-s` with this file's absolute path, so it declares no class of
## its own and reaches gdUnit4 through the project's global classes. Besides the file of suites it
## finds each case by its id in a dictionary ([GdhIndexedSession]), can turn off the reports the
## caller does not read ([constant REPORTS_OFF]), writes the errors and warnings each suite declares
## it prints ([constant EXPECTED_OUT]) and what the run loads ([constant REACHED_OUT]), and in an
## engine of its own compiles every script together ([constant COMPILE_ONLY]).

const LISTED: String = "--suites-in"
const SKIPPING: String = "--skipping-in"
## The file of the parameterised cases dealt by their rows, one a line and tab-separated:
## `res://suite.gd:test_case`, then `only` and the rows this engine runs, or `besides` and the rows
## it leaves to the others, for the engine that takes every row dealt nowhere else. Apart from
## [constant SKIPPING], since gdUnit4 reads `suite:case:row` there as the case and leaves out every
## row of it.
const ROWS: String = "--rows-in"
## Printed before each row an engine leaves out, as `res://suite.gd > test_case:row`, -1 for a case
## that is not parameterised. gdUnit4 prints nothing for a case it skips, and the caller needs every
## row an engine found to tell one that no engine ran.
const LEFT_OUT: String = "gdharness left out"
## Printed before each row an entry of [constant SKIPPING] leaves out, as
## `res://suite.gd > test_case:row`, so the caller can tell an entry naming a row that does not
## exist.
const IGNORED_ROW: String = "gdharness ignored"
## Printed after a case or a suite's hooks that gdUnit4 says left orphan nodes, as
## `res://suite.gd > test_case left 2: Node "Sandbox" of res://sandbox.gd, Timer "Timer"`, with
## `after` for the suite's hooks. gdUnit4 names them only where a case calls
## collect_orphan_node_details(), and otherwise counts them.
const ORPHANS_LEFT: String = "gdharness orphans:"
## How many orphans one line names before it counts the rest.
const ORPHANS_NAMED: int = 8
## The flags turning off a report, with the gdUnit4 hook that writes it. A gate reads what a run
## prints, and each report finds every case it hears of in the session to write them all out as the
## run ends; project_test reads the JUnit one and turns off only the HTML one.
const REPORTS_OFF: Dictionary[String, String] = {
	"--html-report-off": "res://addons/gdUnit4/src/core/hooks/GdUnitHtmlReporterTestSessionHook.gd",
	"--junit-report-off": "res://addons/gdUnit4/src/core/hooks/GdUnitXMLReporterTestSessionHook.gd",
}
## The file to write what every suite declares it prints into, as JSON: each key of
## [constant EXPECTED] holding the declarations keyed by suite path and then case name.
const EXPECTED_OUT: String = "--expected-out"
## The constants a suite declares what it prints on purpose in, case name to the exact texts: its
## engine errors, and its engine warnings.
const EXPECTED: Dictionary[String, String] = {
	"errors": "GDHARNESS_EXPECTED_ERRORS",
	"warnings": "GDHARNESS_EXPECTED_WARNINGS",
}
## Compiles the engine's own suites together ([method compiled_together]) before gdUnit4 loads them,
## so they share one reading of what they reach, and no class of the game they do not: what the
## engine holds is then what its suites reach, which is what [constant REACHED_OUT] records.
const TOGETHER: String = "--compile-together"
## The file to write what the run loads into, a line as each suite ends ([GdhReached]).
const REACHED_OUT: String = "--reached-out"
## Compiles the suites together beside every class of the game ([method compiled_together]), prints
## [constant COMPILED] and quits, running no suite: a run's check of every script, made in an engine
## of its own so the engines running its suites load only what their suites do. `gdharness test`
## asks for it, since it wants every script that does not compile named. project_test does not: its
## answer is about the scripts its run reached, and the compile names every broken script of the
## game, then once more as the one script it made.
const COMPILE_ONLY: String = "--compile-only"
const COMPILED: String = "gdharness compiled every script together"
## The tool name gdUnit4 reads its options after.
const TOOL: String = "GdUnitCmdTool.gd"
## Ends the runner's own arguments: everything after it is gdUnit4's options, for a run with no
## script path on its command line to find them after.
const GDUNIT: String = "--gdh-gdunit"
## How long a windowless engine sleeps after each frame. The engine's own default is the
## low-processor pause, 6.8 ms measured, which a run of suites awaiting frames spends thousands of
## times; zero makes a frame's delta round to nothing, and a tween then never moves.
const FRAME_SLEEP_USEC: int = 1000
## What the engine's shutdown prints as it clears the newest script and the oldest, on an engine
## whose walk [GdhShutdownWalk] guards. Kept in step with the server's engine-leaks.ts, which reads
## a run printing the first and not the second as a walk that stopped part way.
const WALK_BEGAN: String = "gdharness: the engine's shutdown began clearing scripts"
const WALK_ENDED: String = "gdharness: the engine's shutdown cleared every script"
## The meta of the theme database holding the scripts [method GdhShutdownWalk.hold] keeps.
const WALK_HOLD: StringName = &"gdharness_scripts_held_past_the_shutdown_walk"

var _runner: GdhRunner = null


## Here rather than in [method _initialize]: Godot loads the script given with `-s` and makes its
## instance before it loads the autoloads, so a load an autoload makes as it is made is recorded
## too.
func _init() -> void:
	var into: String = argument_after(OS.get_cmdline_user_args(), REACHED_OUT)
	if not into.is_empty():
		GdhReached.start(into)


func _initialize() -> void:
	var given: PackedStringArray = OS.get_cmdline_user_args()
	if given.has(COMPILE_ONLY):
		compile_only(given)
		return
	if GdhReached.current != null:
		GdhReached.current.autoloaded()
	_runner = started(given)
	_runner.own_path = get_script().resource_path
	root.add_child(_runner)


## As gdUnit4's own `GdUnitCmdTool.gd` ends, which names in a verbose run the nodes left orphaned.
## The runner is not queued for deletion here, as gdUnit4's does: the tree has freed root and the
## runner with it before this is called, and queueing a freed node writes into freed memory.
func _finalize() -> void:
	GdhReached.stop()
	if OS.is_stdout_verbose():
		print("Orphan nodes left as the run ends:")
		Window.print_orphan_nodes()


## Compiles the suites [param given] lists together and quits, holding the scripts past the
## engine's shutdown walk as a run of suites does ([GdhShutdownWalk]).
func compile_only(given: PackedStringArray) -> void:
	var oldest: Array[GDScript] = []
	if GdhShutdownWalk.guarded():
		oldest = GdhShutdownWalk.marker(WALK_ENDED)
	var together: GDScript = compiled_together(listed(given, LISTED), held_classes())
	print(COMPILED)
	if GdhShutdownWalk.guarded():
		var also: Array[GDScript] = oldest.duplicate()
		also.append_array(GdhShutdownWalk.marker(WALK_BEGAN))
		also.append(together)
		var own_path: String = get_script().resource_path
		var own: GDScript = ResourceLoader.get_cached_ref(own_path) as GDScript
		if own != null:
			also.append(own)
		GdhShutdownWalk.hold(also)
	quit()


## The runner over the suites [param given] lists, to be added to the tree, which starts it. Shared
## by this script and the suites scene of the tests addon, which loads this file from where the
## server ships it and calls this, since the addon itself names no gdUnit4 class.
static func started(given: PackedStringArray) -> GdhRunner:
	# First, so the marker is older than every script the run loads.
	var oldest: Array[GDScript] = []
	if GdhShutdownWalk.guarded():
		oldest = GdhShutdownWalk.marker(WALK_ENDED)
	OS.low_processor_usage_mode_sleep_usec = FRAME_SLEEP_USEC
	var at: int = given.find(GDUNIT)
	var asked: PackedStringArray = given if at < 0 else given.slice(0, at)
	var unread: PackedStringArray = []
	for flag: String in REPORTS_OFF:
		if asked.has(flag):
			var _unread: bool = unread.append(REPORTS_OFF[flag])
	var hooks: GdUnitTestSessionHookService = GdUnitTestSessionHookService.instance()
	var off: PackedStringArray = unread_off(hooks, unread)
	for path: String in unread:
		if not off.has(path):
			push_error(
				(
					(
						"gdharness test: gdUnit4 %s registers no session hook %s, so the report it "
						+ "writes is not turned off; report it to gdharness with the version."
					)
					% [GdUnit4Version.current(), path]
				)
			)
	var suites: PackedStringArray = listed(asked, LISTED)
	var runner: GdhRunner = GdhRunner.new()
	runner.walk_scripts = oldest
	if at >= 0:
		runner.given = given.slice(at + 1)
	if asked.has(TOGETHER):
		runner.together = compiled_together(suites, [])
	var expected_out: String = argument_after(asked, EXPECTED_OUT)
	if not expected_out.is_empty():
		write_expected(expected_out, suites)
	runner.add_test_suites(suites)
	for entry: String in listed(asked, SKIPPING):
		if is_one_row(entry):
			runner.left_out_rows[entry] = true
		elif is_one_case(entry):
			runner.left_out[entry] = true
		else:
			runner.skip_test_suite(entry)
	runner.row_shares = row_shares_of(listed(asked, ROWS))
	# Added to the list itself rather than through `register`, which saves every hook it holds into
	# `project.godot`.
	hooks.enigne_hooks.append(GdhSessionCheck.new(runner))
	return runner


## Turns off the hooks among [param hooks] whose scripts [param unread] names, answering the scripts
## of those it turned off. Through the mark gdUnit4's own `is_enabled` reads, rather than its
## `enable_hook`, which writes the setting into `project.godot`: a run changes nothing in the tree.
static func unread_off(
	hooks: GdUnitTestSessionHookService, unread: PackedStringArray
) -> PackedStringArray:
	var off: PackedStringArray = []
	for hook: GdUnitTestSessionHook in hooks.enigne_hooks:
		var path: String = hook.get_script().resource_path
		if unread.has(path):
			hook.set_meta("enabled", false)
			var _added: bool = off.append(path)
	return off


## [param suites] compiled inside one script, answered for the caller to hold so gdUnit4's own loads
## find them compiled. The engine keeps what it read of a class only while the compile that asked
## for it runs (`GDScriptCache`), so a suite compiled on its own reads again every class it reaches
## a member of, some seventy milliseconds a suite. As the preloads of one script, after the
## [param classes] it names first, held from that script's compile, they share one reading of each:
## two hundred suites compiled in a third of the time they took one at a time. The names are public,
## since a private one unread is a warning and every warning an error, and each a variable, since a
## class is no constant expression. A suite that does not compile fails here and again when gdUnit4
## loads it, which reports it as it would have. A directory listed is left to gdUnit4 to walk.
static func compiled_together(suites: PackedStringArray, classes: PackedStringArray) -> GDScript:
	var lines: PackedStringArray = ["extends RefCounted"]
	var at: int = 0
	for named: String in classes:
		var _held: bool = lines.append("var held_%d: Variant = %s" % [at, named])
		at += 1
	at = 0
	for path: String in suites:
		if not path.ends_with(".gd"):
			continue
		var _suite: bool = lines.append('var suite_%d: Variant = preload("%s")' % [at, path])
		at += 1
	var together: GDScript = GDScript.new()
	together.source_code = "\n".join(lines) + "\n"
	var _compiled: Error = together.reload()
	return together


## The classes [constant COMPILE_ONLY] compiles before the suites: the game's own GDScript classes,
## none of an addon's or a suite's, then gdUnit4's suite. Only GDScript shares the engine's reading,
## and a sandboxed mod's SafeGDScript class would load the sandbox's compiler, some 290 MB and up to
## 2.5 s, for nothing.
static func held_classes(
	classes: Array[Dictionary] = ProjectSettings.get_global_class_list()
) -> PackedStringArray:
	var held: PackedStringArray = []
	for known: Dictionary in classes:
		var path: String = known["path"]
		var own: bool = not path.begins_with("res://addons/") and not path.ends_with("_test.gd")
		if own and known["language"] == &"GDScript":
			var _own: bool = held.append(str(known["class"]))
	var _suite: bool = held.append("GdUnitTestSuite")
	return held


## What the file after [param flag] in [param args] names, one a line in order, or none when no file
## is named: gdUnit4 then says it found nothing, which a gate refuses.
static func listed(args: PackedStringArray, flag: String) -> PackedStringArray:
	var path: String = argument_after(args, flag)
	if path.is_empty():
		return PackedStringArray()
	var named: PackedStringArray = []
	for line: String in FileAccess.get_file_as_string(path).split("\n", false):
		if not line.strip_edges().is_empty():
			var _named: bool = named.append(line.strip_edges())
	return named


## Whether [param entry] of a [constant SKIPPING] file names one case of one suite file, as
## `res://suite.gd:test_case`, rather than a suite or a case by gdUnit4's looser names, which go to
## gdUnit4 as they are.
## Whether [param entry] names one row of a parameterised case, as `res://suite.gd:test_case:row`.
static func is_one_row(entry: String) -> bool:
	var at: int = entry.rfind(":")
	var row: String = entry.substr(at + 1)
	return (
		at > 0
		and row.is_valid_int()
		and not row.begins_with("-")
		and is_one_case(entry.substr(0, at))
	)


static func is_one_case(entry: String) -> bool:
	var at: int = entry.rfind(":")
	return (
		entry.begins_with("res://")
		and at > "res://".length()
		and entry.substr(0, at).ends_with(".gd")
		and entry.substr(at + 1).is_valid_ascii_identifier()
	)


## The row shares [param lines] of a [constant ROWS] file give, by case.
static func row_shares_of(lines: PackedStringArray) -> Dictionary[String, GdhRowShare]:
	var shares: Dictionary[String, GdhRowShare] = {}
	for line: String in lines:
		var parts: PackedStringArray = line.split("\t")
		if parts.size() < 2:
			continue
		var share: GdhRowShare = GdhRowShare.new()
		share.only = parts[1] == "only"
		for row: String in parts.slice(2):
			if row.is_valid_int():
				var _added: bool = share.rows.append(row.to_int())
		shares[parts[0]] = share
	return shares


## The argument after [param flag] in [param args], or "" when there is none.
static func argument_after(args: PackedStringArray, flag: String) -> String:
	var at: int = args.find(flag)
	if at < 0 or at + 1 >= args.size():
		return ""
	return args[at + 1]


## What each of [param suites] declares in [param constant], by suite path and then case name, read
## off the compiled suite's constants so a declaration is whatever the engine made of it. A
## directory listed is walked for its scripts, as gdUnit4 walks it for suites. Only a script whose
## source names the constant is loaded: gdUnit4 stops on a suite that does not load only when its
## own load is the one that fails, so a broken suite loaded here first let the rest of its directory
## run.
static func expected_by_suite(suites: PackedStringArray, constant: String) -> Dictionary:
	var expected: Dictionary = {}
	for path: String in scripts_in(suites):
		if (
			not FileAccess.file_exists(path)
			or not FileAccess.get_file_as_string(path).contains(constant)
		):
			continue
		var suite: Script = load(path)
		var declared: Variant = suite.get_script_constant_map().get(constant)
		if declared is Dictionary:
			expected[path] = declared
	return expected


## The scripts [param paths] names: each script, and every script under each directory.
static func scripts_in(paths: PackedStringArray) -> PackedStringArray:
	var found: PackedStringArray = []
	var pending: PackedStringArray = []
	for path: String in paths:
		if path.ends_with(".gd"):
			var _script: bool = found.append(path)
		else:
			var _directory: bool = pending.append(path.trim_suffix("/"))
	while not pending.is_empty():
		var directory: String = pending[pending.size() - 1]
		pending.remove_at(pending.size() - 1)
		for file: String in DirAccess.get_files_at(directory):
			if file.ends_with(".gd"):
				var _file: bool = found.append("%s/%s" % [directory, file])
		for inner: String in DirAccess.get_directories_at(directory):
			var _inner: bool = pending.append("%s/%s" % [directory, inner])
	return found


static func write_expected(path: String, suites: PackedStringArray) -> void:
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		push_error(
			"Could not write the expected errors to %s: %s" % [path, FileAccess.get_open_error()]
		)
		return
	var expected: Dictionary = {}
	for kind: String in EXPECTED:
		expected[kind] = expected_by_suite(suites, EXPECTED[kind])
	var _stored: bool = file.store_string(JSON.stringify(expected))
	file.close()


## gdUnit4's runner reading its options after this script's path rather than after its own tool's,
## which it looks for by name and otherwise finds none of them, printing its help.
class GdhRunner:
	extends GdUnitTestCIRunner

	var own_path: String = ""
	## gdUnit4's options when they were given after [constant GDUNIT] rather than read from the
	## engine's command line, as the suites scene gives them: a played scene has no script path to
	## find them after.
	var given: PackedStringArray = []
	## The suites compiled by [method compiled_together], held for as long as the run goes on.
	var together: GDScript = null
	## The cases dealt by their rows, by `res://suite.gd:test_case`.
	var row_shares: Dictionary[String, GdhRowShare] = {}
	## The cases to leave out, by `res://suite.gd:test_case` of the suite running them. gdUnit4's
	## own list is matched against the script declaring a case, which for a case a suite inherits is
	## its base, so an inherited case left out under its suite ran in every engine the suite was
	## dealt to, and a case of `res://tests/a_test.gd` was also left out of
	## `res://more/tests/a_test.gd`.
	var left_out: Dictionary[String, bool] = {}
	## The rows of parameterised cases to leave out, by `res://suite.gd:test_case:row`.
	var left_out_rows: Dictionary[String, bool] = {}
	## The cases gdUnit4 said it finished, which [GdhSessionCheck] holds the session's lookups
	## against.
	var cases_ended: int = 0
	## The marker of the shutdown walk's oldest end, made as the run starts.
	var walk_scripts: Array[GDScript] = []
	## The orphan nodes as the running case and the running suite began, and those already named in
	## the suite, so each line names only what its own case or hooks left.
	var orphans_at_case: Dictionary[int, bool] = {}
	var orphans_at_suite: Dictionary[int, bool] = {}
	var orphans_named: Dictionary[int, bool] = {}
	## The orphans new as the suite's first case began, which its before() made, and whether a case
	## has begun: gdUnit4 counts both hooks' orphans at the suite's end.
	var orphans_from_before: Dictionary[int, bool] = {}
	var case_began: bool = false
	## The suite running, which a case's own event does not carry.
	var suite_running: String = ""
	## Whether gdUnit4 has minimised the window, or is about to, and it is not back yet: it does as
	## its runner starts, and after every suite.
	var minimise_pending: bool = true

	## As the run ends, the marker of the walk's newest end, and every script held past the walk, on
	## an engine whose walk can stop part way ([GdhShutdownWalk]).
	func _notification(what: int) -> void:
		if what != NOTIFICATION_EXIT_TREE or not GdhShutdownWalk.guarded():
			return
		var also: Array[GDScript] = walk_scripts.duplicate()
		also.append_array(GdhShutdownWalk.marker(WALK_BEGAN))
		if together != null:
			also.append(together)
		var own: GDScript = ResourceLoader.get_cached_ref(own_path) as GDScript
		if own != null:
			also.append(own)
		GdhShutdownWalk.hold(also)

	func get_cmdline_args() -> PackedStringArray:
		if not given.is_empty():
			var options: PackedStringArray = [TOOL]
			options.append_array(given)
			return options
		return options_of(OS.get_cmdline_args(), own_path)

	## gdUnit4's own discovery, with each case filed under the suite it was found in before it is
	## asked whether to leave the case out. gdUnit4 files a case under the script declaring it,
	## which for a case a suite inherits is its base: its reports added such a case to no suite, so
	## project_test counted none of them, and a parameterised one ran as a suite of the base's own,
	## outside the suite inheriting it and its hooks, and was judged a case that suite never ran.
	func discover_tests() -> Array[GdUnitTestCase]:
		var added: Signal = GdUnitSignals.instance().gdunit_test_discover_added
		_test_cases = _runner_config.test_cases()
		var scanner: GdUnitTestSuiteScanner = GdUnitTestSuiteScanner.new()
		for path: String in _included_tests:
			for script: Script in scanner.scan(path):
				var suite: String = script.resource_path
				var found: Callable = func(test: GdUnitTestCase) -> void:
					filed_under(test, suite)
					if not is_skipped(test):
						_test_cases.append(test)
						added.emit(test)
				GdUnitTestDiscoverer.discover_tests(script, found)
		return _test_cases

	## [param test] as a case of the suite at [param suite], under which gdUnit4 groups, reports and
	## leaves out its cases.
	static func filed_under(test: GdUnitTestCase, suite: String) -> void:
		if test.suite_resource_path == suite and test.source_file == suite:
			return
		test.suite_resource_path = suite
		test.source_file = suite
		test.suite_name = suite.get_file().get_basename()
		test._build_fully_qualified_name(suite)

	## gdUnit4 asks this of every case it finds, a parameterised case once a row, each row carrying
	## its index.
	func is_skipped(test: GdUnitTestCase) -> bool:
		if left_out.has("%s:%s" % [test.suite_resource_path, test.test_name]) or super(test):
			return true
		var row: String = (
			"%s:%s:%d" % [test.suite_resource_path, test.test_name, test.attribute_index]
		)
		if test.attribute_index >= 0 and left_out_rows.has(row):
			print(
				(
					"%s %s > %s:%d"
					% [IGNORED_ROW, test.suite_resource_path, test.test_name, test.attribute_index]
				)
			)
			return true
		var share: GdhRowShare = row_shares.get(
			"%s:%s" % [test.suite_resource_path, test.test_name], null
		)
		if share == null or not share.leaves_out(test.attribute_index):
			return false
		print(
			(
				"%s %s > %s:%d"
				% [LEFT_OUT, test.suite_resource_path, test.test_name, test.attribute_index]
			)
		)
		return true

	## The session gdUnit4 has just made, swapped for a [GdhIndexedSession] of the same cases as it
	## is announced: everything that reads the session, the hooks, the cases and the console
	## printing every case, is handed it after this.
	func _on_gdunit_event(event: GdUnitEvent) -> void:
		match event.type():
			GdUnitEvent.SESSION_START:
				if not GdhIndexedSession.indexes_itself(_test_session):
					_test_session = GdhIndexedSession.of(_test_session)
				var tree: SceneTree = get_tree()
				if not tree.process_frame.is_connected(drawn_window):
					var _watched: int = tree.process_frame.connect(drawn_window)
			GdUnitEvent.TESTSUITE_BEFORE:
				drawn_window()
				if GdhReached.current != null:
					GdhReached.current.began(event.resource_path())
				suite_running = event.resource_path()
				orphans_at_suite = orphan_ids()
				orphans_named.clear()
				orphans_from_before.clear()
				case_began = false
			GdUnitEvent.TESTCASE_BEFORE:
				orphans_at_case = orphan_ids()
				if not case_began:
					case_began = true
					for id: int in new_orphans(orphans_at_suite):
						orphans_from_before[id] = true
			GdUnitEvent.TESTCASE_AFTER:
				cases_ended += 1
		super(event)
		# gdUnit4 minimises the window once the suite's end is reported.
		if event.type() == GdUnitEvent.TESTSUITE_AFTER:
			minimise_pending = true
			if GdhReached.current != null:
				GdhReached.current.ended(event.resource_path())
		# After gdUnit4's own report of the case, so the line falls under it.
		if event.orphan_nodes() == 0:
			return
		if event.type() == GdUnitEvent.TESTCASE_AFTER:
			say_left(event.test_name(), new_orphans(orphans_at_case))
		elif event.type() == GdUnitEvent.TESTSUITE_AFTER:
			var left: Array[int] = new_orphans(orphans_at_suite)
			if not case_began:
				say_left("before or after", left)
				return
			say_left(
				"before", left.filter(func(id: int) -> bool: return orphans_from_before.has(id))
			)
			say_left(
				"after", left.filter(func(id: int) -> bool: return not orphans_from_before.has(id))
			)

	## The window back from minimised, which gdUnit4 makes it as its runner starts and after every
	## suite, and where Godot draws nothing: a suite given a window to render in waited for a
	## frame_post_draw that never came. Called as a suite begins, ahead of its before(), and every
	## frame after, since on macOS the minimise is an animation that reads as windowed until it
	## ends, and a window not yet minimised cannot be put back. Only once for each minimise of
	## gdUnit4's, so a suite minimising the window itself keeps it minimised.
	func drawn_window() -> void:
		if not minimise_pending or DisplayServer.get_name() == "headless":
			return
		if Engine.is_embedded_in_editor():
			return
		var mode: DisplayServer.WindowMode = DisplayServer.window_get_mode()
		if mode == DisplayServer.WINDOW_MODE_MAXIMIZED and not DisplayServer.window_can_draw():
			# On macOS Godot reads a window whose frame fills the usable screen as maximised before
			# asking whether it is minimised, and changing the mode from that reading unzooms it, so
			# a minimised window that size, as a small screen makes the default one, stayed
			# minimised. A point off it reads as what it is, and goes back once restored. Godot
			# divides pixels by the scale into whole points, so a pixel moves nothing on a scaled
			# screen.
			var at: Vector2i = DisplayServer.window_get_position()
			DisplayServer.window_set_position(
				at + Vector2i(ceili(DisplayServer.screen_get_max_scale()), 0)
			)
			mode = DisplayServer.window_get_mode()
			if mode == DisplayServer.WINDOW_MODE_MINIMIZED:
				DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED)
				minimise_pending = false
			DisplayServer.window_set_position(at)
			return
		if mode == DisplayServer.WINDOW_MODE_MINIMIZED:
			DisplayServer.window_set_mode(DisplayServer.WINDOW_MODE_WINDOWED)
			minimise_pending = false

	## The orphans now that were not there in [param before] and no line has named yet.
	func new_orphans(before: Dictionary[int, bool]) -> Array[int]:
		var found: Array[int] = []
		for id: int in orphan_ids():
			if not before.has(id) and not orphans_named.has(id):
				found.append(id)
		return found

	## Prints the orphans [param ids] as left by [param during], under [constant ORPHANS_LEFT], once
	## each in a suite.
	func say_left(during: String, ids: Array[int]) -> void:
		if ids.is_empty():
			return
		var named: PackedStringArray = []
		for id: int in ids:
			orphans_named[id] = true
			if named.size() < ORPHANS_NAMED:
				var _named: bool = named.append(described(instance_from_id(id) as Node))
		var more: String = (
			"" if ids.size() <= named.size() else ", and %d more" % (ids.size() - named.size())
		)
		print(
			(
				"%s %s > %s left %d: %s%s"
				% [ORPHANS_LEFT, suite_running, during, ids.size(), ", ".join(named), more]
			)
		)

	## The nodes outside every tree that are not on their way out, by instance id, as gdUnit4 counts
	## them: one queued for deletion is freed at the end of the frame.
	static func orphan_ids() -> Dictionary[int, bool]:
		var ids: Dictionary[int, bool] = {}
		for id: int in Node.get_orphan_node_ids():
			var node: Node = instance_from_id(id) as Node
			if node != null and not node.is_queued_for_deletion():
				ids[id] = true
		return ids

	## [param node] as an orphan line names it: its class, its name when it was given one, and its
	## script when it has one.
	static func described(node: Node) -> String:
		var said: String = node.get_class()
		if not node.name.is_empty():
			said += ' "%s"' % node.name
		var attached: Variant = node.get_script()
		if attached is Script:
			var script: Script = attached
			if not script.resource_path.is_empty():
				said += " of " + script.resource_path
		return said

	## [param args] with everything up to the script at [param own] given as gdUnit4's tool name.
	## The path is compared with its separators and, on Windows, its case folded, since the engine
	## reports the script as `D:/a/listed.gd` when it was started as `D:\a\listed.gd`.
	static func options_of(args: PackedStringArray, own: String) -> PackedStringArray:
		var wanted: String = spelt(own)
		var at: int = -1
		for index: int in args.size():
			if spelt(args[index]) == wanted:
				at = index
				break
		if at < 0:
			return args
		var options: PackedStringArray = [TOOL]
		options.append_array(args.slice(at + 1))
		return options

	static func spelt(path: String) -> String:
		var forward: String = path.replace("\\", "/")
		return forward.to_lower() if OS.get_name() == "Windows" else forward


## The rows of one parameterised case an engine runs: those named, or every row but those.
class GdhRowShare:
	extends RefCounted

	var only: bool = true
	var rows: PackedInt32Array = []

	## Whether the engine leaves out [param row], which is -1 for a case that is not parameterised
	## and so runs only in the engine taking the rows besides.
	func leaves_out(row: int) -> bool:
		return rows.has(row) != only


## gdUnit4's session finding a case by its id in a dictionary, where its own walks every case of the
## session, `GdUnitTestSession.find_test_by_id`: the console asks it twice a case and each report
## twice more, so a run's time in it grew with the square of its cases (17.9 s of processor time
## in an engine of 2300 cases).
class GdhIndexedSession:
	extends GdUnitTestSession

	## The cases found by id, which [GdhSessionCheck] reads to tell that the console used this
	## session.
	var lookups: int = 0
	var _by_id: Dictionary[String, GdUnitTestCase] = {}

	func _init(cases: Array[GdUnitTestCase], reports_in: String) -> void:
		super(cases, reports_in)
		for test: GdUnitTestCase in cases:
			_by_id[str(test.guid)] = test

	func find_test_by_id(id: GdUnitGUID) -> GdUnitTestCase:
		lookups += 1
		var found: GdUnitTestCase = _by_id.get(str(id), null)
		return found

	## [param made] as an indexed session of its cases, reporting where it does; one already indexed
	## as it is.
	static func of(made: GdUnitTestSession) -> GdUnitTestSession:
		if made is GdhIndexedSession:
			return made
		# Read by name, since a gdUnit4 whose session indexes its cases has no such member and a
		# script naming it would not compile there.
		var cases: Array[GdUnitTestCase] = []
		var held: Variant = made.get(&"_test_cases")
		if held is Array:
			var listed: Array = held
			cases.assign(listed)
		return GdhIndexedSession.new(cases, made.report_path)

	## Whether [param made] already finds a case by its id in a dictionary, as a gdUnit4 session
	## with [code]test_count()[/code] does: gdUnit4 added both in one change, and took away the
	## array of cases [method of] reads.
	static func indexes_itself(made: GdUnitTestSession) -> bool:
		return made.has_method(&"test_count")


## A session hook of the runner's own, failing the run when the [GdhIndexedSession] is not the
## session gdUnit4 works from. The swap holds only while gdUnit4 announces a session before it hands
## it to the hooks and the console, and a gdUnit4 that changed that order would otherwise run every
## suite as before, only slower, with nothing said. Checked in the gdUnit4 the game installed, on
## every run, rather than in the one gdharness tests against.
class GdhSessionCheck:
	extends GdUnitTestSessionHook

	var _runner: GdhRunner = null

	func _init(runner: GdhRunner) -> void:
		super("gdharness session check", "Fails the run when gdUnit4 works from another session.")
		_runner = runner

	func startup(session: GdUnitTestSession) -> GdUnitResult:
		if session is GdhIndexedSession or GdhIndexedSession.indexes_itself(session):
			return GdUnitResult.success()
		return (
			GdUnitResult
			. error(
				(
					(
						"gdharness test: gdUnit4 %s handed its session hooks the session before "
						+ "announcing it, so the runner's indexed session is not the one they "
						+ "read. This gdUnit4 starts a session differently from the ones gdharness "
						+ "knows; report it to gdharness with the version."
					)
					% GdUnit4Version.current()
				)
			)
		)

	func shutdown(session: GdUnitTestSession) -> GdUnitResult:
		var indexed: GdhIndexedSession = session as GdhIndexedSession
		if indexed == null or _runner.cases_ended == 0 or indexed.lookups > 0:
			return GdUnitResult.success()
		return (
			GdUnitResult
			. error(
				(
					(
						"gdharness test: gdUnit4 %s ran %d cases without looking one up in the "
						+ "runner's indexed session, so its console reads another session. This "
						+ "gdUnit4 starts a session differently from the ones gdharness knows; "
						+ "report it to gdharness with the version."
					)
					% [GdUnit4Version.current(), _runner.cases_ended]
				)
			)
		)


## The engine's shutdown walk over its scripts, on an engine below 4.8. It clears them from the
## newest, and a script whose release frees the next one, as the last reference to its base can,
## leaves the walk on freed memory, where it ends (godot#117991, fixed in 4.8 by godot#120976).
## Every script it never reached keeps what it holds, which the engine then reports as leaked at
## exit, so a run of suites that leaked nothing failed on it.
class GdhShutdownWalk:
	extends RefCounted

	## Whether the engine of [param version] is one whose walk can stop part way.
	static func guarded(version: Dictionary = Engine.get_version_info()) -> bool:
		var major: int = version.get("major", 0)
		var minor: int = version.get("minor", 0)
		return major == 4 and minor < 8

	## A script the walk clears as it passes it, printing [param said] then, made now so it takes
	## this place in the walk. It holds an instance of itself, which keeps it alive past the engine
	## dropping its cache of scripts until the walk clears it, and the instance that prints, whose
	## script is older and so is not cleared yet.
	static func marker(said: String) -> Array[GDScript]:
		var printing: GDScript = GDScript.new()
		printing.source_code = (
			'extends RefCounted\n\nvar said: String = ""\n\n\nfunc _notification(what: int) -> '
			+ "void:\n\tif what == NOTIFICATION_PREDELETE:\n\t\tprint(said)\n"
		)
		var marking: GDScript = GDScript.new()
		marking.source_code = (
			"extends RefCounted\n\nstatic var kept: RefCounted = null\n"
			+ "static var printing: RefCounted = null\n"
		)
		if printing.reload() != OK or marking.reload() != OK:
			push_error("gdharness test could not make the marker of the engine's shutdown: " + said)
			return []
		var instance: Object = printing.new()
		instance.set("said", said)
		marking.set("kept", marking.new())
		marking.set("printing", instance)
		return [printing, marking]

	## Every script loaded from a file under res://, and [param also], held until the theme database
	## goes, which is after the walk and before the GDScript language does. Freed in the walk, a
	## script can take the next one with it and end the walk; held, none is freed there, so the walk
	## reaches every script and what the engine reports at exit is only what was leaked. A script a
	## run leaks is held by what leaked it as well, and is still reported.
	static func hold(also: Array[GDScript]) -> void:
		var held: Array[GDScript] = also.duplicate()
		var pending: PackedStringArray = ["res://"]
		while not pending.is_empty():
			var directory: String = pending[pending.size() - 1]
			pending.remove_at(pending.size() - 1)
			for file: String in DirAccess.get_files_at(directory):
				var path: String = directory.path_join(file)
				if file.ends_with(".gd") and ResourceLoader.has_cached(path):
					var script: GDScript = ResourceLoader.get_cached_ref(path) as GDScript
					if script != null:
						held.append(script)
			for inner: String in DirAccess.get_directories_at(directory):
				if not inner.begins_with("."):
					var _inner: bool = pending.append(directory.path_join(inner))
		ThemeDB.set_meta(WALK_HOLD, held)


## What the run loads, written to the file named after [constant REACHED_OUT] a line of JSON at a
## time, each with every path asked for since the line before: one once the autoloads are loaded,
## one as each suite begins, which also names the project's files the cache holds then, and one as
## it ends. The engine answers a load of a resource it holds from its cache without asking any
## loader, and it holds one only while something refers to it, so what a suite can load unasked is
## what the cache held as it began. Placed first among the loaders, it is asked about every load and
## every [method ResourceLoader.exists] and declines each. A script compiled for a preload, a base
## or a class name is read without a loader, so a suite's last line also has the project's files
## the cache came to hold that no loader was asked for.
class GdhReached:
	extends ResourceFormatLoader

	static var current: GdhReached = null

	var _file: FileAccess = null
	## Loads on other threads ask too, as a threaded load runs its own.
	var _mutex: Mutex = Mutex.new()
	## What the current line holds, since a path freed and loaded again is asked for again.
	var _seen: Dictionary[String, bool] = {}
	var _fresh: PackedStringArray = []
	var _files: PackedStringArray = []
	var _resident: Dictionary[String, bool] = {}

	static func start(into: String) -> void:
		var file: FileAccess = FileAccess.open(into, FileAccess.WRITE)
		if file == null:
			push_error(
				(
					"gdharness test could not write what the run loads to %s: %s"
					% [into, error_string(FileAccess.get_open_error())]
				)
			)
			return
		current = GdhReached.new()
		current._file = file
		current._files = project_files()
		ResourceLoader.add_resource_format_loader(current, true)

	static func stop() -> void:
		if current == null:
			return
		ResourceLoader.remove_resource_format_loader(current)
		current._file.close()
		current = null

	## Every file under res:// the engine sees, as its file system does: no hidden folder, and no
	## folder holding a `.gdignore`.
	static func project_files() -> PackedStringArray:
		var found: PackedStringArray = []
		var pending: PackedStringArray = ["res://"]
		while not pending.is_empty():
			var directory: String = pending[pending.size() - 1]
			pending.remove_at(pending.size() - 1)
			if FileAccess.file_exists(directory.path_join(".gdignore")):
				continue
			for file: String in DirAccess.get_files_at(directory):
				if not file.ends_with(".import") and not file.ends_with(".uid"):
					var _file_found: bool = found.append(directory.path_join(file))
			for inner: String in DirAccess.get_directories_at(directory):
				if not inner.begins_with("."):
					var _inner: bool = pending.append(directory.path_join(inner))
		return found

	func _recognize_path(path: String, _type: StringName) -> bool:
		_mutex.lock()
		if not _seen.has(path):
			_seen[path] = true
			var _asked: bool = _fresh.append(path)
		_mutex.unlock()
		return false

	func _get_recognized_extensions() -> PackedStringArray:
		return []

	func _handles_type(_type: StringName) -> bool:
		return false

	## Writes the line for the autoloads, which have all been loaded by now.
	func autoloaded() -> void:
		written({ "autoloads": true })

	## Writes the line of the suite at [param suite], which is about to begin, with what the cache
	## holds. The cache is asked outside the lock, since a load on another thread holds the cache's
	## own lock while it asks this.
	func began(suite: String) -> void:
		var resident: PackedStringArray = []
		_resident.clear()
		for path: String in _files:
			if ResourceLoader.has_cached(path):
				var _held: bool = resident.append(path)
				_resident[path] = true
		written({ "began": suite, "resident": resident })

	## Writes the line of the suite at [param suite], which has just ended, with the project's files
	## the cache came to hold while it ran that no loader was asked for.
	func ended(suite: String) -> void:
		_mutex.lock()
		var unseen: PackedStringArray = []
		for path: String in _files:
			if not _seen.has(path) and not _resident.has(path):
				var _unseen: bool = unseen.append(path)
		_mutex.unlock()
		var cached: PackedStringArray = []
		for path: String in unseen:
			if ResourceLoader.has_cached(path):
				var _cached: bool = cached.append(path)
		_mutex.lock()
		for path: String in cached:
			if not _seen.has(path):
				_seen[path] = true
				var _held: bool = _fresh.append(path)
		_mutex.unlock()
		written({ "suite": suite })

	## Writes [param fields] as a line with every path asked for since the line before.
	func written(fields: Dictionary) -> void:
		_mutex.lock()
		fields["reached"] = _fresh
		_fresh = []
		_seen.clear()
		_mutex.unlock()
		var _stored: bool = _file.store_line(JSON.stringify(fields))
		_file.flush()
