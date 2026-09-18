extends RefCounted

# A compiled regular expression, with a pattern that will not compile said rather than dropped.
#
# `RegEx.compile()` answers with an Error, and every caller here passes a literal its author had
# already checked by eye, so the answer was thrown away eleven times. A project holding
# `return_value_discarded` at error level will not compile a script that does that, and these
# scripts are compiled under the target project's warning levels rather than under this package's:
# one project turning that warning on loses every headless operation at once.
#
# A pattern that fails here is a mistake in this repository rather than anything a caller did, so
# it goes to the engine's error stream, where the operation's answer carries it back under
# `engine_messages`. The empty RegEx it then returns matches nothing, which is the honest result of
# a pattern that does not exist.


static func compiled(expression: String) -> RegEx:
	var regex: RegEx = RegEx.new()
	var built: Error = regex.compile(expression)
	if built != OK:
		push_error("gdharness: could not compile the pattern " + expression)
	return regex
