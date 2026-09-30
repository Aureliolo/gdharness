extends SceneTree

## What a running screen says, read the way a player reads it: rich text as its words, a line being
## typed out as far as it is drawn, the items of the controls that draw a list, and translations,
## capitals and masks as they are drawn. Nothing is in the tree until the main loop starts, so the
## checks run on the first frame rather than in _init.

const Checked = preload("checked.gd")
const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

var failures: Array[String] = []
var node: Runtime
var directory: String


func _init() -> void:
	# Announced somewhere private, so the fixture does not look like a game to a server running
	# on this machine.
	directory = OS.get_temp_dir().path_join("gdharness-words-%d" % OS.get_process_id())
	OS.set_environment("GDHARNESS_RUNTIME_DIR", directory)
	node = Runtime.new()
	root.add_child(node)
	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _run() -> void:
	await _check_reading_rich_text()
	await _check_reading_lists()
	await _check_reading_as_drawn()
	await _check_a_long_screen()
	await _check_a_near_miss_counts_what_would_be_found()
	await _check_names_as_alternatives()
	node._cleanup()
	# Not checked: it is gone either way by the time the fixture tears itself down.
	var _took_directory: Error = DirAccess.remove_absolute(directory)

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


## A limit can be raised past the default and is refused past the ceiling. The ceiling was the
## default for a read and 1000 for a find, so a longer screen answered that many whatever limit was
## asked for, with nothing saying the ask had been cut.
func _check_a_long_screen() -> void:
	var long: VBoxContainer = VBoxContainer.new()
	long.name = "Long"
	root.add_child(long)
	for index: int in range(1200):
		var line: Label = Label.new()
		line.text = "line %d" % index
		long.add_child(line)
	await process_frame
	var all: Dictionary = await node._execute_command("read_text", {"root": "/root/Long", "limit": 1200})
	if all.get("count") != 1200 or all.get("omitted") != 0:
		_fail("a limit above the default reads that many lines: %s" % str(all.get("count")))
	var many: Dictionary = await node._execute_command(
		"find_nodes", {"class": "Label", "root": "/root/Long", "limit": 1500}
	)
	if many.get("count") != 1200:
		_fail("and a find past the old ceiling answers every match: %s" % str(many.get("count")))
	for command: String in ["read_text", "find_nodes"]:
		var too_many: Dictionary = await node._execute_command(
			command, {"class": "Label", "root": "/root/Long", "limit": 6000}
		)
		if too_many.get("type") != "error" or not str(too_many.get("message", "")).contains("5000"):
			_fail("%s past the ceiling is refused, naming it: %s" % [command, str(too_many)])
	long.queue_free()


## The notes on a find that missed name a query that would find something, so they count what that
## query would answer. Under includeHidden false they counted hidden nodes too, and the query they
## named, asked the same way, found none.
func _check_a_near_miss_counts_what_would_be_found() -> void:
	var shut: Control = Control.new()
	shut.name = "Shut"
	shut.visible = false
	root.add_child(shut)
	for index: int in range(2):
		var enemy: Label = Label.new()
		enemy.name = "Enemy%d" % index
		enemy.text = "the dragon wakes"
		shut.add_child(enemy)
	await process_frame

	var by_name: Dictionary = await node._execute_command(
		"find_nodes", {"name": "Enemy", "include_hidden": false}
	)
	var said: String = str(by_name.get("note", ""))
	if not said.contains(
		'2 hidden node names contain "Enemy", which "*Enemy*" with includeHidden true would find'
	):
		_fail("a near miss on hidden nodes names the query that finds them: %s" % str(by_name))
	var by_words: Dictionary = await node._execute_command(
		"find_nodes", {"says": "dragon*", "include_hidden": false}
	)
	if not str(by_words.get("note", "")).contains(
		'"*dragon*" with includeHidden true would find 2 hidden nodes'
	):
		_fail("and so does one on the words they hold: %s" % str(by_words))
	var shown_too: Dictionary = await node._execute_command("find_nodes", {"name": "Enemy"})
	if not str(shown_too.get("note", "")).contains(
		'2 node names contain "Enemy", which "*Enemy*" would find'
	):
		_fail("counted as findable where hidden nodes are found: %s" % str(shown_too))
	shut.queue_free()


