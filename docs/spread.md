# Spread benches

`gdharness spread` plays a bench's runs over several headless engines at once and prints the same
table the bench prints when it runs alone, to the last digit. A bench whose runs share nothing
(run `i` depends on `i` alone, its seed worked out from the index) is cut into one share per
worker, and the outcomes of every run are gathered back in run order before the bench folds them.

```text
gdharness spread res://bench/balance.tscn                  as many workers as the machine has room for
gdharness spread res://bench/balance.tscn --workers 4
gdharness spread res://bench/balance.tscn -- --seed=3       --seed=3 goes to every engine
```

It exits 0 when every worker played its whole share and the gathering run printed no error, 1
when anything went wrong, and 2 when the command line itself is wrong.

- `--workers N`: how many workers. By default as many as the engine slots allow, held lower when
  the machine has too few processors or too little memory, as `gdharness test` holds its engines.
- `--slots DIR`, `--slot-count N`: the engine slots, shared with `gdharness test` and described in
  [Test runs](test-runs.md#engine-slots). Each worker and the gathering engine hold one, so a
  bench and a gate running at once start no more engines between them than there are slots.
- `--silence S`: the shortest silence that ends an engine, in seconds; 300 by default. A worker
  prints a line every tenth of each arm's share, so a long arm should print well inside it.
- `--deadline S`, `--godot PATH`, `--godot-version V`, `--cores N`: as for `gdharness test`.
- Everything after `--` is handed to every engine as the bench's own arguments.

## Writing the bench

The bench is a scene. For each arm, it asks `GdhShare.outcomes` for the outcomes of that arm's runs,
handing it the arm's name, the number of runs and a callable that plays run `i` and answers what
the run came to. `GdhShare` is in the tests addon, `addons/gdharness_tests`, which `gdharness
setup` installs.

```gdscript
extends Node


func _ready() -> void:
 var balance: Array = GdhShare.outcomes("balance", 120, _played)
 if not GdhShare.working():
  var totals: Dictionary[String, int] = GdhShare.added(balance, ["most_turns"])
  print("won %d of 120, longest %d turns" % [totals["won"], totals["most_turns"]])
 get_tree().quit()


func _played(run: int) -> Dictionary:
 var duel: Duel = Duel.new(SEED + run)
 duel.play()
 return {"won": 1 if duel.won else 0, "most_turns": duel.turns}
```

The same scene runs three ways, and `GdhShare.outcomes` answers in each:

- Alone, as `godot res://bench/balance.tscn` runs it, it plays every run and answers every outcome.
- In a worker, it plays every Nth run from the worker's own index, so each worker draws long runs
  and short ones alike. It leaves the outcomes for the gathering engine and answers an empty array.
  `GdhShare.working()` is true there, and the bench prints no table.
- In the gathering engine, started once every worker has finished, it plays nothing and answers
  every run's outcome in run order, each read back as the type it was written as.

The bench folds the outcomes the same way in all three, so a float summed in run order comes out
the same as when the bench runs alone. `GdhShare.added` adds up outcomes that are dictionaries of
whole numbers key by key, and keeps the largest for the keys it is given.

What a bench has to keep to:

- **An outcome is a plain value**: a number, a string, a vector, or an array or dictionary of
  them. An object cannot be handed from one engine to another; `GdhShare` refuses one with an error,
  which fails the run.
- **Which arms a bench plays, and how many runs each has, depend on its command line alone.** Every
  engine runs the whole scene, so an arm chosen by the clock or by a file one worker wrote is a
  different arm in another engine. A worker that plays other arms than worker 0, or a gathering
  run that skips an arm the workers played, fails the run.
- **Each arm has its own name.** An arm asked for twice in one run is refused.
- **The scene quits when it is done.** An engine that never quits is ended after its silence and
  fails the run.
- **Each engine has its own `user://`**, as test engines do, so two workers never write one save
  or settings file. A bench that reads something from `user://` finds it empty.

No engine of a spread run announces itself to the gdharness server: the runtime stays off in an
engine handed the spread's arguments, whatever folder its scene is in.

## What fails a run

A spread run fails before anything is gathered when a worker:

- was ended for its silence or its deadline, or exited with a code other than 0;
- printed an engine error, the first of which is named;
- played no arm, which is a scene that never asked `GdhShare.outcomes`, or quit before it did;
- played other arms, or other numbers of runs, than worker 0.

It fails after the gathering when the gathering engine printed an error or exited with a code
other than 0, or never asked for an arm the workers played. The gathering engine's output is
printed either way, followed by the faults, so a table printed by a run that failed is marked as
one. Each engine's output is in `.godot/gdharness/spread-runs/<start>-<pid>/<engine>/engine.log`,
which a failed run names and keeps until the next run.
