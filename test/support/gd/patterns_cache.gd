extends SceneTree

## Whether `Patterns.compiled` hands back the same object for a pattern it has already built.
##
## The cache is argued for in the source at length and was held by nothing, which is the shape a
## carefully written note hides: the readers call it once per line of every script in a project,
## so a fresh compile each time is the whole cost of the scan, and taking the cache away breaks no
## answer anywhere. Nothing would have failed.
##
## Asked with `is_same` rather than `==`, because two RegEx built from one pattern match the same
## text and compare equal on everything this could otherwise look at. Identity is the claim.

const Patterns = preload("res://operations/patterns.gd")


func _initialize() -> void:
	var first: RegEx = Patterns.compiled("^abc")
	var again: RegEx = Patterns.compiled("^abc")
	var other: RegEx = Patterns.compiled("^xyz")

	var findings: Dictionary = {
		"ok": true,
		"same_pattern_is_one_object": is_same(first, again),
		# The positive beside it: a cache that answered with one object for everything would
		# satisfy the line above perfectly, and this is what separates holding from hoarding.
		"different_patterns_are_not": not is_same(first, other),
		# And the thing it is a cache of still works, so an empty RegEx handed back by a failed
		# compile cannot pass as a hit.
		"it_still_matches": first.search("abcdef") != null,
		"it_still_refuses": first.search("zabc") == null,
	}
	print(JSON.stringify(findings))
	quit()
