extends SceneTree

## gdUnit4's command-line runner over the suites a file lists, in the file's order. One `-a` a suite
## outgrows the command line once a game has a few hundred suites (Windows stops at 32767
## characters), so the suites come from the file named after `--` with [constant LISTED], and the
## cases to leave out from the one named with [constant SKIPPING]. Every other argument is gdUnit4's
## own, as `GdUnitCmdTool.gd` takes them.
##
## Started from outside the project, `-s` with this file's absolute path, so it declares no class of
## its own and reaches gdUnit4 through the project's global classes. Besides the file of suites it
## finds each case by its id in a dictionary ([GdhIndexedSession]), compiles the suites together
## before gdUnit4 loads them ([method compiled_together]), can turn off the reports nobody reads
## ([constant REPORTS_OFF]), and writes the errors each suite declares it expects
## ([constant EXPECTED_OUT]).

const LISTED: String = "--suites-in"
const SKIPPING: String = "--skipping-in"
## Turns off the reports of [constant UNREAD]: a gate reads what a run prints, and each report finds
## every case it hears of in the session to write them all out as the run ends. project_test reads
## the JUnit one, so it is left on unless asked.
const REPORTS_OFF: String = "--reports-off"
## The file to write the errors every suite declares it expects into, as JSON keyed by suite path and
## then case name.
const EXPECTED_OUT: String = "--expected-errors-out"
## The constant a suite declares its expected errors in: case name to the exact texts it prints.
const EXPECTED: String = "GDHARNESS_EXPECTED_ERRORS"
## The tool name gdUnit4 reads its options after.
const TOOL: String = "GdUnitCmdTool.gd"
const UNREAD: PackedStringArray = [
	"res://addons/gdUnit4/src/core/hooks/GdUnitHtmlReporterTestSessionHook.gd",
	"res://addons/gdUnit4/src/core/hooks/GdUnitXMLReporterTestSessionHook.gd",
]
## How long a windowless engine sleeps after each frame. The engine's own default is the
## low-processor pause, 6.8 ms measured, which a run of suites awaiting frames spends thousands of
## times; zero makes a frame's delta round to nothing, and a tween then never moves.
const FRAME_SLEEP_USEC: int = 1000

var _runner: GdhRunner = null
## The suites of the run, compiled by [method compiled_together] and held for as long as it runs.
var _together: GDScript = null


## gdUnit4's runner reading its options after this script's path rather than after its own tool's,
## which it looks for by name and otherwise finds none of them, printing its help.
class GdhRunner:
	extends GdUnitTestCIRunner

	var own_path: String = ""

	func get_cmdline_args() -> PackedStringArray:
		return options_of(OS.get_cmdline_args(), own_path)

	## The session gdUnit4 has just made, swapped for a [GdhIndexedSession] of the same cases as it
	## is announced: everything that reads the session, the hooks, the cases and the console printing
	## every case, is handed it after this.
	func _on_gdunit_event(event: GdUnitEvent) -> void:
		if event.type() == GdUnitEvent.SESSION_START:
			_test_session = GdhIndexedSession.of(_test_session)
		super(event)

	## [param args] with everything up to the script at [param own] given as gdUnit4's tool name. The
	## path is compared with its separators and, on Windows, its case folded, since the engine
	## reports the script as `X:/a/listed.gd` when it was started as `X:\a\listed.gd`.
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


## gdUnit4's session finding a case by its id in a dictionary, where its own walks every case of the
## session, `GdUnitTestSession.find_test_by_id`: the console asks it twice a case and each report
## twice more, so a run's time in it grew with the square of its cases (17.9 s of processor time
## in an engine of 2300 cases).
class GdhIndexedSession:
	extends GdUnitTestSession

	var _by_id: Dictionary[String, GdUnitTestCase] = {}

	func _init(cases: Array[GdUnitTestCase], reports_in: String) -> void:
		super(cases, reports_in)
		for test: GdUnitTestCase in _test_cases:
			_by_id[str(test.guid)] = test

	func find_test_by_id(id: GdUnitGUID) -> GdUnitTestCase:
		var found: GdUnitTestCase = _by_id.get(str(id), null)
		return found

	## [param made] as an indexed session of its cases, reporting where it does; one already indexed
	## as it is.
	static func of(made: GdUnitTestSession) -> GdUnitTestSession:
		if made is GdhIndexedSession:
			return made
		return GdhIndexedSession.new(made._test_cases, made.report_path)


