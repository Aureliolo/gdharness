/**
 * Seconds each regression of five or more takes on its slowest platform, from the engine legs' own
 * "took" lines (main's run for v1.1.59, 2026-10-09, nine parts across three platforms). Every
 * regression not named here took under five seconds and is counted as `UNMEASURED_SECONDS`.
 *
 * Only the split reads these, so a stale figure costs balance and never coverage. Dealt out every
 * nth instead, the two halves of the Windows leg ran 578 and about 370 seconds, and the run waited
 * on the long one. Weighting only the regressions of twenty or more left the Windows parts at 439
 * and 268, the middle weights falling where they fell.
 */
export const REGRESSION_SECONDS: Readonly<Record<string, number>> = {
  testGdUnitRunner: 71,
  testATestRunSaysHowFarItHasGot: 71,
  testAStartWaitsOutTheEditorsScan: 58,
  testAOneShotEngineRunIsNotTheEditor: 40,
  testAnInjectedMotionCarriesHowFarThePointerMoved: 37,
  testAStopGoesThroughTheKeeper: 30,
  testARenameWithNoEditorLeavesTheCacheAndTheScriptsRight: 29,
  testAnEditorIsReadOnceItHasSaidWhoItIs: 28,
  testAReimportReimportsThroughTheEngine: 28,
  testAnEditorWritesItsConsoleWhereTheServerLooks: 26,
  testATestRunCutShortIsNamedForWhatItWasDoing: 26,
  testAStopCanEndWhatTheGameStarted: 24,
  testARescanAsTheEditorOpensFindsNothingMissing: 24,
  testCommandLineSetup: 23,
  testTheEditorsGameIsToldFromAnotherOfTheSameProject: 22,
  testAPredecessorThatKeepsThePortIsNotWaitedOnForEver: 16,
  testACaptureBeforeTheFirstFrameWaitsForIt: 15,
  testACancelledWaitStopsAskingTheEditor: 15,
  testTheWaitIsSizedToTheLastBoot: 14,
  testTheAnnounceWaitIsNotHeldByASlowEditor: 14,
  testARealBenchTakesItsWorkerWithIt: 14,
  testACancelledFolderStopsAsking: 13,
  testACallTakesAnObjectByItsPath: 13,
  testARunOnItsOwnDesktopIsThere: 12,
  testAnEditorStartedByAnEditorSaysSo: 11,
  testAWordsWaitLeavesTheGameItsSpeed: 11,
  testASupersededServerStandsDown: 11,
  testAStopTheEditorDidNotTakeIsNotAStop: 11,
  testASilentRunIsStartedHereAndSaysWhy: 11,
  testARuntimeCallReachesThisServersOwnGame: 11,
  testALateAnnouncementIsTiedToThePlayedRun: 11,
  testAnUpgradeReadsTheEngineOutOfTheConfigItRewrites: 10,
  testAKeyDoesNotChooseFromAnOpenedMenu: 10,
  testAnEditorAServerOpenedIsStartedAgain: 9,
  testAStackOverflowIsNotAPass: 9,
  testParametersReachTheEngine: 8,
  testASubViewportCaptureIsDrawnNow: 8,
  testAPointerOnTheHiddenDesktopIsNoted: 8,
  testDiagnosticsAnswerSeveralScripts: 7,
  testAStatusCallIsNotHeldByAHeldGame: 7,
  testARescanReloadsWhatNamesAClassItBroughtIn: 7,
  testAForeignRunSurvivesAStart: 7,
  testRefreshingUidsMakesTheSidecarAndWritesNoScene: 6,
  testAnAnnotatedDeclarationIsStillADeclaration: 6,
  testASettingsWriteIsTakenUpByTheEditor: 6,
  testAProfiledRunNamesWhereItsTimeWent: 6,
  testDiagnosticsTimeoutIsNotAnEmptyResult: 5,
  testAStructureReadDescribesTheScriptItRead: 5,
  testAScreenshotHoldsTheGamesOwnWindows: 5,
};

/**
 * Seconds the engine fixtures took on macOS (158 in the run above), where they run on the first
 * regression part's machine rather than one of their own. GitHub runs five macOS jobs at once for the
 * account, and a run that asked for five queued behind any other run holding one: a pull request's
 * run beside main's, or the release's install check beside the release commit's, waited up to eight
 * minutes for a machine.
 */
export const ENGINE_FIXTURES_SECONDS = 160;

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
  firstPartCarries = 0,
): string[] {
  const weight = (name: string): number => seconds[name] ?? UNMEASURED_SECONDS;
  const order = names
    .map((name, at) => ({ name, at }))
    .sort((a, b) => weight(b.name) - weight(a.name) || a.at - b.at);
  // Work the first part's machine does besides its regressions, so the rest are dealt round it.
  const loads = Array.from({ length: parts }, (_unused, at) => (at === 0 ? firstPartCarries : 0));
  const placed = new Map<string, number>();
  for (const { name } of order) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] = (loads[lightest] ?? 0) + weight(name);
    placed.set(name, lightest + 1);
  }
  return names.filter((name) => placed.get(name) === part);
}
