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
	if lines.slice(-2) != ["Hire", "Dismiss"]:
		_fail("an open menu reads as its items, a separator as nothing: %s" % str(opened))

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
