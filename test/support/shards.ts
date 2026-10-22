/**
 * Seconds each regression of five or more takes on its slowest platform, from the engine legs' own
 * "took" lines (two runs of the nine parts across three platforms, the larger figure kept). Every
 * regression not named here took under five seconds and is counted as `UNMEASURED_SECONDS`.
 *
 * Only the split reads these, so a stale figure costs balance and never coverage, until a part runs
 * into its job's timeout: with figures taken before the slowest of today's regressions were written, the first macOS
 * part carried 679 seconds of regressions and 339 of engine fixtures, and was cancelled at twenty
 * minutes while the other two finished in fourteen. Dealt out every nth instead, the two halves of
 * the Windows leg ran 578 and about 370 seconds, and the run waited on the long one.
 */
export const REGRESSION_SECONDS: Readonly<Record<string, number>> = {
  testARescanTheEditorDidNotAnswerIsFinishedByTheNext: 143,
  testAnAnimationIsWrittenWithNoEditor: 117,
  testAPresetIsSetRemovedAndPacked: 109,
  testAWriteWithNoEditorGoesThroughAHeadlessEngine: 109,
  testTheTestCommandRunsAndJudgesAProject: 103,
  testASceneKeepsItsOwnValuesForAnotherScenesNodes: 97,
  testAWriteReadsWhatThePropertyDeclares: 92,
  testGdUnitRunner: 86,
  testATestRunSaysHowFarItHasGot: 76,
  testAThemeAndATilesetWithNoEditor: 73,
  testAReimportReimportsThroughTheEngine: 56,
  testATestRunCutShortIsNamedForWhatItWasDoing: 52,
  testARunawayTestRunAnswersASizeTheClientTakes: 50,
  testAStartWaitsOutTheEditorsScan: 46,
  testAOneShotEngineRunIsNotTheEditor: 46,
  testANodeKeepsItsGroupsAndItsPlace: 45,
  testARunImportsWhatChangedFirst: 44,
  testACallWaitsForTheEditorThisServerOpened: 44,
  testAGameHeldInACallHasTheCall: 43,
  testAnEditorWritesItsConsoleWhereTheServerLooks: 42,
  testARealBenchTakesItsWorkerWithIt: 36,
  testCommandLineSetup: 36,
  testANavigationRegionIsBakedWithNoEditor: 36,
  testTheWaitIsSizedToTheLastBoot: 35,
  testAnInjectedMotionCarriesHowFarThePointerMoved: 35,
  testAMovedNodeIsFollowedIntoTheScenesNamingIt: 32,
  testARescanAsTheEditorOpensFindsNothingMissing: 32,
  testAProjectsFilesAndLayersAreNamedWithNoEditor: 30,
  testACallTakesAnObjectByItsPath: 30,
  testTheEditorsGameIsToldFromAnotherOfTheSameProject: 30,
  testProjectTestJudgesItsRunAsTheGateDoes: 30,
  testAnEngineGdharnessStartsCanHaveItsCrashReported: 29,
  testAnImportOrExportOverAStaleDocCacheRunsAgain: 28,
  testATestRunNamesItsLeaksAndItsUnusedIgnores: 27,
  testThePhysicsRateIsTheStepsTaken: 27,
  testAnEditorThisServerStartsIsSilentUnlessAsked: 26,
  testAReadWithNoEditorAnswersFromTheFile: 25,
  testWhatTheGameTellsAScreenReaderIsRead: 25,
  testAPointerOnTheHiddenDesktopIsNoted: 24,
  testTheShippedRunnerRunsAFileOfSuites: 22,
  testAWordsWaitLeavesTheGameItsSpeed: 20,
  testATestRunTakesTheCasesNamed: 20,
  testAStackOverflowIsNotAPass: 19,
  testARenameWithNoEditorLeavesTheCacheAndTheScriptsRight: 19,
  testAStopGoesThroughTheKeeper: 18,
  testALateAnnouncementIsTiedToThePlayedRun: 18,
  testThePowerShellHelperGoesWithItsProcess: 17,
  testEveryHiddenStartIsStartedHidden: 16,
  testAnUpgradeReadsTheEngineOutOfTheConfigItRewrites: 16,
  testAPredecessorThatKeepsThePortIsNotWaitedOnForEver: 16,
  testASelfContainedEngineKeepsItsTemplates: 16,
  testAnEditorIsReadOnceItHasSaidWhoItIs: 15,
  testAWindowedRunWritesItsMovie: 15,
  testACancelledWaitStopsAskingTheEditor: 15,
  testAQuietSceneIsNotServed: 14,
  testAProfiledRunNamesWhereItsTimeWent: 14,
  testAMovedNodeKeepsThePathsNamingIt: 14,
  testAKeyDoesNotChooseFromAnOpenedMenu: 14,
  testACaptureBeforeTheFirstFrameWaitsForIt: 14,
  testATestRunWhoseAutoloadDidNotCompileStops: 14,
  testTheRendererIsChosenAndItsMemoryRead: 14,
  testTheAnnounceWaitIsNotHeldByASlowEditor: 14,
  testAMoveWithNoEditorLeavesTheProjectLoading: 14,
  testASettingsWriteIsTakenUpByTheEditor: 13,
  testParametersReachTheEngine: 13,
  testAHandWrittenValueIsNoChangeOfAScripts: 13,
  testA3DLevelIsReadAsItIsWritten: 12,
  testAGameThisServerStartedIsDebugged: 12,
  testACancelledFolderStopsAsking: 12,
  testAnEditorStartedByAnEditorSaysSo: 12,
  testARunOnItsOwnDesktopIsThere: 11,
  testAWriteSaysWhatElseItChanged: 11,
  testARuntimeCallReachesThisServersOwnGame: 11,
  testAStopCanEndWhatTheGameStarted: 11,
  testDiagnosticsWithoutAnEditorComeFromTheEngine: 11,
  testAControlIsLaidOutAsTheEditorLaysItOut: 11,
  testAnAnnotatedDeclarationIsStillADeclaration: 11,
  testTheLifecycleLogSaysHowAServerEnded: 11,
  testASupersededServerStandsDown: 10,
  testAStopAsksTheGameToCloseFirst: 10,
  testAPlayedGameIsToldFromItsWorkers: 10,
  testAnAddedPresetExports: 10,
  testAProfileFromTheStartWaitsForTheProfiler: 9,
  testEditorStatusCountsOnlyOtherCallsInFlight: 9,
  testAStatusCallIsNotHeldByAHeldGame: 9,
  testAStructureReadDescribesTheScriptItRead: 8,
  testAToolWaitsOutTheEditorsScan: 8,
  testARescanReloadsWhatNamesAClassItBroughtIn: 8,
  testAnElementIsToldWhatItsTypeTakes: 7,
  testAScreenshotHoldsTheGamesOwnWindows: 7,
  testDiagnosticsAnswerSeveralScripts: 7,
  testCallsSentTogetherWaitTheirTurnAtTheGame: 7,
  testASubViewportCaptureIsDrawnNow: 7,
  testAForeignRunSurvivesAStart: 7,
  testTheFrameTimeIsTheFrame: 6,
  testACaptureOfOneNodeIsThatNodeAtItsOwnPixels: 6,
  testASilentRunIsStartedHereAndSaysWhy: 6,
  testAClickInAWindowNothingEnteredPresses: 6,
  testAPressIsHeldForTheFramesAsked: 6,
  testOptionsWrittenAreSaidWhenTheirReimportFails: 6,
  testTheRunAdoptedIsTheLatestStarted: 6,
  testAPathStepsIntoAVectorsComponents: 5,
  testAPauseAnswersWithTheGamesOwnScript: 5,
  testAnEditorAServerOpenedIsStartedAgain: 5,
  testDiagnosticsTimeoutIsNotAnEmptyResult: 5,
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
