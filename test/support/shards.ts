/**
 * Seconds each regression of five or more takes on its slowest platform, from the engine legs' own
 * "took" lines (two runs of every part on the three platforms, the larger figure kept). Every
 * regression not named here took under five seconds and is counted as `UNMEASURED_SECONDS`.
 *
 * Only the split reads these, so a stale figure costs balance and never coverage, until a part runs
 * into its job's timeout: with figures taken before the slowest of today's regressions were written, the first macOS
 * part carried 679 seconds of regressions and 339 of engine fixtures, and was cancelled at twenty
 * minutes while the other two finished in fourteen. Dealt out every nth instead, the two halves of
 * the Windows leg ran 578 and about 370 seconds, and the run waited on the long one.
 */
export const REGRESSION_SECONDS: Readonly<Record<string, number>> = {
  testTheTestCommandRunsAndJudgesAProject: 197,
  testARescanTheEditorDidNotAnswerIsFinishedByTheNext: 142,
  testAThemeAndATilesetWithNoEditor: 120,
  testAWriteWithNoEditorGoesThroughAHeadlessEngine: 114,
  testAPresetIsSetRemovedAndPacked: 111,
  testAWriteReadsWhatThePropertyDeclares: 102,
  testGdUnitRunner: 78,
  testATestRunSaysHowFarItHasGot: 77,
  testAReimportReimportsThroughTheEngine: 67,
  testARunImportsWhatChangedFirst: 64,
  testANodeKeepsItsGroupsAndItsPlace: 58,
  testProjectTestJudgesItsRunAsTheGateDoes: 54,
  testATestRunCutShortIsNamedForWhatItWasDoing: 52,
  testAProjectsFilesAndLayersAreNamedWithNoEditor: 52,
  testAStartWaitsOutTheEditorsScan: 51,
  testARunawayTestRunAnswersASizeTheClientTakes: 47,
  testAnAnimationsKeysAndLengthAreWrittenWithNoEditor: 44,
  testAOneShotEngineRunIsNotTheEditor: 45,
  testACallWaitsForTheEditorThisServerOpened: 44,
  testAResourceWriteWithNoEditorSaysWhatStoppedIt: 44,
  testAnEditorWritesItsConsoleWhereTheServerLooks: 43,
  testATestRunNamesItsLeaksAndItsUnusedIgnores: 42,
  testATrackAndItsKeysComeOutWithNoEditor: 37,
  testCommandLineSetup: 41,
  testANavigationRegionIsBakedWithNoEditor: 41,
  testARealBenchTakesItsWorkerWithIt: 39,
  testAnInjectedMotionCarriesHowFarThePointerMoved: 37,
  testTheWaitIsSizedToTheLastBoot: 35,
  testARenameWithNoEditorLeavesTheCacheAndTheScriptsRight: 35,
  testAnImportOrExportOverAStaleDocCacheRunsAgain: 35,
  testARescanAsTheEditorOpensFindsNothingMissing: 34,
  testAStateMachineIsWrittenWithNoEditor: 34,
  testATestRunTakesTheCasesNamed: 33,
  testAReadWithNoEditorAnswersFromTheFile: 32,
  testAnAnimationIsRenamedAndRemovedWithNoEditor: 32,
  testAnInheritedSceneIsMadeWithNoEditor: 32,
  testEditableChildrenAreOpenedAndClosedWithNoEditor: 32,
  testASpreadBenchGathersTheTableItPlaysAlone: 31,
  testAMovedNodeIsFollowedIntoTheScenesNamingIt: 30,
  testACallTakesAnObjectByItsPath: 30,
  testAMethodKeyIsJudgedAgainstItsMethodWithNoEditor: 30,
  testTheShutdownWalkIsHeldAndARealLeakStillFails: 29,
  testAParameterisedCaseIsDealtByItsRows: 29,
  testAnEditorThisServerStartsIsSilentUnlessAsked: 28,
  testWhatTheGameTellsAScreenReaderIsRead: 28,
  testAnAnnotatedDeclarationIsStillADeclaration: 27,
  testEveryLongCallIsHeardFrom: 27,
  testThePhysicsRateIsTheStepsTaken: 27,
  testTheEditorsGameIsToldFromAnotherOfTheSameProject: 26,
  testAnInheritedCaseIsLeftOutOfItsOwnSuiteOnly: 26,
  testAControlIsLaidOutAsTheEditorLaysItOut: 26,
  testAWindowedRunWritesItsMovie: 25,
  testAProfileFromTheStartWaitsForTheProfiler: 23,
  testAnAnimationNodeNotFoundIsToldWhereToLook: 22,
  testTheShippedRunnerRunsAFileOfSuites: 23,
  testAWatchRecordsAPropertyEveryFrame: 23,
  testDiagnosticsWithoutAnEditorComeFromTheEngine: 22,
  testAPointerOnTheHiddenDesktopIsNoted: 21,
  testAnInstanceKeepsItsOwnValuesWithNoEditor: 21,
  testAStateMachineWrittenWithNoEditorRunsAsWritten: 20,
  testAWordsWaitLeavesTheGameItsSpeed: 20,
  testAnEditorStartedByAnEditorSaysSo: 20,
  testAStackOverflowIsNotAPass: 19,
  testAnEngineGdharnessStartsCanHaveItsCrashReported: 18,
  testAStopGoesThroughTheKeeper: 18,
  testA3DLevelIsReadAsItIsWritten: 18,
  testARunFollowsTheGamesRestart: 17,
  testAGameHeldInACallHasTheCall: 17,
  testAWriteSaysWhatElseItChanged: 17,
  testALateAnnouncementIsTiedToThePlayedRun: 16,
  testAPredecessorThatKeepsThePortIsNotWaitedOnForEver: 16,
  testATestRunWhoseAutoloadDidNotCompileStops: 16,
  testAnEditorIsReadOnceItHasSaidWhoItIs: 15,
  testSuitesPlayInASceneTheProfilerSees: 15,
  testAnOrphanIsNamedWithTheCaseThatLeftIt: 15,
  testACancelledWaitStopsAskingTheEditor: 15,
  testEveryEngineWaitsForAMachineSlot: 14,
  testAnAddedPresetExports: 14,
  testACaptureBeforeTheFirstFrameWaitsForIt: 14,
  testTheAnnounceWaitIsNotHeldByASlowEditor: 14,
  testAProfiledRunNamesWhereItsTimeWent: 14,
  testParametersReachTheEngine: 13,
  testAQuietSceneIsNotServed: 12,
  testACancelledFolderStopsAsking: 12,
  testAKeyDoesNotChooseFromAnOpenedMenu: 12,
  testAGameThisServerStartedIsDebugged: 12,
  testARunOnItsOwnDesktopIsThere: 12,
  testAStopCanEndWhatTheGameStarted: 11,
  testTheLifecycleLogSaysHowAServerEnded: 11,
  testAMovedNodeNamesTheScriptLinesReadingIt: 11,
  testASettingsWriteIsTakenUpByTheEditor: 11,
  testARuntimeCallReachesThisServersOwnGame: 11,
  testAMovedNodeKeepsThePathsNamingIt: 10,
  testASupersededServerStandsDown: 10,
  testAHandWrittenValueIsNoChangeOfAScripts: 10,
  testAPauseAnswersWithTheGamesOwnScript: 10,
  testAPlayedGameIsToldFromItsWorkers: 10,
  testAnUpgradeReadsTheEngineOutOfTheConfigItRewrites: 10,
  testASelfContainedEngineKeepsItsTemplates: 9,
  testAnInheritedSceneFindsItsBaseAsTheEngineDoes: 9,
  testAMoveWithNoEditorLeavesTheProjectLoading: 9,
  testAPointerAimsInsideANamedNode: 9,
  testAStructureReadDescribesTheScriptItRead: 9,
  testEditorStatusCountsOnlyOtherCallsInFlight: 9,
  testAStatusCallIsNotHeldByAHeldGame: 9,
  testASettingsWriteKeepsEveryOtherLine: 9,
  testARescanReloadsWhatNamesAClassItBroughtIn: 8,
  testAnElementIsToldWhatItsTypeTakes: 8,
  testAStopAsksTheGameToCloseFirst: 8,
  testAToolWaitsOutTheEditorsScan: 8,
  testCallsSentTogetherWaitTheirTurnAtTheGame: 7,
  testDiagnosticsAnswerSeveralScripts: 7,
  testAPathStepsIntoAVectorsComponents: 7,
  testAnExitTheKeeperIsStillWritingIsWaitedFor: 7,
  testAForeignRunSurvivesAStart: 6,
  testTheRendererIsChosenAndItsMemoryRead: 6,
  testAnEngineWritesItsLogThroughAPipeOnWindows: 6,
  testOptionsWrittenAreSaidWhenTheirReimportFails: 6,
  testAClickInAWindowNothingEnteredPresses: 6,
  testASubViewportCaptureIsDrawnNow: 6,
  testACrashedRunIsNeverClean: 6,
  testTheFrameTimeIsTheFrame: 6,
  testARunNoteIsNeverReadHalfWritten: 6,
  testAPlayedGamesConsoleKeepsItsOrder: 6,
  testASilentRunIsStartedHereAndSaysWhy: 6,
  testAHeadlessGameGivenAFixedRateRacesTheClock: 6,
  testAPressIsHeldForTheFramesAsked: 6,
  testARebuildSaysWhatItsOwnEngineCouldNotKnow: 6,
  testTheRunAdoptedIsTheLatestStarted: 5,
  testAnEditorAServerOpenedIsStartedAgain: 5,
  testARuntimeCallToAHeldGameIsRefusedAtOnce: 5,
  testTheWrittenConfigNamesAProgramThatStarts: 5,
  testAScreenshotHoldsTheGamesOwnWindows: 5,
  testDiagnosticsTimeoutIsNotAnEmptyResult: 5,
  testTheTestHelpersWaitStepAndPress: 5,
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
