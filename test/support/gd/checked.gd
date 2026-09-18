extends RefCounted

## Calls a fixture makes for their effect, whose answer it still may not drop.
##
## The fixture project holds every GDScript warning this engine has at error level,
## `return_value_discarded` among them, so scaffolding that throws away an Error will not compile.
## Reading it here is worth more than silencing it: a fixture whose setup half worked goes on to
## report on a game it never built, and a failure said through push_error reaches stderr, where
## assertNoEngineErrors fails the fixture that ignored it.


static func done(status: Error, what: String) -> void:
	if status != OK:
		push_error("fixture setup failed: %s (%s)" % [what, error_string(status)])


static func worked(success: bool, what: String) -> void:
	if not success:
		push_error("fixture setup failed: %s" % what)
