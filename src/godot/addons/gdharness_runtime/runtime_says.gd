extends RefCounted

## Whether a node says what a caller asked for in `says`: the one set of rules a find, a click and a
## wait all match words by, so the three never disagree about which control a word names.

const Words = preload("runtime_words.gd")

## Stands in for a bar written as `\|` while `says` is split into its alternatives: a character from
## the private use area, which no game's text uses.
const ESCAPED_BAR: String = ""

## How many splits [method alternatives] keeps. A find asks about two at once, the words it was given
## and the same words widened, and anything past a handful is a caller that has moved on.
const SPLITS_KEPT: int = 8

## Each `says` split into alternatives, by what was written; see [method alternatives].
static var _splits: Dictionary[String, Array] = {}

## Every space separator Unicode has besides the plain space, built once; see [method spaced].
static var _spaces: RegEx = null


## Whether [param node]'s own words are what [param wanted] asks for.
static func says(node: Node, wanted: String) -> bool:
	return matches(Words.said_by(node), wanted)


## Whether [param said] is what [param wanted] asks for.
##
## A plain word is a contains, which is what somebody looking for the row about a person means. A
## pattern is a glob, because [code]namePattern[/code] beside it is one and nobody writes `*Still*`
## in one field meaning a glob and in the other meaning those characters. Written as a contains
## only, a glob matched nothing at all and an empty answer reads as a control that is not on the
## screen: twice in one session here, over a button that was.
##
## Several alternatives separated by `|` match when any one of them does, each by those rules: a
## wait for the end of a turn is a wait for whichever of "won", "lost" or the next turn's words comes
## first, and read as one glob with the bars in it, it waited out its whole timeout for words no
## screen says.
static func matches(said: String, wanted: String) -> bool:
	var shown: String = spaced(said)
	for words: String in alternatives(wanted):
		if shown.containsn(words) if is_plain(words) else shown.matchn(words):
			return true
	return false


## [param text] with every Unicode space separator written as a plain space, which is what a caller
## types for any of them. A game keeping a name on one line writes it with a non-breaking space, and
## "Deskanem Bonituk" typed with a plain one found nothing while the screen showed exactly those
## words. One character for one, so a place found in the result is the same place in [param text].
static func spaced(text: String) -> String:
	if _spaces == null:
		var separators: String = (
			String.chr(0x00A0)
			+ String.chr(0x1680)
			+ String.chr(0x2000)
			+ "-"
			+ String.chr(0x200A)
			+ String.chr(0x202F)
			+ String.chr(0x205F)
			+ String.chr(0x3000)
		)
		_spaces = RegEx.create_from_string("[%s]" % separators)
	return _spaces.sub(text, " ", true)


## The alternatives [param wanted] names, each as words on a screen: split at every `|` not written
## as `\|`, which stays a bar in the words. An empty alternative, a stray bar at either end, is
## dropped: it names no words, and a find that came back empty widened it to `**` and suggested a
## pattern that matches every node there is.
##
## Kept once split, since a find, a click or a wait asks about the same words for every node on the
## screen: split afresh for each of them, one look over a hall of twenty thousand nodes took 210ms
## rather than 155ms. The array handed back is shared and not to be changed.
static func alternatives(wanted: String) -> Array[String]:
	var kept: Variant = _splits.get(wanted)
	if kept != null:
		var split: Array[String] = kept
		return split
	var found: Array[String] = split_at_bars(as_said(wanted))
	if _splits.size() >= SPLITS_KEPT:
		_splits.clear()
	_splits[wanted] = found
	return found


## [param written] split at every `|` not written as `\|`, empty alternatives dropped. Shared with a
## find's name, which takes alternatives by the same rule so the two arguments beside each other do
## not read a bar two ways: written in a name, `A|B` was one glob no node matched, and the empty
## answer came with no note.
static func split_at_bars(written: String) -> Array[String]:
	var found: Array[String] = []
	for part: String in written.replace("\\|", ESCAPED_BAR).split("|"):
		var words: String = part.replace(ESCAPED_BAR, "|")
		if not words.is_empty():
			found.append(words)
	return found


## [param parts] joined back into one pattern that [method split_at_bars] reads as them.
static func joined_at_bars(parts: Array[String]) -> String:
	var escaped: Array[String] = []
	for words: String in parts:
		escaped.append(words.replace("|", "\\|"))
	return "|".join(PackedStringArray(escaped))


## Whether [param pattern] is words written whole rather than as a glob, which is how a caller
## writes them when they mean "contains". [method String.matchn] answers nothing to it, and nothing
## is also what words that are simply not there answer.
static func is_plain(pattern: String) -> bool:
	return not pattern.is_empty() and not pattern.contains("*") and not pattern.contains("?")


## [param wanted], a glob, open at both ends so it matches its words anywhere in a text; "" when
## it is not a glob, or already open at both ends, and so has nothing to suggest.
static func widened(wanted: String) -> String:
	var open_ended: Array[String] = []
	var changed: bool = false
	for words: String in alternatives(wanted):
		var open: String = words
		if not is_plain(words):
			open = "*" + words.lstrip("*").rstrip("*") + "*"
			changed = changed or open != words
		open_ended.append(open.replace("|", "\\|"))
	return "|".join(open_ended) if changed else ""


## [param wanted] as words on a screen: a backslash followed by n is a line break.
##
## A button with two lines on it was asked for with the break written as the two characters, the
## way it is typed into a JSON string one escape short, and was answered as not there: 0 found,
## which reads as a control that is not on the screen. Nothing on a screen says a backslash and
## an n, so the two characters mean the break to everybody who writes them.
static func as_said(wanted: String) -> String:
	return spaced(wanted.replace("\\n", "\n"))