## A name given as alternatives, the way `says` beside it takes them. Read as one glob, `Hero|Dragon`
## matched no node, and the near-miss count looked for a name containing the bar, so the empty answer
## came with no note at all.
func _check_names_as_alternatives() -> void:
	var cast: Node2D = Node2D.new()
	cast.name = "Cast"
	root.add_child(cast)
	for called: String in ["Hero", "Heroine"]:
		var person: Node2D = Node2D.new()
		person.name = called
		cast.add_child(person)
	var docket: Label = Label.new()
	docket.name = "Docket"
	cast.add_child(docket)
	# A bar is legal in a node name, so one written as `\|` stays a bar.
	var barred: Node = Node.new()
	barred.name = "Left|Right"
	cast.add_child(barred)
	if str(barred.name) != "Left|Right":
		_fail("the engine kept the bar in the name, which the rest of this assumes: %s" % barred.name)
	await process_frame

	var either: Dictionary = await _find_in_cast("Hero|Dragon")
	if _paths(either) != ["/root/Cast/Hero"] or either.has("note"):
		_fail("a name of alternatives finds the node any one of them names: %s" % str(either))
	var both: Dictionary = await _find_in_cast("heroine|HERO")
	if _paths(both) != ["/root/Cast/Hero", "/root/Cast/Heroine"]:
		_fail("each alternative is a whole name, case-insensitively: %s" % str(both))
	var globbed: Dictionary = await _find_in_cast("Dragon|hero*")
	if _paths(globbed) != ["/root/Cast/Hero", "/root/Cast/Heroine"]:
		_fail("an alternative can be a glob: %s" % str(globbed))

	var near: Dictionary = await _find_in_cast("ero|Dock")
	var said: String = str(near.get("note", ""))
	if (
		near.get("count") != 0
		or not said.contains('3 node names contain "ero" or "Dock"')
		or not said.contains('"*ero*|*Dock*" would find')
	):
		_fail("a near miss is counted over every alternative and the glob offered keeps them: %s" % str(near))

	var nothing: Dictionary = await _find_in_cast("|")
	if nothing.get("type") != "error" or not str(nothing.get("message", "")).contains("names no node"):
		_fail("a name of bars alone is refused rather than read as no filter: %s" % str(nothing))

	var escaped: Dictionary = await _find_in_cast("Left\\|Right")
	if _paths(escaped) != ["/root/Cast/Left|Right"]:
		_fail("a bar written as \\| is part of the name: %s" % str(escaped))
	var split: Dictionary = await _find_in_cast("Left|Right")
	if split.get("count") != 0:
		_fail("and one written bare separates two names neither of which is there: %s" % str(split))
	# The glob offered is read back by the same split, so a bar inside a word stays escaped in it.
	var inside: Dictionary = await _find_in_cast("eft\\|Ri")
	if inside.get("count") != 0 or not str(inside.get("note", "")).contains('"*eft\\|Ri*" would find'):
		_fail("a near miss on a word with a bar in it offers a glob that keeps the bar: %s" % str(inside))
	cast.queue_free()


func _find_in_cast(name_pattern: String) -> Dictionary:
	return await node._execute_command("find_nodes", {"name": name_pattern, "root": "/root/Cast"})


func _paths(reply: Dictionary) -> Array[String]:
	var paths: Array[String] = []
	var nodes: Array = reply.get("nodes", [])
	for entry: Dictionary in nodes:
		paths.append(str(entry.get("path", "")))
	return paths


