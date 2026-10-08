/**
 * Seconds each regression of five or more takes on its slowest platform, from the engine legs' own
 * "took" lines (the run of #943, 2026-10-08, nine parts across three platforms). Every regression
 * not named here took under five seconds and is counted as `UNMEASURED_SECONDS`.
 *
 * Only the split reads these, so a stale figure costs balance and never coverage. Dealt out every
 * nth instead, the two halves of the Windows leg ran 578 and about 370 seconds, and the run waited
 * on the long one. Weighting only the regressions of twenty or more left the Windows parts at 439
 * and 268, the middle weights falling where they fell.
 */
export const REGRESSION_SECONDS: Readonly<Record<string, number>> = {
  testATestRunSaysHowFarItHasGot: 70,
  testAStartWaitsOutTheEditorsScan: 66,
  testGdUnitRunner: 65,
  testAnEditorWritesItsConsoleWhereTheServerLooks: 41,
  testAOneShotEngineRunIsNotTheEditor: 41,
  testAnInjectedMotionCarriesHowFarThePointerMoved: 35,
  testCommandLineSetup: 31,
  testARenameWithNoEditorLeavesTheCacheAndTheScriptsRight: 29,
  testAnEditorIsReadOnceItHasSaidWhoItIs: 28,
  testATestRunCutShortIsNamedForWhatItWasDoing: 27,
  testAStopGoesThroughTheKeeper: 27,
  testAReimportReimportsThroughTheEngine: 26,
  testAStopCanEndWhatTheGameStarted: 24,
  testARescanAsTheEditorOpensFindsNothingMissing: 23,
  testTheEditorsGameIsToldFromAnotherOfTheSameProject: 21,
  testAPredecessorThatKeepsThePortIsNotWaitedOnForEver: 16,
  testAKeyDoesNotChooseFromAnOpenedMenu: 16,
  testACaptureOfOneNodeIsThatNodeAtItsOwnPixels: 15,
  testACancelledWaitStopsAskingTheEditor: 15,
  testTheWaitIsSizedToTheLastBoot: 14,
  testTheAnnounceWaitIsNotHeldByASlowEditor: 14,
  testParametersReachTheEngine: 13,
  testARunOnItsOwnDesktopIsThere: 13,
  testARealBenchTakesItsWorkerWithIt: 13,
  testACaptureBeforeTheFirstFrameWaitsForIt: 12,
  testACancelledFolderStopsAsking: 12,
  testAnEditorStartedByAnEditorSaysSo: 11,
  testASupersededServerStandsDown: 11,
  testAStopTheEditorDidNotTakeIsNotAStop: 11,
  testARuntimeCallReachesThisServersOwnGame: 11,
  testALateAnnouncementIsTiedToThePlayedRun: 11,
  testACallTakesAnObjectByItsPath: 11,
  testDiagnosticsAnswerSeveralScripts: 10,
  testAWordsWaitLeavesTheGameItsSpeed: 10,
  testAnUpgradeReadsTheEngineOutOfTheConfigItRewrites: 9,
  testAnEditorAServerOpenedIsStartedAgain: 9,
  testAStatusCallIsNotHeldByAHeldGame: 7,
  testAForeignRunSurvivesAStart: 7,
  testRefreshingUidsMakesTheSidecarAndWritesNoScene: 6,
  testASubViewportCaptureIsDrawnNow: 6,
  testAStructureReadDescribesTheScriptItRead: 6,
  testASilentRunIsStartedHereAndSaysWhy: 6,
  testASettingsWriteIsTakenUpByTheEditor: 6,
  testARescanReloadsWhatNamesAClassItBroughtIn: 6,
  testDiagnosticsTimeoutIsNotAnEmptyResult: 5,
  testAScreenshotHoldsTheGamesOwnWindows: 5,
  testAPointerOnTheHiddenDesktopIsNoted: 5,
};

/**
 * What a regression too quick to have been measured is counted as. The ones under five seconds
 * averaged about half a second on Windows, the slowest platform, in the same run.
 */
export const UNMEASURED_SECONDS = 1;

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
