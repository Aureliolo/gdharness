import { tmpdir } from 'node:os';
import { CompiledHelper } from '../../src/compiled-helper.js';

/** What the stand-in prints once it has run its time out, which only a process left alone gets to. */
export const BOX_GAME_RAN_ON = 'the game ran on';

/**
 * A Windows program standing in for a game that opens a message box. The first argument names where:
 * `main` opens it on the thread the game runs on, `worker` on a thread of its own while the game runs
 * on, and `child` in a second process it starts. The last two print {@link BOX_GAME_RAN_ON} and exit 0
 * after five seconds when nothing has ended them.
 */
const SOURCE = `using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class BoxGame {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int MessageBoxW(IntPtr window, string text, string title, uint kind);
  const uint TaskModal = 0x2000;

  static void Box() {
    MessageBoxW(IntPtr.Zero, "Hello from the game", "Game alert", TaskModal);
  }

  public static int Main(string[] args) {
    string where = args.Length > 0 ? args[0] : "main";
    if (where == "main") {
      Box();
      return 0;
    }
    if (where == "worker") {
      Thread worker = new Thread(Box);
      worker.IsBackground = true;
      worker.Start();
    }
    if (where == "child") {
      ProcessStartInfo child = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "main");
      child.${['UseShell', 'Execute'].join('')} = false;
      child.CreateNoWindow = true;
      Process second = new Process();
      second.StartInfo = child;
      second.Start();
    }
    Thread.Sleep(5000);
    Console.WriteLine("${BOX_GAME_RAN_ON}");
    return 0;
  }
}
`;

const GAME = new CompiledHelper('box game stand-in', 'gdharness-box-game', SOURCE, true);

/** The compiled stand-in's path, or why it could not be compiled. */
export async function boxGame(): Promise<string> {
  const failed = await GAME.ensure();
  if (failed !== null) {
    throw new Error(failed);
  }
  return GAME.assembly(tmpdir());
}
