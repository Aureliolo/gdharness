extends RefCounted

# A value out of a request that arrived as JSON, as the type the caller wants.
#
# `int(value)`, `float(value)` and `bool(value)` take a Variant, and a project holding
# `unsafe_call_argument` at error level will not compile a script that hands one over. The
# conversion is the same; what changes is that the type is established first, on a typed local, and
# the conversion happens from that.
#
# A copy rather than a preload of the one beside the operations, because an addon is installed as a
# directory and has to hold everything it uses. This one ships inside exported games, so it must not
# reach into the editor addon, which does not.
#
# `fallback` answers a value that is there and is null, which is a caller sending JSON null where a
# number was expected. Absent keys never reach here: the callers pass their own default to
# `Dictionary.get`, so what arrives is that default.


static func as_int(value: Variant, fallback: int = 0) -> int:
	if value is int:
		var already: int = value
		return already
	if value is float:
		var real: float = value
		return int(real)
	if value is bool:
		var flag: bool = value
		return 1 if flag else 0
	if value is String:
		var text: String = value
		return text.to_int()
	return fallback


static func as_float(value: Variant, fallback: float = 0.0) -> float:
	if value is float:
		var already: float = value
		return already
	if value is int:
		var whole: int = value
		return float(whole)
	if value is bool:
		var flag: bool = value
		return 1.0 if flag else 0.0
	if value is String:
		var text: String = value
		return text.to_float()
	return fallback


static func as_bool(value: Variant, fallback: bool = false) -> bool:
	if value is bool:
		var already: bool = value
		return already
	if value is int:
		var whole: int = value
		return whole != 0
	if value is float:
		var real: float = value
		return not is_zero_approx(real)
	if value is String:
		var text: String = value
		return not text.is_empty()
	return fallback
