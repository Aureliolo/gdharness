extends RefCounted

# A value out of a dictionary that came from JSON, as the type the operation wants.
#
# `int(value)`, `float(value)` and `bool(value)` take a Variant, and a project holding
# `unsafe_call_argument` at error level will not compile a script that hands one over. These
# scripts are compiled under the target project's warning levels rather than under this package's,
# because `--path` makes that project the loaded one and the file's living in the npm cache
# changes nothing: one project turning that warning on lost every headless operation at once.
#
# The conversion itself is the same. What changes is that the type is established first, on a
# typed local, and the conversion happens from that. Here rather than at each of the thirty-one
# places that read a parameter, because thirty-one is how many chances there are to write the old
# form again, and the error does not appear until somebody sets the warning.
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