func _initialize() -> void:
	OS.low_processor_usage_mode_sleep_usec = FRAME_SLEEP_USEC
	var asked: PackedStringArray = OS.get_cmdline_user_args()
	if asked.has(REPORTS_OFF):
		var _off: PackedStringArray = unread_off(GdUnitTestSessionHookService.instance())
	var suites: PackedStringArray = listed(asked, LISTED)
	_together = compiled_together(suites)
	var expected_out: String = argument_after(asked, EXPECTED_OUT)
	if not expected_out.is_empty():
		write_expected(expected_out, suites)
	_runner = GdhRunner.new()
	_runner.own_path = get_script().resource_path
	_runner.add_test_suites(suites)
	_runner.skip_test_suites(listed(asked, SKIPPING))
	root.add_child(_runner)


func _finalize() -> void:
	queue_delete(_runner)


## Turns off the hooks of [constant UNREAD] among [param hooks], answering the scripts of those it
## turned off. Through the mark gdUnit4's own `is_enabled` reads, rather than its `enable_hook`,
## which writes the setting into `project.godot`: a run changes nothing in the tree.
static func unread_off(hooks: GdUnitTestSessionHookService) -> PackedStringArray:
	var off: PackedStringArray = []
	for hook: GdUnitTestSessionHook in hooks.enigne_hooks:
		var path: String = hook.get_script().resource_path
		if UNREAD.has(path):
			hook.set_meta("enabled", false)
			var _added: bool = off.append(path)
	return off


## [param suites] compiled inside one script, answered for the caller to hold so gdUnit4's own loads
## find them compiled. The engine keeps what it read of a class only while the compile that asked for
## it runs (`GDScriptCache`), so a suite compiled on its own reads again every class it reaches a
## member of, some seventy milliseconds a suite. As the preloads of one script naming every class of
## the game's own first, held from that script's compile, they share one reading of each: two hundred
## suites compiled in a third of the time they took one at a time. The names are public, since a
## private one unread is a warning and every warning an error, and each a variable, since a class is
## no constant expression. A suite that does not compile fails here and again when gdUnit4 loads it,
## which reports it as it would have. A directory listed is left to gdUnit4 to walk.
static func compiled_together(suites: PackedStringArray) -> GDScript:
	var lines: PackedStringArray = ["extends RefCounted"]
	var at: int = 0
	for named: String in held_classes():
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


## The classes [method compiled_together] names before the suites: the game's own GDScript classes,
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


## The argument after [param flag] in [param args], or "" when there is none.
static func argument_after(args: PackedStringArray, flag: String) -> String:
	var at: int = args.find(flag)
	if at < 0 or at + 1 >= args.size():
		return ""
	return args[at + 1]


## The errors each of [param suites] declares it expects, by suite path and then case name, read off
## the compiled suite's constants so a declaration is whatever the engine made of it. A suite
## declaring none is left out.
static func expected_by_suite(suites: PackedStringArray) -> Dictionary:
	var expected: Dictionary = {}
	for path: String in suites:
		if not path.ends_with(".gd") or not ResourceLoader.exists(path):
			continue
		var suite: Script = load(path)
		var declared: Variant = suite.get_script_constant_map().get(EXPECTED)
		if declared is Dictionary:
			expected[path] = declared
	return expected


static func write_expected(path: String, suites: PackedStringArray) -> void:
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		push_error("Could not write the expected errors to %s: %s" % [path, FileAccess.get_open_error()])
		return
	var _stored: bool = file.store_string(JSON.stringify(expected_by_suite(suites)))
	file.close()
