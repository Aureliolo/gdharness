/**
 * Seconds each slow regression takes on the slowest platform, from the engine legs' own "took"
 * lines (1.1.52's release pull request, 2026-10-08). Every regression not named here took under
 * twenty seconds and is counted as `UNMEASURED_SECONDS`.
 *
 * Only the split reads these, so a stale figure costs balance and never coverage. Dealt out every
 * nth instead, the two halves of the Windows leg ran 578 and about 370 seconds, and the run waited
 * on the long one.
 */
export const REGRESSION_SECONDS: Readonly<Record<string, number>> = {
  testATestRunSaysHowFarItHasGot: 75,
  testGdUnitRunner: 68,
  testAStartWaitsOutTheEditorsScan: 65,
  testAOneShotEngineRunIsNotTheEditor: 41,
  testAnEditorWritesItsConsoleWhereTheServerLooks: 33,
  testAnEditorIsReadOnceItHasSaidWhoItIs: 28,
  testAnInjectedMotionCarriesHowFarThePointerMoved: 27,
  testAStopGoesThroughTheKeeper: 27,
  testATestRunCutShortIsNamedForWhatItWasDoing: 27,
  testARescanAsTheEditorOpensFindsNothingMissing: 26,
  testARenameWithNoEditorLeavesTheCacheAndTheScriptsRight: 25,
  testCommandLineSetup: 25,
  testAStopCanEndWhatTheGameStarted: 24,
  testTheEditorsGameIsToldFromAnotherOfTheSameProject: 21,
  testAReimportReimportsThroughTheEngine: 20,
};

/** What a regression too quick to have been measured is counted as: the leg's mean below twenty. */
export const UNMEASURED_SECONDS = 2;

/**
 * The [param part]th of [param parts] parts of [param names], counted from one, in their own order.
 *
 * Heaviest first, each to the part carrying least so far, which leaves no part more than the
 * heaviest single regression above another. Every part is computed from the same list, so the
 * parts cover it exactly once whichever machine computes which.
 */
export function regressionPart(
  names: readonly string[],
  part: number,
  parts: number,
  seconds: Readonly<Record<string, number>> = REGRESSION_SECONDS,
): string[] {
  const weight = (name: string): number => seconds[name] ?? UNMEASURED_SECONDS;
  const order = names
    .map((name, at) => ({ name, at }))
    .sort((a, b) => weight(b.name) - weight(a.name) || a.at - b.at);
  const loads = Array.from({ length: parts }, () => 0);
  const placed = new Map<string, number>();
  for (const { name } of order) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] = (loads[lightest] ?? 0) + weight(name);
    placed.set(name, lightest + 1);
  }
  return names.filter((name) => placed.get(name) === part);
}
