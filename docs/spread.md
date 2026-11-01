# Spread benches

`gdharness spread` plays a bench's runs over several headless engines at once. It prints the same
table the bench prints when it runs alone, to the last digit. A bench whose runs share nothing
(run `i` depends on `i` alone, its seed worked out from the index) is cut into one share per
worker. The outcomes of every run are gathered back in run order before the bench folds them.

## Running it

```text
gdharness spread res://bench/balance.tscn
gdharness spread res://bench/balance.tscn --workers 4
gdharness spread res://bench/balance.tscn -- --seed=3
```

The first takes as many workers as the machine has room for. The last hands `--seed=3` to every
engine.

It exits 0 when every worker played its whole share and the gathering run printed no error. It
exits 1 when anything went wrong. A wrong command line exits 2.

## Options

- `--workers N`: how many workers. The default is as many as the engine slots allow, fewer on a
  machine short of processors or memory, as for `gdharness test`.
- `--slots DIR`, `--slot-count N`: the engine slots, the machine's own by default, shared with
  `gdharness test` ([Test runs](test-runs.md#engine-slots)). With each worker and the gathering
  engine holding one, a bench and a gate running at once never start more engines than there are
  slots.
- `--silence S`: the shortest silence that ends an engine, in seconds, 300 by default. A worker
  prints a line every tenth of each arm's share, so a long arm should print well inside it.
- `--deadline S`, `--godot PATH`, `--godot-version V`, `--cores N`: as for `gdharness test`.
- Everything after `--` is handed to every engine as the bench's own arguments.

## Writing the bench

The bench is a scene. For each arm, it asks `GdhShare.outcomes` for the outcomes of that arm's
runs. It passes the arm's name, the number of runs and a callable that plays run `i` and returns
its outcome. `GdhShare` is in the tests addon, `addons/gdharness_tests`, which `gdharness setup`
installs.

```gdscript
extends Node


func _ready() -> void:
 var balance: Array = GdhShare.outcomes("balance", 120, _played)
 if not GdhShare.working():
  var totals: Dictionary[String, int] = GdhShare.added(balance, ["most_turns"])
  print("won %d of 120, longest %d turns" % [totals["won"], totals["most_turns"]])
 get_tree().quit()


func _played(run: int) -> Dictionary:
 var bout: Bout = Bout.new(SEED + run)
 bout.play()
 return {"won": 1 if bout.won else 0, "most_turns": bout.turns}
```

In a worker `GdhShare.working()` is true. The bench prints no table there. The helper
`GdhShare.added` sums outcomes that are dictionaries of whole numbers key by key. For the keys it is
given, it keeps the largest instead.

## How the scene runs

The same scene runs three ways. `GdhShare.outcomes` answers in each:

- Alone, as `godot res://bench/balance.tscn` runs it, it plays every run and answers every outcome.
- In a worker, it plays every Nth run from the worker's own index, to give each worker long and
  short runs alike. It answers an empty array and leaves the outcomes for the gathering engine.
- In the gathering engine, started once every worker has finished, it plays nothing. It answers
  every run's outcome in run order, each read back as the type it was written as.

The bench folds the outcomes the same way in all three. A float summed in run order comes out as it
does when the bench runs alone.

## What a bench keeps to

- An outcome is a plain value, such as a number, a string, a vector, or an array or dictionary of
  them. An object cannot pass between engines, so `GdhShare` refuses one with an error that fails
  the run.
- Which arms a bench plays, and how many runs each has, depend on its command line alone. Every
  engine runs the whole scene, so an arm chosen by the clock or by one worker's file differs between
  engines.
- Each arm has its own name. An arm asked for twice in one run is refused.
- The scene quits when it is done. An engine that never quits is ended after its silence and fails
  the run.

## What each engine gets

Each engine has its own `user://`, as test engines do. Two workers never write one save or
settings file. A bench that reads something from `user://` finds it empty.

No engine of a spread run announces itself to the gdharness server. The runtime stays off in an
engine handed the spread's arguments, whatever folder its scene is in.

## What fails a run

A spread run fails before anything is gathered when a worker does one of these:

- Was ended for its silence or its deadline, or exited with a code other than 0.
- Printed an engine error. The first is named.
- Played no arm, because its scene never asked `GdhShare.outcomes` or quit before it did.
- Played other arms, or other numbers of runs, than worker 0.

It fails after the gathering when the gathering engine printed an error or exited with a code
other than 0. It also fails when the gathering engine never asked for an arm the workers played.
The gathering engine's output is printed either way, with the faults after it. A table from a
failed run is marked as failed.

## Engine logs

Each engine's output is in `.godot/gdharness/spread-runs/<start>-<pid>/<engine>/engine.log`. A
failed run names that folder and keeps it until five later runs have failed.