## A RichTextLabel reads as its words, not its markup. Its text is the BBCode when it reads BBCode,
## and a dossier line came back as "[b][color=#4fc2d4]Mollum Telken[/color], [/b]...", so a phrase
## running across a tag could be neither read, found nor waited for. And a line a game adds with
## append_text() is in no property at all.
func _check_reading_rich_text() -> void:
	var dossier: VBoxContainer = VBoxContainer.new()
	dossier.name = "Dossier"
	root.add_child(dossier)
	var marked: RichTextLabel = RichTextLabel.new()
	marked.bbcode_enabled = true
	marked.fit_content = true
	marked.text = "[b][color=#4fc2d4]Mollum Telken[/color], [/b][color=#c2ae92]a thief-taker[/color]"
	dossier.add_child(marked)
	var appended: RichTextLabel = RichTextLabel.new()
	appended.fit_content = true
	appended.append_text("Docket 72, [b]an errand[/b]")
	dossier.add_child(appended)
	await process_frame

	var said: Dictionary = await node._execute_command("read_text", {"root": "/root/Dossier"})
	var lines: Array = said.get("lines", [])
	if lines != ["Mollum Telken, a thief-taker", "Docket 72, an errand"]:
		_fail("rich text reads as what is drawn, with no tags in it: %s" % str(said))

	var found: Dictionary = await node._execute_command(
		"find_nodes", {"says": "Telken, a thief", "root": "/root/Dossier"}
	)
	if found.get("count") != 1:
		_fail("a phrase running across a tag is found: %s" % str(found))

	# A line being typed out says as much of itself as is drawn, so a wait for its words is not met
	# before the player can read them. A Label by count, a RichTextLabel by ratio, which sets the count.
	var typed: Label = Label.new()
	typed.text = "Spring 17"
	typed.visible_characters = 6
	dossier.add_child(typed)
	marked.visible_ratio = 0.5
	await process_frame
	var partway: Dictionary = await node._execute_command("read_text", {"root": "/root/Dossier"})
	var shown: Array = partway.get("lines", [])
	if shown != ["Mollum Telken,", "Docket 72, an errand", "Spring"]:
		_fail("text being typed out reads as far as it is drawn: %s" % str(partway))
	var early: Dictionary = await node._execute_command(
		"find_nodes", {"says": "Spring 17", "root": "/root/Dossier"}
	)
	if early.get("count") != 0:
		_fail("and its words are not found before they are shown: %s" % str(early))

	dossier.free()


## The controls that draw a list of text rather than holding one `text`: tab titles, list items, tree
## rows and an open menu's items. Each read as nothing, so a screen of tabs and lists came back as its
## labels alone and a wait for a tab's title was never met.
func _check_reading_lists() -> void:
	var board: VBoxContainer = VBoxContainer.new()
	board.name = "Board"
	root.add_child(board)
	var tabs: TabContainer = TabContainer.new()
	board.add_child(tabs)
	for title: String in ["Roster", "Ledger"]:
		var page: Control = Control.new()
		page.name = title
		tabs.add_child(page)
	var names: ItemList = ItemList.new()
	var _ada: int = names.add_item("Ada")
	var _bram: int = names.add_item("Bram")
	board.add_child(names)
	var tree: Tree = Tree.new()
	var guild: TreeItem = tree.create_item()
	guild.set_text(0, "Guild")
	var member: TreeItem = tree.create_item(guild)
	member.set_text(0, "Cass")
	var kit: TreeItem = tree.create_item(member)
	kit.set_text(0, "Blade")
	member.collapsed = true
	board.add_child(tree)
	var menu: PopupMenu = PopupMenu.new()
	menu.add_item("Hire")
	menu.add_separator()
	menu.add_separator("Staff")
	menu.add_item("Dismiss")
	board.add_child(menu)
	await process_frame

	var closed: Dictionary = await node._execute_command("read_text", {"root": "/root/Board"})
	if closed.get("lines", []) != ["Roster", "Ledger", "Ada", "Bram", "Guild", "Cass"]:
		_fail("tabs, list items and tree rows read as lines, and not under a collapsed row: %s" % str(closed))

	menu.show()
	await process_frame
	var opened: Dictionary = await node._execute_command("read_text", {"root": "/root/Board"})
	var lines: Array = opened.get("lines", [])
	# A titled separator is drawn as a heading and read in its place; one with no title draws no words.
	if lines.slice(-3) != ["Hire", "Staff", "Dismiss"]:
		_fail("an open menu reads as its items and its separators' titles, in order: %s" % str(opened))

	var found: Dictionary = await node._execute_command(
		"find_nodes", {"says": "Ledger", "root": "/root/Board"}
	)
	var matched: Array = found.get("nodes", [])
	var first: Dictionary = matched[0] if not matched.is_empty() else {}
	if found.get("count") != 1 or first.get("type") != "TabBar":
		_fail("a tab is found by its title, as the bar that draws it: %s" % str(found))

	board.free()


