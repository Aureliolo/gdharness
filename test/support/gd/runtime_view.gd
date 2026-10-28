extends SceneTree
## What is out of view is not on the screen. Built here and checked against what was built, on the
## first frame, since nothing is in the tree until the main loop starts.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

var failures: Array[String] = []
var node: Runtime
var directory: String


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine.
	directory = OS.get_temp_dir().path_join("gdharness-view-%d" % OS.get_process_id())
	OS.set_environment("GDHARNESS_RUNTIME_DIR", directory)
	node = Runtime.new()
	root.add_child(node)
	Checked.done(
		process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame"
	)


func _run() -> void:
	# A headless script run's window is 64 by 64; a game's is the project's window size, which is
	# what this stands for. The new size is only in force from the next frame.
	root.size = Vector2i(640, 480)
	await process_frame
	await _check_words_out_of_view()
	node._cleanup()
	# Not checked: it is gone either way by the time the fixture tears itself down.
	var _took_directory: Error = DirAccess.remove_absolute(directory)

	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


## Words drawn past the window's edge, or scrolled out of a ScrollContainer, are not on the screen:
## a label placed past the edge was read out as written there. Reading the screen, a find of what
## the player sees and a wait for words leave them out and say how many, and everything asked with
## hidden ones included still has them. The rows in view are the positive beside each absence.
func _check_words_out_of_view() -> void:
	var holder: Control = Control.new()
	holder.name = "Edges"
	root.add_child(holder)
	var near: Label = Label.new()
	near.text = "Close by"
	holder.add_child(near)
	var far: Label = Label.new()
	far.name = "Far"
	far.text = "Far away"
	far.position = Vector2(100000, 100000)
	holder.add_child(far)
	var scroll: ScrollContainer = ScrollContainer.new()
	scroll.position = Vector2(0, 100)
	scroll.size = Vector2(120, 30)
	holder.add_child(scroll)
	var rows: VBoxContainer = VBoxContainer.new()
	scroll.add_child(rows)
	for said: String in ["Row one", "Row two", "Row three"]:
		var row: Label = Label.new()
		row.text = said
		row.custom_minimum_size = Vector2(80, 40)
		rows.add_child(row)
	await process_frame
	await process_frame

	var read: Dictionary = await node._execute_command("read_text", { "root": "/root/Edges" })
	if read.get("lines") != ["Close by", "Row one"] or read.get("out_of_view") != 3:
		_fail("the screen reads what is in view and counts the rest: %s" % str(read))
	if not str(read.get("note", "")).begins_with("3 lines drawn outside the viewport"):
		_fail("and says why they were left out: %s" % str(read))
	var whole: Dictionary = await node._execute_command(
		"read_text", { "root": "/root/Edges", "include_hidden": true }
	)
	if (
		whole.get("lines") != ["Close by", "Far away", "Row one", "Row two", "Row three"]
		or whole.has("out_of_view")
	):
		_fail("with hidden ones included every line is there: %s" % str(whole))

	var seen: Dictionary = await node._execute_command(
		"find_nodes", { "root": "/root/Edges", "class": "Label", "include_hidden": false }
	)
	if seen.get("count") != 2 or seen.get("out_of_view") != 3:
		_fail(
			(
				"a find of what the player sees leaves out what is out of view, and counts it: %s"
				% str(seen)
			)
		)
	var every: Dictionary = await node._execute_command(
		"find_nodes", { "root": "/root/Edges", "class": "Label" }
	)
	if every.get("count") != 5 or every.has("out_of_view"):
		_fail("and a find of the tree finds all five: %s" % str(every))

	var far_rect: Dictionary = await node._execute_command(
		"get_rect",
		{ "path": "/root/Edges/Far" },
	)
	var near_rect: Dictionary = await node._execute_command(
		"get_rect", { "path": str(near.get_path()) }
	)
	if far_rect.get("in_view") != false or near_rect.get("in_view") != true:
		_fail("a rect says whether it is in view: %s, %s" % [str(far_rect), str(near_rect)])

	var waited: Dictionary = await node._execute_command(
		"wait_until", { "path": "/root/Edges", "says": "Far away", "timeout_ms": 200 }
	)
	if (
		waited.get("met") != false
		or not str(waited.get("unseen_note", "")).contains("cannot read it")
	):
		_fail("a wait for words out of view runs out, and says they are there: %s" % str(waited))
	var row_wait: Dictionary = await node._execute_command(
		"wait_until", { "path": "/root/Edges", "says": "Row one", "timeout_ms": 200 }
	)
	if row_wait.get("met") != true or row_wait.has("unseen_note"):
		_fail("and one for words in view is met: %s" % str(row_wait))
	var hidden_wait: Dictionary = await node._execute_command(
		"wait_until",
		{ "path": "/root/Edges", "says": "Row three", "timeout_ms": 200, "include_hidden": true }
	)
	if hidden_wait.get("met") != true:
		_fail(
			(
				"and with hidden ones included, one for a row scrolled away is met too: %s"
				% str(hidden_wait)
			)
		)
	holder.free()