## A game with translations holds keys and draws what they translate to, so every line here is a
## key with a translation. No key contains its translation, since a find matches a contains and
## `UI_HIRE` would be found by "Hire" untranslated. The lines that stay keys say why: a list item
## whose own setting turns translation off, and a field showing what somebody typed. An upper-case
## label draws capitals, a secret field a mask, and a menu bar and a tree's column titles draw
## words no `text` holds.
func _check_reading_as_drawn() -> void:
	var words: Translation = Translation.new()
	words.locale = TranslationServer.get_locale()
	words.add_message("ACT_ENGAGE", "Hire")
	words.add_message("COL_PAY", "Wages")
	words.add_message("HEAD_STAFF", "Roster")
	words.add_message("TAB_BOOKS", "Ledger")
	TranslationServer.add_translation(words)

	var desk: VBoxContainer = VBoxContainer.new()
	desk.name = "Desk"
	root.add_child(desk)
	var hire: Button = Button.new()
	hire.text = "ACT_ENGAGE"
	desk.add_child(hire)
	var heading: Label = Label.new()
	heading.text = "HEAD_STAFF"
	heading.uppercase = true
	desk.add_child(heading)
	var password: LineEdit = LineEdit.new()
	password.secret = true
	password.text = "hunter2"
	desk.add_child(password)
	var typed: LineEdit = LineEdit.new()
	typed.text = "COL_PAY"
	desk.add_child(typed)
	var bar: MenuBar = MenuBar.new()
	desk.add_child(bar)
	var file_menu: PopupMenu = PopupMenu.new()
	file_menu.name = "File"
	bar.add_child(file_menu)
	var pay_menu: PopupMenu = PopupMenu.new()
	pay_menu.name = "Pay"
	pay_menu.title = "COL_PAY"
	bar.add_child(pay_menu)
	var ledger: Tree = Tree.new()
	ledger.columns = 2
	ledger.column_titles_visible = true
	ledger.hide_root = true
	ledger.set_column_title(0, "Name")
	ledger.set_column_title(1, "COL_PAY")
	var top: TreeItem = ledger.create_item()
	var row: TreeItem = ledger.create_item(top)
	row.set_text(0, "Ada")
	row.set_text(1, "COL_PAY")
	var unpaid: TreeItem = ledger.create_item(top)
	unpaid.set_text(0, "Bram")
	unpaid.set_text(1, "COL_PAY")
	unpaid.set_auto_translate_mode(1, Node.AUTO_TRANSLATE_MODE_DISABLED)
	desk.add_child(ledger)
	var codes: ItemList = ItemList.new()
	var _translated: int = codes.add_item("ACT_ENGAGE")
	var kept: int = codes.add_item("ACT_ENGAGE")
	codes.set_item_auto_translate_mode(kept, Node.AUTO_TRANSLATE_MODE_DISABLED)
	desk.add_child(codes)
	var books: TabBar = TabBar.new()
	books.add_tab("TAB_BOOKS")
	desk.add_child(books)
	var orders: PopupMenu = PopupMenu.new()
	orders.add_item("ACT_ENGAGE")
	orders.add_item("ACT_ENGAGE")
	orders.set_item_auto_translate_mode(1, Node.AUTO_TRANSLATE_MODE_DISABLED)
	desk.add_child(orders)
	orders.show()
	await process_frame

	var read: Dictionary = await node._execute_command("read_text", {"root": "/root/Desk"})
	var expected: Array[String] = [
		"Hire",
		"ROSTER",
		password.secret_character.repeat(7),
		"COL_PAY",
		"File",
		"Wages",
		"Name  Wages",
		"Ada  Wages",
		"Bram  COL_PAY",
		"Hire",
		"ACT_ENGAGE",
		"Ledger",
		"Hire",
		"ACT_ENGAGE",
	]
	if read.get("lines", []) != expected:
		_fail("a screen reads as drawn, translations, capitals and masks included: %s" % str(read))
	if str(read).contains("hunter2"):
		_fail("a secret field's words are not read back: %s" % str(read))

	var found: Dictionary = await node._execute_command(
		"find_nodes", {"says": "Hire", "root": "/root/Desk", "class": "Button"}
	)
	if found.get("count") != 1:
		_fail("a button is found by the translation it draws: %s" % str(found))

	desk.free()
	TranslationServer.remove_translation(words)
